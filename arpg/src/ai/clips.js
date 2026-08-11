/**
 * MONARCH — the enemy animation library, authored in code.
 *
 * There are no animation files, so every clip is a keyframe table written by
 * hand in DEGREES, per bone, in the bone's own bind axes. Because every bone in
 * `rig.js` carries only a translation at bind, "rotate the elbow 40° on X" means
 * exactly that, which is what makes hand-authoring tractable at all.
 *
 * ---------------------------------------------------------------------------
 * THE AXIS CONVENTION, DERIVED ONCE SO NOBODY HAS TO DERIVE IT AGAIN
 *
 * The body faces +Z. A bone's bind axis decides what each rotation does:
 *
 *   spine / neck / head   point +Y   →  +X rotation leans FORWARD, +Z leans left
 *   arm / forearm / hand  point −Y   →  −X rotation swings FORWARD
 *                                       +Z abducts the LEFT arm outward
 *   thigh / shin          point −Y   →  −X swings the leg FORWARD
 *                                       +X on the shin FLEXES the knee
 *   foot                  points +Z  →  +X points the toe DOWN
 *
 * Right-side bones are the mirror of the left, which means `(rx, −ry, −rz)`.
 * `mirror()` does that automatically for symmetric clips; locomotion authors
 * both sides explicitly because the two legs are half a cycle apart, which is
 * not a mirror.
 *
 * ---------------------------------------------------------------------------
 * EVERY CLIP IS NORMALISED TO ONE SECOND
 *
 * Clips are authored with `duration: 1` and played at a speed the archetype
 * decides, so one `attack` table drives a ghoul's 1.0 s swipe and a brute's
 * 2.3 s overhead. The three phases live at fixed fractions so `combat` and the
 * telegraph can be driven off the clip's own phase:
 *
 *   0.00 – 0.55   anticipation   (the wind-up the player reacts to)
 *   0.55 – 0.66   strike         (the damage frame, and the fastest motion)
 *   0.66 – 1.00   recovery       (the window the player is being paid with)
 *
 * `heavy` shifts that to 0.68 / 0.78, which is what makes it read as heavier
 * even before the animation is seen.
 */

export const PHASE = { windup: 0.55, strike: 0.66 };
export const HEAVY_PHASE = { windup: 0.68, strike: 0.78 };

/* ==========================================================================
 * authoring helpers
 * ========================================================================== */

/** Fill in every `*R` track from its `*L` counterpart with the mirror signs. */
function mirror(tracks) {
  for (const name of Object.keys(tracks)) {
    if (!name.endsWith('L')) continue;
    const r = `${name.slice(0, -1)}R`;
    if (tracks[r]) continue;
    tracks[r] = tracks[name].map(([t, x, y, z]) => [t, x, -y, -z]);
  }
  return tracks;
}

/** Shift a looping track in time by `d` cycles, wrapping. Used to put the two
 *  legs half a cycle apart without authoring the second leg. */
function phase(track, d) {
  const out = track.map(([t, x, y, z]) => [(t + d) % 1, x, y, z]);
  out.sort((a, b) => a[0] - b[0]);
  // A looping track must start at 0 and end at 1 or the wrap interpolates
  // through a gap. Duplicate the wrapped ends.
  const first = out[0], last = out[out.length - 1];
  if (first[0] > 0) out.unshift([0, last[1], last[2], last[3]]);
  if (out[out.length - 1][0] < 1) {
    const f = out[0];
    out.push([1, f[1], f[2], f[3]]);
  }
  return out;
}

/** A whole-body additive offset expressed as a single-key track. */
function hold(x, y = 0, z = 0) { return [[0, x, y, z], [1, x, y, z]]; }

/* ==========================================================================
 * BIPED
 * ========================================================================== */

/**
 * Idle. Never a static pose: a slow breath on the chest, a drift on the head,
 * and a barely-perceptible weight shift in the hips. At 120 px the breath is
 * two pixels of movement and it is still the difference between "an enemy" and
 * "a prop".
 */
const bipedIdle = {
  name: 'idle', duration: 1, loop: true, speed: 0.34,
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.5, 0.9, 1.6, 0], [1, 0, 0, 0]],
    spine: [[0, 1.2, 0, 0], [0.5, -1.4, -1.2, 0], [1, 1.2, 0, 0]],
    chest: [[0, -0.8, 0, 0], [0.5, 1.8, 1.0, 0], [1, -0.8, 0, 0]],
    neck: [[0, 1.0, 0, 0], [0.35, -1.5, 3.2, 1.0], [0.75, 0.5, -2.6, -0.8], [1, 1.0, 0, 0]],
    head: [[0, 0, 0, 0], [0.35, 1.2, 4.0, 0], [0.75, -0.6, -3.4, 0], [1, 0, 0, 0]],
    clavL: [[0, 0, 0, 0], [0.5, 0, 0, 1.6], [1, 0, 0, 0]],
    armL: [[0, 4, 0, 5], [0.5, 1, 0, 7.5], [1, 4, 0, 5]],
    forearmL: [[0, -14, 0, 0], [0.5, -18, 0, 2], [1, -14, 0, 0]],
    handL: [[0, -6, 0, 0], [1, -6, 0, 0]],
    thighL: hold(1.5, 0, 1.5),
    shinL: hold(3, 0, 0),
    footL: hold(-2, 0, 0),
  }),
};

/**
 * Walk. Two contacts per cycle, with the hips dropping on each contact and a
 * counter-rotation between shoulders and pelvis. The counter-rotation is the
 * single thing that separates a walk from a march.
 */
const walkL = {
  thigh: [[0, -22, 0, 2], [0.25, 4, 0, 2], [0.5, 24, 0, 2], [0.75, 8, 0, 2], [1, -22, 0, 2]],
  shin: [[0, 6, 0, 0], [0.18, 4, 0, 0], [0.5, 6, 0, 0], [0.68, 46, 0, 0], [0.85, 34, 0, 0], [1, 6, 0, 0]],
  foot: [[0, 10, 0, 0], [0.15, -4, 0, 0], [0.5, 14, 0, 0], [0.72, -8, 0, 0], [1, 10, 0, 0]],
  arm: [[0, 16, 0, 4], [0.5, -18, 0, 6], [1, 16, 0, 4]],
  forearm: [[0, -20, 0, 0], [0.5, -30, 0, 0], [1, -20, 0, 0]],
};

const bipedWalk = {
  name: 'walk', duration: 1, loop: true, speed: 1,
  events: [[0.06, 'foot'], [0.56, 'foot']],
  tracks: {
    pelvis: [[0, 0, -6, 0], [0.25, 1.5, 0, 1.6], [0.5, 0, 6, 0], [0.75, 1.5, 0, -1.6], [1, 0, -6, 0]],
    spine: [[0, 2.5, 3, 0], [0.5, 2.5, -3, 0], [1, 2.5, 3, 0]],
    chest: [[0, 1.5, 5, 0], [0.5, 1.5, -5, 0], [1, 1.5, 5, 0]],
    neck: hold(-1.5),
    head: [[0, 0, -2, 0], [0.5, 0, 2, 0], [1, 0, -2, 0]],
    clavL: [[0, 0, 0, 0], [0.5, 0, 0, 2.2], [1, 0, 0, 0]],
    thighL: walkL.thigh, shinL: walkL.shin, footL: walkL.foot,
    armL: walkL.arm, forearmL: walkL.forearm,
    thighR: phase(walkL.thigh, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    shinR: phase(walkL.shin, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    footR: phase(walkL.foot, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    armR: phase(walkL.arm, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    forearmR: phase(walkL.forearm, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    clavR: [[0, 0, 0, -2.2], [0.5, 0, 0, 0], [1, 0, 0, -2.2]],
    handL: hold(-8), handR: hold(-8),
  },
};

/**
 * Run. Longer stride, a real flight phase (both feet off the ground around 0.22
 * and 0.72), a forward torso lean, and arms driving across the body. The lean is
 * what makes a run read as a run from directly above, where stride length is
 * heavily foreshortened.
 */
const runL = {
  thigh: [[0, -42, 0, 3], [0.22, -10, 0, 3], [0.45, 38, 0, 3], [0.72, 16, 0, 3], [1, -42, 0, 3]],
  shin: [[0, 26, 0, 0], [0.14, 6, 0, 0], [0.45, 12, 0, 0], [0.62, 96, 0, 0], [0.82, 68, 0, 0], [1, 26, 0, 0]],
  foot: [[0, 4, 0, 0], [0.12, -14, 0, 0], [0.45, 22, 0, 0], [0.68, -18, 0, 0], [1, 4, 0, 0]],
  arm: [[0, 40, 0, 10], [0.5, -46, 0, 14], [1, 40, 0, 10]],
  forearm: [[0, -62, 0, 0], [0.28, -78, 0, 0], [0.5, -50, 0, 0], [1, -62, 0, 0]],
};

const bipedRun = {
  name: 'run', duration: 1, loop: true, speed: 1,
  events: [[0.04, 'foot'], [0.54, 'foot']],
  tracks: {
    pelvis: [[0, 3, -10, 0], [0.25, 5, 0, 3], [0.5, 3, 10, 0], [0.75, 5, 0, -3], [1, 3, -10, 0]],
    spine: [[0, 8, 6, 0], [0.5, 8, -6, 0], [1, 8, 6, 0]],
    chest: [[0, 6, 9, 0], [0.5, 6, -9, 0], [1, 6, 9, 0]],
    neck: hold(-6),
    head: [[0, -4, -3, 0], [0.5, -4, 3, 0], [1, -4, -3, 0]],
    clavL: [[0, 0, 0, 2], [0.5, 0, 0, 5], [1, 0, 0, 2]],
    thighL: runL.thigh, shinL: runL.shin, footL: runL.foot,
    armL: runL.arm, forearmL: runL.forearm,
    thighR: phase(runL.thigh, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    shinR: phase(runL.shin, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    footR: phase(runL.foot, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    armR: phase(runL.arm, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    forearmR: phase(runL.forearm, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    clavR: [[0, 0, 0, -5], [0.5, 0, 0, -2], [1, 0, 0, -5]],
    handL: hold(-14), handR: hold(-14),
  },
};

/**
 * The standard attack: a big wound-up right swing.
 *
 * The wind-up is the point. Everything travels BACKWARD and the body coils —
 * shoulders rotate away, the weight loads onto the back foot, the arm cocks past
 * the shoulder line — and it holds there for a beat before the strike. A wind-up
 * that merely raises the arm is not a telegraph, because nothing about the
 * silhouette changed.
 */
const bipedAttack = {
  name: 'attack', duration: 1, loop: false, phase: PHASE,
  events: [[0.05, 'windup'], [PHASE.windup, 'swing'], [PHASE.strike, 'hit']],
  tracks: {
    pelvis: [[0, 0, 0, 0], [0.42, 0, -22, 0], [0.62, 0, 26, 0], [0.78, 0, 12, 0], [1, 0, 0, 0]],
    spine: [[0, 0, 0, 0], [0.42, -6, -26, 4], [0.62, 12, 30, -6], [0.8, 6, 12, -2], [1, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.42, -8, -30, 5], [0.62, 14, 34, -8], [0.8, 6, 14, -3], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.42, 4, 12, 0], [0.62, -4, -14, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.42, 2, 16, 0], [0.62, 6, -10, 0], [1, 0, 0, 0]],
    clavR: [[0, 0, 0, 0], [0.42, 0, -14, -12], [0.62, 0, 18, 10], [1, 0, 0, 0]],
    armR: [[0, 6, 0, -6], [0.30, 46, -20, -34], [0.55, 62, -26, -44],
      [0.66, -74, 16, 20], [0.80, -30, 6, 8], [1, 6, 0, -6]],
    forearmR: [[0, -16, 0, 0], [0.42, -96, 0, 0], [0.55, -108, 0, 0],
      [0.66, -18, 0, 0], [0.82, -46, 0, 0], [1, -16, 0, 0]],
    handR: [[0, -6, 0, 0], [0.55, -22, 0, 0], [0.66, 14, 0, 0], [1, -6, 0, 0]],
    clavL: [[0, 0, 0, 0], [0.42, 0, 14, 6], [0.62, 0, -18, -4], [1, 0, 0, 0]],
    armL: [[0, 6, 0, 6], [0.42, -18, 14, 22], [0.62, 34, -18, 8], [1, 6, 0, 6]],
    forearmL: [[0, -16, 0, 0], [0.42, -52, 0, 0], [0.62, -22, 0, 0], [1, -16, 0, 0]],
    thighL: [[0, 0, 0, 2], [0.42, 14, 0, 2], [0.62, -16, 0, 2], [1, 0, 0, 2]],
    thighR: [[0, 0, 0, -2], [0.42, -14, 0, -2], [0.62, 18, 0, -2], [1, 0, 0, -2]],
    shinL: [[0, 3, 0, 0], [0.42, 16, 0, 0], [0.62, 6, 0, 0], [1, 3, 0, 0]],
    shinR: [[0, 3, 0, 0], [0.42, 22, 0, 0], [0.62, 4, 0, 0], [1, 3, 0, 0]],
  },
};

/**
 * The heavy overhead. Both arms above the head at the top, a full second of
 * hang, then everything comes down through the floor. The hang is what the
 * player dodges into; it is authored as an actual HOLD (two identical keys) so
 * the silhouette is unambiguously static for a beat.
 */
const bipedHeavy = {
  name: 'heavy', duration: 1, loop: false, phase: HEAVY_PHASE,
  events: [[0.05, 'windup'], [HEAVY_PHASE.windup, 'swing'], [HEAVY_PHASE.strike, 'hit'],
    [HEAVY_PHASE.strike + 0.02, 'shake']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.45, -6, 0, 0], [0.68, -10, 0, 0], [0.80, 16, 0, 0], [1, 0, 0, 0]],
    spine: [[0, 0, 0, 0], [0.45, -18, 0, 0], [0.68, -22, 0, 0], [0.80, 34, 0, 0], [0.9, 22, 0, 0], [1, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.45, -20, 0, 0], [0.68, -24, 0, 0], [0.80, 38, 0, 0], [0.9, 24, 0, 0], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.45, 10, 0, 0], [0.68, 12, 0, 0], [0.80, -18, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.45, 14, 0, 0], [0.68, 16, 0, 0], [0.80, -10, 0, 0], [1, 0, 0, 0]],
    clavL: [[0, 0, 0, 0], [0.45, 0, 0, 18], [0.68, 0, 0, 20], [0.80, 0, 0, -6], [1, 0, 0, 0]],
    armL: [[0, 6, 0, 6], [0.30, 120, 0, 26], [0.45, 158, 0, 22], [0.68, 162, 0, 22],
      [0.80, -46, 0, 6], [0.92, -8, 0, 6], [1, 6, 0, 6]],
    forearmL: [[0, -16, 0, 0], [0.45, -34, 0, 0], [0.68, -30, 0, 0],
      [0.80, -6, 0, 0], [1, -16, 0, 0]],
    handL: [[0, -6, 0, 0], [0.68, -20, 0, 0], [0.80, 16, 0, 0], [1, -6, 0, 0]],
    thighL: [[0, 0, 0, 2], [0.45, -12, 0, 6], [0.68, -14, 0, 6], [0.80, 22, 0, 4], [1, 0, 0, 2]],
    shinL: [[0, 3, 0, 0], [0.45, 20, 0, 0], [0.80, 34, 0, 0], [1, 3, 0, 0]],
    footL: [[0, -2, 0, 0], [0.45, -10, 0, 0], [0.80, 8, 0, 0], [1, -2, 0, 0]],
  }),
};

/**
 * Cast / channel. Both arms up and out, the staff crossing the body, the whole
 * figure rising slightly onto the toes. The channel version LOOPS so it can be
 * held for as long as the player takes to interrupt it.
 */
const bipedCast = {
  name: 'cast', duration: 1, loop: false, phase: { windup: 0.60, strike: 0.70 },
  events: [[0.05, 'windup'], [0.60, 'swing'], [0.70, 'hit']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.55, -4, 0, 0], [0.70, 8, 0, 0], [1, 0, 0, 0]],
    spine: [[0, 0, 0, 0], [0.55, -12, 0, 0], [0.70, 16, 0, 0], [1, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.55, -14, 0, 0], [0.70, 20, 0, 0], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.55, 6, 0, 0], [0.70, -8, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.55, 8, 0, 0], [0.70, -12, 0, 0], [1, 0, 0, 0]],
    clavL: [[0, 0, 0, 0], [0.55, 0, 0, 16], [0.70, 0, 0, 4], [1, 0, 0, 0]],
    armL: [[0, 6, 0, 6], [0.40, 84, -16, 40], [0.60, 104, -20, 46],
      [0.72, 36, 4, 18], [1, 6, 0, 6]],
    forearmL: [[0, -16, 0, 0], [0.60, -74, 0, 0], [0.72, -20, 0, 0], [1, -16, 0, 0]],
    handL: [[0, -6, 0, 0], [0.60, -30, 0, 0], [0.72, 22, 0, 0], [1, -6, 0, 0]],
    thighL: [[0, 0, 0, 2], [0.6, -6, 0, 4], [1, 0, 0, 2]],
    shinL: [[0, 3, 0, 0], [0.6, 8, 0, 0], [1, 3, 0, 0]],
  }),
};

const bipedChannel = {
  name: 'channel', duration: 1, loop: true, speed: 0.62,
  tracks: mirror({
    pelvis: [[0, -2, 0, 0], [0.5, 1, 0, 0], [1, -2, 0, 0]],
    spine: [[0, -14, 0, 0], [0.5, -10, 0, 0], [1, -14, 0, 0]],
    chest: [[0, -16, 0, 0], [0.5, -11, 0, 0], [1, -16, 0, 0]],
    neck: [[0, 10, 0, 0], [0.5, 7, 0, 0], [1, 10, 0, 0]],
    head: [[0, 14, 0, 0], [0.5, 10, 0, 0], [1, 14, 0, 0]],
    clavL: [[0, 0, 0, 18], [0.5, 0, 0, 14], [1, 0, 0, 18]],
    armL: [[0, 112, -22, 48], [0.5, 100, -18, 44], [1, 112, -22, 48]],
    forearmL: [[0, -78, 0, 0], [0.5, -66, 0, 0], [1, -78, 0, 0]],
    handL: [[0, -34, 0, 0], [0.5, -26, 0, 0], [1, -34, 0, 0]],
    thighL: hold(-6, 0, 4),
    shinL: hold(9),
  }),
};

/**
 * Block. Shield up and across, weight on the back foot, head tucked behind the
 * rim. Loops, because a block is a STATE the player has to break, not an event.
 */
const bipedBlock = {
  name: 'block', duration: 1, loop: true, speed: 0.5,
  tracks: {
    pelvis: [[0, 0, 12, 0], [0.5, 1, 14, 0], [1, 0, 12, 0]],
    spine: [[0, 6, 16, -3], [0.5, 7, 18, -3], [1, 6, 16, -3]],
    chest: [[0, 5, 18, -4], [0.5, 6, 20, -4], [1, 5, 18, -4]],
    neck: [[0, 6, -10, 0], [1, 6, -10, 0]],
    head: [[0, 4, -14, 0], [1, 4, -14, 0]],
    clavL: [[0, 0, -8, 14], [1, 0, -8, 14]],
    armL: [[0, -58, -26, 30], [0.5, -62, -26, 32], [1, -58, -26, 30]],
    forearmL: [[0, -76, 0, -18], [0.5, -80, 0, -18], [1, -76, 0, -18]],
    handL: [[0, -10, 0, 0], [1, -10, 0, 0]],
    clavR: [[0, 0, 10, -6], [1, 0, 10, -6]],
    armR: [[0, 34, 20, -18], [0.5, 32, 20, -18], [1, 34, 20, -18]],
    forearmR: [[0, -66, 0, 0], [1, -66, 0, 0]],
    handR: [[0, -12, 0, 0], [1, -12, 0, 0]],
    thighL: [[0, -14, 0, 5], [1, -14, 0, 5]],
    thighR: [[0, 18, 0, -6], [1, 18, 0, -6]],
    shinL: [[0, 18, 0, 0], [1, 18, 0, 0]],
    shinR: [[0, 26, 0, 0], [1, 26, 0, 0]],
    footL: [[0, -6, 0, 0], [1, -6, 0, 0]],
    footR: [[0, 8, 0, 0], [1, 8, 0, 0]],
  },
};

/** Stagger. A sharp jolt backward, then a two-step recovery. Short and loud —
 *  the player has to be able to see that their hit landed. */
const bipedStagger = {
  name: 'stagger', duration: 1, loop: false,
  events: [[0.02, 'stagger']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.12, -14, 0, 0], [0.4, 6, 0, 0], [1, 0, 0, 0]],
    spine: [[0, 0, 0, 0], [0.12, -26, 0, 6], [0.4, 10, 0, -2], [1, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.12, -30, 0, 8], [0.4, 12, 0, -3], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.12, -18, 0, 0], [0.4, 10, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.12, -26, 6, 0], [0.4, 14, -4, 0], [1, 0, 0, 0]],
    armL: [[0, 6, 0, 6], [0.12, 30, 0, 34], [0.45, -8, 0, 12], [1, 6, 0, 6]],
    forearmL: [[0, -16, 0, 0], [0.12, -46, 0, 0], [1, -16, 0, 0]],
    thighL: [[0, 0, 0, 2], [0.14, 16, 0, 6], [0.5, -8, 0, 2], [1, 0, 0, 2]],
    shinL: [[0, 3, 0, 0], [0.14, 26, 0, 0], [1, 3, 0, 0]],
  }),
};

/** Death. Only ever played for the first ~0.25 s — `physics` takes the body
 *  over as a ragdoll on the next fixed step — so every frame of it counts. The
 *  knees buckle first, which is what makes a body drop rather than topple. */
const bipedDeath = {
  name: 'death', duration: 1, loop: false,
  events: [[0.02, 'death'], [0.30, 'bodyfall']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.3, -10, 6, 0], [1, -26, 12, 0]],
    spine: [[0, 0, 0, 0], [0.25, 16, -8, 6], [1, 42, -14, 12]],
    chest: [[0, 0, 0, 0], [0.25, 20, -10, 8], [1, 48, -18, 16]],
    neck: [[0, 0, 0, 0], [1, 34, 0, 0]],
    head: [[0, 0, 0, 0], [0.2, -18, 10, 0], [1, 40, 16, 0]],
    armL: [[0, 6, 0, 6], [0.3, 40, 0, 30], [1, 70, 0, 44]],
    forearmL: [[0, -16, 0, 0], [1, -10, 0, 0]],
    thighL: [[0, 0, 0, 2], [0.3, 26, 0, 8], [1, 52, 0, 16]],
    shinL: [[0, 3, 0, 0], [0.3, 48, 0, 0], [1, 88, 0, 0]],
    footL: [[0, -2, 0, 0], [1, 22, 0, 0]],
  }),
};

/**
 * Spawn / rise. The body unfolds from a crouch. Used when the director spawns a
 * pack out of frame and — reversed in intent — as the shadow soldier's rise,
 * where it plays under the materialisation dissolve.
 */
const bipedRise = {
  name: 'rise', duration: 1, loop: false,
  events: [[0.55, 'shake']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.35, 4, 0, 0], [1, 0, 0, 0]],
    spine: [[0, 62, 0, 0], [0.4, 30, 0, 0], [0.75, -10, 0, 0], [1, 0, 0, 0]],
    chest: [[0, 54, 0, 0], [0.4, 26, 0, 0], [0.75, -8, 0, 0], [1, 0, 0, 0]],
    neck: [[0, 24, 0, 0], [0.5, -14, 0, 0], [1, 0, 0, 0]],
    head: [[0, 30, 0, 0], [0.5, -22, 0, 0], [0.8, 4, 0, 0], [1, 0, 0, 0]],
    armL: [[0, 66, 0, 18], [0.45, 20, 0, 26], [0.8, -6, 0, 8], [1, 6, 0, 6]],
    forearmL: [[0, -84, 0, 0], [0.5, -40, 0, 0], [1, -16, 0, 0]],
    thighL: [[0, 74, 0, 12], [0.45, 34, 0, 6], [1, 0, 0, 2]],
    shinL: [[0, 96, 0, 0], [0.45, 44, 0, 0], [1, 3, 0, 0]],
    footL: [[0, 16, 0, 0], [1, -2, 0, 0]],
  }),
};

/** Roar / taunt. Chest opens, head back, arms flung wide. The boss's phase
 *  transition and every pack's alert use it. */
const bipedRoar = {
  name: 'roar', duration: 1, loop: false,
  events: [[0.22, 'roar'], [0.30, 'shake']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.3, -8, 0, 0], [0.7, -6, 0, 0], [1, 0, 0, 0]],
    spine: [[0, 0, 0, 0], [0.25, -26, 0, 0], [0.7, -20, 0, 0], [1, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.25, -30, 0, 0], [0.7, -24, 0, 0], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.25, -30, 0, 0], [0.7, -26, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.25, -36, 0, 0], [0.7, -30, 0, 0], [1, 0, 0, 0]],
    clavL: [[0, 0, 0, 0], [0.28, 0, 0, 26], [0.7, 0, 0, 22], [1, 0, 0, 0]],
    armL: [[0, 6, 0, 6], [0.28, 26, -30, 62], [0.7, 20, -26, 56], [1, 6, 0, 6]],
    forearmL: [[0, -16, 0, 0], [0.28, -66, 0, 0], [1, -16, 0, 0]],
    thighL: [[0, 0, 0, 2], [0.3, 8, 0, 10], [1, 0, 0, 2]],
    shinL: [[0, 3, 0, 0], [0.3, 20, 0, 0], [1, 3, 0, 0]],
  }),
};

/** Charge: a committed forward run with the shoulder dropped. */
const bipedCharge = {
  name: 'charge', duration: 1, loop: true, speed: 1.35,
  events: [[0.05, 'foot'], [0.55, 'foot']],
  tracks: {
    pelvis: [[0, 6, -8, 0], [0.5, 6, 8, 0], [1, 6, -8, 0]],
    spine: [[0, 26, 5, 0], [0.5, 26, -5, 0], [1, 26, 5, 0]],
    chest: [[0, 22, 8, 0], [0.5, 22, -8, 0], [1, 22, 8, 0]],
    neck: hold(-22),
    head: hold(-16),
    armL: [[0, -40, 0, 22], [0.5, -34, 0, 26], [1, -40, 0, 22]],
    armR: [[0, -36, 0, -26], [0.5, -42, 0, -22], [1, -36, 0, -26]],
    forearmL: hold(-92), forearmR: hold(-96),
    thighL: runL.thigh, shinL: runL.shin, footL: runL.foot,
    thighR: phase(runL.thigh, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    shinR: phase(runL.shin, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
    footR: phase(runL.foot, 0.5).map(([t, x, y, z]) => [t, x, -y, -z]),
  },
};

/* ==========================================================================
 * QUADRUPED
 * ========================================================================== */

/** Idle: breathing plus a slow head sweep, and the tail is fully procedural. */
const quadIdle = {
  name: 'idle', duration: 1, loop: true, speed: 0.4,
  tracks: mirror({
    spineA: [[0, 0, 0, 0], [0.5, 1.6, 0, 0], [1, 0, 0, 0]],
    spineB: [[0, -1.2, 0, 0], [0.5, 1.2, 0, 0], [1, -1.2, 0, 0]],
    chest: [[0, 1.0, 0, 0], [0.5, -1.0, 0, 0], [1, 1.0, 0, 0]],
    neck: [[0, 4, 8, 0], [0.4, 2, -10, 0], [0.8, 6, 5, 0], [1, 4, 8, 0]],
    head: [[0, -2, 6, 0], [0.4, 0, -8, 0], [1, -2, 6, 0]],
    fLegAL: [[0, 0, 0, 2], [1, 0, 0, 2]],
    fLegBL: [[0, -6, 0, 0], [1, -6, 0, 0]],
    hLegAL: [[0, 4, 0, 2], [1, 4, 0, 2]],
    hLegBL: [[0, 16, 0, 0], [1, 16, 0, 0]],
  }),
};

/** Prowl. A slow diagonal-pair walk with the shoulders rolling. */
const quadLegWalk = {
  a: [[0, -26, 0, 2], [0.3, 6, 0, 2], [0.55, 26, 0, 2], [0.8, 10, 0, 2], [1, -26, 0, 2]],
  b: [[0, 18, 0, 0], [0.25, 4, 0, 0], [0.55, 12, 0, 0], [0.75, 48, 0, 0], [1, 18, 0, 0]],
  f: [[0, 6, 0, 0], [0.25, -8, 0, 0], [0.7, 14, 0, 0], [1, 6, 0, 0]],
};

const quadWalk = {
  name: 'walk', duration: 1, loop: true, speed: 1,
  events: [[0.05, 'foot'], [0.30, 'foot'], [0.55, 'foot'], [0.80, 'foot']],
  tracks: {
    spineA: [[0, 0, 4, 0], [0.5, 0, -4, 0], [1, 0, 4, 0]],
    spineB: [[0, 0, -3, 0], [0.5, 0, 3, 0], [1, 0, -3, 0]],
    chest: [[0, 2, 5, 0], [0.5, 2, -5, 0], [1, 2, 5, 0]],
    neck: [[0, 2, 3, 0], [0.5, 2, -3, 0], [1, 2, 3, 0]],
    head: [[0, 0, -2, 0], [0.5, 0, 2, 0], [1, 0, -2, 0]],
    fLegAL: quadLegWalk.a, fLegBL: quadLegWalk.b, fFootL: quadLegWalk.f,
    fLegAR: phase(quadLegWalk.a, 0.5), fLegBR: phase(quadLegWalk.b, 0.5),
    fFootR: phase(quadLegWalk.f, 0.5),
    // Diagonal gait: the hind leg on one side moves with the front leg on the
    // other. A same-side pairing is a pace, which reads as a camel.
    hLegAL: phase(quadLegWalk.a, 0.5), hLegBL: phase(quadLegWalk.b, 0.5),
    hFootL: phase(quadLegWalk.f, 0.5),
    hLegAR: quadLegWalk.a, hLegBR: quadLegWalk.b, hFootR: quadLegWalk.f,
  },
};

/**
 * Bound. A galloping two-beat with a real spine flex: the back arches on the
 * gather and extends on the reach. That flex is the entire read of a running
 * quadruped from above, where leg motion is almost invisible.
 */
const quadRun = {
  name: 'run', duration: 1, loop: true, speed: 1,
  events: [[0.02, 'foot'], [0.44, 'foot']],
  tracks: {
    pelvis: [[0, 0, 0, 0], [0.3, -8, 0, 0], [0.65, 10, 0, 0], [1, 0, 0, 0]],
    spineA: [[0, 14, 0, 0], [0.3, -16, 0, 0], [0.65, 20, 0, 0], [1, 14, 0, 0]],
    spineB: [[0, 12, 0, 0], [0.3, -14, 0, 0], [0.65, 18, 0, 0], [1, 12, 0, 0]],
    chest: [[0, -8, 0, 0], [0.3, 12, 0, 0], [0.65, -12, 0, 0], [1, -8, 0, 0]],
    neck: [[0, -14, 0, 0], [0.3, 8, 0, 0], [1, -14, 0, 0]],
    head: [[0, -8, 0, 0], [0.3, 6, 0, 0], [1, -8, 0, 0]],
    fLegAL: [[0, -52, 0, 3], [0.25, 20, 0, 3], [0.55, 44, 0, 3], [1, -52, 0, 3]],
    fLegBL: [[0, 40, 0, 0], [0.2, 8, 0, 0], [0.6, 74, 0, 0], [1, 40, 0, 0]],
    fFootL: [[0, 10, 0, 0], [0.22, -16, 0, 0], [0.7, 20, 0, 0], [1, 10, 0, 0]],
    hLegAL: [[0, 40, 0, 3], [0.35, -44, 0, 3], [0.7, 6, 0, 3], [1, 40, 0, 3]],
    hLegBL: [[0, 62, 0, 0], [0.35, 18, 0, 0], [0.72, 88, 0, 0], [1, 62, 0, 0]],
    hFootL: [[0, -14, 0, 0], [0.4, 12, 0, 0], [1, -14, 0, 0]],
  },
};
// The two sides of a bound are nearly in phase, offset by a tenth of a cycle so
// the landing is a rolling thud rather than a single slap.
for (const k of ['fLegA', 'fLegB', 'fFoot', 'hLegA', 'hLegB', 'hFoot']) {
  quadRun.tracks[`${k}R`] = phase(quadRun.tracks[`${k}L`], 0.10)
    .map(([t, x, y, z]) => [t, x, -y, -z]);
}

/** The bite. Rear back, mouth wide, then everything snaps forward. */
const quadAttack = {
  name: 'attack', duration: 1, loop: false, phase: PHASE,
  events: [[0.05, 'windup'], [PHASE.windup, 'swing'], [PHASE.strike, 'hit']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.45, -12, 0, 0], [0.66, 10, 0, 0], [1, 0, 0, 0]],
    spineA: [[0, 0, 0, 0], [0.45, -22, 0, 0], [0.66, 24, 0, 0], [1, 0, 0, 0]],
    spineB: [[0, 0, 0, 0], [0.45, -18, 0, 0], [0.66, 22, 0, 0], [1, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.45, -14, 0, 0], [0.66, 18, 0, 0], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.45, -34, 0, 0], [0.66, 32, 0, 0], [0.82, 12, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.45, -24, 0, 0], [0.66, 26, 0, 0], [1, 0, 0, 0]],
    fLegAL: [[0, 0, 0, 2], [0.45, -30, 0, 6], [0.66, 22, 0, 2], [1, 0, 0, 2]],
    fLegBL: [[0, -6, 0, 0], [0.45, 40, 0, 0], [0.66, -12, 0, 0], [1, -6, 0, 0]],
    hLegAL: [[0, 4, 0, 2], [0.45, 26, 0, 2], [0.66, -8, 0, 2], [1, 4, 0, 2]],
    hLegBL: [[0, 16, 0, 0], [0.45, 46, 0, 0], [1, 16, 0, 0]],
  }),
};

/** The leap: gather, launch, extend in the air, and land absorbing. Played with
 *  its phases mapped onto the real ballistic flight by `brains.js`. */
const quadLeap = {
  name: 'leap', duration: 1, loop: false, phase: { windup: 0.34, strike: 0.42 },
  events: [[0.05, 'windup'], [0.34, 'leap'], [0.88, 'bodyfall']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.30, -18, 0, 0], [0.45, 14, 0, 0], [0.8, 6, 0, 0], [1, 0, 0, 0]],
    spineA: [[0, 0, 0, 0], [0.30, -34, 0, 0], [0.45, 26, 0, 0], [0.8, -14, 0, 0], [1, 0, 0, 0]],
    spineB: [[0, 0, 0, 0], [0.30, -28, 0, 0], [0.45, 22, 0, 0], [0.8, -12, 0, 0], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.30, 18, 0, 0], [0.45, -26, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.30, 14, 0, 0], [0.45, -20, 0, 0], [1, 0, 0, 0]],
    fLegAL: [[0, 0, 0, 2], [0.30, 44, 0, 4], [0.45, -62, 0, 6], [0.8, 20, 0, 4], [1, 0, 0, 2]],
    fLegBL: [[0, -6, 0, 0], [0.30, 74, 0, 0], [0.45, -20, 0, 0], [0.8, 44, 0, 0], [1, -6, 0, 0]],
    hLegAL: [[0, 4, 0, 2], [0.30, 52, 0, 2], [0.45, -34, 0, 2], [0.8, 42, 0, 2], [1, 4, 0, 2]],
    hLegBL: [[0, 16, 0, 0], [0.30, 86, 0, 0], [0.45, 20, 0, 0], [0.8, 72, 0, 0], [1, 16, 0, 0]],
  }),
};

const quadStagger = {
  name: 'stagger', duration: 1, loop: false,
  events: [[0.02, 'stagger']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [0.14, 10, -8, 0], [1, 0, 0, 0]],
    spineA: [[0, 0, 0, 0], [0.14, -20, -12, 6], [0.5, 6, 4, -2], [1, 0, 0, 0]],
    spineB: [[0, 0, 0, 0], [0.14, -18, -10, 5], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.14, 24, 10, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.14, 20, 14, 0], [1, 0, 0, 0]],
    fLegAL: [[0, 0, 0, 2], [0.16, 24, 0, 8], [1, 0, 0, 2]],
    hLegAL: [[0, 4, 0, 2], [0.16, -18, 0, 6], [1, 4, 0, 2]],
  }),
};

const quadDeath = {
  name: 'death', duration: 1, loop: false,
  events: [[0.02, 'death'], [0.26, 'bodyfall']],
  tracks: mirror({
    pelvis: [[0, 0, 0, 0], [1, -14, 16, 0]],
    spineA: [[0, 0, 0, 0], [0.3, 12, -14, 8], [1, 26, -22, 16]],
    spineB: [[0, 0, 0, 0], [1, 22, -18, 14]],
    neck: [[0, 0, 0, 0], [0.25, -20, 0, 0], [1, 34, 0, 0]],
    head: [[0, 0, 0, 0], [1, 28, 12, 0]],
    fLegAL: [[0, 0, 0, 2], [1, 46, 0, 18]],
    fLegBL: [[0, -6, 0, 0], [1, 62, 0, 0]],
    hLegAL: [[0, 4, 0, 2], [1, 40, 0, 14]],
    hLegBL: [[0, 16, 0, 0], [1, 78, 0, 0]],
  }),
};

const quadRoar = {
  name: 'roar', duration: 1, loop: false,
  events: [[0.2, 'roar']],
  tracks: mirror({
    spineA: [[0, 0, 0, 0], [0.25, -18, 0, 0], [0.7, -14, 0, 0], [1, 0, 0, 0]],
    spineB: [[0, 0, 0, 0], [0.25, -14, 0, 0], [1, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [0.25, -42, 0, 0], [0.7, -36, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.25, -30, 0, 0], [0.7, -26, 0, 0], [1, 0, 0, 0]],
    fLegAL: [[0, 0, 0, 2], [0.25, -12, 0, 8], [1, 0, 0, 2]],
    hLegAL: [[0, 4, 0, 2], [0.25, 18, 0, 6], [1, 4, 0, 2]],
  }),
};

const quadRise = {
  name: 'rise', duration: 1, loop: false,
  tracks: mirror({
    pelvis: [[0, -18, 0, 0], [1, 0, 0, 0]],
    spineA: [[0, 40, 0, 0], [0.5, 12, 0, 0], [1, 0, 0, 0]],
    spineB: [[0, 34, 0, 0], [1, 0, 0, 0]],
    neck: [[0, 30, 0, 0], [0.5, -10, 0, 0], [1, 0, 0, 0]],
    head: [[0, 22, 0, 0], [1, 0, 0, 0]],
    fLegAL: [[0, 62, 0, 8], [0.5, 20, 0, 4], [1, 0, 0, 2]],
    fLegBL: [[0, 84, 0, 0], [1, -6, 0, 0]],
    hLegAL: [[0, 58, 0, 8], [1, 4, 0, 2]],
    hLegBL: [[0, 92, 0, 0], [1, 16, 0, 0]],
  }),
};

/* ==========================================================================
 * export
 * ========================================================================== */

/** Every clip a biped body can play. `heavy`, `block`, `cast` and `channel` are
 *  only used by the archetypes that have those abilities, but they are in the
 *  same table so a shadow soldier raised from a knight keeps the knight's moves. */
export const BIPED_CLIPS = {
  idle: bipedIdle, walk: bipedWalk, run: bipedRun,
  attack: bipedAttack, heavy: bipedHeavy, cast: bipedCast, channel: bipedChannel,
  block: bipedBlock, stagger: bipedStagger, death: bipedDeath,
  rise: bipedRise, roar: bipedRoar, charge: bipedCharge,
};

export const QUAD_CLIPS = {
  idle: quadIdle, walk: quadWalk, run: quadRun,
  attack: quadAttack, heavy: quadAttack, cast: quadRoar, channel: quadIdle,
  block: quadIdle, stagger: quadStagger, death: quadDeath,
  rise: quadRise, roar: quadRoar, charge: quadRun, leap: quadLeap,
};

export function clipsFor(plan) {
  return plan === 'quadruped' ? QUAD_CLIPS : BIPED_CLIPS;
}

/**
 * Compile a clip's tracks against a rig, once, at load.
 *
 * The result is a flat typed-array form the sampler can walk with no string
 * lookups and no per-frame allocation: for each bone that the clip actually
 * addresses, a key count, a time array and an xyz array in RADIANS.
 *
 * A track naming a bone the plan did not build is DROPPED rather than being an
 * error — that is what lets one `attack` table drive a two-armed ghoul and a
 * four-armed boss.
 */
export function compileClip(clip, rig) {
  const D = Math.PI / 180;
  const bones = [];
  const times = [];
  const values = [];
  for (const [name, keys] of Object.entries(clip.tracks)) {
    if (!rig.has(name)) continue;
    const n = keys.length;
    const t = new Float32Array(n);
    const v = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      t[i] = keys[i][0];
      v[i * 3] = keys[i][1] * D;
      v[i * 3 + 1] = keys[i][2] * D;
      v[i * 3 + 2] = keys[i][3] * D;
    }
    bones.push(rig.id(name));
    times.push(t);
    values.push(v);
  }
  return {
    name: clip.name,
    loop: !!clip.loop,
    speed: clip.speed ?? 1,
    phase: clip.phase ?? PHASE,
    events: clip.events ?? null,
    bones: Int32Array.from(bones),
    times, values,
    count: bones.length,
  };
}

/** Compile every clip in a table for one rig. */
export function compileClips(table, rig) {
  const out = {};
  for (const [key, clip] of Object.entries(table)) out[key] = compileClip(clip, rig);
  return out;
}
