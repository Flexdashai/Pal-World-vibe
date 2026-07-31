/**
 * MONARCH — item generation.
 *
 * One function does the whole job: `makeItem(rng, opts)`. Everything else here
 * is a step of it, factored out because each step is independently worth
 * reading — and because `selfTest()` exercises them individually.
 *
 * ---------------------------------------------------------------------------
 * THE PIPELINE
 *
 *   1  rarity      weighted roll, modified by magic find, floored by rank,
 *                  overridden by pity
 *   2  base        weighted by the player's build (smart loot) and by slot
 *   3  item level  monster level + rank bonus + jitter
 *   4  unique      legendary/mythic only: pick a named power for that base, or
 *                  fall back to another base entirely if none exists
 *   5  implicit    the base's guaranteed modifier, rolled at this item level
 *   6  affixes     N draws from the base's allowed pools, weighted by the
 *                  player's build 70% of the time, never repeating a stat
 *   7  grants      unique-only guaranteed lines, scaled from ilvl 70
 *   8  name        prefix from the dominant affix family, suffix from the second
 *   9  presentation headline number, flavour, score
 *
 * ---------------------------------------------------------------------------
 * TWO PARALLEL AFFIX ARRAYS, ON PURPOSE
 *
 *   item.mods     machine readable: { stat, value:number, ... }. This is what
 *                 `inventory.js` applies to the player.
 *   item.affixes  `ui`'s shape: { text:'Shadow Damage', value:'+18%' }, which
 *                 is what `ui/panels.js` renders without modification.
 *
 * They are generated together and never drift. Collapsing them into one array
 * would mean either `ui` cannot render our items or `inventory` has to reparse a
 * formatted string, and both of those are worse than eight bytes per affix.
 */

import {
  DROP_TABLE, MF_PULL, PITY, ILVL, AFFIX_COUNT, SMART_BIAS,
  RARITY_ORDER, RARITY_INDEX, clamp, lerp,
} from './tuning.js';
import {
  BASES, BASE_BY_ID, BASES_BY_SLOT, SLOT_FAMILY, SLOT_NAME,
  PREFIX_BY_FAMILY, SUFFIX_BY_FAMILY, QUALITY_WORDS,
  BUILD_WEIGHTS, BASE_AFFINITY,
} from './bases.js';
import {
  STAT, AFFIX_BY_ID, candidatesFor, weightedPick, rollAffix, rollTier,
  ilvlFactor, formatAffix,
} from './affixes.js';
import { UNIQUES, uniquesFor, GRANT_ILVL } from './uniques.js';

/** Monotonic instance id, so two identical rolls are still distinct objects. */
let UID = 1;

/* ==========================================================================
 * SMART LOOT — the player's build as weights
 * ========================================================================== */

/**
 * Family weights from the player's primary stats.
 *
 * Written into `out` (a preallocated object) rather than returned fresh: this
 * runs on every kill that drops something, and the enemy density in this game
 * makes that "several times a second" in a real fight.
 */
export function buildFamilyWeights(primary, out) {
  for (const k in out) out[k] = 0;
  let total = 0;
  for (const p in BUILD_WEIGHTS) total += primary?.[p] ?? 0;
  if (total <= 0) {
    // No player yet (the shot harness can generate loot before `player` has
    // published stats). Flat weights, which is the correct neutral prior.
    for (const fam in BUILD_WEIGHTS.intelligence) out[fam] = 1;
    return out;
  }
  for (const p in BUILD_WEIGHTS) {
    const share = (primary?.[p] ?? 0) / total;
    const row = BUILD_WEIGHTS[p];
    for (const fam in row) out[fam] = (out[fam] ?? 0) + row[fam] * share;
  }
  return out;
}

/** Base-pick weight for one base, given the player's primaries. */
function baseWeight(base, primary) {
  let w = base.weight ?? 1;
  if (!primary) return w;
  let total = 0;
  for (const p in BASE_AFFINITY) total += primary[p] ?? 0;
  if (total <= 0) return w;
  let aff = 0;
  for (const p in BASE_AFFINITY) {
    const share = (primary[p] ?? 0) / total;
    aff += (BASE_AFFINITY[p]?.[base.id] ?? 1.0) * share;
  }
  return w * aff;
}

/* ==========================================================================
 * RARITY
 * ========================================================================== */

/**
 * Roll a rarity from a rank's weight vector.
 *
 * `magicFind` shifts weight up the table (MF_PULL). `pity` is a pair of
 * counters, mutated here, that force the roll when the player has gone too long
 * without the moment — see the note in tuning.js on why that is not cheating.
 */
export function rollRarity(rng, rank, magicFind = 0, pity = null) {
  const table = DROP_TABLE[rank] ?? DROP_TABLE.common;

  if (pity) {
    if (pity.mythic >= PITY.mythic) { pity.mythic = 0; pity.legendary = 0; return 'mythic'; }
    if (pity.legendary >= PITY.legendary) { pity.legendary = 0; return 'legendary'; }
  }

  let total = 0;
  for (const r of RARITY_ORDER) {
    const w = (table.weights[r] ?? 0) * (1 + magicFind * (MF_PULL[r] ?? 0));
    total += Math.max(0, w);
  }
  let x = rng.float() * total;
  let picked = 'common';
  for (const r of RARITY_ORDER) {
    const w = Math.max(0, (table.weights[r] ?? 0) * (1 + magicFind * (MF_PULL[r] ?? 0)));
    x -= w;
    if (x <= 0) { picked = r; break; }
  }
  if (table.floor && RARITY_INDEX[picked] < RARITY_INDEX[table.floor]) picked = table.floor;

  if (pity) {
    if (RARITY_INDEX[picked] >= RARITY_INDEX.legendary) pity.legendary = 0;
    else pity.legendary++;
    if (picked === 'mythic') pity.mythic = 0;
    else pity.mythic++;
  }
  return picked;
}

/* ==========================================================================
 * BASE
 * ========================================================================== */

/** Scratch for the base roll. Module scope, so the roll allocates nothing. */
const _baseList = [];
const _baseWeights = [];

export function pickBase(rng, { slot = null, primary = null, exclude = null } = {}) {
  const pool = slot ? (BASES_BY_SLOT[slot] ?? BASES) : BASES;
  _baseList.length = 0;
  _baseWeights.length = 0;
  for (const b of pool) {
    if (exclude && exclude.includes(b.id)) continue;
    _baseList.push(b);
    _baseWeights.push(baseWeight(b, primary));
  }
  if (!_baseList.length) return BASES[0];
  let total = 0;
  for (const w of _baseWeights) total += w;
  let x = rng.float() * total;
  for (let i = 0; i < _baseList.length; i++) {
    x -= _baseWeights[i];
    if (x <= 0) return _baseList[i];
  }
  return _baseList[_baseList.length - 1];
}

/* ==========================================================================
 * ITEM LEVEL
 * ========================================================================== */

export function rollItemLevel(rng, monsterLevel, rank) {
  const bonus = ILVL.rankBonus[rank] ?? 0;
  const jitter = rng.int(ILVL.jitter[0], ILVL.jitter[1]);
  return clamp(Math.round(monsterLevel + ILVL.offset + bonus + jitter), ILVL.min, ILVL.max);
}

/* ==========================================================================
 * NUMBERS
 * ========================================================================== */

/** The base's own power at an item level, before affixes. */
export function basePower(base, ilvl) {
  return base.power + base.powerPerIlvl * Math.max(0, ilvl - 1);
}

/** Rarity multiplier on the base number. Small — rarity is supposed to be about
 *  the affixes and the power, not about a bigger headline. */
const RARITY_POWER = { common: 1.0, magic: 1.06, rare: 1.14, legendary: 1.24, mythic: 1.34 };

/* ==========================================================================
 * AFFIX ROLLING
 * ========================================================================== */

const _cands = [];
const _candW = [];
const _flatW = [];
const _usedStats = new Set();

/**
 * Roll `n` affixes onto `mods`/`affixes`.
 *
 * `SMART_BIAS` of picks use the build-weighted list; the rest use a flat one.
 * Both lists are the SAME candidate array, so the difference is purely which
 * weight vector the pick reads — no second filtering pass, no allocation.
 */
function rollAffixes(rng, base, ilvl, n, familyWeights, mods, affixes, used) {
  const count = candidatesFor(base, ilvl, familyWeights, _cands, _candW);
  if (!count) return 0;
  _flatW.length = 0;
  for (let i = 0; i < count; i++) _flatW.push(_cands[i].rare ? 0.22 : 1);

  let made = 0;
  for (let i = 0; i < n; i++) {
    const smart = rng.float() < SMART_BIAS;
    const def = weightedPick(rng, _cands, smart ? _candW : _flatW, used);
    if (!def) break;
    used.add(def.stat);
    const roll = rollAffix(rng, def, ilvl);
    mods.push(roll);
    affixes.push({ text: roll.label, value: roll.text });
    made++;
  }
  return made;
}

/* ==========================================================================
 * NAMING
 * ========================================================================== */

function dominantFamilies(mods) {
  // Two passes over at most six entries; a Map here would allocate per item.
  let bestFam = null, bestScore = -1, secondFam = null, secondScore = -1;
  for (const m of mods) {
    let s = 0;
    for (const o of mods) if (o.family === m.family) s += o.tierIndex + 1;
    if (s > bestScore) {
      secondFam = bestFam; secondScore = bestScore;
      bestFam = m.family; bestScore = s;
    } else if (m.family !== bestFam && s > secondScore) {
      secondFam = m.family; secondScore = s;
    }
  }
  return [bestFam, secondFam];
}

function nameFor(rng, base, rarity, mods) {
  const noun = rng.pick(base.nouns);
  if (rarity === 'common') {
    return rng.float() < 0.45 ? `${rng.pick(QUALITY_WORDS)} ${noun}` : noun;
  }
  const [famA, famB] = dominantFamilies(mods);
  const pre = PREFIX_BY_FAMILY[famA] ?? PREFIX_BY_FAMILY.offence;
  if (rarity === 'magic') return `${rng.pick(pre)} ${noun}`;
  const suf = SUFFIX_BY_FAMILY[famB ?? famA] ?? SUFFIX_BY_FAMILY.offence;
  return `${rng.pick(pre)} ${noun} ${rng.pick(suf)}`;
}

/* ==========================================================================
 * SCORING — used by auto-equip and by the tooltip's comparison arrow
 * ========================================================================== */

/**
 * How much this item is worth to THIS build.
 *
 * Not a damage simulation — a weighted sum whose weights are the same build
 * weights smart loot uses, normalised so a percentage and a flat value are
 * comparable. It only has to be monotonic and stable, because its whole job is
 * to answer "is this better than what I am wearing".
 */
const SCORE_WEIGHT = {
  damageFlat: 1.4, damagePct: 260, shadowPower: 1.0, shadowPct: 240,
  armour: 0.34, armourPct: 90, hpMax: 0.22, hpPct: 300, manaMax: 0.14,
  critChance: 900, critDamage: 130, moveSpeed: 700, poise: 0.5,
  healthRegen: 5, manaRegen: 5, extractChance: 480, armyCapacity: 90,
  cooldown: 900, attackSpeed: 460, staggerDamage: 120, lifeOnKill: 1.2,
  magicFind: 90, thorns: 0.3, areaSize: 200,
  resShadow: 120, resFire: 90, resFrost: 90, resLightning: 90, resHoly: 90, resAll: 420,
};

export function scoreItem(item, familyWeights) {
  let s = 0;
  for (const m of item.mods) {
    const w = SCORE_WEIGHT[m.stat] ?? 1;
    const fam = familyWeights?.[m.family] ?? 1;
    s += m.value * w * (0.55 + 0.45 * fam);
  }
  // The base number matters too, or a rare dagger beats a legendary greatsword
  // on affixes alone.
  s += item.basePower * (item.slot === 'weapon' ? 2.6 : 0.42);
  // A named power is worth roughly a whole extra affix tier.
  if (item.power) s *= 1.14;
  return s;
}

/* ==========================================================================
 * THE GENERATOR
 * ========================================================================== */

const _famScratch = {};

/**
 * @param {Rng} rng
 * @param {object} opts
 *   rarity       force a rarity
 *   rank         'common'|'elite'|'champion'|'boss'|'container'
 *   level        monster level
 *   ilvl         force an item level
 *   slot         restrict to a doll slot
 *   baseId       force a base
 *   uniqueId     force a unique
 *   primary      the player's primary stats, for smart loot
 *   magicFind    0..n
 *   pity         { legendary, mythic } counters, mutated
 */
export function makeItem(rng, opts = {}) {
  const primary = opts.primary ?? null;
  const familyWeights = buildFamilyWeights(primary, _famScratch);

  const rank = opts.rank ?? 'common';
  const rarity = opts.rarity ?? rollRarity(rng, rank, opts.magicFind ?? 0, opts.pity ?? null);
  const ilvl = opts.ilvl ?? rollItemLevel(rng, opts.level ?? 1, rank);

  /* ---- unique first: it decides the base ---------------------------------- */
  let unique = null;
  if (opts.uniqueId) unique = UNIQUES.find((u) => u.id === opts.uniqueId) ?? null;
  else if (rarity === 'legendary' || rarity === 'mythic') {
    const pool = uniquesFor(rarity, opts.baseId ?? null);
    // A legendary rolled for a base with no unique falls back to ANY unique of
    // that rarity rather than degrading to a rare: the beam has already been
    // promised by the time this runs.
    const list = pool.length ? pool : uniquesFor(rarity, null);
    if (list.length) unique = list[rng.u32() % list.length];
  }

  const base = unique ? BASE_BY_ID[unique.base]
    : opts.baseId ? (BASE_BY_ID[opts.baseId] ?? BASES[0])
      : pickBase(rng, { slot: opts.slot ?? null, primary });

  /* ---- the modifier lists -------------------------------------------------- */
  const mods = [];
  const affixes = [];
  _usedStats.clear();

  // Implicit: always present, always first, and marked so the tooltip can put a
  // rule under it the way every ARPG since Diablo II has.
  if (base.implicit) {
    const def = base.implicit;
    const t = lerp(0.25, 1.0, rng.float()) * (1 + (RARITY_INDEX[rarity] ?? 0) * 0.06);
    let v = lerp(def.lo, def.hi, Math.min(1, t));
    if (def.lo >= 1) v = Math.max(1, Math.round(v * ilvlFactor(ilvl)));
    const meta = STAT[def.stat];
    const fmt = def.lo >= 1 ? 'flat' : (def.stat === 'critDamage' ? 'mult' : 'pct1');
    const roll = {
      id: `implicit.${def.stat}`, label: meta?.label ?? def.stat, stat: def.stat,
      family: 'implicit', fmt, value: v, tier: '—', tierIndex: 0,
      text: formatAffix(fmt, v), implicit: true,
    };
    mods.push(roll);
    affixes.push({ text: roll.label, value: roll.text });
    _usedStats.add(def.stat);
  }

  // Unique grants, scaled from their authored item level.
  if (unique) {
    const k = clamp(ilvl / GRANT_ILVL, 0.22, 1.45);
    for (const g of unique.grants) {
      const meta = STAT[g.stat];
      const flat = Math.abs(g.value) >= 1;
      let v = g.value * k;
      if (flat) v = Math.max(1, Math.round(v));
      const fmt = flat ? 'flat' : (g.stat === 'critDamage' ? 'mult' : 'pct');
      const roll = {
        id: `unique.${g.stat}`, label: meta?.label ?? g.stat, stat: g.stat,
        family: 'unique', fmt, value: v, tier: '★', tierIndex: 5,
        text: formatAffix(fmt, v),
      };
      mods.push(roll);
      affixes.push({ text: roll.label, value: roll.text });
      _usedStats.add(g.stat);
    }
  }

  // Rolled affixes.
  const spec = AFFIX_COUNT[rarity] ?? AFFIX_COUNT.common;
  const n = spec.min + (spec.max > spec.min ? rng.int(0, spec.max - spec.min) : 0);
  rollAffixes(rng, base, ilvl, n, familyWeights, mods, affixes, _usedStats);

  /* ---- presentation -------------------------------------------------------- */
  const bp = basePower(base, ilvl) * (RARITY_POWER[rarity] ?? 1);
  const isWeapon = base.slot === 'weapon';
  const dps = isWeapon ? Math.round(bp * base.speed * 10) / 10 : 0;

  const item = {
    uid: UID++,
    name: unique ? unique.name : nameFor(rng, base, rarity, mods),
    rarity, ilvl,
    baseId: base.id,
    type: base.type,
    glyph: base.glyph,
    slot: base.slot,
    slotName: SLOT_NAME[base.slot] ?? base.slot,
    family: SLOT_FAMILY[base.slot] ?? 'armour',
    mesh: base.mesh,
    surface: base.surface,
    scale: base.scale ?? 1,
    hands: base.hands ?? 1,
    basePower: bp,
    mods,
    affixes,
    headline: isWeapon
      ? { label: 'Damage per Second', value: String(Math.round(dps)) }
      : bp > 0
        ? { label: 'Armour', value: String(Math.round(bp)) }
        : { label: mods[0]?.label ?? 'Item Level', value: mods[0]?.text ?? String(ilvl) },
    power: unique ? { name: unique.power, text: unique.text } : null,
    uniqueId: unique?.id ?? null,
    skill: unique?.skill ?? null,
    flavour: unique?.flavour ?? null,
    stack: 0,
    /** Deterministic per-instance seed for the mesh's forge warp and the drop's
     *  bob phase, so two items of the same base are not visually identical. */
    seed: rng.u32(),
    score: 0,
  };
  item.score = scoreItem(item, familyWeights);
  return item;
}

/**
 * How many items a kill drops, and at what rarities. Returns the count; the
 * caller makes the items so this function stays allocation free.
 */
export function rollDropCount(rng, rank) {
  const table = DROP_TABLE[rank] ?? DROP_TABLE.common;
  if (table.rolls <= 0) return 0;
  if (rng.float() > table.chance) return 0;
  let n = 0;
  for (let i = 0; i < table.rolls; i++) {
    // Each roll after the first is progressively less likely, so an elite
    // usually drops one thing and occasionally drops three.
    if (i === 0 || rng.float() < 0.55 - i * 0.12) n++;
  }
  return Math.max(1, n);
}

/** A believable starter loadout, so the character sheet is never empty and
 *  the comparison arrows in the tooltip always have something to compare to. */
export function makeStarterEquipment(rng, level = 1, primary = null) {
  const out = {};
  const plan = [
    ['head', 'magic'], ['shoulder', 'common'], ['neck', 'magic'], ['chest', 'magic'],
    ['hands', 'common'], ['waist', 'common'], ['legs', 'common'], ['feet', 'magic'],
    ['ring', 'common'], ['ring2', 'common'], ['weapon', 'rare'], ['offhand', 'magic'],
  ];
  for (const [slot, rarity] of plan) {
    out[slot] = makeItem(rng, {
      slot: slot === 'ring2' ? 'ring' : slot,
      rarity, ilvl: Math.max(1, level), primary,
    });
    out[slot].slot = slot;
  }
  return out;
}

export { AFFIX_BY_ID };
