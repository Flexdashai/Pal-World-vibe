/**
 * MONARCH — the damage model.
 *
 * One function decides what a blow is worth, and it is deliberately pure: it
 * reads two actors and a skill, writes into a preallocated result record, and
 * touches nothing else. Everything that makes damage *feel* like something —
 * hit-stop, shake, flash, numbers — happens in `impact.js` from this record.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS, AND WHY
 *
 *   1  base        = weapon·attack + power·shadowPower
 *   2  · variance  ±8.5%, so two identical swings show different numbers
 *   3  · falloff   distance from the centre of the hitbox
 *   4  · vulnerability   stagger / freeze / mark windows, multiplied together
 *   5  · crit      rolled AFTER vulnerability so a crit on a marked target is
 *                  genuinely enormous — the payoff for setting a target up
 *   6  − resist    elemental, from the target if it publishes one
 *   7  − armour    diminishing curve, physical component only
 *
 * Armour last and resistance before it, because armour is the *physical* wall
 * and resistance is the *elemental* one; applying armour to a shadow spear
 * would make plate a defence against magic, which it is not.
 *
 * ---------------------------------------------------------------------------
 * WHO APPLIES THE DAMAGE
 *
 * ARCHITECTURE.md is explicit: `combat:hit` means damage dealt TO `target`, and
 * **the target's own listener applies it — the emitter never applies it too**.
 * So combat computes and emits; it never writes `target.stats.hp`.
 *
 * That leaves one wrinkle worth stating out loud, because it is invisible until
 * someone measures it. The player subsystem's `combat:hit` listener runs the
 * amount through its OWN armour curve (`Stats.takeDamage`). If combat also
 * mitigated, the player would be mitigated twice. So:
 *
 *   target.isPlayer  → emit the PRE-mitigation figure; the player mitigates.
 *   anything else    → emit the final figure; `applyDamage` should subtract it.
 *
 * Both numbers are on the payload (`amount` and `raw`) so a listener that wants
 * the other one can have it.
 */

import { DAMAGE, STATUS, clamp, clamp01 } from './tuning.js';

/** A reusable damage result. One per call site; never allocated per hit. */
export function makeDamageResult() {
  return {
    /** Final damage after everything, what a damage number should read. */
    amount: 0,
    /** Pre-mitigation damage, before resistance and armour. */
    raw: 0,
    crit: false,
    element: 'physical',
    /** Combined vulnerability multiplier that was applied. */
    vulnerability: 1,
    /** Fractions removed, for the combat log / debug. */
    resisted: 0,
    armoured: 0,
    /** Fraction of the target's max health this blow removes — the severity
     *  that scales hit-stop, shake and impulse. */
    severity: 0,
    /** True when this blow reduces the target below zero. */
    lethal: false,
    overkill: 0,
    /** Health returned to the source. */
    lifesteal: 0,
  };
}

/** Attack rating of an actor for a given scaling pair. Duck-typed so an `ai`
 *  actor that publishes only `stats.damage` still works. */
export function attackOf(source, def) {
  const s = source?.stats ?? source ?? null;
  const weapon = s?.damage ?? s?.attack ?? 20;
  const power = s?.shadowPower ?? s?.power ?? weapon;
  return (def.weapon ?? 0) * weapon + (def.power ?? 0) * power;
}

/** Elemental resistance 0..1, from `actor.resist[element]` or `actor.stats.resist`. */
export function resistOf(target, element) {
  const r = target?.resist ?? target?.stats?.resist ?? null;
  if (!r) return 0;
  const v = r[element];
  return typeof v === 'number' ? clamp(v, -1, DAMAGE.resistMax) : 0;
}

/**
 * Armour mitigation, Diablo's diminishing form. `k·level` keeps armour
 * meaningful at every level instead of trivialising early content and being
 * worthless late.
 */
export function armourMitigation(armour, level) {
  if (!(armour > 0)) return 0;
  const denom = armour + DAMAGE.armourK * Math.max(1, level || 1);
  return clamp(armour / denom, 0, DAMAGE.armourMax);
}

/**
 * The combined vulnerability multiplier for a target, from its open windows.
 * Multiplicative and capped — three statuses at once should be a big number, not
 * an unbounded one.
 *
 * `status` is the StatusSystem's per-actor record, or null.
 */
export function vulnerabilityOf(target, status, now = Infinity) {
  let m = 1;
  // Compared against `now`, not merely tested for existence. `staggerUntil` is
  // an absolute time and a target that was staggered once would otherwise stay
  // permanently vulnerable — a bug worth nothing visually and everything
  // numerically, and invisible without a test.
  if ((target?.staggerUntil ?? 0) > now) m *= DAMAGE.vulnStagger;
  if (status) {
    if (status.has('freeze')) m *= DAMAGE.vulnFrozen;
    // The mark and the shock are the two *stacking* amplifiers, and they stack
    // with each other: `vulnMarked` is the value at one stack, so the per-stack
    // increment is (vulnMarked − 1).
    const mark = status.stacks('mark');
    if (mark > 0) m *= 1 + mark * (DAMAGE.vulnMarked - 1);
    const shock = status.stacks('shock');
    if (shock > 0) m *= 1 + shock * STATUS.shock.amplifyPerStack;
    // An explicit vulnerability window opened by a skill — the domain opens one
    // on everything standing inside it for its whole duration.
    if (status.vulnerable > 1) m *= status.vulnerable;
  }
  // A target the ai has flagged as open — a boss in its stun phase, an enemy
  // caught mid-cast. Duck-typed so `ai` can use it without a contract change.
  if (target?.vulnerable === true) m *= DAMAGE.vulnStagger;
  return clamp(m, 1, DAMAGE.vulnMax);
}

/**
 * Roll one blow.
 *
 * @param out       a `makeDamageResult()` record, written in place
 * @param source    the attacking actor (may be null for environmental damage)
 * @param target    the actor being hit
 * @param def       the skill definition (or a plain `{ weapon, power, ... }`)
 * @param rng       deterministic stream — NEVER Math.random
 * @param opts      { falloff, scale, status, pierceIndex }
 */
export function rollDamage(out, source, target, def, rng, opts = {}) {
  const element = def.element ?? 'physical';
  out.element = element;
  out.crit = false;
  out.vulnerability = 1;
  out.resisted = 0;
  out.armoured = 0;
  out.lethal = false;
  out.overkill = 0;
  out.lifesteal = 0;

  // ---- 1. base ------------------------------------------------------------
  let dmg = attackOf(source, def) * (opts.scale ?? 1);

  // Shadow damage never touches the Monarch's own soldiers. This is a rule, not
  // a resistance: friendly fire from the player's signature element would make
  // every AoE a liability the moment the army got big, which is the exact
  // opposite of the power curve this game is built around.
  if (element === 'shadow' && target?.isShadow) {
    out.amount = 0; out.raw = 0; out.severity = 0;
    return out;
  }

  // ---- 2. variance --------------------------------------------------------
  dmg *= 1 + (rng ? rng.signed() : 0) * DAMAGE.variance;

  // ---- 3. falloff ---------------------------------------------------------
  if (opts.falloff !== undefined) dmg *= opts.falloff;

  // ---- 4. vulnerability ---------------------------------------------------
  const vuln = vulnerabilityOf(target, opts.status ?? null, opts.now ?? Infinity);
  out.vulnerability = vuln;
  dmg *= vuln;

  // ---- 5. crit ------------------------------------------------------------
  const chance = clamp01((source?.stats?.critChance ?? DAMAGE.critChance) + (def.critBonus ?? 0));
  if (rng && rng.float() < chance) {
    out.crit = true;
    dmg *= source?.stats?.critDamage ?? DAMAGE.critDamage;
  }

  out.raw = dmg;

  // ---- 6. resistance ------------------------------------------------------
  const res = resistOf(target, element);
  if (res !== 0) { dmg *= 1 - res; out.resisted = res; }

  // ---- 7. armour ----------------------------------------------------------
  // Only the physical component is stopped by plate. A skill that scales off
  // both (the dash-strike, the domain) is mitigated proportionally to how much
  // of its damage came from the weapon term, which is the honest answer and
  // costs one extra multiply.
  const st = target?.stats ?? null;
  const armour = st?.armour ?? 0;
  if (armour > 0) {
    const physFrac = element === 'physical' ? 1 : physicalFraction(source, def);
    if (physFrac > 0) {
      const mit = armourMitigation(armour, st?.level ?? 1) * physFrac;
      dmg *= 1 - mit;
      out.armoured = mit;
    }
  }

  out.amount = Math.max(1, dmg);

  // ---- severity + lethality ----------------------------------------------
  const hpMax = st?.hpMax ?? 100;
  const hp = st?.hp ?? hpMax;
  out.severity = clamp01(out.amount / Math.max(1, hpMax * 0.25));
  if (out.amount >= hp) {
    out.lethal = true;
    out.overkill = out.amount - hp;
  }
  out.lifesteal = (def.lifesteal ?? 0) * out.amount;
  return out;
}

/** What fraction of a mixed-scaling skill's damage came from the weapon term.
 *  Used to decide how much of it armour may stop. */
function physicalFraction(source, def) {
  const w = def.weapon ?? 0, p = def.power ?? 0;
  if (w <= 0) return 0;
  if (p <= 0) return 1;
  const s = source?.stats ?? {};
  const wv = w * (s.damage ?? 20);
  const pv = p * (s.shadowPower ?? 20);
  return wv / Math.max(1e-4, wv + pv);
}

/**
 * Damage-over-time bookkeeping. DoT is not a skill hit: it has no crit, no
 * knockback, no hit-stop and a much smaller number, and it must not be routed
 * through the full impact pipeline or a four-stack burn would shake the camera
 * twice a second for four seconds.
 */
export function rollDot(out, target, element, amount, status) {
  out.element = element;
  out.crit = false;
  out.vulnerability = 1;
  out.resisted = 0;
  out.armoured = 0;
  out.lifesteal = 0;
  let dmg = amount;
  const res = resistOf(target, element);
  if (res !== 0) { dmg *= 1 - res; out.resisted = res; }
  // DoT still respects the mark, because the mark's entire job is "everything
  // hurts this thing more".
  if (status) {
    const mark = status.stacks('mark');
    if (mark > 0) {
      out.vulnerability = 1 + mark * (DAMAGE.vulnMarked - 1);
      dmg *= out.vulnerability;
    }
  }
  out.raw = amount;
  out.amount = Math.max(1, dmg);
  const st = target?.stats ?? null;
  const hpMax = st?.hpMax ?? 100;
  const hp = st?.hp ?? hpMax;
  out.severity = clamp01(out.amount / Math.max(1, hpMax * 0.25));
  out.lethal = out.amount >= hp;
  out.overkill = out.lethal ? out.amount - hp : 0;
  return out;
}

/**
 * Threat. Kept here rather than in `ai` because threat is a property of the
 * damage event, and `ai` should be able to read a number rather than reconstruct
 * one. Healing and taunts are worth more than their raw value; damage-over-time
 * is worth less, so a burn does not hold a boss.
 */
export function threatOf(result, def) {
  const base = result.amount * (def?.threatScale ?? 1);
  return def?.taunt ? base * 4 + 500 : base;
}
