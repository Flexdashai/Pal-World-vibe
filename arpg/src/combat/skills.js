/**
 * MONARCH — the skill table.
 *
 * Data, not code. Everything about what a skill costs, how long it takes, what
 * shape it hits, how hard, what status it leaves and what it looks and sounds
 * like lives in one literal per skill. `executor.js` runs them; nothing in this
 * file knows about THREE, physics or events.
 *
 * ---------------------------------------------------------------------------
 * SCHEMA
 *
 *   id            must match the slot id `ui` uses ('skill1'..'skill4',
 *                 'skillQ', 'skillE', 'ultimate'). `ui` keys its cooldown sweep
 *                 and its mana deduction off `player:cast`.{skill}, so an id
 *                 that is not in that set silently gets no HUD feedback.
 *   name          display name
 *   element       palette element; drives colour, audio timbre and resistance
 *   cost          mana
 *   cooldown      seconds; 0 means "gated only by the cast time"
 *   charges       0 = single use; >0 = N independent charges, each recharging
 *                 on `cooldown`
 *
 *   TIMING — a skill is windup → strike → recovery, and the three are separate
 *   because they do different jobs. Windup is the anticipation the animation
 *   sells and the window in which the player can still be interrupted. Strike is
 *   the frame damage lands. Recovery is the commitment: the player cannot move
 *   or act, which is what makes a big skill a decision rather than a free action.
 *
 *   windup        seconds before the first damage window opens
 *   pulses        extra damage windows after the first, as offsets in seconds
 *   recovery      seconds of movement/action lockout after the LAST window
 *   channel       true: the skill keeps running (the domain) and recovery only
 *                 starts when it finishes
 *
 *   SHAPE — the hitbox, resolved by `resolve.js` against physics:
 *   shape         'cone' | 'circle' | 'line' | 'projectile' | 'self' | 'dash'
 *   range         metres (cone/line/dash reach, projectile max distance)
 *   radius        metres (circle radius, line/dash half-width, projectile radius)
 *   halfAngle     radians (cone only)
 *   maxTargets    cap; the nearest N are taken. An AoE with no cap is a
 *                 frame-rate cliff the first time a boss room is full.
 *   falloff       0..1 — damage at the edge of the shape relative to the centre
 *
 *   DAMAGE
 *   weapon        multiplier on the source's physical `damage` stat
 *   power         multiplier on the source's `shadowPower` stat
 *   critBonus     added crit chance for this skill
 *   status        status id to apply (null = the element's default, '' = none)
 *   statusStacks  how many stacks per hit
 *   stagger       poise damage
 *   knockback     0..~1.4, scaled by IMPACT.knockbackScale
 *   lifesteal     fraction of damage dealt returned as health
 *
 *   PRESENTATION
 *   anim          which player clip to drive ('attack' uses the combo chain)
 *   vfx           which effect module fires
 *   cue           audio cue name (falls through to audio's element cast cue)
 *   shakeWeight   0 = fast and tight, 1 = slow and heavy
 */

import { ELEMENTS } from '../core/palette.js';

/* ==================================================================== */
/* The primary chain                                                    */
/* ==================================================================== */

/**
 * Four swings, and the fourth is a different move.
 *
 * Windups are matched to `player/clips.js` frame by frame — attack1 fires its
 * `hit` event at 0.19 s, attack2 at 0.17, attack3 at 0.30, attack4 at 0.26 and
 * again at 0.46. Damage that lands on a different frame from the blade reads as
 * a desync even when the player cannot say why, so these are copied, not
 * guessed. If the clips change, these change.
 *
 * The chain accelerates (each swing is cheaper in recovery than the last) and
 * then pays for it: the finisher is a 360° spin with double the recovery, real
 * knockback and a guaranteed stagger. That shape — three fast, one committed —
 * is what makes a basic attack worth pressing repeatedly instead of holding.
 */
export const CLEAVE_CHAIN = [
  {
    label: 'I', windup: 0.19, recovery: 0.14,
    halfAngle: 0.95, range: 3.0, weapon: 1.00, stagger: 14, knockback: 0.30,
    arc: { from: -1.15, to: 0.95, tilt: 0.30, thickness: 1.0 },
  },
  {
    label: 'II', windup: 0.17, recovery: 0.13,
    halfAngle: 0.95, range: 3.0, weapon: 1.05, stagger: 15, knockback: 0.30,
    arc: { from: 1.15, to: -0.95, tilt: -0.22, thickness: 1.0 },
  },
  {
    label: 'III', windup: 0.30, recovery: 0.22,
    halfAngle: 1.15, range: 3.4, weapon: 1.45, stagger: 26, knockback: 0.55,
    arc: { from: -0.35, to: 0.35, tilt: 0.95, thickness: 1.5 },
  },
  {
    // The finisher. A full spin, so the arc is the whole circle and the ribbon
    // is drawn as a closed ring rather than a crescent.
    label: 'FINISH', windup: 0.26, recovery: 0.40, finisher: true,
    pulses: [0.20],
    halfAngle: Math.PI, range: 3.9, weapon: 1.85, stagger: 52, knockback: 1.05,
    critBonus: 0.12,
    arc: { from: -Math.PI, to: Math.PI, tilt: 0.12, thickness: 2.1 },
  },
];

/** How long the chain waits before resetting to swing I. Slightly longer than
 *  the slowest swing's total so a player who pauses to reposition does not lose
 *  their finisher, but short enough that walking across a room does. */
export const CHAIN_WINDOW = 1.15;

/* ==================================================================== */
/* The equipped set                                                     */
/* ==================================================================== */

export const SKILLS = {
  /* ---------------------------------------------------------------- */
  skill1: {
    id: 'skill1', name: 'Rending Cleave', element: 'physical', slot: 0,
    cost: 0, cooldown: 0, charges: 0,
    windup: 0.19, recovery: 0.14, shape: 'cone',
    range: 3.0, halfAngle: 0.95, maxTargets: 6, falloff: 0.78,
    weapon: 1.0, power: 0, critBonus: 0,
    status: 'bleed', statusStacks: 1, statusChance: 0.34,
    stagger: 14, knockback: 0.30, lifesteal: 0,
    anim: 'attack', vfx: 'cleave', cue: 'swing.blade', shakeWeight: 0.15,
    chain: CLEAVE_CHAIN,
    doc: 'Three fast horizontal cleaves into a committed spinning finisher. ' +
         'The finisher hits twice, staggers through most poise and knocks a ' +
         'ring of enemies off the player.',
  },

  /* ---------------------------------------------------------------- */
  skill2: {
    id: 'skill2', name: 'Umbral Step', element: 'shadow', slot: 1,
    cost: 14, cooldown: 6.0, charges: 2,
    // A dash-strike has almost no windup — the whole point is that it is the
    // answer to "they are over there and I am not". 60 ms is one frame of
    // anticipation, enough for the trail to start before the body moves.
    windup: 0.06, recovery: 0.20, shape: 'dash',
    range: 7.5, radius: 1.15, maxTargets: 5, falloff: 0.9,
    weapon: 0.85, power: 0.55, critBonus: 0.10,
    status: 'mark', statusStacks: 1, statusChance: 1.0,
    stagger: 30, knockback: 0.45, lifesteal: 0.06,
    /** Dash-specific: how far past the target the player ends up, and the
     *  i-frame window. Ending BEHIND the target is the whole feel of the move. */
    overshoot: 1.6, iframes: 0.28, dashSpeed: 30.0,
    anim: 'cast', vfx: 'dash', cue: 'player.dash', shakeWeight: 0.35,
    doc: 'Blink forward through everything in a corridor of shadow, cutting ' +
         'each of them on the way past and re-forming behind the last.',
  },

  /* ---------------------------------------------------------------- */
  skill3: {
    id: 'skill3', name: 'Shadow Spear', element: 'shadow', slot: 2,
    cost: 22, cooldown: 9.0, charges: 0,
    windup: 0.28, recovery: 0.24, shape: 'projectile',
    range: 26.0, radius: 0.26, maxTargets: 1, falloff: 1.0,
    weapon: 0.35, power: 1.55, critBonus: 0.05,
    status: 'mark', statusStacks: 2, statusChance: 1.0,
    stagger: 42, knockback: 0.55, lifesteal: 0,
    /** Passes through this many bodies before it stops — a spear that stops at
     *  the first skeleton in a queue of eight is a disappointment. */
    pierce: 3,
    /** Damage retained per body pierced. */
    pierceFalloff: 0.82,
    speed: 34.0,
    anim: 'cast', vfx: 'spear', cue: 'magic.cast.shadow', shakeWeight: 0.25,
    doc: 'A thrown lance of condensed shadow. Pierces a line of enemies, leaves ' +
         "the Monarch's mark in every one, and staggers almost anything.",
  },

  /* ---------------------------------------------------------------- */
  skill4: {
    id: 'skill4', name: 'SHADOW NOVA', element: 'shadow', slot: 3,
    cost: 35, cooldown: 14.0, charges: 0,
    // A long windup, because a nova with no anticipation is just a flash. The
    // gather phase is 0.44 s of violet motes converging on the player, which is
    // also the window in which the enemy AI can react to it.
    windup: 0.44, recovery: 0.34, shape: 'circle',
    range: 0, radius: 6.4, maxTargets: 14, falloff: 0.55,
    weapon: 0.30, power: 2.10, critBonus: 0.08,
    status: 'mark', statusStacks: 1, statusChance: 1.0,
    stagger: 70, knockback: 1.20, lifesteal: 0.04,
    /** A second, weaker ring 0.18 s later — the shockwave rebound. It is what
     *  makes the nova feel like an eruption rather than a sphere. */
    pulses: [0.18],
    pulseScale: 0.42,
    anim: 'cast', vfx: 'nova', cue: 'magic.explosion.shadow', shakeWeight: 0.80,
    doc: 'Violet detonation centred on the Monarch. Everything inside is thrown ' +
         'off its feet, marked, and hit a second time by the rebound.',
  },

  /* ---------------------------------------------------------------- */
  skillQ: {
    id: 'skillQ', name: "Sovereign's Command", element: 'shadow', slot: 4,
    cost: 28, cooldown: 11.0, charges: 0,
    windup: 0.32, recovery: 0.26, shape: 'circle',
    range: 0, radius: 11.0, maxTargets: 16, falloff: 1.0,
    // Almost no direct damage: this is a command, not a spell. Its value is the
    // mark on everything in the room and the order it gives the shadow army.
    weapon: 0, power: 0.35, critBonus: 0,
    status: 'mark', statusStacks: 3, statusChance: 1.0,
    stagger: 12, knockback: 0, lifesteal: 0,
    /** Command payload, consumed by `ai` through the optional hooks in
     *  `index.js`. Never a hard dependency — the skill is complete without it. */
    command: { order: 'focus', buffDuration: 8.0, damageBuff: 0.35, hasteBuff: 0.25 },
    anim: 'cast', vfx: 'command', cue: 'shadow.extract', shakeWeight: 0.4,
    doc: "Marks every enemy in the room and sends the shadow army at the one " +
         'under the cursor, with a violet fury they keep for eight seconds.',
  },

  /* ---------------------------------------------------------------- */
  skillE: {
    id: 'skillE', name: 'Aegis of Ash', element: 'holy', slot: 5,
    cost: 18, cooldown: 18.0, charges: 0,
    windup: 0.22, recovery: 0.18, shape: 'self',
    range: 0, radius: 3.2, maxTargets: 10, falloff: 0.8,
    weapon: 0.4, power: 0.5, critBonus: 0,
    status: '', statusStacks: 0, statusChance: 0,
    stagger: 24, knockback: 0.5, lifesteal: 0,
    /** The ward absorbs this fraction of the caster's max health, and detonates
     *  for a multiple of whatever it absorbed when it breaks or expires. That
     *  coupling is the design: the more you were hit while warded, the bigger
     *  the answer. */
    ward: { fraction: 0.35, duration: 7.0, detonateScale: 1.6, detonateRadius: 4.4 },
    anim: 'cast', vfx: 'ward', cue: 'magic.cast.holy', shakeWeight: 0.3,
    doc: 'A shell of ash that eats damage for seven seconds and then returns ' +
         'everything it ate as a ring of pale fire.',
  },

  /* ---------------------------------------------------------------- */
  ultimate: {
    id: 'ultimate', name: "MONARCH'S DOMAIN", element: 'shadow', slot: 6,
    cost: 0, cooldown: 60.0, charges: 0,
    // Matched to the `ultimate` clip: ultCharge at 0.70, ultRelease at 1.10.
    // The domain erupts on the release frame, not before.
    windup: 1.10, recovery: 0.55, shape: 'circle', channel: true,
    range: 0, radius: 13.5, maxTargets: 24, falloff: 0.72,
    weapon: 0.5, power: 1.35, critBonus: 0.25,
    status: 'mark', statusStacks: 3, statusChance: 1.0,
    stagger: 120, knockback: 1.35, lifesteal: 0.08,
    /** The opening detonation, then a pulse every DOMAIN.pulseInterval for as
     *  long as the domain stands. Pulses are weaker but they never stop, and
     *  every one of them re-marks. */
    pulseScale: 0.46,
    domain: {
      duration: 6.2,
      /** While it stands: every shadow soldier inside gets these, the Monarch
       *  gets damage reduction, and everything else takes the pulses. */
      armyDamage: 0.85, armyHaste: 0.45, selfMitigation: 0.35,
      /** Enemies inside are slowed — the domain is the Monarch's ground. */
      enemySlow: 0.35,
    },
    anim: 'ultimate', vfx: 'domain', cue: 'ultimate.cast', shakeWeight: 1.0,
    doc: 'The Monarch claims the ground. A violet domain covers the screen, ' +
         'every shadow inside it is empowered, everything else is crushed by ' +
         'a pulse every three-quarters of a second.',
  },
};

/** Slot order, for iteration and for the HUD. */
export const SLOT_ORDER = ['skill1', 'skill2', 'skill3', 'skill4', 'skillQ', 'skillE', 'ultimate'];

/** Input action name → skill id. `ui`'s slot ids and `core/input.js`'s action
 *  names happen to be identical for the six equipped slots; the ultimate is not
 *  ('ultimate' is both, by luck), so the map is explicit rather than implied. */
export const SKILL_KEYS = {
  skill1: 'skill1', skill2: 'skill2', skill3: 'skill3', skill4: 'skill4',
  skillQ: 'skillQ', skillE: 'skillE', ultimate: 'ultimate',
};

/**
 * Total committed time of a skill, for the animation speed match and for the
 * "am I busy" test. The channel skills report only their entry, because the
 * domain runs for six seconds during which the player is free to fight.
 */
export function skillDuration(def) {
  const last = def.pulses?.length ? def.pulses[def.pulses.length - 1] : 0;
  return def.windup + last + def.recovery;
}

/** The linear-space colour a skill's effects use. Read from the palette, never
 *  hardcoded — the whole game's identity depends on `shadow` being the only
 *  saturated thing on screen most of the time. */
export function skillColour(def, channel = 'core') {
  return (ELEMENTS[def.element] ?? ELEMENTS.physical)[channel];
}

/**
 * The loadout in the shape `ui`'s `SkillBar` builds its slots from, so the HUD
 * can adopt the real skill set instead of its own plausible fallback the moment
 * someone wires `ui.setSkills`. Exposed through `combat.getLoadout()`.
 *
 * (As of this writing `ui` ships its own DEFAULT_SKILLS; two of the six icons
 * therefore carry the wrong element tint — `skill3` draws frost and `skill4`
 * draws fire where combat casts shadow. The glyphs — lance, nova — are right.)
 */
export function loadout() {
  return SLOT_ORDER.map((id) => {
    const d = SKILLS[id];
    return {
      id: d.id, name: d.name, element: d.element,
      cost: d.cost, cd: d.cooldown, charges: d.charges,
      doc: d.doc,
    };
  });
}
