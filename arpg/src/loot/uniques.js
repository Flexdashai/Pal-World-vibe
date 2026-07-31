/**
 * MONARCH — legendary and mythic uniques.
 *
 * A legendary in this game is not "a rare with more numbers". It carries a NAMED
 * POWER that changes how a skill behaves, and the power is what the player
 * remembers — nobody has ever told a story about +214 armour.
 *
 * ---------------------------------------------------------------------------
 * HOW A POWER ACTUALLY REACHES THE SKILL
 *
 * `combat` owns skills, and ARCHITECTURE.md forbids reaching into it. So a power
 * is published, never pushed:
 *
 *     const mods = ctx.get('loot').skillMods('skill4');
 *     // -> { radius: 1.34, maxTargets: 3, pulses: 1, cooldown: 0.86, ... }
 *
 * `skillMods(id)` returns a LIVE, REUSED object (never a fresh literal — it is
 * safe to call every cast) whose keys are exactly the field names in
 * `combat/skills.js`. Multiplicative keys are multipliers around 1; additive
 * keys are deltas. `combat` can adopt them in one line per field, at any time,
 * without this subsystem changing.
 *
 * That is a real contract, but it is also a promise about somebody else's code,
 * so **every power additionally carries `grants`** — guaranteed affixes applied
 * through the ordinary stat channel. A unique is therefore never inert: the
 * worst case is that its headline is flavour and its statline is enormous.
 *
 * ---------------------------------------------------------------------------
 * SCALING
 *
 * `grants` values are authored at item level 70 and scaled by the drop's actual
 * item level, so a unique that drops at level 12 is a level-12 item — not a
 * level-70 one that trivialises the run.
 */

/** The item level `grants` values are authored against. */
export const GRANT_ILVL = 70;

/**
 * Multiplicative mod keys. Anything not listed here is treated as ADDITIVE, so a
 * new mod defaults to the safer interpretation — an unrecognised multiplier
 * applied as an addition is a small bug; an unrecognised addition applied as a
 * multiplier is a 26x nova.
 */
export const MULTIPLICATIVE = new Set([
  'radius', 'range', 'damage', 'cooldown', 'speed', 'duration',
  'halfAngle', 'dashSpeed', 'weapon', 'power', 'stagger', 'knockback',
]);

export const UNIQUES = [
  /* =========================================================== legendary == */
  {
    id: 'blackspire',
    name: 'Blackspire, Vow of the Nave',
    base: 'greatsword', rarity: 'legendary',
    power: 'Vow of the Nave',
    text: 'SHADOW NOVA erupts a third time, at the outer edge of the first ring.',
    skill: 'skill4',
    mods: { pulses: 1, radius: 1.18, maxTargets: 4 },
    grants: [
      { stat: 'shadowPct', value: 0.28 },
      { stat: 'critDamage', value: 0.55 },
      { stat: 'areaSize', value: 0.16 },
    ],
    flavour: 'Driven through the altar the night the choir drowned. Nobody has moved it since.',
  },
  {
    id: 'kasaka',
    name: "Kasaka's Venom Fang",
    base: 'dagger', rarity: 'legendary',
    power: 'Venom Fang',
    text: 'Umbral Step keeps a third charge and leaves a corrosive wake.',
    skill: 'skill2',
    mods: { charges: 1, cooldown: 0.80, lifesteal: 0.06, iframes: 0.06 },
    grants: [
      { stat: 'critChance', value: 0.062 },
      { stat: 'attackSpeed', value: 0.11 },
      { stat: 'lifeOnKill', value: 34 },
    ],
    flavour: 'Cut from something that was still moving when they cut it.',
  },
  {
    id: 'knightkiller',
    name: 'Knight-Killer',
    base: 'axe', rarity: 'legendary',
    power: 'Executioner',
    text: 'Rending Cleave reaches a full half-circle and hits four more bodies.',
    skill: 'skill1',
    mods: { halfAngle: 1.62, maxTargets: 4, stagger: 1.45, range: 1.2 },
    grants: [
      { stat: 'staggerDamage', value: 0.38 },
      { stat: 'damagePct', value: 0.22 },
      { stat: 'poise', value: 38 },
    ],
    flavour: 'Counted its kills on the haft until it ran out of haft.',
  },
  {
    id: 'graveward',
    name: 'The Ossuary Crown',
    base: 'helm', rarity: 'legendary',
    power: 'Crown of the Ninth',
    text: 'Every cooldown starts at 20% spent, and the Monarch commands one more shadow.',
    skill: null,
    mods: null,
    grants: [
      { stat: 'cooldown', value: 0.11 },
      { stat: 'armyCapacity', value: 2 },
      { stat: 'shadowPower', value: 74 },
    ],
    flavour: 'Nine kings wore it. All nine are still in the ossuary.',
  },
  {
    id: 'drownedchoir',
    name: 'Vestments of the Drowned Choir',
    base: 'chest', rarity: 'legendary',
    power: 'Answering Chorus',
    text: "Aegis of Ash absorbs half again as much and detonates for double.",
    skill: 'skillE',
    mods: { 'ward.fraction': 0.5, 'ward.detonateScale': 1.5, 'ward.detonateRadius': 1.35 },
    grants: [
      { stat: 'hpMax', value: 320 },
      { stat: 'armourPct', value: 0.24 },
      { stat: 'resAll', value: 0.11 },
    ],
    flavour: 'Still damp. It has been four hundred years.',
  },
  {
    id: 'longstride',
    name: 'Sabatons of Stolen Hours',
    base: 'boots', rarity: 'legendary',
    power: 'Stolen Hours',
    text: 'Umbral Step travels half again as far and passes through everything.',
    skill: 'skill2',
    mods: { range: 1.5, overshoot: 0.9, dashSpeed: 1.2, maxTargets: 3 },
    grants: [
      { stat: 'moveSpeed', value: 0.072 },
      { stat: 'cooldown', value: 0.07 },
      { stat: 'critChance', value: 0.038 },
    ],
    flavour: 'The corridor was forty metres long. He was told it took no time at all.',
  },
  {
    id: 'thirdgate',
    name: 'Seal of the Third Gate',
    base: 'ring', rarity: 'legendary',
    power: 'The Gate Opens',
    text: "Sovereign's Command covers the whole room and marks three times over.",
    skill: 'skillQ',
    mods: { radius: 1.45, maxTargets: 8, statusStacks: 2, cooldown: 0.82 },
    grants: [
      { stat: 'extractChance', value: 0.13 },
      { stat: 'shadowPct', value: 0.19 },
      { stat: 'magicFind', value: 0.28 },
    ],
    flavour: 'The third gate is not a door. It is a permission.',
  },
  {
    id: 'hollowvigil',
    name: 'Reliquary of Hollow Vigil',
    base: 'orb', rarity: 'legendary',
    power: 'Hollow Vigil',
    text: 'Shadow Spear pierces every body in the line and staggers each one.',
    skill: 'skill3',
    mods: { pierce: 5, pierceFalloff: 0.12, stagger: 1.3, speed: 1.25 },
    grants: [
      { stat: 'shadowPower', value: 96 },
      { stat: 'manaMax', value: 68 },
      { stat: 'cooldown', value: 0.08 },
    ],
    flavour: 'A saint sealed inside glass, still watching the door.',
  },
  {
    id: 'ashenwrath',
    name: 'Ashen Wrath',
    base: 'staff', rarity: 'legendary',
    power: 'Wrath of Ash',
    text: 'SHADOW NOVA is cast at half cost and reaches a third further.',
    skill: 'skill4',
    mods: { radius: 1.32, cost: -0.5, maxTargets: 5 },
    grants: [
      { stat: 'shadowPower', value: 128 },
      { stat: 'areaSize', value: 0.20 },
      { stat: 'manaRegen', value: 4.0 },
    ],
    flavour: 'What is left of a cantor who tried to sing the dark quiet.',
  },
  {
    id: 'quickdark',
    name: 'Grips of the Quick Dark',
    base: 'gloves', rarity: 'legendary',
    power: 'The Quick Dark',
    text: 'The fourth cleave in the chain always crits.',
    skill: 'skill1',
    mods: { critBonus: 0.34, weapon: 1.15 },
    grants: [
      { stat: 'attackSpeed', value: 0.13 },
      { stat: 'critChance', value: 0.055 },
      { stat: 'critDamage', value: 0.42 },
    ],
    flavour: 'The hands move before the decision does.',
  },

  /* ============================================================== mythic == */
  {
    id: 'monarchsword',
    name: "Demon Monarch's Longsword",
    base: 'sword', rarity: 'mythic',
    power: 'Sovereign Edge',
    text: "MONARCH'S DOMAIN stands twice as long and drags every enemy inside it.",
    skill: 'ultimate',
    mods: { 'domain.duration': 2.0, radius: 1.22, 'domain.enemySlow': 0.25, cooldown: 0.75 },
    grants: [
      { stat: 'damagePct', value: 0.40 },
      { stat: 'shadowPct', value: 0.36 },
      { stat: 'critDamage', value: 0.80 },
      { stat: 'armyCapacity', value: 3 },
    ],
    flavour: 'It was never given. It was inherited, from something that did not die.',
  },
  {
    id: 'shadowcrown',
    name: 'The Shadow Sovereign',
    base: 'amulet', rarity: 'mythic',
    power: 'Arise, All of You',
    text: 'Extraction never fails on a common enemy, and the army may stand five deeper.',
    skill: null,
    mods: null,
    grants: [
      { stat: 'extractChance', value: 0.34 },
      { stat: 'armyCapacity', value: 5 },
      { stat: 'shadowPower', value: 156 },
      { stat: 'cooldown', value: 0.12 },
    ],
    flavour: 'The System does not explain where the soldiers go when he sleeps.',
  },
  {
    id: 'baruka',
    name: "Baruka's Dagger",
    base: 'dagger', rarity: 'mythic',
    power: 'Beast of the Ninth Floor',
    text: 'Umbral Step becomes a four-charge chain and each hit marks twice.',
    skill: 'skill2',
    mods: { charges: 2, cooldown: 0.62, statusStacks: 1, weapon: 1.35, maxTargets: 4 },
    grants: [
      { stat: 'attackSpeed', value: 0.18 },
      { stat: 'critChance', value: 0.085 },
      { stat: 'critDamage', value: 0.72 },
      { stat: 'moveSpeed', value: 0.06 },
    ],
    flavour: 'He gave it up in exchange for a name. It is not clear who got the better deal.',
  },
];

export const UNIQUES_BY_BASE = (() => {
  const m = {};
  for (const u of UNIQUES) (m[u.base] ??= []).push(u);
  return m;
})();

export const UNIQUES_BY_ID = Object.freeze(
  UNIQUES.reduce((m, u) => { m[u.id] = u; return m; }, {})
);

/** Every unique that can roll at this rarity, for a given base (or any base). */
export function uniquesFor(rarity, baseId) {
  const out = [];
  const list = baseId ? (UNIQUES_BY_BASE[baseId] ?? []) : UNIQUES;
  for (const u of list) if (u.rarity === rarity) out.push(u);
  return out;
}

/**
 * Merge one unique's mods into an accumulator keyed by skill id.
 *
 * Dotted keys (`'ward.fraction'`, `'domain.duration'`) are kept dotted: the
 * consumer walks the path itself, which keeps this side flat and allocation
 * free. Multiplicative keys compose by product, additive keys by sum, which is
 * the only composition rule under which two uniques on the same skill cannot
 * produce a number nobody predicted.
 */
export function mergeMods(acc, unique) {
  if (!unique?.skill || !unique.mods) return acc;
  const bag = (acc[unique.skill] ??= {});
  for (const key in unique.mods) {
    const v = unique.mods[key];
    const leaf = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
    if (MULTIPLICATIVE.has(leaf)) bag[key] = (bag[key] ?? 1) * v;
    else bag[key] = (bag[key] ?? 0) + v;
  }
  return acc;
}
