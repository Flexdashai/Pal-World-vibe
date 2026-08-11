/**
 * MONARCH — the hero's animation library, authored in code.
 *
 * Every clip is a set of per-bone euler curves in DEGREES, sampled with a
 * Catmull-Rom spline and converted to quaternions at sample time.
 *
 * ---------------------------------------------------------------------------
 * WHY EULER CURVES AND NOT QUATERNION KEYS
 *
 * Quaternion keys interpolate correctly but cannot be hand-authored: nobody can
 * read `[0.13, -0.02, 0.71, 0.69]` as "the elbow is bent 80°". Euler degrees are
 * legible, diffable and tunable, and the two failure modes they have are both
 * avoidable here:
 *
 *   - *Gimbal lock* needs the middle axis (Y under XYZ order) at ±90°. No track
 *     in this file takes a Y past 80°, and the one animation that genuinely
 *     spins 360° (`attack4`) does it on the `root` bone, whose X and Z stay at
 *     zero, so the degenerate configuration is never reached.
 *   - *Linear interpolation looking mechanical* is solved by the spline rather
 *     than by adding keys: Catmull-Rom gives C1 continuity and a little natural
 *     overshoot at direction changes, which is exactly the follow-through a
 *     hand-animated pose has.
 *
 * ---------------------------------------------------------------------------
 * SIGN CONVENTIONS (derived once, so no clip has to re-derive them)
 *
 * Bind rotations are identity, so a bone's local axes are the character's:
 * +X right-of-screen-relative-to-model, +Y up, +Z forward (the model faces +Z).
 *
 *   spine / neck / head  (bone points +Y)   +X = lean/nod FORWARD
 *   arm / forearm        (bone points -Y)   -X = swing FORWARD, +Z = raise
 *                                                (left arm out, right arm in)
 *   thigh / shin         (bone points -Y)   -X thigh = leg forward
 *                                           +X shin  = knee bends (heel back)
 *   foot                 (points +Z/-Y)     +X = toe down (plantar flexion)
 *
 * Mirroring across x=0 negates the Y and Z euler channels and keeps X, which is
 * what `mirror()` does. Locomotion cycles additionally phase-shift by half.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS *NOT* IN HERE
 *
 * The coat, collar and hair are never keyframed. They are driven entirely by
 * secondary.js from the body's motion plus a per-state `billow` scalar. Hand
 * keying 23 cloth bones would be a week of work and would still look worse than
 * a spring solver, and — critically — a keyframed coat cannot react to a dash
 * the player performed a frame ago.
 */

/** Convenience: a rotation key. */
const R = (t, x, y, z) => [t, x, y, z];

/**
 * Mirror a track across x = 0: X channel unchanged, Y and Z negated.
 * @param {number[][]} keys
 */
function mirror(keys) {
  return keys.map(([t, x, y, z]) => [t, x, -y, -z]);
}

/**
 * Phase-shift a cyclic track by `by` (fraction of the cycle) and re-sort, so a
 * run cycle's right leg is the left leg half a cycle later. Keys that wrap past
 * 1 come back at the front, and a key is duplicated at t=0 and t=1 so the
 * spline closes.
 */
function phase(keys, by = 0.5) {
  const out = keys.map(([t, x, y, z]) => [(t + by) % 1, x, y, z]);
  out.sort((a, b) => a[0] - b[0]);
  // Close the loop: the value at 1 must equal the value at 0.
  if (out.length && out[0][0] > 1e-6) {
    const last = out[out.length - 1];
    out.unshift([0, last[1], last[2], last[3]]);
  }
  if (out.length && out[out.length - 1][0] < 1 - 1e-6) {
    const first = out[0];
    out.push([1, first[1], first[2], first[3]]);
  }
  return out;
}

/** Scale every key's time from a 0..1 cycle into seconds. */
function scaleTime(keys, dur) {
  return keys.map(([t, x, y, z]) => [t * dur, x, y, z]);
}

/** Mirror + phase-shift, the combination every locomotion limb needs. */
const opp = (keys) => phase(mirror(keys), 0.5);

// ===========================================================================
// IDLE
// ===========================================================================

/**
 * A monarch at rest. Weight on the back foot, chest open, chin fractionally
 * raised, hands loose and clear of the coat.
 *
 * The whole clip is a 4.4 s breath cycle (≈14 breaths/minute) with a slower
 * weight shift under it. Amplitudes are tiny — 1-3° almost everywhere — because
 * at the isometric camera the hero is 89 px tall and a 6° sway reads as a
 * stagger. What must be visible is the *chest*: spine02 and chest carry the
 * breath, and the pauldrons riding on the clavicles amplify it into something
 * legible at that size.
 */
const IDLE = {
  duration: 4.4,
  loop: true,
  tracks: {
    root: { r: [R(0, 0, -1.5, 0), R(2.2, 0, -1.5, 0), R(4.4, 0, -1.5, 0)] },
    pelvis: {
      r: [R(0, -1.0, 1.6, 1.4), R(1.5, -1.6, 2.4, 2.2), R(2.9, -0.8, 0.9, 1.0), R(4.4, -1.0, 1.6, 1.4)],
      p: [[0, 0, 0, 0], [1.5, 0, -0.008, 0], [2.9, 0, -0.003, 0], [4.4, 0, 0, 0]],
    },
    spine01: { r: [R(0, 1.2, -0.8, -0.9), R(1.5, 1.9, -1.3, -1.5), R(2.9, 0.9, -0.4, -0.6), R(4.4, 1.2, -0.8, -0.9)] },
    spine02: { r: [R(0, -2.4, -0.6, -0.5), R(1.1, -3.6, -0.9, -0.8), R(2.4, -1.9, -0.3, -0.3), R(3.4, -3.1, -0.7, -0.6), R(4.4, -2.4, -0.6, -0.5)] },
    chest: { r: [R(0, -3.4, 0.9, 0.4), R(1.1, -4.9, 1.4, 0.7), R(2.4, -2.6, 0.5, 0.2), R(3.4, -4.3, 1.1, 0.6), R(4.4, -3.4, 0.9, 0.4)] },
    neck: { r: [R(0, 2.4, -1.6, 0), R(1.8, 3.2, -3.4, 0), R(3.2, 1.8, 0.8, 0), R(4.4, 2.4, -1.6, 0)] },
    head: { r: [R(0, -3.6, -2.2, 0.4), R(1.8, -4.2, -4.6, 0.8), R(3.2, -3.0, 1.2, 0.1), R(4.4, -3.6, -2.2, 0.4)] },

    clavL: { r: [R(0, -1.0, 0, 3.0), R(1.1, -1.4, 0, 4.6), R(2.4, -0.7, 0, 2.2), R(3.4, -1.2, 0, 4.0), R(4.4, -1.0, 0, 3.0)] },
    armL: { r: [R(0, -3.5, 2.0, 9.5), R(1.6, -5.2, 2.6, 10.8), R(3.0, -2.4, 1.4, 8.6), R(4.4, -3.5, 2.0, 9.5)] },
    forearmL: { r: [R(0, -16, 4, 2.5), R(1.6, -20, 5, 3.2), R(3.0, -13, 3, 2.0), R(4.4, -16, 4, 2.5)] },
    handL: { r: [R(0, -8, 0, 4), R(2.2, -11, 0, 5), R(4.4, -8, 0, 4)] },

    thighL: { r: [R(0, -1.6, -2.0, -1.6), R(1.5, -2.2, -2.6, -2.2), R(2.9, -1.1, -1.5, -1.2), R(4.4, -1.6, -2.0, -1.6)] },
    shinL: { r: [R(0, 3.0, 0, 0), R(1.5, 4.2, 0, 0), R(2.9, 2.2, 0, 0), R(4.4, 3.0, 0, 0)] },
    footL: { r: [R(0, -1.2, 1.5, 0), R(4.4, -1.2, 1.5, 0)] },
    thighR: { r: [R(0, 2.4, 5.5, 2.0), R(1.5, 2.0, 5.0, 1.6), R(2.9, 2.8, 6.0, 2.4), R(4.4, 2.4, 5.5, 2.0)] },
    shinR: { r: [R(0, 6.5, 0, 0), R(1.5, 5.6, 0, 0), R(2.9, 7.2, 0, 0), R(4.4, 6.5, 0, 0)] },
    footR: { r: [R(0, -2.4, -4.0, 0), R(4.4, -2.4, -4.0, 0)] },
  },
  billow: 0.06,
};

// ===========================================================================
// LOCOMOTION
// ===========================================================================

/**
 * Run cycle. Authored in normalised cycle time and scaled at the end, so the
 * clip's duration can be retuned without touching a single key.
 *
 * The structure is a real sprint gait: contact → absorb → drive → toe-off →
 * flight, twice per cycle. Left foot contacts at t=0.
 *
 * The two things that make a procedural run read as heavy rather than as a
 * jog: the pelvis DROPS 5 cm at each absorb (t=0.12, t=0.62) and the spine
 * carries a permanent 13° forward lean. Without the drop it floats; without the
 * lean it looks like the character is being dragged.
 */
const RUN_LEG_L = [
  R(0.00, -36, 0, -2),   // contact, heel strike, leg reaching forward
  R(0.12, -20, 0, -2),   // absorb, hip passing over the foot
  R(0.25, 2, 0, -1),     // mid-stance
  R(0.38, 24, 0, 0),     // drive, hip extended behind
  R(0.50, 30, 0, 0),     // toe-off
  R(0.62, 8, 0, -1),     // knee coming through
  R(0.78, -30, 0, -2),   // swing forward, high knee
  R(0.90, -42, 0, -2),   // reach, the furthest forward the leg goes
  R(1.00, -36, 0, -2),
];
const RUN_SHIN_L = [
  R(0.00, 14, 0, 0),
  R(0.12, 26, 0, 0),
  R(0.25, 12, 0, 0),
  R(0.38, 6, 0, 0),
  R(0.50, 30, 0, 0),
  R(0.62, 92, 0, 0),     // heel tucked hard under the hip during swing
  R(0.78, 74, 0, 0),
  R(0.90, 26, 0, 0),
  R(1.00, 14, 0, 0),
];
const RUN_FOOT_L = [
  R(0.00, -12, 0, 0),
  R(0.12, 4, 0, 0),
  R(0.25, 10, 0, 0),
  R(0.38, 20, 0, 0),
  R(0.50, 26, 0, 0),     // toe pointed at push-off
  R(0.62, -4, 0, 0),
  R(0.78, -14, 0, 0),
  R(0.90, -16, 0, 0),
  R(1.00, -12, 0, 0),
];
const RUN_ARM_L = [
  R(0.00, 34, 2, 7),     // opposite the left leg: back when the left leg is forward
  R(0.12, 26, 2, 7),
  R(0.25, 6, 2, 8),
  R(0.38, -18, 2, 9),
  R(0.50, -34, 2, 9),
  R(0.62, -26, 2, 9),
  R(0.78, 2, 2, 8),
  R(0.90, 24, 2, 7),
  R(1.00, 34, 2, 7),
];
const RUN_FOREARM_L = [
  R(0.00, -62, 6, 3),
  R(0.25, -78, 6, 3),
  R(0.50, -96, 6, 3),    // elbow closes hard at the front of the swing
  R(0.75, -74, 6, 3),
  R(1.00, -62, 6, 3),
];

const RUN = {
  duration: 0.56,
  loop: true,
  cyclic: true,
  events: [
    { t: 0.02, name: 'foot', foot: 'L' },
    { t: 0.52, name: 'foot', foot: 'R' },
  ],
  tracks: {
    pelvis: {
      r: [R(0, 2, -9, 4), R(0.25, 3, 0, 0), R(0.5, 2, 9, -4), R(0.75, 3, 0, 0), R(1, 2, -9, 4)],
      p: [[0, 0, -0.022, 0], [0.12, 0, -0.052, 0], [0.28, 0, 0.006, 0], [0.5, 0, -0.022, 0],
        [0.62, 0, -0.052, 0], [0.78, 0, 0.006, 0], [1, 0, -0.022, 0]],
    },
    spine01: { r: [R(0, 6.5, 3, -1.5), R(0.5, 6.5, -3, 1.5), R(1, 6.5, 3, -1.5)] },
    spine02: { r: [R(0, 4.5, 5, -2), R(0.5, 4.5, -5, 2), R(1, 4.5, 5, -2)] },
    chest: { r: [R(0, 2.5, 7, -2.5), R(0.5, 2.5, -7, 2.5), R(1, 2.5, 7, -2.5)] },
    neck: { r: [R(0, -6, -3, 1), R(0.5, -6, 3, -1), R(1, -6, -3, 1)] },
    head: { r: [R(0, -9, -4, 1.5), R(0.25, -10.5, 0, 0), R(0.5, -9, 4, -1.5), R(0.75, -10.5, 0, 0), R(1, -9, -4, 1.5)] },

    clavL: { r: [R(0, 0, -3, 2), R(0.5, 0, 3, 4), R(1, 0, -3, 2)] },
    clavR: { r: [R(0, 0, -3, -4), R(0.5, 0, 3, -2), R(1, 0, -3, -4)] },
    armL: { r: RUN_ARM_L },
    forearmL: { r: RUN_FOREARM_L },
    handL: { r: [R(0, -12, 0, 6), R(1, -12, 0, 6)] },
    armR: { r: opp(RUN_ARM_L) },
    forearmR: { r: opp(RUN_FOREARM_L) },
    handR: { r: [R(0, -12, 0, -6), R(1, -12, 0, -6)] },

    thighL: { r: RUN_LEG_L },
    shinL: { r: RUN_SHIN_L },
    footL: { r: RUN_FOOT_L },
    thighR: { r: opp(RUN_LEG_L) },
    shinR: { r: opp(RUN_SHIN_L) },
    footR: { r: opp(RUN_FOOT_L) },
  },
  billow: 0.55,
};

/** Walk. Same skeleton of a cycle at a third of the amplitude, no flight phase,
 *  and an upright spine — used below ~2.6 m/s and as the low end of the blend
 *  so a hero creeping toward a corpse does not sprint in place. */
const WALK_LEG_L = [
  R(0.00, -22, 0, -2), R(0.12, -12, 0, -2), R(0.25, -2, 0, -1), R(0.38, 10, 0, 0),
  R(0.50, 16, 0, 0), R(0.62, 4, 0, -1), R(0.78, -14, 0, -2), R(0.90, -24, 0, -2), R(1.00, -22, 0, -2),
];
const WALK_SHIN_L = [
  R(0.00, 5, 0, 0), R(0.12, 12, 0, 0), R(0.25, 6, 0, 0), R(0.38, 3, 0, 0),
  R(0.50, 14, 0, 0), R(0.62, 46, 0, 0), R(0.78, 36, 0, 0), R(0.90, 10, 0, 0), R(1.00, 5, 0, 0),
];
const WALK_ARM_L = [
  R(0.00, 17, 2, 8), R(0.25, 3, 2, 8), R(0.50, -17, 2, 9), R(0.75, 1, 2, 8), R(1.00, 17, 2, 8),
];

const WALK = {
  duration: 0.98,
  loop: true,
  cyclic: true,
  events: [
    { t: 0.03, name: 'foot', foot: 'L' },
    { t: 0.53, name: 'foot', foot: 'R' },
  ],
  tracks: {
    pelvis: {
      r: [R(0, 1, -5, 2.5), R(0.25, 1.5, 0, 0), R(0.5, 1, 5, -2.5), R(0.75, 1.5, 0, 0), R(1, 1, -5, 2.5)],
      p: [[0, 0, -0.010, 0], [0.12, 0, -0.024, 0], [0.28, 0, 0.002, 0], [0.5, 0, -0.010, 0],
        [0.62, 0, -0.024, 0], [0.78, 0, 0.002, 0], [1, 0, -0.010, 0]],
    },
    spine01: { r: [R(0, 2.0, 1.5, -0.8), R(0.5, 2.0, -1.5, 0.8), R(1, 2.0, 1.5, -0.8)] },
    spine02: { r: [R(0, -0.5, 2.5, -1), R(0.5, -0.5, -2.5, 1), R(1, -0.5, 2.5, -1)] },
    chest: { r: [R(0, -2.0, 3.5, -1.2), R(0.5, -2.0, -3.5, 1.2), R(1, -2.0, 3.5, -1.2)] },
    head: { r: [R(0, -3, -2, 0.8), R(0.5, -3, 2, -0.8), R(1, -3, -2, 0.8)] },
    armL: { r: WALK_ARM_L },
    forearmL: { r: [R(0, -26, 4, 2.5), R(0.5, -38, 4, 2.5), R(1, -26, 4, 2.5)] },
    armR: { r: opp(WALK_ARM_L) },
    forearmR: { r: [R(0, -38, -4, -2.5), R(0.5, -26, -4, -2.5), R(1, -38, -4, -2.5)] },
    thighL: { r: WALK_LEG_L },
    shinL: { r: WALK_SHIN_L },
    footL: { r: [R(0, -8, 0, 0), R(0.25, 6, 0, 0), R(0.5, 14, 0, 0), R(0.7, -8, 0, 0), R(1, -8, 0, 0)] },
    thighR: { r: opp(WALK_LEG_L) },
    shinR: { r: opp(WALK_SHIN_L) },
    footR: { r: opp([R(0, -8, 0, 0), R(0.25, 6, 0, 0), R(0.5, 14, 0, 0), R(0.7, -8, 0, 0), R(1, -8, 0, 0)]) },
  },
  billow: 0.20,
};

// ===========================================================================
// DASH
// ===========================================================================

/**
 * Shadow step. A low, shoulder-first lunge, not a roll — a roll puts the hero's
 * head at ground level and the isometric camera loses them behind the nearest
 * prop for the whole i-frame window, which is the exact moment the player most
 * needs to see where they are.
 *
 * Root motion is authored as a distance curve rather than as translation keys on
 * the `root` bone, so movement code owns the collision response and the clip
 * only says how far along the move should be at each instant.
 *
 * THE CURVE IS FRONT-LOADED, and it was not. The first version spent its opening
 * 50 ms — three simulated frames — covering 0.15 m, which is 3 m/s, HALF the
 * hero's running speed. Measured frame by frame, pressing dash while running
 * made the hero briefly slow down. Whatever that reads as, it does not read as a
 * dash; a dodge has to beat running on its very first frame or the player
 * concludes the button is laggy. The opening key now clears 0.24 (0.28 m after
 * scaling, 16 m/s) inside a single step and the peak lands two frames later.
 *
 * The tail past 0.30 is animation only. `locomotion` stops consuming the curve
 * at DASH.moveTime and hands movement control back, so those last twelve frames
 * are a landing the player can steer out of instead of a lockout.
 */
const DASH = {
  duration: 0.50,
  loop: false,
  rootMotion: [[0, 0], [0.017, 0.24], [0.05, 0.95], [0.10, 1.85], [0.17, 2.80],
    [0.24, 3.45], [0.30, 3.78], [0.38, 3.95], [0.5, 4.0]],
  events: [
    { t: 0.03, name: 'dashStart' },
    { t: 0.36, name: 'foot', foot: 'L' },
    { t: 0.44, name: 'foot', foot: 'R' },
  ],
  tracks: {
    root: { p: [[0, 0, 0, 0], [0.10, 0, -0.16, 0], [0.24, 0, -0.10, 0], [0.38, 0, -0.20, 0], [0.5, 0, 0, 0]] },
    pelvis: { r: [R(0, 14, 0, 0), R(0.10, 34, 0, 0), R(0.26, 30, 0, 0), R(0.38, 20, 0, 0), R(0.5, 0, 0, 0)] },
    spine01: { r: [R(0, 10, 4, 0), R(0.10, 22, 8, 0), R(0.26, 18, 6, 0), R(0.5, 1, 0, 0)] },
    spine02: { r: [R(0, 6, 6, 0), R(0.10, 14, 12, 0), R(0.26, 12, 10, 0), R(0.5, -2, 0, 0)] },
    chest: { r: [R(0, 4, 8, 0), R(0.10, 10, 16, 0), R(0.26, 8, 13, 0), R(0.5, -3, 0, 0)] },
    neck: { r: [R(0, -8, -6, 0), R(0.14, -18, -12, 0), R(0.5, 2, 0, 0)] },
    head: { r: [R(0, -10, -6, 0), R(0.14, -20, -10, 0), R(0.5, -3, 0, 0)] },

    clavL: { r: [R(0, 0, 0, 4), R(0.12, -6, -8, 12), R(0.30, -4, -6, 9), R(0.5, -1, 0, 3)] },
    armL: { r: [R(0, -10, 0, 10), R(0.10, 62, 6, 22), R(0.26, 48, 6, 20), R(0.5, -3, 2, 9)] },
    forearmL: { r: [R(0, -20, 0, 0), R(0.10, -52, 0, 0), R(0.30, -36, 0, 0), R(0.5, -16, 4, 2)] },
    clavR: { r: [R(0, 0, 0, -4), R(0.12, 4, 6, -14), R(0.5, -1, 0, -3)] },
    armR: { r: [R(0, -10, 0, -10), R(0.10, -58, 10, -26), R(0.26, -44, 8, -22), R(0.5, -3, -2, -9)] },
    forearmR: { r: [R(0, -20, 0, 0), R(0.10, -78, 0, 0), R(0.30, -50, 0, 0), R(0.5, -16, -4, -2)] },

    thighL: { r: [R(0, -26, 0, 0), R(0.10, 30, 0, 0), R(0.24, 4, 0, 0), R(0.36, -34, 0, 0), R(0.5, -2, 0, 0)] },
    shinL: { r: [R(0, 44, 0, 0), R(0.10, 22, 0, 0), R(0.24, 82, 0, 0), R(0.36, 26, 0, 0), R(0.5, 4, 0, 0)] },
    footL: { r: [R(0, 6, 0, 0), R(0.10, 28, 0, 0), R(0.30, -12, 0, 0), R(0.5, -1, 0, 0)] },
    thighR: { r: [R(0, -14, 0, 0), R(0.10, 46, 0, 0), R(0.24, 40, 0, 0), R(0.38, -12, 0, 0), R(0.5, 2, 0, 0)] },
    shinR: { r: [R(0, 34, 0, 0), R(0.10, 14, 0, 0), R(0.24, 96, 0, 0), R(0.38, 40, 0, 0), R(0.5, 6, 0, 0)] },
    footR: { r: [R(0, 4, 0, 0), R(0.10, 32, 0, 0), R(0.30, -10, 0, 0), R(0.5, -2, 0, 0)] },
  },
  billow: 1.0,
  billowDir: 'back',
};

// ===========================================================================
// ATTACKS
// ===========================================================================

/**
 * Four distinct attacks, deliberately different in SHAPE rather than in speed:
 * a wide horizontal, a returning diagonal, an overhead commit, and a spin. A
 * combo whose members differ only in timing reads as one attack stuttering.
 *
 * Each declares its `hit` event(s); combat is expected to open its damage window
 * there. Anticipation is 30-40% of each clip — the windup is what makes the
 * strike land, and it is the first thing cut when animations are rushed.
 */
const ATTACK1 = {
  duration: 0.50,
  loop: false,
  events: [{ t: 0.10, name: 'swing' }, { t: 0.19, name: 'hit', arc: 'wide' }],
  rootMotion: [[0, 0], [0.14, 0.05], [0.24, 0.55], [0.5, 0.72]],
  tracks: {
    root: { r: [R(0, 0, 22, 0), R(0.12, 0, 40, 0), R(0.22, 0, -30, 0), R(0.34, 0, -38, 0), R(0.5, 0, -6, 0)] },
    pelvis: { r: [R(0, 0, 14, 0), R(0.12, 0, 26, 0), R(0.22, 0, -18, 0), R(0.5, 0, -2, 0)] },
    spine01: { r: [R(0, 3, 10, 0), R(0.12, 6, 20, -3), R(0.22, 8, -14, 4), R(0.5, 1, -2, 0)] },
    spine02: { r: [R(0, 2, 12, 0), R(0.12, 5, 24, -4), R(0.22, 9, -18, 6), R(0.5, -1, -2, 0)] },
    chest: { r: [R(0, 0, 14, 0), R(0.12, 2, 26, -5), R(0.22, 8, -22, 7), R(0.5, -3, -2, 0)] },
    neck: { r: [R(0, 0, -10, 0), R(0.12, 2, -18, 0), R(0.22, 0, 12, 0), R(0.5, 2, 0, 0)] },
    head: { r: [R(0, -4, -12, 0), R(0.12, -2, -22, 0), R(0.22, -6, 16, 0), R(0.5, -4, 2, 0)] },

    clavR: { r: [R(0, 0, 8, -6), R(0.12, -4, 22, -16), R(0.22, -8, -18, -26), R(0.34, -4, -14, -16), R(0.5, -1, 0, -4)] },
    armR: { r: [R(0, -12, 0, -12), R(0.12, 24, 24, -46), R(0.19, -34, -6, -74), R(0.30, -46, -22, -58), R(0.5, -6, -2, -10)] },
    forearmR: { r: [R(0, -24, 0, 0), R(0.12, -76, -14, 0), R(0.19, -22, 0, 0), R(0.30, -44, 8, 0), R(0.5, -18, -4, 0)] },
    handR: { r: [R(0, -8, 0, -6), R(0.19, -20, 0, -18), R(0.5, -8, 0, -6)] },
    clavL: { r: [R(0, 0, -6, 5), R(0.12, 2, -16, 10), R(0.22, 4, 14, 18), R(0.5, -1, 0, 4)] },
    armL: { r: [R(0, -10, 0, 10), R(0.12, -30, -12, 26), R(0.22, 34, 10, 16), R(0.5, -4, 2, 9)] },
    forearmL: { r: [R(0, -20, 0, 0), R(0.12, -54, 0, 0), R(0.22, -30, 0, 0), R(0.5, -16, 4, 2)] },

    thighL: { r: [R(0, -6, -8, 0), R(0.12, -14, -14, 0), R(0.24, -20, 10, 0), R(0.5, -2, 0, 0)] },
    shinL: { r: [R(0, 10, 0, 0), R(0.24, 22, 0, 0), R(0.5, 4, 0, 0)] },
    thighR: { r: [R(0, 4, 10, 0), R(0.12, 12, 18, 0), R(0.24, 16, -12, 0), R(0.5, 3, 0, 0)] },
    shinR: { r: [R(0, 14, 0, 0), R(0.24, 30, 0, 0), R(0.5, 7, 0, 0)] },
  },
  billow: 0.75,
};

const ATTACK2 = {
  duration: 0.46,
  loop: false,
  events: [{ t: 0.09, name: 'swing' }, { t: 0.17, name: 'hit', arc: 'diagonal' }],
  rootMotion: [[0, 0], [0.12, 0.04], [0.22, 0.48], [0.46, 0.62]],
  tracks: {
    root: { r: [R(0, 0, -28, 0), R(0.10, 0, -44, 0), R(0.20, 0, 26, 0), R(0.32, 0, 34, 0), R(0.46, 0, 6, 0)] },
    pelvis: { r: [R(0, 0, -16, 0), R(0.10, 0, -26, 0), R(0.20, 0, 16, 0), R(0.46, 0, 2, 0)] },
    spine01: { r: [R(0, 4, -12, 0), R(0.10, 8, -22, 4), R(0.20, 12, 14, -5), R(0.46, 1, 2, 0)] },
    spine02: { r: [R(0, 3, -14, 0), R(0.10, 7, -26, 5), R(0.20, 14, 18, -6), R(0.46, -1, 2, 0)] },
    chest: { r: [R(0, 1, -16, 0), R(0.10, 4, -28, 6), R(0.20, 12, 22, -8), R(0.46, -3, 2, 0)] },
    head: { r: [R(0, -2, 14, 0), R(0.10, 0, 22, 0), R(0.20, -10, -16, 0), R(0.46, -4, -2, 0)] },

    clavR: { r: [R(0, -4, -14, -10), R(0.10, -10, -24, -22), R(0.20, -2, 20, -6), R(0.46, -1, 0, -4)] },
    armR: { r: [R(0, -20, -14, -30), R(0.10, -74, -26, -52), R(0.17, 26, 12, -22), R(0.28, 44, 20, -12), R(0.46, -6, -2, -10)] },
    forearmR: { r: [R(0, -40, 0, 0), R(0.10, -92, 10, 0), R(0.17, -26, 0, 0), R(0.28, -50, -8, 0), R(0.46, -18, -4, 0)] },
    handR: { r: [R(0, -10, 0, -8), R(0.17, -24, 0, 16), R(0.46, -8, 0, -6)] },
    clavL: { r: [R(0, 2, 12, 8), R(0.10, 6, 20, 14), R(0.20, -2, -16, 6), R(0.46, -1, 0, 4)] },
    armL: { r: [R(0, 16, 8, 22), R(0.10, 40, 14, 30), R(0.20, -34, -12, 14), R(0.46, -4, 2, 9)] },
    forearmL: { r: [R(0, -30, 0, 0), R(0.10, -58, 0, 0), R(0.20, -40, 0, 0), R(0.46, -16, 4, 2)] },

    thighL: { r: [R(0, 4, 12, 0), R(0.10, 12, 20, 0), R(0.22, 14, -14, 0), R(0.46, -2, 0, 0)] },
    shinL: { r: [R(0, 12, 0, 0), R(0.22, 26, 0, 0), R(0.46, 4, 0, 0)] },
    thighR: { r: [R(0, -6, -10, 0), R(0.10, -16, -18, 0), R(0.22, -22, 12, 0), R(0.46, 3, 0, 0)] },
    shinR: { r: [R(0, 10, 0, 0), R(0.22, 24, 0, 0), R(0.46, 7, 0, 0)] },
  },
  billow: 0.75,
};

const ATTACK3 = {
  duration: 0.68,
  loop: false,
  events: [{ t: 0.20, name: 'swing' }, { t: 0.30, name: 'hit', arc: 'overhead' }, { t: 0.32, name: 'shake' }],
  rootMotion: [[0, 0], [0.18, 0.02], [0.30, 0.70], [0.42, 1.05], [0.68, 1.12]],
  tracks: {
    root: { p: [[0, 0, 0, 0], [0.20, 0, 0.055, 0], [0.32, 0, -0.10, 0], [0.44, 0, -0.05, 0], [0.68, 0, 0, 0]] },
    pelvis: { r: [R(0, -6, 6, 0), R(0.20, -16, 12, 0), R(0.32, 22, -6, 0), R(0.46, 16, -4, 0), R(0.68, 0, 0, 0)] },
    spine01: { r: [R(0, -6, 4, 0), R(0.20, -20, 10, 0), R(0.32, 26, -6, 0), R(0.46, 18, -4, 0), R(0.68, 1, 0, 0)] },
    spine02: { r: [R(0, -5, 4, 0), R(0.20, -18, 10, 0), R(0.32, 24, -6, 0), R(0.68, -1, 0, 0)] },
    chest: { r: [R(0, -4, 4, 0), R(0.20, -16, 10, 0), R(0.32, 20, -6, 0), R(0.68, -3, 0, 0)] },
    neck: { r: [R(0, 2, -4, 0), R(0.20, 10, -8, 0), R(0.32, -12, 4, 0), R(0.68, 2, 0, 0)] },
    head: { r: [R(0, -4, -4, 0), R(0.20, 4, -8, 0), R(0.32, -16, 4, 0), R(0.68, -4, 0, 0)] },

    clavR: { r: [R(0, -6, 4, -12), R(0.20, -18, 10, -34), R(0.32, 10, -8, -4), R(0.68, -1, 0, -4)] },
    armR: { r: [R(0, -30, 0, -20), R(0.20, 128, 10, -34), R(0.30, -68, -4, -18), R(0.42, -84, -8, -12), R(0.68, -6, -2, -10)] },
    forearmR: { r: [R(0, -40, 0, 0), R(0.20, -104, 0, 0), R(0.30, -16, 0, 0), R(0.42, -34, 0, 0), R(0.68, -18, -4, 0)] },
    clavL: { r: [R(0, -6, -4, 12), R(0.20, -18, -10, 34), R(0.32, 10, 8, 4), R(0.68, -1, 0, 4)] },
    armL: { r: [R(0, -30, 0, 20), R(0.20, 122, -10, 34), R(0.30, -64, 4, 18), R(0.42, -80, 8, 12), R(0.68, -4, 2, 9)] },
    forearmL: { r: [R(0, -40, 0, 0), R(0.20, -100, 0, 0), R(0.30, -18, 0, 0), R(0.42, -36, 0, 0), R(0.68, -16, 4, 2)] },

    thighL: { r: [R(0, -18, 0, 0), R(0.20, -34, 0, 0), R(0.32, -46, 0, 0), R(0.46, -30, 0, 0), R(0.68, -2, 0, 0)] },
    shinL: { r: [R(0, 24, 0, 0), R(0.20, 48, 0, 0), R(0.32, 40, 0, 0), R(0.68, 4, 0, 0)] },
    footL: { r: [R(0, -4, 0, 0), R(0.32, -18, 0, 0), R(0.68, -1, 0, 0)] },
    thighR: { r: [R(0, 12, 0, 0), R(0.20, 26, 0, 0), R(0.32, 34, 0, 0), R(0.46, 22, 0, 0), R(0.68, 2, 0, 0)] },
    shinR: { r: [R(0, 22, 0, 0), R(0.20, 40, 0, 0), R(0.32, 66, 0, 0), R(0.68, 6, 0, 0)] },
    footR: { r: [R(0, 6, 0, 0), R(0.32, 22, 0, 0), R(0.68, -2, 0, 0)] },
  },
  billow: 0.95,
};

const ATTACK4 = {
  duration: 0.78,
  loop: false,
  events: [
    { t: 0.14, name: 'swing' },
    { t: 0.26, name: 'hit', arc: 'spin' },
    { t: 0.46, name: 'hit', arc: 'spin' },
    { t: 0.28, name: 'shake' },
  ],
  rootMotion: [[0, 0], [0.16, 0.06], [0.34, 0.70], [0.52, 1.15], [0.78, 1.30]],
  tracks: {
    // The full turn lives on `root`, whose X and Z are pinned at 0 — the only
    // safe place in an euler rig to rotate through 360°.
    root: { r: [R(0, 0, -34, 0), R(0.16, 0, -60, 0), R(0.34, 0, 110, 0), R(0.52, 0, 268, 0), R(0.66, 0, 330, 0), R(0.78, 0, 356, 0)] },
    pelvis: { r: [R(0, 2, -10, 0), R(0.16, 4, -14, 0), R(0.44, 6, 10, 0), R(0.78, 0, 4, 0)] },
    spine01: { r: [R(0, 4, -8, 3), R(0.20, 8, -12, 8), R(0.44, 10, 10, -8), R(0.78, 1, 2, 0)] },
    spine02: { r: [R(0, 3, -10, 4), R(0.20, 7, -14, 10), R(0.44, 11, 12, -10), R(0.78, -1, 2, 0)] },
    chest: { r: [R(0, 1, -12, 4), R(0.20, 5, -16, 10), R(0.44, 10, 14, -10), R(0.78, -3, 2, 0)] },
    head: { r: [R(0, -4, 16, 0), R(0.16, -2, 34, 0), R(0.34, -6, -18, 0), R(0.60, -6, 12, 0), R(0.78, -4, 0, 0)] },

    clavR: { r: [R(0, -4, -8, -14), R(0.20, -10, -14, -30), R(0.46, -6, 10, -22), R(0.78, -1, 0, -4)] },
    armR: { r: [R(0, -16, -10, -34), R(0.18, -26, -16, -82), R(0.34, -10, 6, -92), R(0.56, -14, 10, -78), R(0.78, -6, -2, -10)] },
    forearmR: { r: [R(0, -34, 0, 0), R(0.18, -30, 0, 0), R(0.40, -14, 0, 0), R(0.78, -18, -4, 0)] },
    clavL: { r: [R(0, 2, 8, 12), R(0.20, 6, 14, 26), R(0.46, 4, -10, 20), R(0.78, -1, 0, 4)] },
    armL: { r: [R(0, -14, 8, 30), R(0.18, -22, 14, 76), R(0.34, -8, -6, 86), R(0.56, -12, -8, 72), R(0.78, -4, 2, 9)] },
    forearmL: { r: [R(0, -32, 0, 0), R(0.18, -28, 0, 0), R(0.40, -12, 0, 0), R(0.78, -16, 4, 2)] },

    thighL: { r: [R(0, -14, 0, 0), R(0.20, -26, 0, 0), R(0.44, -8, 0, 0), R(0.78, -2, 0, 0)] },
    shinL: { r: [R(0, 20, 0, 0), R(0.20, 54, 0, 0), R(0.44, 18, 0, 0), R(0.78, 4, 0, 0)] },
    thighR: { r: [R(0, 8, 0, 0), R(0.20, 18, 0, 0), R(0.44, -14, 0, 0), R(0.78, 2, 0, 0)] },
    shinR: { r: [R(0, 16, 0, 0), R(0.20, 30, 0, 0), R(0.44, 46, 0, 0), R(0.78, 6, 0, 0)] },
  },
  billow: 1.0,
};

// ===========================================================================
// CAST / ARISE / ULTIMATE
// ===========================================================================

/**
 * Cast. Hands gather at the sternum, then thrust forward, palms out. The pose
 * held for `debugPose('cast')` is at t = 0.62 s: arms extended, chest open, coat
 * blown back — the frame that says "the power came from him".
 */
const CAST = {
  duration: 0.94,
  loop: false,
  events: [{ t: 0.34, name: 'castGather' }, { t: 0.50, name: 'castRelease' }],
  tracks: {
    root: { p: [[0, 0, 0, 0], [0.34, 0, -0.035, 0], [0.56, 0, 0.020, 0], [0.94, 0, 0, 0]] },
    pelvis: { r: [R(0, 2, 0, 0), R(0.34, 12, 0, 0), R(0.56, -10, 0, 0), R(0.94, 0, 0, 0)] },
    spine01: { r: [R(0, 2, 0, 0), R(0.34, 14, 0, 0), R(0.56, -14, 0, 0), R(0.94, 1, 0, 0)] },
    spine02: { r: [R(0, 0, 0, 0), R(0.34, 12, 0, 0), R(0.56, -13, 0, 0), R(0.94, -1, 0, 0)] },
    chest: { r: [R(0, -3, 0, 0), R(0.34, 10, 0, 0), R(0.56, -14, 0, 0), R(0.94, -3, 0, 0)] },
    neck: { r: [R(0, 2, 0, 0), R(0.34, 6, 0, 0), R(0.56, 4, 0, 0), R(0.94, 2, 0, 0)] },
    head: { r: [R(0, -4, 0, 0), R(0.34, 2, 0, 0), R(0.56, -8, 0, 0), R(0.94, -4, 0, 0)] },

    clavL: { r: [R(0, -1, 0, 4), R(0.34, -6, -10, 12), R(0.56, -10, -20, 18), R(0.94, -1, 0, 4)] },
    armL: { r: [R(0, -4, 2, 9), R(0.34, -46, -22, 34), R(0.56, -84, -18, 22), R(0.70, -78, -16, 20), R(0.94, -4, 2, 9)] },
    forearmL: { r: [R(0, -16, 4, 2), R(0.34, -96, -10, 0), R(0.56, -18, -6, 0), R(0.94, -16, 4, 2)] },
    handL: { r: [R(0, -8, 0, 4), R(0.34, -30, 0, 10), R(0.56, 24, 0, 6), R(0.94, -8, 0, 4)] },
    clavR: { r: [R(0, -1, 0, -4), R(0.34, -6, 10, -12), R(0.56, -10, 20, -18), R(0.94, -1, 0, -4)] },
    armR: { r: [R(0, -4, -2, -9), R(0.34, -46, 22, -34), R(0.56, -84, 18, -22), R(0.70, -78, 16, -20), R(0.94, -4, -2, -9)] },
    forearmR: { r: [R(0, -16, -4, -2), R(0.34, -96, 10, 0), R(0.56, -18, 6, 0), R(0.94, -16, -4, -2)] },
    handR: { r: [R(0, -8, 0, -4), R(0.34, -30, 0, -10), R(0.56, 24, 0, -6), R(0.94, -8, 0, -4)] },

    thighL: { r: [R(0, -2, 0, 0), R(0.34, -22, 0, 0), R(0.56, -6, 0, 0), R(0.94, -2, 0, 0)] },
    shinL: { r: [R(0, 3, 0, 0), R(0.34, 34, 0, 0), R(0.94, 3, 0, 0)] },
    thighR: { r: [R(0, 3, 6, 0), R(0.34, 14, 8, 0), R(0.56, 22, 8, 0), R(0.94, 3, 6, 0)] },
    shinR: { r: [R(0, 7, 0, 0), R(0.34, 28, 0, 0), R(0.56, 34, 0, 0), R(0.94, 7, 0, 0)] },
  },
  billow: 1.0,
};

/**
 * ARISE. The signature beat.
 *
 * Right arm punched straight up, palm open; left arm swept low and out; chest
 * open, head back, weight on the front foot. It is a HOLD, not a gesture — the
 * clip reaches the pose at 1.05 s and stays there until released, because the
 * shot the critics review is a still and because the extraction VFX plays for
 * over a second underneath it.
 */
const ARISE = {
  duration: 2.6,
  loop: false,
  hold: true,
  events: [{ t: 0.62, name: 'ariseCharge' }, { t: 1.02, name: 'ariseRelease' }, { t: 1.05, name: 'shake' }],
  tracks: {
    root: { p: [[0, 0, 0, 0], [0.55, 0, -0.075, 0], [1.05, 0, 0.045, 0], [1.5, 0, 0.030, 0], [2.6, 0, 0.030, 0]] },
    pelvis: { r: [R(0, 4, 0, 0), R(0.55, 18, -6, 0), R(1.05, -10, 4, 0), R(1.5, -8, 4, 0), R(2.6, -8, 4, 0)] },
    spine01: { r: [R(0, 3, 0, 0), R(0.55, 20, -8, 0), R(1.05, -14, 5, 0), R(1.5, -12, 5, 0), R(2.6, -12, 5, 0)] },
    spine02: { r: [R(0, 0, 0, 0), R(0.55, 18, -8, 0), R(1.05, -16, 5, 0), R(1.5, -14, 5, 0), R(2.6, -14, 5, 0)] },
    chest: { r: [R(0, -3, 0, 0), R(0.55, 16, -8, 0), R(1.05, -18, 6, 0), R(1.5, -16, 6, 0), R(2.6, -16, 6, 0)] },
    neck: { r: [R(0, 2, 0, 0), R(0.55, 12, 4, 0), R(1.05, -10, -3, 0), R(2.6, -9, -3, 0)] },
    head: { r: [R(0, -4, 0, 0), R(0.55, 6, 6, 0), R(1.05, -22, -4, 2), R(1.5, -20, -4, 2), R(2.6, -20, -4, 2)] },

    // Right arm: down and coiled, then punched vertical. 156° of Z on the
    // shoulder — the arm ends up straight above the head, which is the pose.
    clavR: { r: [R(0, -1, 0, -4), R(0.55, 6, 10, -6), R(1.05, -16, -6, -34), R(2.6, -15, -6, -33)] },
    armR: { r: [R(0, -4, -2, -9), R(0.55, 34, 16, -22), R(1.02, -14, -10, -156), R(1.28, -8, -8, -168), R(1.6, -10, -9, -163), R(2.6, -10, -9, -163)] },
    forearmR: { r: [R(0, -16, -4, -2), R(0.55, -84, -14, 0), R(1.02, -14, 0, 0), R(1.3, -4, 0, 0), R(2.6, -5, 0, 0)] },
    handR: { r: [R(0, -8, 0, -4), R(0.55, -26, 0, -10), R(1.05, 16, 0, -6), R(2.6, 14, 0, -6)] },

    // Left arm swept low and back, palm turned out. Asymmetry is what stops the
    // pose reading as a cheer.
    clavL: { r: [R(0, -1, 0, 4), R(0.55, 4, -8, 8), R(1.05, 6, 14, 16), R(2.6, 6, 14, 16)] },
    armL: { r: [R(0, -4, 2, 9), R(0.55, 26, -14, 20), R(1.05, 44, 26, 46), R(1.5, 40, 24, 44), R(2.6, 40, 24, 44)] },
    forearmL: { r: [R(0, -16, 4, 2), R(0.55, -70, 10, 0), R(1.05, -26, 14, 0), R(2.6, -24, 14, 0)] },
    handL: { r: [R(0, -8, 0, 4), R(1.05, -18, 0, 22), R(2.6, -18, 0, 22)] },

    thighL: { r: [R(0, -2, 0, 0), R(0.55, -28, 0, 0), R(1.05, -18, -4, 0), R(2.6, -17, -4, 0)] },
    shinL: { r: [R(0, 3, 0, 0), R(0.55, 40, 0, 0), R(1.05, 12, 0, 0), R(2.6, 12, 0, 0)] },
    footL: { r: [R(0, -1, 0, 0), R(1.05, -8, 0, 0), R(2.6, -8, 0, 0)] },
    thighR: { r: [R(0, 3, 6, 0), R(0.55, 20, 8, 0), R(1.05, 22, 12, 0), R(2.6, 22, 12, 0)] },
    shinR: { r: [R(0, 7, 0, 0), R(0.55, 34, 0, 0), R(1.05, 26, 0, 0), R(2.6, 26, 0, 0)] },
    footR: { r: [R(0, -2, 0, 0), R(1.05, 14, 0, 0), R(2.6, 14, 0, 0)] },
  },
  billow: 1.35,
  billowDir: 'up',
};

/**
 * The Monarch's ultimate. Arms spread wide, head thrown back, spine arched: the
 * "shadows, obey" silhouette. The hold at 1.15 s is what `debugPose('ultimate')`
 * freezes, and the camera pushes in over the same window.
 */
const ULTIMATE = {
  duration: 3.2,
  loop: false,
  hold: true,
  events: [{ t: 0.70, name: 'ultCharge' }, { t: 1.10, name: 'ultRelease' }, { t: 1.12, name: 'shake' }],
  tracks: {
    root: { p: [[0, 0, 0, 0], [0.66, 0, -0.095, 0], [1.12, 0, 0.075, 0], [1.6, 0, 0.055, 0], [3.2, 0, 0.055, 0]] },
    pelvis: { r: [R(0, 4, 0, 0), R(0.66, 22, 0, 0), R(1.12, -16, 0, 0), R(1.6, -14, 0, 0), R(3.2, -14, 0, 0)] },
    spine01: { r: [R(0, 3, 0, 0), R(0.66, 24, 0, 0), R(1.12, -22, 0, 0), R(1.6, -19, 0, 0), R(3.2, -19, 0, 0)] },
    spine02: { r: [R(0, 0, 0, 0), R(0.66, 22, 0, 0), R(1.12, -24, 0, 0), R(1.6, -21, 0, 0), R(3.2, -21, 0, 0)] },
    chest: { r: [R(0, -3, 0, 0), R(0.66, 20, 0, 0), R(1.12, -26, 0, 0), R(1.6, -23, 0, 0), R(3.2, -23, 0, 0)] },
    neck: { r: [R(0, 2, 0, 0), R(0.66, 14, 0, 0), R(1.12, -16, 0, 0), R(3.2, -15, 0, 0)] },
    head: { r: [R(0, -4, 0, 0), R(0.66, 10, 0, 0), R(1.12, -30, 0, 0), R(1.6, -27, 0, 0), R(3.2, -27, 0, 0)] },

    clavL: { r: [R(0, -1, 0, 4), R(0.66, 8, -12, 6), R(1.12, -14, -12, 24), R(3.2, -13, -12, 23)] },
    armL: { r: [R(0, -4, 2, 9), R(0.66, 40, -18, 16), R(1.12, -26, -14, 96), R(1.5, -22, -12, 92), R(3.2, -22, -12, 92)] },
    forearmL: { r: [R(0, -16, 4, 2), R(0.66, -88, 8, 0), R(1.12, -12, 6, 0), R(3.2, -10, 6, 0)] },
    handL: { r: [R(0, -8, 0, 4), R(1.12, 6, 0, 26), R(3.2, 6, 0, 26)] },
    clavR: { r: [R(0, -1, 0, -4), R(0.66, 8, 12, -6), R(1.12, -14, 12, -24), R(3.2, -13, 12, -23)] },
    armR: { r: [R(0, -4, -2, -9), R(0.66, 40, 18, -16), R(1.12, -26, 14, -96), R(1.5, -22, 12, -92), R(3.2, -22, 12, -92)] },
    forearmR: { r: [R(0, -16, -4, -2), R(0.66, -88, -8, 0), R(1.12, -12, -6, 0), R(3.2, -10, -6, 0)] },
    handR: { r: [R(0, -8, 0, -4), R(1.12, 6, 0, -26), R(3.2, 6, 0, -26)] },

    thighL: { r: [R(0, -2, 0, 0), R(0.66, -30, 0, 0), R(1.12, -14, -6, 0), R(3.2, -13, -6, 0)] },
    shinL: { r: [R(0, 3, 0, 0), R(0.66, 46, 0, 0), R(1.12, 16, 0, 0), R(3.2, 16, 0, 0)] },
    thighR: { r: [R(0, 3, 6, 0), R(0.66, -24, 6, 0), R(1.12, -8, 12, 0), R(3.2, -8, 12, 0)] },
    shinR: { r: [R(0, 7, 0, 0), R(0.66, 42, 0, 0), R(1.12, 14, 0, 0), R(3.2, 14, 0, 0)] },
    footL: { r: [R(0, -1, 0, 0), R(1.12, -10, 0, 0), R(3.2, -10, 0, 0)] },
    footR: { r: [R(0, -2, 0, 0), R(1.12, -10, 0, 0), R(3.2, -10, 0, 0)] },
  },
  billow: 1.6,
  billowDir: 'up',
};

// ===========================================================================
// REACTIONS
// ===========================================================================

/** Hurt. A short flinch, played as an ADDITIVE layer so the hero can be hit
 *  mid-run without losing the run — a full-body override there reads as a
 *  teleport back to a neutral pose. */
const HURT = {
  duration: 0.38,
  loop: false,
  additive: true,
  tracks: {
    pelvis: { r: [R(0, 0, 0, 0), R(0.07, -9, 4, 0), R(0.2, 3, -1, 0), R(0.38, 0, 0, 0)] },
    spine01: { r: [R(0, 0, 0, 0), R(0.07, -13, 6, 3), R(0.2, 4, -2, -1), R(0.38, 0, 0, 0)] },
    spine02: { r: [R(0, 0, 0, 0), R(0.07, -14, 7, 4), R(0.2, 4, -2, -1), R(0.38, 0, 0, 0)] },
    chest: { r: [R(0, 0, 0, 0), R(0.07, -12, 8, 4), R(0.2, 3, -2, -1), R(0.38, 0, 0, 0)] },
    head: { r: [R(0, 0, 0, 0), R(0.06, 16, -6, -5), R(0.2, -5, 2, 2), R(0.38, 0, 0, 0)] },
    clavL: { r: [R(0, 0, 0, 0), R(0.07, 6, 0, -8), R(0.38, 0, 0, 0)] },
    clavR: { r: [R(0, 0, 0, 0), R(0.07, 6, 0, 8), R(0.38, 0, 0, 0)] },
    armL: { r: [R(0, 0, 0, 0), R(0.08, 18, 0, -12), R(0.38, 0, 0, 0)] },
    armR: { r: [R(0, 0, 0, 0), R(0.08, 18, 0, 12), R(0.38, 0, 0, 0)] },
  },
  billow: 0.5,
};

/** Death. Knees fold, the body pitches forward and lands on its side. Root
 *  translation takes the whole figure to the floor; `hold` keeps the last pose
 *  so the corpse stays down. */
const DEATH = {
  duration: 1.5,
  loop: false,
  hold: true,
  events: [{ t: 0.62, name: 'shake' }, { t: 0.66, name: 'bodyfall' }],
  tracks: {
    root: {
      r: [R(0, 0, 0, 0), R(0.34, 4, -8, 6), R(0.72, 26, -18, 44), R(1.1, 30, -22, 78), R(1.5, 30, -22, 82)],
      p: [[0, 0, 0, 0], [0.30, 0, -0.34, 0], [0.66, 0, -0.72, 0.10], [1.1, 0, -0.80, 0.16], [1.5, 0, -0.80, 0.16]],
    },
    pelvis: { r: [R(0, 0, 0, 0), R(0.34, -14, 0, 0), R(0.72, 6, 0, 0), R(1.5, 10, 0, 0)] },
    spine01: { r: [R(0, 2, 0, 0), R(0.34, 22, -6, 0), R(0.72, 34, -10, 0), R(1.5, 30, -12, 0)] },
    spine02: { r: [R(0, 0, 0, 0), R(0.34, 20, -6, 0), R(0.72, 30, -10, 0), R(1.5, 26, -12, 0)] },
    chest: { r: [R(0, -3, 0, 0), R(0.34, 16, -6, 0), R(0.72, 24, -10, 0), R(1.5, 20, -12, 0)] },
    head: { r: [R(0, -4, 0, 0), R(0.30, 18, 8, 0), R(0.72, 30, 14, 0), R(1.5, 26, 16, 0)] },
    clavL: { r: [R(0, -1, 0, 4), R(0.6, 10, 0, -6), R(1.5, 12, 0, -10)] },
    armL: { r: [R(0, -4, 2, 9), R(0.4, -20, 0, 24), R(0.9, 30, 10, 42), R(1.5, 36, 12, 48)] },
    forearmL: { r: [R(0, -16, 4, 2), R(0.6, -46, 0, 0), R(1.5, -22, 0, 0)] },
    clavR: { r: [R(0, -1, 0, -4), R(0.6, 10, 0, 6), R(1.5, 12, 0, 10)] },
    armR: { r: [R(0, -4, -2, -9), R(0.4, -18, 0, -20), R(0.9, 26, -10, -36), R(1.5, 32, -12, -42)] },
    forearmR: { r: [R(0, -16, -4, -2), R(0.6, -50, 0, 0), R(1.5, -26, 0, 0)] },
    thighL: { r: [R(0, -2, 0, 0), R(0.34, -46, 0, 0), R(0.72, -62, -6, 0), R(1.5, -58, -8, 0)] },
    shinL: { r: [R(0, 3, 0, 0), R(0.34, 70, 0, 0), R(0.72, 96, 0, 0), R(1.5, 92, 0, 0)] },
    thighR: { r: [R(0, 3, 6, 0), R(0.34, -38, 8, 0), R(0.72, -52, 12, 0), R(1.5, -48, 14, 0)] },
    shinR: { r: [R(0, 7, 0, 0), R(0.34, 64, 0, 0), R(0.72, 88, 0, 0), R(1.5, 84, 0, 0)] },
  },
  billow: 0.3,
};

// ===========================================================================

/**
 * Every clip, keyed by name. `duration` is in seconds; cyclic clips have their
 * 0..1 authoring time scaled here so the keys above stay readable.
 */
export const CLIP_DEFS = (() => {
  const defs = {
    idle: IDLE, walk: WALK, run: RUN, dash: DASH,
    attack1: ATTACK1, attack2: ATTACK2, attack3: ATTACK3, attack4: ATTACK4,
    cast: CAST, arise: ARISE, ultimate: ULTIMATE, hurt: HURT, death: DEATH,
  };
  for (const [name, def] of Object.entries(defs)) {
    def.name = name;
    if (!def.cyclic) continue;
    for (const track of Object.values(def.tracks)) {
      if (track.r) track.r = scaleTime(track.r, def.duration);
      if (track.p) track.p = scaleTime(track.p, def.duration);
    }
    if (def.events) def.events = def.events.map((e) => ({ ...e, t: e.t * def.duration }));
    def.cyclic = false;   // idempotent: scaling twice would halve every time
  }
  return defs;
})();

/**
 * The frame each debug pose freezes on.
 *
 * Chosen by capturing and looking, not by picking the middle: `run` at 0.07 s
 * has both feet off the ground with the legs at maximum separation, which is the
 * only phase of a run that reads as a run in a still image.
 */
export const POSE_FREEZE = {
  idle: 1.15,
  walk: 0.26,
  run: 0.07,
  dash: 0.20,
  cast: 0.62,
  arise: 1.42,
  ultimate: 1.55,
  hurt: 0.07,
  death: 1.5,
  attack1: 0.21,
  attack2: 0.19,
  attack3: 0.31,
  attack4: 0.30,
};
