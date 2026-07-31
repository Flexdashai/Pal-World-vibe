import { ELEMENTS } from '../core/palette.js';
import { SPRITE, DECAL_SPRITE } from './atlas.js';
import { FX } from './tuning.js';

/**
 * MONARCH — spell VFX, per element, and every one of them lights the scene.
 *
 * ---------------------------------------------------------------------------
 * THE PHASE TABLE IS NOT A SUGGESTION
 *
 * Each effect below is written as the explicit timeline from ARCHITECTURE.md,
 * and — the part that is easy to get wrong — the core, ring, embers, smoke and
 * light each run on their OWN duration, roughly 1x / 2.5x / 6x / 10x / 3x. That
 * ratio is why an explosion reads as an event with a beginning and an end rather
 * than as one sprite being scaled: at 120 ms the core is already gone, the ring
 * is at its widest, the embers are still accelerating outward and the smoke has
 * barely started.
 *
 * ---------------------------------------------------------------------------
 * EVERY EFFECT TAKES A LIGHT
 *
 * Without exception, and with an envelope that PEAKS ONE FRAME BEFORE the
 * visual. `FxLights` owns the pool; the only thing this file decides is colour,
 * peak intensity, radius and release — and those are the numbers that decide
 * whether a fireball looks like it is in the room.
 *
 * Intensities are candela-scale, against `palette.LIGHTS.brazier` = 26 at an
 * 11 m radius. An explosion peaking at 110 is therefore about four braziers,
 * which for three frames is exactly right and is what makes the walls jump.
 */
export class Spells {
  /** @param {import('./index.js').FxSystem} fx */
  constructor(fx) {
    this.fx = fx;
    this._count = 0;
    /** Live projectile visuals: { x,y,z, ribbon, ticket, light, lightTicket,
     *  element, age, life }. Preallocated so `update` never allocates. */
    this._proj = [];
    for (let i = 0; i < 8; i++) {
      this._proj.push({
        active: false, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0,
        ribbon: -1, rTicket: 0, light: -1, lTicket: 0,
        el: 'shadow', age: 0, life: 3, size: 1, emit: 0,
      });
    }
  }

  /* ======================================================================
   * Explosion — the full four-phase event
   * ====================================================================== */

  /**
   * @param {object} o position/x,y,z, radius, element, magnitude, ground
   */
  explosion(o) {
    const fx = this.fx;
    const em = fx.emitter;
    const el = ELEMENTS[o.element] ?? ELEMENTS.fire;
    const R = o.radius ?? 3.0;
    const mag = o.magnitude ?? 1;
    const x = o.x, y = o.y, z = o.z;
    this._count++;

    const shadow = o.element === 'shadow';

    // ---- STRIKE: the core. 1x. Two frames, far above the final brightness --
    em.burst('flare', {
      count: 1, x, y, z, speed: 0, spread: 0,
      color: el.glow, intensity: 3.5 * mag, size: R * 0.16, life: 1.4, softness: 1.0,
    });
    // THREE, not five, and at less than half the radiance. `glow` is a 2 m soft
    // additive volume; five of them released from one point overlap completely
    // for the first tenth of a second and integrate to white, which is how a
    // FIRE explosion ends up with no orange anywhere in it.
    em.burst('glow', {
      count: 3, x, y, z, dx: 0, dy: 1, dz: 0, spread: Math.PI,
      speed: R * 1.25, speedVar: 0.5, radius: R * 0.10,
      color: el.core, intensity: 0.9 * mag, size: R * 0.22, life: 1.0,
    });

    // ---- BLOOM-OUT: the ring. 2.5x ----------------------------------------
    fx.mesh.ring({
      x, y: o.groundY ?? y, z,
      radius0: R * 0.18, radius: R * 1.15,
      color: el.glow, intensity: 1.5 * mag, life: 0.40, sharp: 3.6, wobble: 0.18,
    });
    // A second, vertical front so the blast reads in the air as well as on the
    // floor. An isometric camera sees both.
    em.burst('shockAir', {
      count: 1, x, y: y + R * 0.12, z, speed: 0, spread: 0,
      color: el.glow, intensity: 1.0 * mag, size: R * 0.44, life: 1.2, softness: 1.4,
    });

    // ---- DEBRIS: embers. 6x ------------------------------------------------
    const emberKind = shadow ? 'emberRise' : 'ember';
    em.burst(emberKind, {
      count: Math.round(26 * Math.min(2, mag)), x, y: y + 0.1, z,
      dx: 0, dy: 0.35, dz: 0, spread: Math.PI * 0.85,
      speed: R * 2.2, speedVar: 0.65, radius: R * 0.12,
      color: el.core, intensity: 3.6, size: 1.15, life: 1.3,
    });
    em.burst('spark', {
      count: Math.round(16 * Math.min(2, mag)), x, y: y + 0.1, z,
      dx: 0, dy: 0.30, dz: 0, spread: Math.PI * 0.7,
      speed: R * 3.4, speedVar: 0.8, radius: R * 0.08,
      color: el.glow, intensity: 7.0, size: 1.1,
    });
    em.burst('wisp', {
      count: Math.round(10 * Math.min(2, mag)), x, y: y + 0.15, z,
      dx: 0, dy: 0.6, dz: 0, spread: Math.PI * 0.6,
      speed: R * 1.6, speedVar: 0.6, radius: R * 0.12,
      color: el.core, intensity: 2.0, size: R * 0.26, life: 1.2,
    });

    // ---- DISSIPATION: smoke. 10x -------------------------------------------
    em.burst('smoke', {
      count: Math.round(11 * Math.min(2, mag)), x, y: y + 0.15, z,
      dx: 0, dy: 0.55, dz: 0, spread: Math.PI * 0.75,
      speed: R * 0.9, speedVar: 0.6, radius: R * 0.16,
      color: el.dark, intensity: shadow ? 8.0 : 5.5,
      size: R * 0.5, life: 1.35, alpha: 0.85,
    });
    // Ground-hugging skirt: the part of a blast that runs along the floor. It
    // is what makes the explosion sit IN the room rather than in front of it.
    em.burst('dust', {
      count: Math.round(12 * Math.min(2, mag)), x, y: (o.groundY ?? y) + 0.12, z,
      dx: 0, dy: 0.12, dz: 0, spread: Math.PI * 0.48,
      speed: R * 2.4, speedVar: 0.5, radius: R * 0.2,
      color: shadow ? [0.16, 0.12, 0.26] : [0.26, 0.235, 0.20], intensity: 1,
      size: R * 0.45, life: 1.5, alpha: 0.9,
    });

    // ---- LIGHT: 3x, and it leads ------------------------------------------
    fx.lights.acquire({
      x, y: y + R * 0.25, z, color: el.light,
      intensity: 30 * mag * (shadow ? 1.15 : 1),
      distance: R * 2.4, attack: 0.026, release: 0.30 + 0.1 * mag,
    });

    // ---- the mark it leaves ------------------------------------------------
    if (o.decal !== false) {
      fx.decals.place({
        x, y: o.groundY ?? y, z, nx: 0, ny: 1, nz: 0,
        sprite: shadow ? DECAL_SPRITE.rune : DECAL_SPRITE.scorch,
        size: R * 1.1,
        color: shadow ? [0.18, 0.10, 0.48] : [0.040, 0.030, 0.024],
        alpha: 0.9, rough: shadow ? 1.2 : 2.5,
        emissive: shadow ? 0.7 : 0.06,
        rotation: fx.rng.range(0, Math.PI * 2),
        life: shadow ? 8 : 34, fade: shadow ? 3 : 10,
      });
    }

    // ---- the screen ---------------------------------------------------------
    fx.screen.impulse(0.20 * mag, 0, 0);
    fx.screen.wave(x, y, z, R);
    fx.shake(0.28 * mag, 0.30, 24);
    return true;
  }

  /* ======================================================================
   * Nova — an expanding ground front, the ARPG AoE
   * ====================================================================== */

  nova(o) {
    const fx = this.fx;
    const em = fx.emitter;
    const el = ELEMENTS[o.element] ?? ELEMENTS.shadow;
    const R = o.radius ?? 5.0;
    const mag = o.magnitude ?? 1;
    const x = o.x, y = o.groundY ?? o.y, z = o.z;
    this._count++;

    // Anticipation is the caller's job (`cast`); this is the release.
    fx.mesh.glyph({
      x, y, z, size: R * 1.05, sprite: SPRITE.glyphRing,
      color: el.glow, intensity: 3.4 * mag, life: FX.spell.novaLife, scribe: 0.14, spin: -0.7,
    });
    fx.mesh.ring({
      x, y, z, radius0: R * 0.12, radius: R,
      color: el.glow, intensity: 2.1 * mag, life: FX.spell.novaRing, sharp: 4.0, wobble: 0.10,
    });
    // A second, slower ring behind the first. Two fronts at different speeds is
    // what turns "a circle grew" into "a wave passed".
    fx.mesh.ring({
      x, y, z, radius0: R * 0.05, radius: R * 0.72,
      color: el.core, intensity: 1.2 * mag, life: FX.spell.novaRing * 1.7, sharp: 2.2, wobble: 0.2,
    });

    // A wall of energy standing up out of the ring.
    em.ring('wisp', {
      count: Math.round(26 * Math.min(2, mag)), x, y: y + 0.05, z,
      radius: R * 0.30, radiusVar: 0.35,
      speed: R * 1.5, speedVar: 0.4, dy: 0.55, rise: 1.4,
      color: el.core, intensity: 3.4, size: R * 0.13, life: 1.25,
    });
    em.ring(o.element === 'shadow' ? 'emberRise' : 'ember', {
      count: Math.round(34 * Math.min(2, mag)), x, y: y + 0.04, z,
      radius: R * 0.22, radiusVar: 0.5,
      speed: R * 1.9, speedVar: 0.55, dy: 0.35, rise: 1.1,
      color: el.core, intensity: 3.2, size: 1.1, life: 1.4,
    });
    em.ring('dust', {
      count: Math.round(16 * Math.min(2, mag)), x, y: y + 0.08, z,
      radius: R * 0.28, radiusVar: 0.4,
      speed: R * 2.1, speedVar: 0.4, dy: 0.10,
      color: [0.20, 0.17, 0.26], intensity: 1, size: R * 0.22, life: 1.6, alpha: 0.75,
    });

    fx.lights.acquire({
      x, y: y + 1.0, z, color: el.light,
      intensity: 32 * mag, distance: R * 2.0,
      attack: 0.03, release: 0.42, sustain: 0.05,
    });

    fx.decals.place({
      x, y, z, sprite: DECAL_SPRITE.rune, size: R * 0.95,
      color: [el.dark[0] * 4, el.dark[1] * 4, el.dark[2] * 4],
      alpha: 0.8, rough: 1.3, emissive: 0.55,
      rotation: fx.rng.range(0, Math.PI * 2), life: 5, fade: 3,
    });

    fx.screen.impulse(0.15 * mag, 0, 0);
    fx.screen.wave(x, y + 0.5, z, R);
    fx.shake(0.24 * mag, 0.34, 20);
    return true;
  }

  /* ======================================================================
   * Cast anticipation — energy gathers before anything is released
   * ====================================================================== */

  /**
   * 80-220 ms of ease-IN. Motes converge on the caster's hand, a glyph scribes
   * under them, and the light builds. Skipping this is the difference between a
   * spell and a sprite appearing.
   */
  cast(o) {
    const fx = this.fx;
    const em = fx.emitter;
    const el = ELEMENTS[o.element] ?? ELEMENTS.shadow;
    const x = o.x, y = o.y, z = o.z;
    const mag = o.magnitude ?? 1;

    // Converging motes: emitted ON a sphere with velocity pointing INWARD, so
    // they arrive together. Radial drift does the convergence, the orbit makes
    // it a spiral rather than a collapse.
    em.ring('ember', {
      count: Math.round(16 * mag), x, y, z,
      radius: 1.05 * mag, radiusVar: 0.3, yVar: 0.55,
      speed: 0, inward: true,
      color: el.core, intensity: 3.0, size: 0.85, life: 0.55,
      orbit: 5.0, radial: -2.4, cx: x, cz: z, gravity: 0.4, turbulence: 0,
    });
    em.burst('glyph', {
      count: 3, x, y, z, dx: 0, dy: 1, dz: 0, spread: 1.2,
      speed: 0.5, speedVar: 0.6, radius: 0.28,
      color: el.glow, intensity: 2.6, size: 0.9 * mag, life: 0.8,
    });
    if (o.ground !== false) {
      fx.mesh.glyph({
        x, y: o.groundY ?? (y - 1.2), z, size: 1.7 * mag, sprite: SPRITE.glyphRing,
        color: el.glow, intensity: 2.0 * mag, life: 0.75, scribe: 0.22, spin: 0.9,
      });
    }
    fx.lights.acquire({
      x, y, z, color: el.light, intensity: 8 * mag, distance: 4.5,
      attack: 0.16, sustain: 0.06, release: 0.20,
    });
    return true;
  }

  /* ======================================================================
   * Projectiles
   * ====================================================================== */

  /**
   * Start a projectile visual. Returns a handle to feed `moveProjectile`.
   * `combat` owns the physics projectile; this owns everything you can see.
   */
  projectile(o) {
    const fx = this.fx;
    const el = ELEMENTS[o.element] ?? ELEMENTS.shadow;
    let p = null;
    for (const q of this._proj) if (!q.active) { p = q; break; }
    if (!p) {
      // All eight busy: recycle the oldest rather than dropping the newest,
      // because the newest is the one the player just fired and is watching.
      let oldest = this._proj[0];
      for (const q of this._proj) if (q.age > oldest.age) oldest = q;
      this._releaseProjectile(oldest);
      p = oldest;
    }

    p.active = true;
    p.x = p.px = o.x; p.y = p.py = o.y; p.z = p.pz = o.z;
    p.el = o.element ?? 'shadow';
    p.age = 0;
    p.life = o.life ?? 3.0;
    p.size = o.size ?? 1;
    p.emit = 0;

    p.ribbon = fx.ribbons.acquire({
      color: el.core, width: 0.10 * p.size, life: 0.26,
      intensity: FX.spell.projectileGlow * 3.0, taper: 1.4,
    });
    p.rTicket = fx.ribbons.ticketOf(p.ribbon);

    p.light = fx.lights.acquire({
      x: o.x, y: o.y, z: o.z, color: el.light,
      intensity: o.lightIntensity ?? 14, distance: 5.5,
      attack: 0.05, sustain: p.life, release: 0.16,
    });
    p.lTicket = fx.lights.ticketOf(p.light);
    return p;
  }

  moveProjectile(p, x, y, z) {
    if (!p?.active) return;
    p.px = p.x; p.py = p.y; p.pz = p.z;
    p.x = x; p.y = y; p.z = z;
  }

  endProjectile(p, impact = true) {
    if (!p?.active) return;
    if (impact) {
      const el = ELEMENTS[p.el] ?? ELEMENTS.shadow;
      this.fx.emitter.burst('flare', {
        count: 1, x: p.x, y: p.y, z: p.z, speed: 0, spread: 0,
        color: el.glow, intensity: 4.5, size: 0.32 * p.size, life: 1.1,
      });
    }
    this._releaseProjectile(p);
  }

  _releaseProjectile(p) {
    const fx = this.fx;
    if (p.ribbon >= 0) fx.ribbons.stop(p.ribbon, p.rTicket);
    if (p.light >= 0) fx.lights.release_(p.light, p.lTicket);
    p.active = false;
    p.ribbon = -1;
    p.light = -1;
  }

  /* ======================================================================
   * Beam
   * ====================================================================== */

  beam(o) {
    const fx = this.fx;
    const el = ELEMENTS[o.element] ?? ELEMENTS.shadow;
    fx.mesh.beam({
      x0: o.x0, y0: o.y0, z0: o.z0, x1: o.x1, y1: o.y1, z1: o.z1,
      radius: o.radius ?? 0.18, color: el.core, hot: el.glow,
      intensity: (o.magnitude ?? 1) * 4.5, life: o.life ?? FX.spell.beamLife,
    });
    // Muzzle and terminus both flare; a beam with no ends reads as a cylinder.
    fx.emitter.burst('flare', {
      count: 1, x: o.x0, y: o.y0, z: o.z0, speed: 0, spread: 0,
      color: el.glow, intensity: 5, size: 0.34, life: 1.2,
    });
    fx.emitter.burst('flare', {
      count: 1, x: o.x1, y: o.y1, z: o.z1, speed: 0, spread: 0,
      color: el.glow, intensity: 6, size: 0.42, life: 1.4,
    });
    const mx = (o.x0 + o.x1) * 0.5, my = (o.y0 + o.y1) * 0.5, mz = (o.z0 + o.z1) * 0.5;
    fx.lights.acquire({
      x: mx, y: my, z: mz, color: el.light, intensity: 20 * (o.magnitude ?? 1),
      distance: 6.5, attack: 0.02, sustain: (o.life ?? FX.spell.beamLife) * 0.6, release: 0.2,
    });
    return true;
  }

  /* ====================================================================== */

  update(dt) {
    const fx = this.fx;
    for (const p of this._proj) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) { this._releaseProjectile(p); continue; }
      if (p.ribbon >= 0) fx.ribbons.push(p.ribbon, p.rTicket, p.x, p.y, p.z);
      if (p.light >= 0) fx.lights.move(p.light, p.lTicket, p.x, p.y, p.z);

      // Shed a trailing ember roughly every 45 ms of travel. Rate-limited by
      // time rather than by frame so the density is the same however the frame
      // rate varies — the single most common reason a trail looks different in
      // a capture than it does live.
      p.emit += dt;
      if (p.emit > 0.045) {
        p.emit = 0;
        const el = ELEMENTS[p.el] ?? ELEMENTS.shadow;
        fx.emitter.burst(p.el === 'shadow' ? 'emberRise' : 'ember', {
          count: 1, x: p.x, y: p.y, z: p.z,
          dx: 0, dy: 1, dz: 0, spread: 1.4, speed: 0.55, speedVar: 0.8, radius: 0.05,
          color: el.core, intensity: 3.0, size: 0.75 * p.size, life: 0.85,
        });
      }
    }
  }

  clear() {
    for (const p of this._proj) if (p.active) this._releaseProjectile(p);
  }

  stats() {
    let live = 0;
    for (const p of this._proj) if (p.active) live++;
    return { spells: this._count, projectiles: live };
  }
}
