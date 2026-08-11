/**
 * MONARCH — affixes, tiers and the stat channel.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT MAKES THIS SUBSYSTEM REAL
 *
 * Every affix in the pool below names a `stat`, and every stat in the STAT
 * table below lands on a FIELD OF THE LIVE PLAYER STATS OBJECT that another
 * subsystem already reads:
 *
 *   stats.damage        → combat/damage.js `attackOf()`      (every swing)
 *   stats.shadowPower   → combat/damage.js `attackOf()`      (every spell)
 *   stats.critChance    → combat/damage.js `rollDamage()`
 *   stats.critDamage    → combat/damage.js `rollDamage()`
 *   stats.armour        → player/stats.js  `takeDamage()`
 *   stats.hpMax/manaMax → the HUD globes and every resource check
 *   stats.moveSpeedMul  → player/locomotion.js, read every fixed step
 *   stats.poise         → player `applyStagger()`
 *   stats.extractChance → player/shadowarmy.js extraction roll
 *   stats.armyCapacity  → how many shadow soldiers may stand at once
 *
 * So "+18% Shadow Damage" is not a line of text: it makes the next Shadow Nova
 * hit harder, and the damage number on screen goes up. A loot system whose
 * affixes are display-only is the single most common failure in a demo build,
 * and it is invisible in a screenshot, which is why it is stated here.
 *
 * The remaining fields (`cooldownReduction`, `magicFind`, `attackSpeed`,
 * `staggerDamage`, `lifeOnKill`, `thorns`, `resist`) are OWNED BY THIS
 * SUBSYSTEM: nothing else writes them, this file defines them, and `loot`
 * consumes them itself (magic find feeds the rarity roll, life-on-kill heals on
 * `combat:kill`). `combat` may adopt the rest at any time by reading
 * `player.stats.cooldownReduction` — the field is always present and always
 * correct.
 *
 * ---------------------------------------------------------------------------
 * TIERS
 *
 * An affix has ONE value range and six tiers that cut windows out of it. Tier VI
 * of "Maximum Life" is 82-100% of the range; tier I is 10-30%. The item level
 * decides which tiers are unlocked, and the roll takes the highest unlocked tier
 * most of the time (see TIER_STEPDOWN). That gives the two properties an ARPG
 * affix system needs: a high-level item is reliably good, and there is still a
 * visible difference between two items of the same level.
 */

import { TIERS, TIER_STEPDOWN, clamp, clamp01, lerp } from './tuning.js';

/* ==========================================================================
 * THE STAT CHANNEL
 * ========================================================================== */

/**
 * `kind`:
 *   'add' — flat, summed, then added to the player's base
 *   'mul' — fractional, summed, then applied as base × (1 + Σ)
 *   'own' — a field this subsystem owns outright; base is `base`
 *
 * `owner: 'player'` marks a field the player subsystem recomputes in `derive()`.
 * Those are re-applied automatically whenever the player levels — see
 * `inventory.js`'s drift check.
 */
export const STAT = {
  damageFlat: { field: 'damage', kind: 'add', owner: 'player', label: 'Damage' },
  damagePct: { field: 'damage', kind: 'mul', owner: 'player', label: 'Damage' },
  shadowPower: { field: 'shadowPower', kind: 'add', owner: 'player', label: 'Shadow Power' },
  shadowPct: { field: 'shadowPower', kind: 'mul', owner: 'player', label: 'Shadow Damage' },
  armour: { field: 'armour', kind: 'add', owner: 'player', label: 'Armour' },
  armourPct: { field: 'armour', kind: 'mul', owner: 'player', label: 'Armour' },
  hpMax: { field: 'hpMax', kind: 'add', owner: 'player', label: 'Maximum Life' },
  hpPct: { field: 'hpMax', kind: 'mul', owner: 'player', label: 'Maximum Life' },
  manaMax: { field: 'manaMax', kind: 'add', owner: 'player', label: 'Maximum Mana' },
  critChance: { field: 'critChance', kind: 'add', owner: 'player', label: 'Critical Strike Chance' },
  critDamage: { field: 'critDamage', kind: 'add', owner: 'player', label: 'Critical Strike Damage' },
  moveSpeed: { field: 'moveSpeedMul', kind: 'add', owner: 'player', label: 'Movement Speed' },
  poise: { field: 'poise', kind: 'add', owner: 'player', label: 'Poise' },
  healthRegen: { field: 'healthRegen', kind: 'add', owner: 'player', label: 'Life Regeneration' },
  manaRegen: { field: 'manaRegen', kind: 'add', owner: 'player', label: 'Mana Regeneration' },
  extractChance: { field: 'extractChance', kind: 'add', owner: 'player', label: 'Shadow Extraction Chance' },
  armyCapacity: { field: 'armyCapacity', kind: 'add', owner: 'player', label: 'Shadow Army Capacity' },

  /* --- fields this subsystem owns outright --------------------------------- */
  cooldown: { field: 'cooldownReduction', kind: 'own', base: 0, label: 'Cooldown Reduction' },
  attackSpeed: { field: 'attackSpeed', kind: 'own', base: 0, label: 'Attack Speed' },
  staggerDamage: { field: 'staggerDamage', kind: 'own', base: 0, label: 'Damage to Staggered' },
  lifeOnKill: { field: 'lifeOnKill', kind: 'own', base: 0, label: 'Life on Kill' },
  magicFind: { field: 'magicFind', kind: 'own', base: 0, label: 'Magic Find' },
  thorns: { field: 'thorns', kind: 'own', base: 0, label: 'Thorns' },
  areaSize: { field: 'areaSize', kind: 'own', base: 0, label: 'Area of Effect' },

  /* --- elemental resistance, a nested object ------------------------------- */
  resShadow: { field: 'resist.shadow', kind: 'own', base: 0, label: 'Shadow Resistance' },
  resFire: { field: 'resist.fire', kind: 'own', base: 0, label: 'Fire Resistance' },
  resFrost: { field: 'resist.frost', kind: 'own', base: 0, label: 'Frost Resistance' },
  resLightning: { field: 'resist.lightning', kind: 'own', base: 0, label: 'Lightning Resistance' },
  resHoly: { field: 'resist.holy', kind: 'own', base: 0, label: 'Holy Resistance' },
  resAll: { field: 'resist.*', kind: 'own', base: 0, label: 'All Resistances' },
};

/** Fields recomputed by `player.stats.derive()`; watched for drift. */
export const PLAYER_FIELDS = Object.freeze([...new Set(
  Object.values(STAT).filter((s) => s.owner === 'player').map((s) => s.field)
)]);

/** Fields this subsystem creates on the stats object. */
export const OWNED_FIELDS = Object.freeze([...new Set(
  Object.values(STAT).filter((s) => s.kind === 'own' && !s.field.startsWith('resist.'))
    .map((s) => s.field)
)]);

export const RESIST_ELEMENTS = Object.freeze(['physical', 'shadow', 'fire', 'frost', 'lightning', 'holy']);

/* ==========================================================================
 * FORMATTING
 * ========================================================================== */

/**
 * `fmt` decides how a rolled value becomes the string on the tooltip.
 *   'flat'  +240
 *   'pct'   +18%          (value is a fraction)
 *   'pct1'  +4.6%         (value is a fraction, one decimal)
 *   'dec1'  +3.4
 *   'mult'  +0.24 → +24%  crit damage, which is stored as a multiplier delta
 */
export function formatAffix(fmt, v) {
  switch (fmt) {
    case 'pct': return `+${Math.round(v * 100)}%`;
    case 'pct1': return `+${(v * 100).toFixed(1)}%`;
    case 'dec1': return `+${v.toFixed(1)}`;
    case 'mult': return `+${Math.round(v * 100)}%`;
    default: return `+${Math.round(v)}`;
  }
}

/* ==========================================================================
 * THE POOL
 * ========================================================================== */

/**
 * `scaleIlvl: true` means the range is additionally multiplied by an item-level
 * factor. Flat resources (life, armour, damage, mana) must do this or a level-70
 * item's "+90 Life" is noise against a 1 400 health pool; percentages must NOT,
 * because the tier already encodes their power and a scaled percentage
 * compounds into nonsense.
 */
export const AFFIXES = [
  /* ------------------------------------------------------------- offence -- */
  { id: 'dmgFlat', label: 'Damage', family: 'offence', stat: 'damageFlat', lo: 3, hi: 26, fmt: 'flat', scaleIlvl: true },
  { id: 'dmgPct', label: 'Damage', family: 'offence', stat: 'damagePct', lo: 0.04, hi: 0.26, fmt: 'pct' },
  { id: 'crit', label: 'Critical Strike Chance', family: 'offence', stat: 'critChance', lo: 0.012, hi: 0.082, fmt: 'pct1' },
  { id: 'critDmg', label: 'Critical Strike Damage', family: 'offence', stat: 'critDamage', lo: 0.08, hi: 0.72, fmt: 'mult' },
  { id: 'aspd', label: 'Attack Speed', family: 'offence', stat: 'attackSpeed', lo: 0.02, hi: 0.14, fmt: 'pct' },
  { id: 'stagger', label: 'Damage to Staggered', family: 'offence', stat: 'staggerDamage', lo: 0.06, hi: 0.44, fmt: 'pct' },
  { id: 'onKill', label: 'Life on Kill', family: 'offence', stat: 'lifeOnKill', lo: 3, hi: 42, fmt: 'flat', scaleIlvl: true },

  /* -------------------------------------------------------------- arcane -- */
  { id: 'shadow', label: 'Shadow Power', family: 'arcane', stat: 'shadowPower', lo: 6, hi: 78, fmt: 'flat', scaleIlvl: true },
  { id: 'shadowPct', label: 'Shadow Damage', family: 'arcane', stat: 'shadowPct', lo: 0.05, hi: 0.34, fmt: 'pct' },
  { id: 'cdr', label: 'Cooldown Reduction', family: 'arcane', stat: 'cooldown', lo: 0.015, hi: 0.115, fmt: 'pct1' },
  { id: 'mana', label: 'Maximum Mana', family: 'arcane', stat: 'manaMax', lo: 8, hi: 74, fmt: 'flat', scaleIlvl: true },
  { id: 'manaReg', label: 'Mana Regeneration', family: 'arcane', stat: 'manaRegen', lo: 0.4, hi: 4.2, fmt: 'dec1', scaleIlvl: true },
  { id: 'extract', label: 'Shadow Extraction Chance', family: 'arcane', stat: 'extractChance', lo: 0.02, hi: 0.14, fmt: 'pct' },
  {
    id: 'army', label: 'Shadow Army Capacity', family: 'arcane', stat: 'armyCapacity',
    lo: 1, hi: 3, fmt: 'flat',
    // The single most build-defining line in the game — an extra soldier is
    // permanent, visible, and compounds with everything. Gated hard.
    minIlvl: 40, rare: true, slots: ['neck', 'ring', 'ring2', 'offhand'],
  },
  { id: 'area', label: 'Area of Effect', family: 'arcane', stat: 'areaSize', lo: 0.04, hi: 0.24, fmt: 'pct' },

  /* ------------------------------------------------------------- defence -- */
  { id: 'armour', label: 'Armour', family: 'defence', stat: 'armour', lo: 8, hi: 96, fmt: 'flat', scaleIlvl: true },
  { id: 'armourPct', label: 'Armour', family: 'defence', stat: 'armourPct', lo: 0.05, hi: 0.30, fmt: 'pct' },
  { id: 'life', label: 'Maximum Life', family: 'defence', stat: 'hpMax', lo: 18, hi: 210, fmt: 'flat', scaleIlvl: true },
  { id: 'lifePct', label: 'Maximum Life', family: 'defence', stat: 'hpPct', lo: 0.03, hi: 0.16, fmt: 'pct' },
  { id: 'regen', label: 'Life Regeneration', family: 'defence', stat: 'healthRegen', lo: 0.6, hi: 7.5, fmt: 'dec1', scaleIlvl: true },
  { id: 'poise', label: 'Poise', family: 'defence', stat: 'poise', lo: 4, hi: 46, fmt: 'flat', scaleIlvl: true },

  /* --------------------------------------------------------------- brawn -- */
  { id: 'thorns', label: 'Thorns', family: 'brawn', stat: 'thorns', lo: 4, hi: 58, fmt: 'flat', scaleIlvl: true },
  { id: 'brawnLife', label: 'Maximum Life', family: 'brawn', stat: 'hpMax', lo: 26, hi: 260, fmt: 'flat', scaleIlvl: true },
  { id: 'brawnPoise', label: 'Poise', family: 'brawn', stat: 'poise', lo: 8, hi: 62, fmt: 'flat', scaleIlvl: true },

  /* ------------------------------------------------------------- utility -- */
  { id: 'move', label: 'Movement Speed', family: 'utility', stat: 'moveSpeed', lo: 0.015, hi: 0.075, fmt: 'pct1' },
  { id: 'mf', label: 'Magic Find', family: 'utility', stat: 'magicFind', lo: 0.05, hi: 0.42, fmt: 'pct' },
  { id: 'utilCdr', label: 'Cooldown Reduction', family: 'utility', stat: 'cooldown', lo: 0.01, hi: 0.085, fmt: 'pct1' },

  /* -------------------------------------------------------------- resist -- */
  { id: 'resShadow', label: 'Shadow Resistance', family: 'resist', stat: 'resShadow', lo: 0.03, hi: 0.30, fmt: 'pct' },
  { id: 'resFire', label: 'Fire Resistance', family: 'resist', stat: 'resFire', lo: 0.03, hi: 0.30, fmt: 'pct' },
  { id: 'resFrost', label: 'Frost Resistance', family: 'resist', stat: 'resFrost', lo: 0.03, hi: 0.30, fmt: 'pct' },
  { id: 'resLightning', label: 'Lightning Resistance', family: 'resist', stat: 'resLightning', lo: 0.03, hi: 0.30, fmt: 'pct' },
  { id: 'resHoly', label: 'Holy Resistance', family: 'resist', stat: 'resHoly', lo: 0.03, hi: 0.30, fmt: 'pct' },
  { id: 'resAll', label: 'All Resistances', family: 'resist', stat: 'resAll', lo: 0.02, hi: 0.16, fmt: 'pct', rare: true },

  /* ------------------------------------------------ weapon-only flavour --- */
  { id: 'wpnDmg', label: 'Damage', family: 'weapon', stat: 'damageFlat', lo: 6, hi: 44, fmt: 'flat', scaleIlvl: true, slots: ['weapon'] },
  { id: 'wpnCrit', label: 'Critical Strike Damage', family: 'weapon', stat: 'critDamage', lo: 0.12, hi: 0.9, fmt: 'mult', slots: ['weapon'] },
  { id: 'wpnShadow', label: 'Shadow Power', family: 'weapon', stat: 'shadowPower', lo: 10, hi: 108, fmt: 'flat', scaleIlvl: true, slots: ['weapon', 'offhand'] },
];

export const AFFIX_BY_ID = Object.freeze(
  AFFIXES.reduce((m, a) => { m[a.id] = a; return m; }, {})
);

/** Affixes grouped by family, built once. */
export const AFFIXES_BY_FAMILY = (() => {
  const m = {};
  for (const a of AFFIXES) (m[a.family] ??= []).push(a);
  return m;
})();

/* ==========================================================================
 * ROLLING
 * ========================================================================== */

/** The highest tier index unlocked at this item level. */
export function tierFor(ilvl) {
  let t = 0;
  for (let i = 0; i < TIERS.length; i++) if (ilvl >= TIERS[i].ilvl) t = i;
  return t;
}

/**
 * Pick the tier this roll lands in: start at the highest unlocked and step down
 * with probability TIER_STEPDOWN, repeatedly. That distribution — mode at the
 * top with a decaying tail — is what makes a high item level *feel* like an
 * upgrade without making every drop identical.
 */
export function rollTier(rng, ilvl) {
  let t = tierFor(ilvl);
  while (t > 0 && rng.float() < TIER_STEPDOWN) t--;
  return t;
}

/** Item-level factor for flat affixes. Clamped so a level-100 drop is 1.5x a
 *  level-35 one rather than 3x — flat scaling that outruns the tiers makes the
 *  tier names meaningless. */
export function ilvlFactor(ilvl) {
  return clamp(0.42 + (ilvl / 70) * 0.78, 0.42, 1.55);
}

/**
 * Roll one affix into a REUSED result object shape.
 * @returns {{ id, label, stat, value, text, tier, family, fmt }}
 */
export function rollAffix(rng, def, ilvl) {
  const ti = rollTier(rng, ilvl);
  const tier = TIERS[ti];
  const t = lerp(tier.lo, tier.hi, rng.float());
  let v = lerp(def.lo, def.hi, clamp01(t));
  if (def.scaleIlvl) v *= ilvlFactor(ilvl);
  // Integer affixes read as designed numbers; fractional ones read as a bug.
  if (def.fmt === 'flat') v = Math.max(1, Math.round(v));
  return {
    id: def.id,
    label: def.label,
    stat: def.stat,
    family: def.family,
    fmt: def.fmt,
    value: v,
    tier: tier.name,
    tierIndex: ti,
    text: formatAffix(def.fmt, v),
  };
}

/** May this affix appear on this base? */
export function affixAllowed(def, base, ilvl) {
  if (def.minIlvl && ilvl < def.minIlvl) return false;
  if (def.slots && !def.slots.includes(base.slot)) return false;
  return base.pools.includes(def.family);
}

/**
 * Build the candidate list for a base, weighted by the player's build.
 *
 * Written into `out` rather than returned fresh: generation runs on every kill
 * and ARCHITECTURE.md rule 5 forbids allocating per event, let alone per frame.
 */
export function candidatesFor(base, ilvl, familyWeights, out, weightsOut) {
  out.length = 0;
  weightsOut.length = 0;
  for (const def of AFFIXES) {
    if (!affixAllowed(def, base, ilvl)) continue;
    let w = familyWeights[def.family] ?? 1;
    // Rare affixes are gated by weight rather than by a separate roll, so magic
    // find and build weighting both still apply to them.
    if (def.rare) w *= 0.22;
    out.push(def);
    weightsOut.push(w);
  }
  return out.length;
}

/** Weighted pick from parallel arrays. */
export function weightedPick(rng, items, weights, exclude) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (exclude && exclude.has(items[i].stat)) continue;
    total += weights[i];
  }
  if (total <= 0) return null;
  let r = rng.float() * total;
  for (let i = 0; i < items.length; i++) {
    if (exclude && exclude.has(items[i].stat)) continue;
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  for (let i = items.length - 1; i >= 0; i--) {
    if (!exclude || !exclude.has(items[i].stat)) return items[i];
  }
  return null;
}
