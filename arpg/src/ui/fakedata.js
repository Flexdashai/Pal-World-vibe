/**
 * Plausible content for the HUD.
 *
 * TWO JOBS, and it is worth being explicit about both:
 *
 *  1. The screenshot harness drives `ui.debugState(name)` and the contract is
 *     that every state produces a FULLY POPULATED, CONVINCING HUD. An empty
 *     inventory grid or a boss bar reading "Enemy — 100%" is indistinguishable
 *     from a broken HUD to a critic looking at a PNG.
 *
 *  2. Until `loot`, `ai` and `combat` exist, this is what the HUD displays
 *     during ordinary play, so it has to be internally consistent — the item
 *     level on a drop has to match the character level, the affix ranges have
 *     to look like they came from one designer, and the enemy names have to
 *     sound like they came from one world.
 *
 * Everything is generated from a forked `ctx.rng`, never Math.random, so two
 * captures of the same shot show the same inventory.
 */

import { RARITY } from '../core/palette.js';

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

export const ENEMY_NAMES = [
  'Fell Revenant', 'Crypt Stalker', 'Ashbound Thrall', 'Gravebound Knight',
  'Hollow Acolyte', 'Rotting Chanter', 'Bone Harrower', 'Pale Warden',
  'Ossuary Hound', 'Sunken Penitent', 'Gloomfang', 'Wretch of the Nave',
];

export const ELITE_AFFIXES = [
  'Frenzied', 'Soul-Bound', 'Plaguebearer', 'Wraithtouched',
  'Iron-Hided', 'Vampiric', 'Sunder-Marked', 'Chill-Wreathed',
];

export const BOSSES = [
  {
    name: 'Igris, Blood-Red Commander',
    title: 'Monarch of the Sunken Nave',
    phases: ['Vigil', 'Wrath', 'Sovereign'],
  },
  {
    name: 'The Ossuary Warden',
    title: 'Keeper of the Third Gate',
    phases: ['Bound', 'Unbound', 'Hollow'],
  },
];

export const SHADOW_NAMES = [
  'Igris', 'Iron', 'Tank', 'Tusk', 'Beru', 'Greed', 'Kaisel', 'Jima',
];

export const SHADOW_RANKS = ['Soldier', 'Elite', 'Knight', 'Marshal', 'Commander'];

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

const BASE_ITEMS = [
  { type: 'Two-Handed Sword', glyph: 'sword', slot: 'weapon' },
  { type: 'Shadow Dagger', glyph: 'dagger', slot: 'offhand' },
  { type: 'Barbute Helm', glyph: 'helm', slot: 'head' },
  { type: 'Scaled Cuirass', glyph: 'chest', slot: 'chest' },
  { type: 'Greaves', glyph: 'boots', slot: 'feet' },
  { type: 'Gauntlets', glyph: 'gloves', slot: 'hands' },
  { type: 'Signet', glyph: 'ring', slot: 'ring' },
  { type: 'Reliquary Pendant', glyph: 'amulet', slot: 'neck' },
  { type: 'Warplate Pauldron', glyph: 'pauldron', slot: 'shoulder' },
  { type: 'Girdle', glyph: 'belt', slot: 'waist' },
  { type: 'Soulglass Orb', glyph: 'orb', slot: 'offhand' },
  { type: 'Aegis', glyph: 'shield', slot: 'offhand' },
  { type: 'Elixir of Mending', glyph: 'potion', slot: 'consumable' },
  { type: 'Shadow Shard', glyph: 'gem', slot: 'material' },
  { type: 'Sealed Writ', glyph: 'scroll', slot: 'consumable' },
];

const PREFIX = [
  'Grim', 'Sable', 'Hollow', 'Ashen', 'Wretched', 'Bleak', 'Umbral', 'Gilded',
  'Riven', 'Sundered', 'Mourning', 'Cinder', 'Vow-Kept', 'Blackened',
];

const SUFFIX = [
  'of the Monarch', 'of Endless Night', 'of the Third Gate', 'of Hollow Vigil',
  'of the Drowned Choir', 'of Ruin', 'of the Ninth Shadow', 'of Cold Ascent',
  'of the Sunken Crown', 'of Silent Wrath',
];

const UNIQUE_NAMES = [
  'Kasaka\'s Venom Fang', 'Blackspire, Vow of the Nave', 'Baruka\'s Dagger',
  'The Ossuary Crown', 'Knight-Killer', 'Demon Monarch\'s Longsword',
];

const AFFIX_POOL = [
  { t: 'Shadow Damage', lo: 12, hi: 64, suffix: '%' },
  { t: 'Critical Strike Chance', lo: 2.4, hi: 9.8, suffix: '%', dec: 1 },
  { t: 'Critical Strike Damage', lo: 18, hi: 96, suffix: '%' },
  { t: 'Attack Speed', lo: 3, hi: 14, suffix: '%' },
  { t: 'Maximum Life', lo: 60, hi: 620 },
  { t: 'Armour', lo: 40, hi: 480 },
  { t: 'Shadow Resistance', lo: 6, hi: 38, suffix: '%' },
  { t: 'Cooldown Reduction', lo: 2, hi: 11, suffix: '%' },
  { t: 'Damage to Staggered', lo: 10, hi: 52, suffix: '%' },
  { t: 'Life on Kill', lo: 8, hi: 96 },
  { t: 'Shadow Extraction Chance', lo: 3, hi: 17, suffix: '%' },
  { t: 'Movement Speed', lo: 4, hi: 12, suffix: '%' },
];

const FLAVOUR = [
  'It was buried with its owner. Twice.',
  'The Nave remembers every name it swallowed.',
  'Cold to the touch, even in the forge.',
  'Kill count etched along the fuller. It ran out of room.',
  'The System does not explain where these come from.',
];

const RARITY_KEYS = ['common', 'magic', 'rare', 'legendary', 'mythic'];

function rollRarity(rng, luck = 0) {
  const r = rng.float() * (1 - luck * 0.25);
  if (r < 0.34) return 'common';
  if (r < 0.66) return 'magic';
  if (r < 0.88) return 'rare';
  if (r < 0.975) return 'legendary';
  return 'mythic';
}

const AFFIX_COUNT = { common: 0, magic: 2, rare: 4, legendary: 5, mythic: 6 };

export function makeItem(rng, opts = {}) {
  const base = opts.base ?? rng.pick(BASE_ITEMS);
  const rarity = opts.rarity ?? rollRarity(rng, opts.luck ?? 0);
  const ilvl = opts.ilvl ?? rng.int(48, 82);

  let name;
  if (rarity === 'legendary' || rarity === 'mythic') name = rng.pick(UNIQUE_NAMES);
  else if (rarity === 'rare') name = `${rng.pick(PREFIX)} ${base.type} ${rng.pick(SUFFIX)}`;
  else if (rarity === 'magic') name = `${rng.pick(PREFIX)} ${base.type}`;
  else name = base.type;

  const n = AFFIX_COUNT[rarity];
  const affixes = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    let a = rng.pick(AFFIX_POOL);
    let guard = 0;
    while (used.has(a.t) && guard++ < 8) a = rng.pick(AFFIX_POOL);
    used.add(a.t);
    const scale = 0.45 + (ilvl / 82) * 0.55 + rng.float() * 0.25;
    const raw = a.lo + (a.hi - a.lo) * Math.min(1, scale);
    const v = a.dec ? raw.toFixed(a.dec) : String(Math.round(raw));
    affixes.push({ text: a.t, value: `+${v}${a.suffix ?? ''}` });
  }

  const dps = Math.round((110 + ilvl * 26) * (1 + RARITY_KEYS.indexOf(rarity) * 0.16));
  return {
    name, rarity, ilvl,
    type: base.type, glyph: base.glyph, slot: base.slot,
    affixes,
    headline: base.slot === 'weapon' || base.slot === 'offhand'
      ? { label: 'Damage per Second', value: String(dps) }
      : { label: 'Armour', value: String(Math.round(180 + ilvl * 9)) },
    flavour: rarity === 'legendary' || rarity === 'mythic' ? rng.pick(FLAVOUR) : null,
    stack: base.slot === 'consumable' || base.slot === 'material' ? rng.int(2, 19) : 0,
  };
}

/** A believable bag: mostly junk, a few good things, one legendary. */
export function makeInventory(rng, count = 34) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(makeItem(rng, { luck: i === 6 ? 1.2 : i === 21 ? 0.9 : 0 }));
  }
  out[6] = makeItem(rng, { rarity: 'legendary', ilvl: 79 });
  out[21] = makeItem(rng, { rarity: 'mythic', ilvl: 82 });
  return out;
}

/**
 * The equipped set, one per doll slot.
 *
 * Two vertical columns of slots flanking the figure, plus head and feet on the
 * centre line and the two weapon slots at the bottom of each column. Diablo's
 * layout, and it works because the eye reads two clean columns rather than
 * twelve boxes scattered around a shape.
 */
export const DOLL_SLOTS = [
  { key: 'head', label: 'Head', x: 0.50, y: 0.00 },
  { key: 'shoulder', label: 'Shoulders', x: 0.13, y: 0.11 },
  { key: 'neck', label: 'Amulet', x: 0.87, y: 0.11 },
  { key: 'chest', label: 'Chest', x: 0.13, y: 0.26 },
  { key: 'hands', label: 'Gloves', x: 0.87, y: 0.26 },
  { key: 'waist', label: 'Belt', x: 0.13, y: 0.41 },
  { key: 'ring', label: 'Ring', x: 0.87, y: 0.41 },
  { key: 'legs', label: 'Legs', x: 0.13, y: 0.56 },
  { key: 'ring2', label: 'Ring', x: 0.87, y: 0.56 },
  { key: 'feet', label: 'Boots', x: 0.50, y: 0.86 },
  { key: 'weapon', label: 'Weapon', x: 0.13, y: 0.71 },
  { key: 'offhand', label: 'Offhand', x: 0.87, y: 0.71 },
];

export function makeEquipment(rng) {
  const out = {};
  for (const s of DOLL_SLOTS) {
    const base = BASE_ITEMS.find((b) => b.slot === (s.key === 'ring2' ? 'ring' : s.key))
      ?? BASE_ITEMS.find((b) => b.slot === 'chest');
    out[s.key] = makeItem(rng, {
      base, ilvl: rng.int(62, 80),
      rarity: rng.float() < 0.22 ? 'legendary' : rng.float() < 0.55 ? 'rare' : 'magic',
    });
  }
  out.weapon = makeItem(rng, { base: BASE_ITEMS[0], rarity: 'mythic', ilvl: 82 });
  return out;
}

// ---------------------------------------------------------------------------
// character sheet
// ---------------------------------------------------------------------------

export function makeCharacter(level = 14) {
  const str = 46 + level * 3;
  const dex = 31 + level * 2;
  const int = 58 + level * 4;
  const vit = 40 + level * 3;
  return {
    name: 'Sung Jinwoo',
    className: 'Shadow Monarch',
    level,
    core: [
      { k: 'Strength', v: str },
      { k: 'Dexterity', v: dex },
      { k: 'Intelligence', v: int },
      { k: 'Vitality', v: vit },
      { k: 'Perception', v: 22 + level },
    ],
    offence: [
      { k: 'Damage', v: `${(1180 + level * 168).toLocaleString('en-GB')}`, note: 'per hit' },
      { k: 'Attack Speed', v: '1.62', note: '/s' },
      { k: 'Critical Chance', v: '31.4%' },
      { k: 'Critical Damage', v: '+218%' },
      { k: 'Shadow Power', v: `${Math.round(int * 4.2)}` },
      { k: 'Cooldown Reduction', v: '18.5%' },
    ],
    defence: [
      { k: 'Armour', v: `${1240 + level * 96}`, note: `${(28 + level * 0.4).toFixed(1)}% red.` },
      { k: 'Maximum Life', v: `${820 + level * 44}` },
      { k: 'Life Regeneration', v: '24.0', note: '/s' },
      { k: 'Poise', v: `${68 + level * 2}` },
      { k: 'Dodge Chance', v: '11.2%' },
    ],
    resist: [
      { k: 'Shadow', v: 42 }, { k: 'Fire', v: 27 }, { k: 'Frost', v: 31 },
      { k: 'Lightning', v: 19 }, { k: 'Holy', v: 8 },
    ],
  };
}

// ---------------------------------------------------------------------------
// skill tree
// ---------------------------------------------------------------------------

/**
 * Three branches of five ranks. Node positions are normalised 0..1 so the tree
 * canvas can be any size. Allocation state is what makes the panel look played
 * rather than freshly rolled.
 */
export function makeSkillTree() {
  const branches = [
    { name: 'Shadow', element: 'shadow', x: 0.20 },
    { name: 'Monarch', element: 'shadow', x: 0.50 },
    { name: 'Blade', element: 'physical', x: 0.80 },
  ];
  const titles = [
    ['Shadow Step', 'Soul Siphon', 'Rending Dark', 'Shadow Exchange', 'Domain of the Dead'],
    ['Command', 'Legion', 'Sovereign Will', 'Shadow Preservation', "Monarch's Domain"],
    ['Rupture', 'Cleaving Arc', 'Bloodlust', 'Executioner', 'Ruler\'s Authority'],
  ];
  const glyphs = [
    ['dash', 'siphon', 'cleave', 'dash', 'domain'],
    ['crown', 'arise', 'crown', 'ward', 'domain'],
    ['cleave', 'cleave', 'nova', 'lance', 'crown'],
  ];
  const nodes = [];
  const links = [];
  for (let b = 0; b < branches.length; b++) {
    for (let r = 0; r < 5; r++) {
      const i = nodes.length;
      nodes.push({
        id: i,
        branch: b,
        name: titles[b][r],
        glyph: glyphs[b][r],
        element: branches[b].element,
        x: branches[b].x + (r % 2 ? 0.055 : -0.055) * (b === 1 ? 1 : 0.6),
        y: 0.88 - r * 0.185,
        rank: r < 2 ? 5 : r === 2 ? (b === 0 ? 3 : 1) : 0,
        maxRank: 5,
        capstone: r === 4,
      });
      if (r > 0) links.push([i - 1, i]);
    }
  }
  // a couple of cross-branch links so it reads as a tree, not three ladders
  links.push([2, 7], [12, 7]);
  return { branches, nodes, links };
}

// ---------------------------------------------------------------------------
// synthetic dungeon, for the minimap in debug states
// ---------------------------------------------------------------------------

/**
 * Build a small rectangular-rooms-and-corridors layout around the origin and
 * return a sampling function the minimap can rasterise. Deterministic.
 */
export function makeDungeonField(rng) {
  const rooms = [];
  const halls = [];
  // A spine of rooms wandering away from the origin, plus side chambers.
  let cx = 0, cz = 0;
  for (let i = 0; i < 9; i++) {
    const hw = rng.range(5, 11);
    const hh = rng.range(5, 10);
    rooms.push({ x: cx, z: cz, hw, hh, cleared: i < 4 });
    const dir = rng.float();
    const len = rng.range(11, 21);
    const nx = cx + (dir < 0.5 ? (rng.float() < 0.5 ? -len : len) : 0);
    const nz = cz + (dir >= 0.5 ? (rng.float() < 0.5 ? -len : len) : 0);
    halls.push({ x0: cx, z0: cz, x1: nx, z1: nz, w: rng.range(1.6, 2.6) });
    cx = nx; cz = nz;
    if (rng.float() < 0.45) {
      const sx = cx + rng.range(-16, 16);
      const sz = cz + rng.range(-16, 16);
      rooms.push({ x: sx, z: sz, hw: rng.range(3.5, 7), hh: rng.range(3.5, 7), cleared: rng.float() < 0.4 });
      halls.push({ x0: cx, z0: cz, x1: sx, z1: sz, w: rng.range(1.4, 2.2) });
    }
  }

  const field = (x, z) => {
    for (const r of rooms) {
      if (Math.abs(x - r.x) < r.hw && Math.abs(z - r.z) < r.hh) return r.cleared ? 0.55 : 0.34;
    }
    for (const h of halls) {
      const dx = h.x1 - h.x0, dz = h.z1 - h.z0;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - h.x0) * dx + (z - h.z0) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = h.x0 + dx * t, pz = h.z0 + dz * t;
      if ((x - px) ** 2 + (z - pz) ** 2 < h.w * h.w) return 0.40;
    }
    return 0;
  };

  return { rooms, halls, field };
}

/** Blips scattered through the synthetic dungeon, for the debug states. */
export function makeBlips(rng, rooms, count = 14) {
  const out = [];
  const kinds = ['enemy', 'enemy', 'enemy', 'elite', 'loot', 'shadow', 'legendary', 'shrine', 'exit'];
  for (let i = 0; i < count; i++) {
    const r = rng.pick(rooms);
    out.push({
      x: r.x + rng.range(-r.hw * 0.7, r.hw * 0.7),
      z: r.z + rng.range(-r.hh * 0.7, r.hh * 0.7),
      type: kinds[i % kinds.length],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// combat log seeding
// ---------------------------------------------------------------------------

export function seedFeed(feed, rng) {
  feed.push('kill', rng.pick(ENEMY_NAMES), 'slain', rng.int(1800, 5200));
  feed.push('crit', 'Critical', '', rng.int(9000, 24000), RARITY.rare.srgb);
  feed.push('loot', 'Blackspire, Vow of the Nave', '', 0);
  feed.push('shadow', rng.pick(SHADOW_NAMES), 'has arisen', 0);
  feed.push('kill', rng.pick(ENEMY_NAMES), 'slain', rng.int(1800, 5200));
  feed.push('quest', 'Clear the Nave', '3 / 7 chambers', 0);
}

export const RARITY_ORDER = RARITY_KEYS;
