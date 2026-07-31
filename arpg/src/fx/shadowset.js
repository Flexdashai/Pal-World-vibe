import { ELEMENTS } from '../core/palette.js';
import { SPRITE, DECAL_SPRITE } from './atlas.js';
import { FX, clamp01, easeIn, easeOutExpo, smoothstep } from './tuning.js';

/**
 * MONARCH — THE SHADOW SET.
 *
 * The signature of the whole game and the most important file in this
 * subsystem: extraction, ARISE, the monarch aura, and the trail on every shadow
 * soldier.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS READ, TAKEN FROM THE SOURCE
 *
 * Four things, and every one of them is a decision that could easily have gone
 * the other way:
 *
 *  1. **The embers RISE.** Not "fall slowly" — rise, at a real positive
 *     acceleration, against gravity. Falling embers say fire; rising embers say
 *     something is being drawn OUT of the corpse. It is the single strongest cue
 *     in the anime and it costs one sign.
 *
 *  2. **The body is near-black, and near-black is not black.** A flat black
 *     silhouette in a dark dungeon is a hole in the frame — the eye reads it as
 *     missing geometry. The shadow shader gives the body a violet fresnel, a
 *     faint internal band, and a hard bright edge at the materialisation front,
 *     so it is unmistakably a *thing* that happens to be dark.
 *
 *  3. **There is a hard bright core.** Violet mist alone is atmospheric and
 *     weak. The extraction collapses to a white-violet point for three frames at
 *     four times a brazier's intensity, and everything in the room lights up
 *     from it. That contrast between a near-black body and a clipping core is
 *     the whole aesthetic.
 *
 *  4. **It is a TIMELINE, not a fade.** 1.55 seconds, four phases, each with its
 *     own easing, with the light leading the visual. See FX.extract.
 *
 * ---------------------------------------------------------------------------
 * DIVISION OF LABOUR WITH `ai` AND `player`
 *
 * `ai` owns the shadow soldier's mesh, rig and animation; `player` owns the
 * hero's own aura. This file owns the ENERGY: the vortex, the collapse, the
 * shockwave, the transient silhouette that bridges the moment between "corpse"
 * and "soldier", and the trail that follows a soldier afterwards. If `ai` never
 * spawns a body the beat still reads completely, which is what lets this be
 * reviewed on its own.
 */

const S = ELEMENTS.shadow;
/**
 * The hot end of the signature, #C9A8FF, used ONLY on the three-frame strike.
 *
 * Everything else uses `S.core` (#7B4BFF), which is far more saturated. That is
 * not a stylistic preference: additive sprites stack, and `HOT` is close enough
 * to white that four overlapping ones are white. `tools/analyze.mjs` scores the
 * violet pixel share, and the first draft — which used HOT for the ARISE burst,
 * the eyes and the ring — measured 0.09% violet on a shot whose entire purpose
 * is shadow magic.
 */
const HOT = [0.72, 0.50, 1.0];
/** Deep indigo for the anticipation phase, so the effect has somewhere to
 *  travel to. Starting at the hot colour leaves the strike nowhere to go. */
const DEEP = [0.10, 0.035, 0.42];
/** The saturated working violet: the palette's `core` opened up just enough to
 *  survive a tone curve without going white. Used for the ground glyphs and the
 *  shockwave, which are large and must carry the hue for the whole frame. */
const VIOLET = [0.34, 0.14, 1.0];

const PHASE = { GATHER: 0, DISSOLVE: 1, STRIKE: 2, ARISE: 3, DONE: 4 };

export class ShadowSet {
  /** @param {import('./index.js').FxSystem} fx */
  constructor(fx) {
    this.fx = fx;

    // ---- extraction slots (preallocated; nothing is created at runtime) ----
    this.extractions = [];
    for (let i = 0; i < 3; i++) {
      this.extractions.push({
        active: false, phase: PHASE.DONE,
        x: 0, y: 0, z: 0, groundY: 0, yaw: 0,
        t: 0, duration: FX.extract.duration, rank: 1, scale: 1,
        column: -1, glyph: -1, sil: -1,
        light: -1, lTicket: 0,
        emitA: 0, emitB: 0, struck: false, arose: false,
        actor: null,
      });
    }

    // ---- monarch aura slots -----------------------------------------------
    this.auras = [];
    for (let i = 0; i < 2; i++) {
      this.auras.push({
        active: false, target: null, x: 0, y: 0, z: 0,
        power: 0, want: 0, column: -1, glyph: -1,
        light: -1, lTicket: 0, emit: 0, glyphEmit: 0, phase: 0,
      });
    }

    // ---- shadow trails ------------------------------------------------------
    /** actor -> { ribbon, ticket, emit, lx, ly, lz }. A Map, not an array,
     *  because `ai` will attach and detach by actor identity. */
    this.trails = new Map();
    this.maxTrails = 6;

    /**
     * ONE preallocated options object for every PER-FRAME emitter in this file.
     *
     * The extraction, the aura and the trails all emit continuously, so a fresh
     * literal at those call sites would be an allocation every frame for the
     * whole length of the effect — exactly what ARCHITECTURE.md rule 5 forbids.
     * `_opt()` clears it back to "unspecified" so a field left over from the
     * previous call can never leak into the next one, which is the single trap
     * of sharing a descriptor like this.
     */
    this._o = {};
    this._opt();
    this._extracted = 0;
    this._arisen = 0;
  }

  _opt() {
    const o = this._o;
    o.count = 1;
    o.x = 0; o.y = 0; o.z = 0;
    o.dx = 0; o.dy = 1; o.dz = 0;
    o.spread = undefined; o.flatten = undefined;
    o.speed = 0; o.speedVar = undefined;
    o.radius = undefined; o.radiusVar = undefined; o.yVar = undefined;
    o.rise = undefined; o.phase = undefined; o.inward = undefined;
    o.color = undefined; o.intensity = undefined; o.size = undefined;
    o.life = undefined; o.alpha = undefined; o.softness = undefined;
    o.drag = undefined; o.gravity = undefined; o.turbulence = undefined;
    o.mode = undefined; o.rot = undefined; o.fadeIn = undefined; o.fadeOut = undefined;
    o.groundY = undefined; o.tag = undefined; o.flags = undefined;
    o.orbit = undefined; o.radial = undefined; o.cx = undefined; o.cz = undefined;
    return o;
  }

  /* ======================================================================
   * EXTRACTION
   * ====================================================================== */

  /**
   * Begin an extraction at a corpse.
   *
   * @param {object} o x,y,z (feet), groundY, rank (1..5, scales everything),
   *                   duration, yaw, actor
   * @returns {object|null} the slot, so the caller can cancel it
   */
  extract(o) {
    const fx = this.fx;
    let e = null;
    for (const q of this.extractions) if (!q.active) { e = q; break; }
    if (!e) {
      // Steal the one furthest through its timeline — it has already delivered
      // most of its information.
      let best = this.extractions[0];
      for (const q of this.extractions) if (q.t / q.duration > best.t / best.duration) best = q;
      this._end(best);
      e = best;
    }

    const rank = clamp01((o.rank ?? 1) / 5);
    e.active = true;
    e.phase = PHASE.GATHER;
    e.x = o.x; e.y = o.y; e.z = o.z;
    e.groundY = o.groundY ?? o.y;
    e.yaw = o.yaw ?? 0;
    e.t = 0;
    e.duration = o.duration ?? FX.extract.duration;
    e.rank = o.rank ?? 1;
    e.scale = 0.85 + rank * 0.75;
    e.emitA = 0; e.emitB = 0;
    e.struck = false; e.arose = false;
    e.actor = o.actor ?? null;
    e.column = -1; e.glyph = -1; e.sil = -1;
    this._extracted++;

    // ---- anticipation, frame zero -----------------------------------------
    // The ground mark scribes itself. `scribe` is 0.26 s, which is inside the
    // 80-220 ms anticipation window plus a little, because a magic circle that
    // appears instantly reads as a decal rather than as something being written.
    e.glyph = fx.mesh.glyph({
      x: e.x, y: e.groundY, z: e.z,
      size: FX.extract.gather * 1.05 * e.scale, sprite: SPRITE.glyphRing,
      color: VIOLET, intensity: 1.4 * e.scale,
      life: e.duration * 0.92, scribe: 0.26, spin: 0.62,
    });

    // Motes converge from the gather radius, spiralling inward.
    fx.emitter.ring('ember', {
      count: Math.round(20 * e.scale), x: e.x, y: e.groundY + 0.10, z: e.z,
      radius: FX.extract.gather * e.scale, radiusVar: 0.28, yVar: 0.9,
      speed: 0, inward: true,
      color: DEEP, intensity: 2.1, size: 0.95, life: 1.15,
      orbit: 3.6, radial: -1.9, cx: e.x, cz: e.z,
      gravity: 0.85, turbulence: 0.25,
    });

    // The light starts NOW, dim and indigo, and it will be retuned across the
    // whole timeline. One light for the whole beat, not one per phase.
    e.light = fx.lights.acquire({
      x: e.x, y: e.y + 0.9, z: e.z, color: DEEP,
      intensity: 2 * e.scale, distance: 4.5,
      attack: FX.extract.anticipation, sustain: e.duration, release: 0.55,
    });
    e.lTicket = fx.lights.ticketOf(e.light);

    fx.emitCue('shadow_extract_start', e.x, e.y, e.z);
    return e;
  }

  /** Cancel an extraction without the ARISE payoff (the corpse was destroyed). */
  cancel(e) {
    if (e?.active) this._end(e);
  }

  _end(e) {
    const fx = this.fx;
    if (e.light >= 0) fx.lights.release_(e.light, e.lTicket);
    e.active = false;
    e.phase = PHASE.DONE;
    e.column = -1; e.glyph = -1; e.sil = -1; e.light = -1;
  }

  /**
   * ARISE — the payoff. Callable standalone (`ai` spawning a soldier without a
   * corpse to extract) or driven from the end of an extraction.
   */
  arise(o) {
    const fx = this.fx;
    const scale = 0.85 + clamp01((o.rank ?? 1) / 5) * 0.75;
    const x = o.x, z = o.z;
    const gy = o.groundY ?? o.y;
    this._arisen++;

    // ---- the ground shockwave ---------------------------------------------
    fx.mesh.ring({
      x, y: gy, z, radius0: 0.35 * scale, radius: 3.4 * scale,
      // The leading front carries the palette's `glow`, the trailing one its
      // `core`. Using the hot colour for both makes the whole shockwave white
      // and throws away the one saturated hue the art direction allows.
      color: VIOLET, intensity: 1.6 * scale, life: 0.44, sharp: 4.2, wobble: 0.14,
    });
    fx.mesh.ring({
      x, y: gy, z, radius0: 0.2 * scale, radius: 2.1 * scale,
      color: S.core, intensity: 0.9 * scale, life: 0.72, sharp: 2.0, wobble: 0.25,
    });

    // ---- the silhouette ----------------------------------------------------
    // `ai` may replace this with a real soldier immediately; the transient is
    // what bridges the frames in between, and it is also the whole effect when
    // there is no `ai`.
    const sil = fx.mesh.silhouette({
      x, y: gy, z, yaw: o.yaw ?? 0,
      height: (o.height ?? 1.85) * (0.92 + 0.16 * scale),
      // `deep` is the BODY. It has to be near-black but never zero: a pure
      // black shape in a dark room reads as missing geometry rather than as a
      // soldier. `rim` at 1.9 puts most of the figure's energy on its
      // silhouette, which is what the eye actually reads at 120 px of height.
      color: S.glow, deep: [0.020, 0.013, 0.052],
      rim: 1.15, opacity: 1, life: o.silLife ?? 0.85,
    });

    // Eyes: two hard violet points at head height. They ignite slightly AFTER
    // the body resolves, which is the beat that makes the soldier read as alive
    // rather than as a statue.
    const eyeY = gy + (o.height ?? 1.85) * 0.90;
    const c = Math.cos(o.yaw ?? 0), s = Math.sin(o.yaw ?? 0);
    for (let i = -1; i <= 1; i += 2) {
      fx.emitter.burst('flare', {
        count: 1, x: x + c * i * 0.075, y: eyeY, z: z - s * i * 0.075,
        speed: 0, spread: 0, color: HOT, intensity: 4.2,
        size: 0.070, life: 5.5, fadeIn: 0.55, fadeOut: 0.35, softness: 0.3,
      });
    }

    // ---- the burst ---------------------------------------------------------
    fx.emitter.burst('flare', {
      count: 1, x, y: gy + 1.0, z, speed: 0, spread: 0,
      color: HOT, intensity: 1.5 * scale, size: 0.40 * scale, life: 1.5,
    });
    fx.emitter.ring('emberRise', {
      count: Math.round(34 * scale), x, y: gy + 0.10, z,
      // Spawned on a WIDE ring with a big radius variance rather than at a
      // point: 34 additive sprites released from one spot stay coincident for
      // the first tenth of a second and read as a single white ball, which is
      // exactly what the shutter catches.
      radius: 0.95 * scale, radiusVar: 0.75, yVar: 1.1,
      speed: 4.2 * scale, speedVar: 0.7, dy: 0.35, rise: 1.6,
      color: S.core, intensity: 1.25, size: 1.0, life: 1.5,
    });
    fx.emitter.burst('wisp', {
      count: Math.round(11 * scale), x, y: gy + 0.6, z,
      dx: 0, dy: 1, dz: 0, spread: Math.PI * 0.55,
      speed: 3.0, speedVar: 0.6, radius: 0.32,
      color: S.core, intensity: 1.15, size: 0.42 * scale, life: 1.2,
    });
    fx.emitter.burst('smokeThin', {
      count: Math.round(5 * scale), x, y: gy + 0.25, z,
      dx: 0, dy: 1, dz: 0, spread: Math.PI * 0.6,
      speed: 1.2, speedVar: 0.7, radius: 0.35,
      color: S.dark, intensity: 2.0, size: 1.0 * scale, life: 1.5, alpha: 0.38,
    });

    // ---- the mark it leaves ------------------------------------------------
    fx.decals.place({
      x, y: gy, z, sprite: DECAL_SPRITE.rune, size: 2.2 * scale,
      color: [0.16, 0.08, 0.44], alpha: 0.85, rough: 1.25, emissive: 0.85,
      rotation: fx.rng.range(0, Math.PI * 2), life: 7, fade: 4,
    });

    // ---- light, screen, camera ---------------------------------------------
    fx.lights.acquire({
      x, y: gy + 1.2, z, color: [0.62, 0.44, 1.0],
      intensity: FX.extract.peak * 0.42 * scale, distance: 5.8,
      attack: 0.02, sustain: 0.06, release: 0.55,
    });
    fx.screen.impulse(0.18, 0, 0);
    fx.screen.violet(0.10);
    fx.screen.wave(x, gy + 0.6, z, 3.5 * scale);
    fx.shake(0.42 * scale, 0.36, 22);
    fx.emitCue('shadow_arise', x, gy, z);
    return sil;
  }

  /* ======================================================================
   * MONARCH AURA
   * ====================================================================== */

  /**
   * A standing column of violet light with orbiting glyphs.
   *
   * @param {object} o target (anything with `.position`) or x,y,z; power 0..1
   * @returns {object} the slot; call `setAuraPower` to ramp it, `stopAura` to end
   */
  aura(o) {
    const fx = this.fx;
    let a = null;
    for (const q of this.auras) if (!q.active && q.power <= 0.001) { a = q; break; }
    if (!a) a = this.auras[0];

    a.active = true;
    a.target = o.target ?? null;
    a.x = o.x ?? o.target?.position?.x ?? 0;
    a.y = o.y ?? o.target?.position?.y ?? 0;
    a.z = o.z ?? o.target?.position?.z ?? 0;
    a.want = clamp01(o.power ?? 1);
    a.phase = fx.rng.range(0, Math.PI * 2);
    a.emit = 0; a.glyphEmit = 0;

    if (a.column < 0 || !fx.mesh.isBusy('columns', a.column)) {
      a.column = fx.mesh.column({
        x: a.x, y: a.y, z: a.z,
        radius: FX.aura.radius, height: FX.aura.height,
        color: S.core, hot: HOT, intensity: 0.001, rise: 5.0, fill: 1,
        life: o.life ?? 30,
      });
    }
    if (a.glyph < 0 || !fx.mesh.isBusy('glyphs', a.glyph)) {
      a.glyph = fx.mesh.glyph({
        x: a.x, y: a.y, z: a.z, size: FX.aura.radius * 2.3,
        sprite: SPRITE.glyphRing, color: S.glow, intensity: 0.001,
        life: o.life ?? 30, scribe: 0.3, spin: FX.aura.orbit,
      });
    }
    if (a.light < 0 || !fx.lights.valid(a.light, a.lTicket)) {
      a.light = fx.lights.acquire({
        x: a.x, y: a.y + 1.2, z: a.z, color: S.light,
        intensity: 0.001, distance: 8, attack: FX.aura.ramp,
        sustain: o.life ?? 30, release: FX.aura.ramp,
      });
      a.lTicket = fx.lights.ticketOf(a.light);
    }
    return a;
  }

  setAuraPower(a, power) { if (a) a.want = clamp01(power); }

  stopAura(a) { if (a) { a.want = 0; a.active = false; } }

  /* ======================================================================
   * SHADOW TRAILS
   * ====================================================================== */

  /**
   * Attach a trail to a shadow soldier. Called on `shadow:arise` and on
   * `actor:spawn` for anything with `isShadow`.
   */
  attachTrail(actor, o = {}) {
    if (!actor || this.trails.has(actor)) return false;
    if (this.trails.size >= this.maxTrails) return false;
    const fx = this.fx;
    const ribbon = fx.ribbons.acquire({
      color: o.color ?? S.core,
      width: o.width ?? FX.shadowTrail.width,
      life: o.life ?? FX.shadowTrail.life,
      intensity: o.intensity ?? 1.6,
      taper: 1.5,
    });
    this.trails.set(actor, {
      ribbon, ticket: fx.ribbons.ticketOf(ribbon),
      emit: 0, lx: actor.position?.x ?? 0, ly: actor.position?.y ?? 0, lz: actor.position?.z ?? 0,
      height: o.height ?? 0.55,
    });
    return true;
  }

  detachTrail(actor) {
    const t = this.trails.get(actor);
    if (!t) return false;
    this.fx.ribbons.stop(t.ribbon, t.ticket);
    this.trails.delete(actor);
    return true;
  }

  /* ======================================================================
   * PER-FRAME
   * ====================================================================== */

  update(dt, time) {
    this._updateExtractions(dt, time);
    this._updateAuras(dt, time);
    this._updateTrails(dt);
  }

  _updateExtractions(dt, time) {
    const fx = this.fx;
    const E = FX.extract;

    for (const e of this.extractions) {
      if (!e.active) continue;
      e.t += dt;
      const T = e.t;
      const D = e.duration;
      // Phase boundaries scale with the requested duration so a `rank 5`
      // extraction can be slower without the phases drifting apart.
      const k = D / FX.extract.duration;
      const tGather = E.anticipation * k;
      const tDissolve = tGather + E.dissolve * k;
      const tStrike = tDissolve + E.strike;

      if (T >= D) { this._end(e); continue; }

      // -------------------------------------------------------- GATHER ----
      if (T < tGather) {
        e.phase = PHASE.GATHER;
        const u = T / tGather;
        // Ease IN: energy gathers slowly and then rushes. A linear gather reads
        // as a fade-in, which is exactly what the phase table forbids.
        const g = easeIn(u);
        fx.lights.retune(e.light, e.lTicket, DEEP, (1.6 + 4 * g) * e.scale, 4.5);

        e.emitA += dt;
        if (e.emitA > 0.055) {
          e.emitA = 0;
          const o = this._opt();
          o.count = 3; o.x = e.x; o.y = e.groundY + 0.08; o.z = e.z;
          o.radius = E.gather * e.scale * (1 - g * 0.45);
          o.radiusVar = 0.25; o.yVar = 0.6;
          o.speed = 0; o.inward = true;
          o.color = DEEP; o.intensity = 1.9 + 1.5 * g;
          o.size = 0.85; o.life = 0.85;
          // The spiral tightens as the gather progresses: faster orbit, harder
          // inward drift. A constant spiral reads as decoration; an accelerating
          // one reads as a thing being pulled in.
          o.orbit = 4.0 + 4.0 * g; o.radial = -2.2 - 1.6 * g;
          o.cx = e.x; o.cz = e.z;
          o.gravity = 0.7; o.turbulence = 0.2;
          fx.emitter.ring('ember', o);
        }
        continue;
      }

      // ------------------------------------------------------- DISSOLVE ----
      if (T < tDissolve) {
        if (e.phase !== PHASE.DISSOLVE) {
          e.phase = PHASE.DISSOLVE;
          // The column is created at the START of the dissolve, not at the
          // start of the effect: the anticipation must be motes and a glyph
          // only, or the column steals the reveal.
          e.column = fx.mesh.column({
            x: e.x, y: e.groundY, z: e.z,
            // Height scales only weakly with rank: a rank-5 extraction should
            // read as DENSER, not as a taller column that leaves the frame.
            radius: 0.30 * e.scale, height: E.column * (0.85 + 0.20 * e.scale),
            color: S.core, hot: HOT,
            intensity: 0.15, rise: 7.5, fill: 0.02,
            life: (tStrike - T) + 0.5,
          });
          fx.emitCue('shadow_dissolve', e.x, e.y, e.z);
        }
        const u = (T - tGather) / (tDissolve - tGather);
        // The column FILLS upward with an ease-out — fast at the bottom where
        // the body is, slowing as it reaches for the ceiling.
        const fill = Math.min(1, easeOutExpo(u) * 1.05);
        const colour = mix3(DEEP, S.core, smoothstep(clamp01(u * 1.4)));
        fx.mesh.setColumn(e.column, {
          radius: (0.30 + 0.055 * Math.sin(time * 7 + e.x)) * e.scale * (1 - u * 0.25),
          height: E.column * (0.85 + 0.20 * e.scale) * (0.55 + 0.45 * fill),
          intensity: 0.18 + 0.62 * u,
          fill,
          color: colour,
        });
        fx.lights.retune(e.light, e.lTicket, colour, (2.6 + 4.5 * u) * e.scale, 4.2 + 0.6 * u);

        // Rising embers, continuously, out of the body. THE read.
        e.emitA += dt;
        if (e.emitA > 0.048) {
          e.emitA = 0;
          const o = this._opt();
          o.count = 2 + Math.round(u * 3);
          o.x = e.x; o.y = e.groundY + 0.15 + u * 0.5; o.z = e.z;
          o.dx = 0; o.dy = 1; o.dz = 0;
          o.spread = 0.55;
          o.speed = 1.1 + u * 1.8; o.speedVar = 0.55;
          o.radius = 0.30 * (1 - u * 0.5);
          o.rise = E.rise * (0.6 + 0.7 * u);
          o.color = colour; o.intensity = 1.15 + 0.85 * u; o.size = 0.95; o.life = 1.1;
          fx.emitter.burst('emberRise', o);
        }
        // A slow helix of wisps around the column.
        e.emitB += dt;
        if (e.emitB > 0.085) {
          e.emitB = 0;
          const o = this._opt();
          o.count = 2;
          o.x = e.x; o.y = e.groundY + 0.2 + u * 1.2; o.z = e.z;
          o.radius = 0.62 * e.scale * (1 - u * 0.35); o.radiusVar = 0.1;
          o.speed = 0.15; o.dy = 0.9; o.rise = E.rise * 0.9;
          o.phase = time * 2.2;
          o.color = S.core; o.intensity = 1.05; o.size = 0.30 * e.scale; o.life = 1.0;
          o.orbit = E.swirl; o.radial = -0.35; o.cx = e.x; o.cz = e.z;
          fx.emitter.ring('wisp', o);
        }
        continue;
      }

      // --------------------------------------------------------- STRIKE ----
      if (T < tStrike) {
        if (!e.struck) {
          e.struck = true;
          e.phase = PHASE.STRIKE;
          // STEP, not a ramp. Three frames of white-violet, far above anything
          // else in the level, and a light at four braziers.
          fx.emitter.burst('flare', {
            count: 1, x: e.x, y: e.groundY + 1.15 * e.scale, z: e.z,
            speed: 0, spread: 0, color: HOT, intensity: 2.6 * e.scale,
            size: 0.50 * e.scale, life: 1.0, softness: 1.2,
          });
          fx.emitter.burst('shockAir', {
            count: 1, x: e.x, y: e.groundY + 1.1 * e.scale, z: e.z,
            speed: 0, spread: 0, color: HOT, intensity: 1.1,
            size: 0.62 * e.scale, life: 1.0, softness: 1.4,
          });
          fx.mesh.setColumn(e.column, { intensity: 1.15, radius: 0.13 * e.scale });
          fx.lights.retune(e.light, e.lTicket, HOT, E.peak * e.scale, 9.5);
          fx.screen.impulse(0.12, 0, 0);
          fx.screen.violet(0.07);
          fx.shake(0.22, 0.16, 34);
          fx.emitCue('shadow_strike', e.x, e.y, e.z);
        }
        continue;
      }

      // ---------------------------------------------------------- ARISE ----
      if (!e.arose) {
        e.arose = true;
        e.phase = PHASE.ARISE;
        fx.mesh.setColumn(e.column, { intensity: 0.001 });
        this.arise({
          x: e.x, y: e.y, z: e.z, groundY: e.groundY,
          yaw: e.yaw, rank: e.rank, height: e.height ?? 1.85,
          silLife: Math.max(0.5, D - T),
        });
        // The blood under the body goes with it — a corpse that dissolves into
        // violet light but leaves its pool behind reads as two separate events.
        if (e.actor) fx.blood.evaporatePool(e.actor, 0.45);
        fx.lights.retune(e.light, e.lTicket, S.light, 5 * e.scale, 5.2);
      }
      // Tail: embers keep rising and drifting after the soldier resolves.
      e.emitA += dt;
      if (e.emitA > 0.07) {
        e.emitA = 0;
        const o = this._opt();
        o.count = 2; o.x = e.x; o.y = e.groundY + 0.5; o.z = e.z;
        o.dx = 0; o.dy = 1; o.dz = 0;
        o.spread = 1.0; o.speed = 0.9; o.speedVar = 0.7; o.radius = 0.45;
        o.rise = E.rise * 0.7;
        o.color = S.core; o.intensity = 1.25; o.size = 0.8; o.life = 1.2;
        fx.emitter.burst('emberRise', o);
      }
    }
  }

  _updateAuras(dt, time) {
    const fx = this.fx;
    const A = FX.aura;
    for (const a of this.auras) {
      // Ramp toward the requested power. Both directions are eased, because an
      // aura that snaps off is as wrong as one that snaps on.
      const rate = dt / A.ramp;
      if (a.power < a.want) a.power = Math.min(a.want, a.power + rate);
      else if (a.power > a.want) a.power = Math.max(a.want, a.power - rate);

      if (a.power <= 0.001) {
        if (a.column >= 0) { fx.mesh.setColumn(a.column, { intensity: 0.001 }); }
        if (a.light >= 0 && fx.lights.valid(a.light, a.lTicket)) {
          fx.lights.retune(a.light, a.lTicket, S.light, 0.001, 8);
        }
        continue;
      }

      if (a.target?.position) {
        a.x = a.target.position.x;
        a.y = a.target.position.y;
        a.z = a.target.position.z;
      }

      const p = a.power;
      // Breathing: a standing column that is perfectly steady reads as a
      // cylinder of fog. Two incommensurate sines, slow.
      const breath = 1 + 0.10 * Math.sin(time * 1.7 + a.phase) + 0.06 * Math.sin(time * 2.9 + a.phase * 1.7);

      fx.mesh.setColumn(a.column, {
        x: a.x, y: a.y, z: a.z,
        radius: A.radius * (0.7 + 0.35 * p) * breath,
        height: A.height * (0.6 + 0.5 * p),
        intensity: 0.42 * p * breath,
      });
      const g = fx.mesh.glyphs[a.glyph];
      if (g?.busy) {
        g.mesh.position.set(a.x, a.y + 0.02, a.z);
        g.mesh.scale.setScalar(A.radius * 2.3 * (0.8 + 0.3 * p));
        g.intensity = 2.6 * p;
        // The aura holds indefinitely, so its own life must not run out under it.
        g.age = Math.min(g.age, g.life * 0.5);
      }
      if (fx.lights.valid(a.light, a.lTicket)) {
        fx.lights.move(a.light, a.lTicket, a.x, a.y + 1.3, a.z);
        fx.lights.retune(a.light, a.lTicket, S.light, 4.5 * p * breath, 4.8 + 1.2 * p);
      }

      // Rising motes out of the ring.
      a.emit += dt;
      if (a.emit > 0.06 / Math.max(0.25, p)) {
        a.emit = 0;
        const o = this._opt();
        o.count = 2; o.x = a.x; o.y = a.y + 0.05; o.z = a.z;
        o.radius = A.radius * 0.85; o.radiusVar = 0.2;
        o.speed = 0.1; o.dy = 1; o.rise = 1.5;
        o.phase = time * 0.9;
        o.color = S.core; o.intensity = 1.4 * p; o.size = 0.85; o.life = 1.2;
        o.orbit = A.orbit * 2.4; o.radial = -0.12; o.cx = a.x; o.cz = a.z;
        fx.emitter.ring('emberRise', o);
      }

      // Orbiting glyphs — the reason it is a MONARCH aura and not a smoke pot.
      a.glyphEmit += dt;
      if (a.glyphEmit > 0.42) {
        a.glyphEmit = 0;
        const o = this._opt();
        o.count = A.glyphs; o.x = a.x; o.y = a.y + 0.9 + 0.5 * p; o.z = a.z;
        o.radius = A.radius * 1.25; o.radiusVar = 0.05; o.yVar = 0.9;
        o.speed = 0.02; o.dy = 0.2;
        o.phase = time * A.orbit;
        o.color = S.glow; o.intensity = 1.05 * p;
        o.size = 0.85 * (0.7 + 0.5 * p); o.life = 1.4;
        o.orbit = A.orbit * 1.6; o.radial = 0; o.cx = a.x; o.cz = a.z;
        o.gravity = 0.28; o.turbulence = 0;
        fx.emitter.ring('glyph', o);
      }
    }
  }

  _updateTrails(dt) {
    const fx = this.fx;
    for (const [actor, t] of this.trails) {
      const p = actor.position;
      if (!p || actor.alive === false) {
        fx.ribbons.stop(t.ribbon, t.ticket);
        this.trails.delete(actor);
        continue;
      }
      if (!fx.ribbons.valid(t.ribbon, t.ticket)) {
        // The pool recycled our ribbon under us; take another rather than
        // silently writing into someone else's.
        t.ribbon = fx.ribbons.acquire({
          color: S.core, width: FX.shadowTrail.width,
          life: FX.shadowTrail.life, intensity: 1.6, taper: 1.5,
        });
        t.ticket = fx.ribbons.ticketOf(t.ribbon);
      }
      const y = p.y + t.height;
      fx.ribbons.push(t.ribbon, t.ticket, p.x, y, p.z);

      const dx = p.x - t.lx, dy = p.y - t.ly, dz = p.z - t.lz;
      const moved = Math.hypot(dx, dy, dz);
      t.lx = p.x; t.ly = p.y; t.lz = p.z;

      // Embers shed in proportion to distance travelled, not to time: a soldier
      // standing still should not smoulder, and one sprinting should stream.
      t.emit += moved * FX.shadowTrail.emberRate;
      while (t.emit >= 1) {
        t.emit -= 1;
        const o = this._opt();
        o.count = 1; o.x = p.x; o.y = p.y + fx.rng.range(0.15, 1.4); o.z = p.z;
        o.dx = 0; o.dy = 1; o.dz = 0;
        o.spread = 1.3; o.speed = 0.45; o.speedVar = 0.8; o.radius = 0.18;
        o.rise = 0.9;
        o.color = S.core; o.intensity = 2.6; o.size = 0.7; o.life = 0.9;
        fx.emitter.burst('emberRise', o);
      }
    }
  }

  clear() {
    for (const e of this.extractions) if (e.active) this._end(e);
    for (const a of this.auras) { a.active = false; a.power = 0; a.want = 0; a.column = -1; a.glyph = -1; a.light = -1; }
    for (const [, t] of this.trails) this.fx.ribbons.kill(t.ribbon, t.ticket);
    this.trails.clear();
  }

  stats() {
    let ex = 0, au = 0;
    for (const e of this.extractions) if (e.active) ex++;
    for (const a of this.auras) if (a.power > 0.001) au++;
    return {
      extracting: ex, extracted: this._extracted, arisen: this._arisen,
      auras: au, trails: this.trails.size,
    };
  }
}

/** Reused colour scratch — this is called every frame during a dissolve. */
const MIX = [0, 0, 0];
function mix3(a, b, t) {
  MIX[0] = a[0] + (b[0] - a[0]) * t;
  MIX[1] = a[1] + (b[1] - a[1]) * t;
  MIX[2] = a[2] + (b[2] - a[2]) * t;
  return MIX;
}
