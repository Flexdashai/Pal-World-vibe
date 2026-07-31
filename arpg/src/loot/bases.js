/**
 * MONARCH — item bases.
 *
 * A base is the *object*: what it looks like, what slot it occupies, what it is
 * fundamentally good at, and the implicit modifier it always carries. Rarity and
 * affixes are dressing on top; the base is the identity.
 *
 * ARCHITECTURE.md: "A dropped item is a real procedural mesh with a silhouette
 * specific to its base type — a greatsword is not a scaled long sword." So every
 * base names its own mesh recipe in `meshes.js`, and no two share one.
 *
 * ---------------------------------------------------------------------------
 * THE IMPLICIT
 *
 * Every base carries one guaranteed modifier chosen so the base type has a
 * REASON to exist beyond its damage number:
 *
 *   dagger      crit chance      — the assassin's weapon
 *   greatsword  crit damage      — slow, enormous, all-or-nothing
 *   axe         damage to staggered — the follow-up weapon
 *   bow         attack speed
 *   staff       shadow power     — the caster's weapon, and this hero is one
 *   helm        cooldown reduction
 *   chest       maximum life
 *   gloves      attack speed
 *   boots       movement speed
 *   ring        magic find / crit
 *   amulet      shadow power
 *
 * That table is most of what makes a build: the player who wants cooldowns is
 * looking for helms, not for a specific affix.
 *
 * ---------------------------------------------------------------------------
 * POWER
 *
 * `power` is the base's headline number at item level 1 and `powerPerIlvl` its
 * growth. For weapons it is damage per swing, for armour it is armour points.
 * Both feed the player's real stats through `affixes.js`'s STAT table, so an
 * equipped weapon genuinely raises `stats.damage` and `combat` genuinely deals
 * more damage with it — nothing here is display-only.
 */

/** Slot → the family of affix pools that slot may draw from. */
export const SLOT_FAMILY = {
  weapon: 'weapon',
  offhand: 'offhand',
  head: 'armour',
  shoulder: 'armour',
  chest: 'armour',
  hands: 'armour',
  waist: 'armour',
  legs: 'armour',
  feet: 'armour',
  neck: 'jewel',
  ring: 'jewel',
  ring2: 'jewel',
};

/** Human-readable slot names, for the tooltip's second line. */
export const SLOT_NAME = {
  weapon: 'Weapon', offhand: 'Off-Hand', head: 'Head', shoulder: 'Shoulders',
  chest: 'Chest', hands: 'Hands', waist: 'Waist', legs: 'Legs', feet: 'Feet',
  neck: 'Amulet', ring: 'Ring', ring2: 'Ring',
};

/**
 * The catalogue.
 *
 * `mesh` keys into `meshes.js`. `glyph` keys into `ui`'s item icon table, which
 * has no axe/greatsword/bow/staff paths — those fall back to the closest shape
 * that exists there, because reaching into `src/ui/` to add one is not allowed
 * and a missing glyph would draw a sword for everything anyway.
 */
export const BASES = [
  /* ---------------------------------------------------------------- weapons */
  {
    id: 'sword', type: 'Longsword', slot: 'weapon', glyph: 'sword', mesh: 'sword',
    hands: 1, weight: 1.0, scale: 1.0, surface: 'metal',
    power: 14, powerPerIlvl: 2.9, speed: 1.15,
    implicit: { stat: 'damagePct', lo: 0.04, hi: 0.10 },
    pools: ['offence', 'weapon', 'utility'],
    nouns: ['Longsword', 'Falchion', 'Broadsword', 'Sabre'],
  },
  {
    id: 'greatsword', type: 'Greatsword', slot: 'weapon', glyph: 'sword', mesh: 'greatsword',
    hands: 2, weight: 0.78, scale: 1.22, surface: 'metal',
    power: 26, powerPerIlvl: 5.1, speed: 0.72,
    implicit: { stat: 'critDamage', lo: 0.10, hi: 0.26 },
    pools: ['offence', 'weapon', 'brawn'],
    nouns: ['Greatsword', 'Zweihander', 'Executioner', 'Warblade'],
  },
  {
    id: 'axe', type: 'Battle Axe', slot: 'weapon', glyph: 'sword', mesh: 'axe',
    hands: 1, weight: 0.9, scale: 1.05, surface: 'metal',
    power: 18, powerPerIlvl: 3.6, speed: 0.94,
    implicit: { stat: 'staggerDamage', lo: 0.08, hi: 0.22 },
    pools: ['offence', 'weapon', 'brawn'],
    nouns: ['Battle Axe', 'Cleaver', 'Bardiche', 'Reaver'],
  },
  {
    id: 'dagger', type: 'Dagger', slot: 'weapon', glyph: 'dagger', mesh: 'dagger',
    hands: 1, weight: 0.95, scale: 0.72, surface: 'metal',
    power: 9, powerPerIlvl: 1.9, speed: 1.62,
    implicit: { stat: 'critChance', lo: 0.015, hi: 0.045 },
    pools: ['offence', 'weapon', 'utility'],
    nouns: ['Dagger', 'Stiletto', 'Kris', 'Fang'],
  },
  {
    id: 'bow', type: 'Warbow', slot: 'weapon', glyph: 'dagger', mesh: 'bow',
    hands: 2, weight: 0.62, scale: 1.14, surface: 'wood',
    power: 16, powerPerIlvl: 3.2, speed: 1.05,
    implicit: { stat: 'attackSpeed', lo: 0.04, hi: 0.11 },
    pools: ['offence', 'weapon', 'utility'],
    nouns: ['Warbow', 'Recurve', 'Longbow', 'Hornbow'],
  },
  {
    id: 'staff', type: 'Staff', slot: 'weapon', glyph: 'orb', mesh: 'staff',
    hands: 2, weight: 1.05, scale: 1.30, surface: 'wood',
    power: 12, powerPerIlvl: 2.4, speed: 0.98,
    implicit: { stat: 'shadowPower', lo: 14, hi: 46 },
    pools: ['arcane', 'weapon', 'utility'],
    nouns: ['Staff', 'Crozier', 'Rod', 'Sceptre'],
  },

  /* --------------------------------------------------------------- off-hand */
  {
    id: 'shield', type: 'Kite Shield', slot: 'offhand', glyph: 'shield', mesh: 'shield',
    hands: 1, weight: 0.75, scale: 0.98, surface: 'metal',
    power: 40, powerPerIlvl: 7.4, speed: 1,
    implicit: { stat: 'poise', lo: 8, hi: 26 },
    pools: ['defence', 'brawn', 'utility'],
    nouns: ['Kite Shield', 'Heater', 'Bulwark', 'Aegis'],
  },
  {
    id: 'orb', type: 'Soulglass Orb', slot: 'offhand', glyph: 'orb', mesh: 'orb',
    hands: 1, weight: 0.75, scale: 0.72, surface: 'crystal',
    power: 22, powerPerIlvl: 4.0, speed: 1,
    implicit: { stat: 'manaMax', lo: 12, hi: 44 },
    pools: ['arcane', 'defence', 'utility'],
    nouns: ['Soulglass Orb', 'Reliquary', 'Focus', 'Phylactery'],
  },

  /* ---------------------------------------------------------------- armour */
  {
    id: 'helm', type: 'Barbute Helm', slot: 'head', glyph: 'helm', mesh: 'helm',
    weight: 1.0, scale: 0.80, surface: 'metal',
    power: 30, powerPerIlvl: 5.5,
    implicit: { stat: 'cooldown', lo: 0.02, hi: 0.06 },
    pools: ['defence', 'arcane', 'utility'],
    nouns: ['Barbute', 'Sallet', 'Great Helm', 'Visor'],
  },
  {
    id: 'chest', type: 'Cuirass', slot: 'chest', glyph: 'chest', mesh: 'chest',
    weight: 1.0, scale: 1.05, surface: 'metal',
    power: 62, powerPerIlvl: 11.5,
    implicit: { stat: 'hpMax', lo: 24, hi: 96 },
    pools: ['defence', 'brawn', 'resist'],
    nouns: ['Cuirass', 'Hauberk', 'Brigandine', 'Warplate'],
  },
  {
    id: 'gloves', type: 'Gauntlets', slot: 'hands', glyph: 'gloves', mesh: 'gloves',
    weight: 1.0, scale: 0.66, surface: 'metal',
    power: 24, powerPerIlvl: 4.3,
    implicit: { stat: 'attackSpeed', lo: 0.03, hi: 0.09 },
    pools: ['offence', 'defence', 'utility'],
    nouns: ['Gauntlets', 'Grips', 'Handguards', 'Vambraces'],
  },
  {
    id: 'boots', type: 'Greaves', slot: 'feet', glyph: 'boots', mesh: 'boots',
    weight: 1.0, scale: 0.76, surface: 'metal',
    power: 24, powerPerIlvl: 4.3,
    implicit: { stat: 'moveSpeed', lo: 0.02, hi: 0.055 },
    pools: ['defence', 'utility', 'resist'],
    nouns: ['Greaves', 'Sabatons', 'Treads', 'Warboots'],
  },
  {
    id: 'pauldron', type: 'Pauldrons', slot: 'shoulder', glyph: 'pauldron', mesh: 'pauldron',
    weight: 0.9, scale: 0.82, surface: 'metal',
    power: 28, powerPerIlvl: 5.0,
    implicit: { stat: 'poise', lo: 6, hi: 20 },
    pools: ['defence', 'brawn', 'resist'],
    nouns: ['Pauldrons', 'Spaulders', 'Mantle', 'Shoulderguards'],
  },
  {
    id: 'belt', type: 'Girdle', slot: 'waist', glyph: 'belt', mesh: 'belt',
    weight: 0.9, scale: 0.72, surface: 'cloth',
    power: 18, powerPerIlvl: 3.2,
    implicit: { stat: 'healthRegen', lo: 1.2, hi: 5.4 },
    pools: ['defence', 'utility', 'resist'],
    nouns: ['Girdle', 'Sash', 'Warbelt', 'Cinch'],
  },
  {
    id: 'legs', type: 'Legguards', slot: 'legs', glyph: 'boots', mesh: 'legs',
    weight: 0.9, scale: 0.90, surface: 'metal',
    power: 42, powerPerIlvl: 7.8,
    implicit: { stat: 'hpMax', lo: 16, hi: 62 },
    pools: ['defence', 'brawn', 'resist'],
    nouns: ['Legguards', 'Cuisses', 'Faulds', 'Tassets'],
  },

  /* ---------------------------------------------------------------- jewels */
  {
    id: 'ring', type: 'Signet', slot: 'ring', glyph: 'ring', mesh: 'ring',
    weight: 1.1, scale: 0.40, surface: 'metal',
    power: 0, powerPerIlvl: 0,
    implicit: { stat: 'magicFind', lo: 0.04, hi: 0.16 },
    pools: ['offence', 'arcane', 'utility', 'resist'],
    nouns: ['Signet', 'Band', 'Loop', 'Seal'],
  },
  {
    id: 'amulet', type: 'Pendant', slot: 'neck', glyph: 'amulet', mesh: 'amulet',
    weight: 1.0, scale: 0.55, surface: 'metal',
    power: 0, powerPerIlvl: 0,
    implicit: { stat: 'shadowPower', lo: 10, hi: 38 },
    pools: ['arcane', 'offence', 'utility', 'resist'],
    nouns: ['Pendant', 'Torc', 'Amulet', 'Charm'],
  },
];

export const BASE_BY_ID = Object.freeze(
  BASES.reduce((m, b) => { m[b.id] = b; return m; }, {})
);

/** Everything that can occupy a given doll slot. `ring2` shares `ring`'s pool. */
export const BASES_BY_SLOT = (() => {
  const m = {};
  for (const b of BASES) (m[b.slot] ??= []).push(b);
  m.ring2 = m.ring;
  return m;
})();

/* ==========================================================================
 * NAMING
 * ========================================================================== */

/**
 * Prefixes and suffixes carry MEANING: a prefix is tied to the affix family
 * that dominates the roll and a suffix to the second one. That is why a "Grim
 * Longsword of Ruin" reads like an item and a randomly-concatenated one reads
 * like a placeholder — the player learns after twenty drops that "Umbral"
 * means shadow damage, and the name becomes information.
 */
export const PREFIX_BY_FAMILY = {
  offence: ['Grim', 'Riven', 'Sundering', 'Wretched', 'Bloodlet'],
  arcane: ['Umbral', 'Sable', 'Nightbound', 'Voidtouched', 'Wraithlit'],
  defence: ['Warded', 'Ironbound', 'Bulwark', 'Stonecast', 'Hollowplate'],
  brawn: ['Brutal', 'Gravehewn', 'Titanbone', 'Crushing', 'Ogrekin'],
  utility: ['Swift', 'Whispering', 'Cinder', 'Vow-Kept', 'Quickened'],
  resist: ['Blackened', 'Ashen', 'Quenched', 'Bleak', 'Mournful'],
  weapon: ['Keen', 'Serrated', 'Bloodgroove', 'Hungering', 'Baneful'],
};

export const SUFFIX_BY_FAMILY = {
  offence: ['of Ruin', 'of Silent Wrath', 'of the Ninth Shadow', 'of Slaughter'],
  arcane: ['of the Monarch', 'of Endless Night', 'of the Drowned Choir', 'of Hollow Vigil'],
  defence: ['of the Third Gate', 'of Cold Ascent', 'of the Sunken Crown', 'of the Vigil'],
  brawn: ['of the Ossuary', 'of Broken Kings', 'of the Bone Tithe'],
  utility: ['of the Quick Dark', 'of Stolen Hours', 'of the Wanderer'],
  resist: ['of the Quenched Flame', 'of Ash and Salt', 'of the Long Winter'],
  weapon: ['of the Red Fuller', 'of Ten Thousand Cuts', 'of the Last Breath'],
};

/** Common items get no affixes, so their name is the base and a quality word. */
export const QUALITY_WORDS = ['Worn', 'Chipped', 'Serviceable', 'Plain', 'Battered'];

/* ==========================================================================
 * SMART LOOT
 * ========================================================================== */

/**
 * The player's build, as a weight per affix family. Read from the live
 * `player.stats.primary` at generation time so it tracks levelling, with these
 * as the shape: the Monarch is an intelligence-led caster who fights in melee,
 * so arcane and offence dominate and pure brawn is the tail.
 *
 * Used for TWO things: which BASE drops (a staff should drop more often than a
 * bow for this hero) and which AFFIXES roll on it.
 */
export const BUILD_WEIGHTS = {
  intelligence: { arcane: 2.6, offence: 1.0, utility: 1.2, defence: 0.7, brawn: 0.35, resist: 0.6, weapon: 0.9 },
  strength: { arcane: 0.4, offence: 1.9, utility: 0.7, defence: 1.3, brawn: 2.2, resist: 0.8, weapon: 1.5 },
  agility: { arcane: 0.6, offence: 2.0, utility: 1.9, defence: 0.6, brawn: 0.5, resist: 0.6, weapon: 1.4 },
  vitality: { arcane: 0.5, offence: 0.5, utility: 0.9, defence: 2.3, brawn: 1.3, resist: 1.8, weapon: 0.5 },
};

/** Base-pick bias by build: which weapon a caster is happy to see. */
export const BASE_AFFINITY = {
  intelligence: { staff: 2.4, orb: 2.0, amulet: 1.7, ring: 1.4, dagger: 1.2, helm: 1.2 },
  strength: { greatsword: 2.2, axe: 2.0, chest: 1.6, shield: 1.5, legs: 1.3 },
  agility: { dagger: 2.2, bow: 2.0, sword: 1.6, gloves: 1.5, boots: 1.6 },
  vitality: { chest: 1.9, legs: 1.6, belt: 1.5, shield: 1.4, pauldron: 1.3 },
};
