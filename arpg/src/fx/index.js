import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';

import { buildAtlas, SPRITE, DECAL_SPRITE } from './atlas.js';
import { ParticleSystem } from './particles.js';
import { Emitter, KINDS } from './emitters.js';
import { DecalSystem } from './decals.js';
import { FxLights } from './lights.js';
import { RibbonPool } from './ribbons.js';
import { MeshFx } from './meshfx.js';
import { Impacts, surfaceBleeds } from './impacts.js';
import { BloodSystem } from './blood.js';
import { Spells } from './spells.js';
import { ShadowSet } from './shadowset.js';
import { ScreenImpulse } from './screen.js';
import { HitFlash } from './flash.js';
import { FX } from './tuning.js';

/**
 * ============================================================================
 * MONARCH — `fx` subsystem.  PUBLIC API.
 * ============================================================================
 *
 *   id    'fx'
 *   deps  ['render', 'materials']   (`physics` is reached with ctx.peek and is
 *                                    optional — everything degrades to "no
 *                                    surface conformance" without it)
 *
 * `const fx = ctx.get('fx')`. Nothing outside `src/fx/` imports a module from
 * this directory.
 *
 * ---------------------------------------------------------------------------
 * IMPACTS AND SPELLS
 *   fx.impact({ x,y,z, nx,ny,nz, dx,dy,dz, surface, element, magnitude, crit })
 *   fx.explosion({ x,y,z, radius, element, magnitude, groundY })
 *   fx.nova({ x,y,z, radius, element, magnitude, groundY })
 *   fx.cast({ x,y,z, element, magnitude, groundY })
 *   fx.beam({ x0,y0,z0, x1,y1,z1, element, magnitude, radius, life })
 *   fx.projectile({ x,y,z, element, size, life }) -> handle
 *   fx.moveProjectile(handle, x, y, z)
 *   fx.endProjectile(handle, impact)
 *
 * BLOOD
 *   fx.bloodSpray({ x,y,z, dx,dy,dz, amount, crit })
 *   fx.bloodPool({ x,y,z, size, actor })
 *   fx.gib({ x,y,z, dx,dy,dz, actor })
 *   fx.weaponBlood                       0..1, how wet the weapon is
 *
 * DECALS
 *   fx.decal({ x,y,z, nx,ny,nz, sprite, size, color, alpha, rough, emissive,
 *              rotation, life, fade, grow, conform }) -> slot | -1
 *   fx.SPRITE / fx.DECAL_SPRITE          the atlas index tables
 *
 * THE SHADOW SET
 *   fx.extract({ x,y,z, groundY, rank, duration, yaw, actor }) -> handle
 *   fx.cancelExtract(handle)
 *   fx.arise({ x,y,z, groundY, rank, yaw, height })
 *   fx.aura({ target | x,y,z, power }) -> handle
 *   fx.setAuraPower(handle, 0..1)  /  fx.stopAura(handle)
 *   fx.attachShadowTrail(actor, opts) / fx.detachShadowTrail(actor)
 *
 * TRAILS
 *   fx.trail({ color, width, life, intensity }) -> handle
 *   fx.trailPush(handle, x,y,z, ax,ay,az, width)
 *   fx.trailStop(handle)
 *   fx.swing({ x0,y0,z0, x1,y1,z1, element })     one frame of a weapon arc
 *
 * FEEDBACK
 *   fx.hitFlash(actor, { amount, element, crit })
 *   fx.shake(amount, duration, frequency)
 *   fx.impulse(dirX, dirY, amount)
 *   fx.burst(kind, opts)                 raw access to the particle recipes
 *
 * DEBUG (called only from src/dev/shots.js and tools/)
 *   fx.debugBurst('none'|'impacts'|'blood'|'extract'|'explosion', opts)
 *   fx.stats()
 *
 * ---------------------------------------------------------------------------
 * FILE MAP
 *
 *   tuning.js     every duration, count and threshold, with its reason
 *   atlas.js      the 16-sprite procedural atlas, computed at load
 *   particles.js  typed-array simulation + two instanced draw calls, soft
 *   emitters.js   the particle KIND table and the emission primitives
 *   decals.js     one instanced lit quad pool, ring-buffer LRU, BVH conformance
 *   lights.js     the fixed effect-light pool and its envelopes
 *   ribbons.js    swing sheets, projectile trails, dash streaks, shadow tails
 *   meshfx.js     shockwave rings, energy columns, beams, glyphs, silhouettes
 *   impacts.js    surface x element impact composition
 *   blood.js      arterial spray, landing decals, pooling, weapon blood
 *   spells.js     explosion, nova, cast, beam, projectiles
 *   shadowset.js  extraction, ARISE, the monarch aura, shadow trails
 *   screen.js     the display-space impulse overlay
 *   flash.js      the emissive hit flash on struck actors
 *
 * ---------------------------------------------------------------------------
 * FIVE CONTRACTS THIS FILE KEEPS
 *
 *  1. **The light pool is allocated in `init()` and never changes size.** The
 *     visible point-light count is a shader program cache key; a subsystem that
 *     spawned a light per explosion would recompile every material in the scene
 *     mid-fight. See lights.js.
 *
 *  2. **Nothing allocates per frame.** Simulation is in typed arrays, every
 *     continuous emitter writes into a preallocated descriptor, and every
 *     scratch vector lives on `this`.
 *
 *  3. **Everything is soft against `render.depthTexture`.** Particles, ribbons,
 *     rings, columns and silhouettes all fade where they approach opaque
 *     geometry. Hard-edged intersection with the floor is the fastest way to
 *     make a AAA-looking frame look like a prototype.
 *
 *  4. **Every significant effect takes a light.** No exceptions. A fireball that
 *     does not illuminate the wall beside it is a sprite, not a spell.
 *
 *  5. **`fx` never damages, moves or kills anything.** It listens; `combat`,
 *     `ai`, `player` and `physics` decide. The only events it emits are
 *     `camera:shake`, `camera:impulse` and `audio:cue`.
 */
export class FxSystem {
  static id = 'fx';
  static deps = ['render', 'materials'];

  async init(ctx) {
    this.ctx = ctx;
    const t0 = performance.now();
    /** ONE fork, taken here and never re-forked, so a capture of a given seed
     *  produces identical particles. */
    this.rng = ctx.rng.fork();

    const render = ctx.get('render');
    const materials = ctx.get('materials');
    this.render = render;
    this.physics = ctx.peek('physics');
    this.q = ctx.config.q;

    // ---- scene graph --------------------------------------------------------
    this.root = new THREE.Group();
    this.root.name = 'mn.fx';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    // ---- the atlas ----------------------------------------------------------
    const atlas = buildAtlas(this.rng.fork());
    this.atlas = atlas.texture;
    this._atlasMs = atlas.ms;
    this.atlas.anisotropy = Math.min(4, this.q.anisotropy);

    // ---- systems ------------------------------------------------------------
    this.particles = new ParticleSystem(this.atlas, this.q);
    this.particles.attach(this.root);
    this.emitter = new Emitter(this.particles, this.rng.fork());

    this.decals = new DecalSystem(
      this.atlas, materials.detailTexture, render, this.physics, this.q
    );
    this.decals.attach(this.root);

    this.ribbons = new RibbonPool(this.particles.uniforms);
    this.ribbons.attach(this.root);

    this.mesh = new MeshFx(this.root, this.particles.uniforms, this.atlas);

    // Created HERE, in init(), so `render.prewarmMaterials` freezes the light
    // slot count with these four counted. Contract 1.
    this.lights = new FxLights(this.root, render);

    this.screen = new ScreenImpulse(render);
    this.blood = new BloodSystem(this);
    this.impacts = new Impacts(this);
    this.spells = new Spells(this);
    this.shadow = new ShadowSet(this);
    this.flash = new HitFlash(this);

    // A landed droplet becomes a decal. The particle system does not know what
    // a decal is; this is the one wire between them.
    this.particles.onLand = (x, y, z, tag, vx, vy, vz) => this.blood.onLand(x, y, z, tag, vx, vy, vz);

    // ---- preallocated scratch ----------------------------------------------
    this.tmpA = new THREE.Vector3();
    this.tmpB = new THREE.Vector3();
    this.tmpC = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    /** Reused event payloads. ARCHITECTURE.md forbids fresh literals on any
     *  event that can fire more than a few times a second, and `camera:shake`
     *  fires on every hit. Object IDENTITY of `_shake` is also how the listener
     *  below recognises its own emission and does not double-count it. */
    this._shake = { amount: 0, duration: 0, frequency: 26, source: 'fx' };
    this._impulse = { dir: new THREE.Vector3(), amount: 0, source: 'fx' };
    this._cue = { cue: '', position: new THREE.Vector3(), gain: 1 };

    /** My own clock, in SCALED seconds. Everything visual reads it, which means
     *  hit-stop freezes the fire, the smoke and the sparks together with the
     *  world — that shared freeze IS the impact frame. It is also what lets
     *  `debugBurst` pre-roll an effect without touching `ctx.time`. */
    this.time = 0;

    // ---- debug burst state --------------------------------------------------
    this._debug = { name: 'none', opts: null, fireFrame: -1, loop: 0, ideal: 0, avail: 0 };

    this._wire(ctx);

    // `?fxburst=extract` triggers a burst from the URL, which is how the capture
    // harness reaches a debug effect on a shot whose own `apply` does not call
    // us (every environment shot). Dev only.
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    this._urlBurst = params?.get('fxburst') ?? null;
    this._urlFrame = Number(params?.get('fxframe')) || 12;

    /**
     * Isolation switches, for answering "which of my three additive systems is
     * washing the frame out" with one capture instead of six.
     *
     *   ?fxlights=0     effect lights contribute nothing
     *   ?fxparticles=0  the particle pools are never drawn
     *   ?fxmesh=0       rings, columns, beams, glyphs and silhouettes are hidden
     *
     * This exists because a haze in a fogged room has three plausible causes —
     * `sky`'s volumetric march picking up an fx light, overlapping additive
     * sprites, or an over-bright mesh effect — and they are indistinguishable in
     * a screenshot while having completely different fixes.
     */
    if (params?.get('fxlights') === '0') this.lights.disabled = true;
    this._noParticles = params?.get('fxparticles') === '0';
    this._noMesh = params?.get('fxmesh') === '0';
    if (this._noParticles) {
      this.particles.add.mesh.userData.mnFxMuted = true;
      this.particles.alpha.mesh.userData.mnFxMuted = true;
    }
    if (this._noMesh) this.mesh.group.visible = false;

    console.info(
      `[fx] atlas 512px/16 sprites in ${this._atlasMs.toFixed(0)}ms | ` +
      `particles ${this.particles.capacity} (budget ${this.q.particleBudget}) | ` +
      `decals ${this.decals.capacity} (budget ${this.q.decalBudget}) | ` +
      `ribbons ${this.ribbons.count}x${this.ribbons.S - 1} | lights ${this.lights.count} | ` +
      `init ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  // =========================================================================
  // event wiring
  // =========================================================================

  _wire(ctx) {
    this._offs = [];
    const on = (type, fn) => this._offs.push(ctx.events.on(type, fn));

    // ---- the canonical impact event ---------------------------------------
    on('fx:impact', (e) => {
      if (!e?.position) return;
      this.impact({
        x: e.position.x, y: e.position.y, z: e.position.z,
        nx: e.normal?.x, ny: e.normal?.y, nz: e.normal?.z,
        surface: e.surface ?? 'stone',
        element: e.element ?? 'physical',
        magnitude: e.magnitude ?? 1,
      });
    });

    on('fx:explosion', (e) => {
      if (!e?.position) return;
      this.explosion({
        x: e.position.x, y: e.position.y, z: e.position.z,
        radius: e.radius ?? 3, element: e.element ?? 'fire',
        magnitude: e.magnitude ?? 1,
      });
    });

    // ---- damage ------------------------------------------------------------
    // ARCHITECTURE.md: `combat:hit` means damage dealt TO `target`. We draw the
    // reaction for both factions but scale the player's down — a hit ON the
    // player is already communicated by `ui`'s damage vignette, and doubling it
    // buries the enemy that dealt it.
    on('combat:hit', (e) => this._onHit(e));
    on('combat:kill', (e) => this._onKill(e));
    on('combat:miss', (e) => {
      if (!e?.position) return;
      // A parry/whiff still needs a tell, or a missed swing reads as a dropped
      // input. One spark and a thin puff, no light, no decal.
      this.emitter.burst('spark', {
        count: 4, x: e.position.x, y: e.position.y, z: e.position.z,
        dx: 0, dy: 1, dz: 0, spread: 1.4, speed: 3.0, speedVar: 0.7, radius: 0.06,
        color: ELEMENTS.physical.glow, intensity: 3.0, size: 0.7,
      });
    });

    on('actor:stagger', (e) => {
      if (!e?.actor?.position) return;
      const p = e.actor.position;
      this.emitter.burst('dust', {
        count: 4, x: p.x, y: p.y + 0.12, z: p.z,
        dx: e.dir?.x ?? 0, dy: 0.25, dz: e.dir?.z ?? 0,
        spread: 1.2, speed: 1.6, speedVar: 0.6, radius: 0.18,
        color: [0.22, 0.20, 0.19], intensity: 1, size: 0.7, alpha: 0.7,
      });
    });

    // ---- the shadow set ----------------------------------------------------
    on('shadow:extract', (e) => {
      if (!e?.position) return;
      this.extract({
        x: e.position.x, y: e.position.y, z: e.position.z,
        rank: e.rank ?? 1, duration: e.duration, actor: e.actor ?? null,
        yaw: e.actor?.root?.rotation?.y ?? 0,
      });
    });

    on('shadow:arise', (e) => {
      // `ai` owns the soldier; we own the light show and the trail. When an
      // extraction is already running at this position its own timeline
      // produces the ARISE, so a second one here would double the shockwave.
      if (e?.soldier) this.attachShadowTrail(e.soldier);
      if (!e?.position) return;
      if (this._extractionNear(e.position, 1.2)) return;
      this.arise({
        x: e.position.x, y: e.position.y, z: e.position.z,
        rank: e.rank ?? 1, yaw: e.soldier?.root?.rotation?.y ?? 0,
        height: e.soldier?.height ?? 1.85,
      });
    });

    on('actor:spawn', (e) => {
      if (e?.actor?.isShadow) this.attachShadowTrail(e.actor);
    });

    // ---- casting -----------------------------------------------------------
    on('player:cast', (e) => {
      if (!e?.origin) return;
      this.cast({
        x: e.origin.x, y: e.origin.y, z: e.origin.z,
        element: e.element ?? 'shadow', magnitude: e.magnitude ?? 1,
      });
    });

    // ---- screen ------------------------------------------------------------
    // Respond to anyone's camera shake with a matching screen impulse, but not
    // to our own — `_shake` is a reused payload, so object identity tells us
    // exactly which is which and there is no double-counting.
    on('camera:shake', (e) => {
      if (e === this._shake) return;
      this.screen.impulse(Math.min(1.0, (e?.amount ?? 0.3) * 0.55));
    });
    on('camera:impulse', (e) => {
      if (e === this._impulse) return;
      this.screen.impulse(Math.min(1.0, (e?.amount ?? 0.2) * 0.7));
    });

    // ---- level transitions -------------------------------------------------
    // A new level must not inherit the last one's blood. Decals are world-space
    // and the world has just been rebuilt underneath them.
    on('world:ready', () => this.clearTransients(true));
  }

  _onHit(e) {
    if (!e) return;
    const target = e.target;
    const pos = e.position ?? target?.position;
    if (!pos) return;

    const isPlayer = target?.isPlayer === true;
    const amount = e.amount ?? 1;
    // Normalise damage to an effect magnitude. Raw damage is unbounded and
    // scales with level; the FEEL of a hit must not.
    const hpMax = target?.stats?.hpMax ?? 100;
    const mag = Math.max(0.35, Math.min(3.0, 0.6 + (amount / Math.max(1, hpMax)) * 7));
    const crit = !!e.crit;
    const element = e.element ?? 'physical';

    // Direction: prefer the normal from the emitter, else from the attacker.
    let dx = 0, dy = 0.2, dz = 0;
    if (e.normal) { dx = -e.normal.x; dy = -e.normal.y; dz = -e.normal.z; }
    else if (e.source?.position && target?.position) {
      dx = target.position.x - e.source.position.x;
      dy = 0.15;
      dz = target.position.z - e.source.position.z;
    }
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    // The wound is at chest height, not at the feet. `combat` often reports the
    // actor's origin as the hit position, and blood spraying out of somebody's
    // boots is the single funniest bug this subsystem can produce. An event that
    // gives a genuinely elevated contact point is trusted; one that is level
    // with the target's feet is lifted.
    const feetY = target?.position?.y ?? pos.y;
    const wy = pos.y - feetY > 0.35 ? pos.y : feetY + (target?.height ?? 1.8) * 0.62;

    // ---- flesh bleeds, everything else chips -------------------------------
    const surface = e.surface ?? (target ? 'flesh' : 'stone');
    if (surfaceBleeds(surface)) {
      this.blood.spray({ x: pos.x, y: wy, z: pos.z, dx, dy, dz, amount: mag * 0.8, crit });
      // Plus the universal core: a hit on flesh still needs an impact frame.
      this.impacts.spawn({
        x: pos.x, y: wy, z: pos.z, nx: -dx, ny: -dy, nz: -dz,
        dx, dy, dz, surface, element, magnitude: mag, crit, decal: false,
      });
    } else {
      this.impacts.spawn({
        x: pos.x, y: wy, z: pos.z, nx: -dx, ny: -dy, nz: -dz,
        dx, dy, dz, surface, element, magnitude: mag, crit,
      });
    }

    if (target) this.flash.flash(target, { amount: mag, element, crit });

    // ---- weight ------------------------------------------------------------
    // The player being hit shakes the camera harder than the player hitting
    // something: it is the one moment the camera should feel out of control.
    const shakeAmt = isPlayer ? 0.30 + 0.22 * mag : 0.10 + 0.13 * mag;
    this.shake(Math.min(0.85, shakeAmt * (crit ? 1.5 : 1)), crit ? 0.30 : 0.20, 30);
    if (crit) this.screen.flash(0.16);
  }

  _onKill(e) {
    const pos = e?.position ?? e?.actor?.position;
    if (!pos) return;
    const actor = e.actor;
    const overkill = e.overkill ?? 0;
    const h = actor?.height ?? 1.8;

    let dx = 0, dz = 0;
    if (e.killer?.position && actor?.position) {
      dx = actor.position.x - e.killer.position.x;
      dz = actor.position.z - e.killer.position.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
    }

    const groundY = this.blood.groundUnder(pos.x, pos.y, pos.z);
    // A heavy overkill dismembers; anything else just bleeds out.
    if (overkill > 0.35 || e.gib) {
      this.blood.gib({
        x: pos.x, y: pos.y + h * 0.5, z: pos.z, dx, dy: 0.3, dz,
        actor, groundY,
      });
      this.shake(0.34, 0.30, 24);
      this.screen.impulse(0.35);
    } else {
      this.blood.spray({
        x: pos.x, y: pos.y + h * 0.6, z: pos.z, dx, dy: 0.25, dz,
        amount: 1.9, crit: true, groundY,
      });
      this.blood.pool({ x: pos.x, y: groundY, z: pos.z, size: 0.95, actor });
    }

    // Death of a shadow-touched thing gives back a little of what made it.
    if (e.element === 'shadow' || actor?.isShadow) {
      this.emitter.burst('emberRise', {
        count: 12, x: pos.x, y: pos.y + h * 0.4, z: pos.z,
        dx: 0, dy: 1, dz: 0, spread: 1.2, speed: 1.4, speedVar: 0.7, radius: 0.28,
        rise: 1.6, color: ELEMENTS.shadow.core, intensity: 3.0, size: 0.9, life: 1.4,
      });
      this.detachShadowTrail(actor);
    }
  }

  _extractionNear(p, radius) {
    const r2 = radius * radius;
    for (const e of this.shadow.extractions) {
      if (!e.active) continue;
      const dx = e.x - p.x, dz = e.z - p.z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  // =========================================================================
  // public API
  // =========================================================================

  get SPRITE() { return SPRITE; }
  get DECAL_SPRITE() { return DECAL_SPRITE; }
  get KINDS() { return KINDS; }
  get weaponBlood() { return this.blood.weapon; }

  impact(o) { return this.impacts.spawn(o); }
  explosion(o) { return this.spells.explosion(this._withGround(o)); }
  nova(o) { return this.spells.nova(this._withGround(o)); }
  cast(o) { return this.spells.cast(this._withGround(o)); }
  beam(o) { return this.spells.beam(o); }
  projectile(o) { return this.spells.projectile(o); }
  moveProjectile(p, x, y, z) { return this.spells.moveProjectile(p, x, y, z); }
  endProjectile(p, impact) { return this.spells.endProjectile(p, impact); }

  bloodSpray(o) { return this.blood.spray(o); }
  bloodPool(o) { return this.blood.pool(o); }
  gib(o) { return this.blood.gib(o); }

  decal(o) { return this.decals.place(o); }

  extract(o) { return this.shadow.extract(this._withGround(o)); }
  cancelExtract(h) { return this.shadow.cancel(h); }
  arise(o) { return this.shadow.arise(this._withGround(o)); }
  aura(o) { return this.shadow.aura(o); }
  setAuraPower(h, p) { return this.shadow.setAuraPower(h, p); }
  stopAura(h) { return this.shadow.stopAura(h); }
  attachShadowTrail(actor, o) { return this.shadow.attachTrail(actor, o); }
  detachShadowTrail(actor) { return this.shadow.detachTrail(actor); }

  trail(o) {
    const slot = this.ribbons.acquire(o);
    return { slot, ticket: this.ribbons.ticketOf(slot) };
  }
  trailPush(h, x, y, z, ax, ay, az, width) {
    return h ? this.ribbons.push(h.slot, h.ticket, x, y, z, ax, ay, az, width) : false;
  }
  trailStop(h) { return h ? this.ribbons.stop(h.slot, h.ticket) : false; }

  /**
   * One frame of a weapon arc: hilt at (x0,y0,z0), tip at (x1,y1,z1).
   *
   * Call it every frame of a swing with a handle from `fx.trail()`; the ribbon
   * expands along the explicit hilt-to-tip axis, so it is the surface the blade
   * swept and not a camera-facing tube. The tint carries `weaponBlood`, which is
   * how blood ends up visible ON the weapon.
   */
  swing(h, x0, y0, z0, x1, y1, z1) {
    if (!h) return false;
    const mx = (x0 + x1) * 0.5, my = (y0 + y1) * 0.5, mz = (z0 + z1) * 0.5;
    return this.ribbons.push(h.slot, h.ticket, mx, my, mz,
      (x1 - x0) * 0.5, (y1 - y0) * 0.5, (z1 - z0) * 0.5);
  }

  /** The tint a weapon trail should use given how bloodied the weapon is. */
  weaponTrailColor(out, element = 'physical') {
    const base = (ELEMENTS[element] ?? ELEMENTS.physical).core;
    const b = this.blood.weapon;
    out[0] = base[0] + (ELEMENTS.blood.glow[0] * 1.6 - base[0]) * b;
    out[1] = base[1] + (ELEMENTS.blood.glow[1] * 1.6 - base[1]) * b;
    out[2] = base[2] + (ELEMENTS.blood.glow[2] * 1.6 - base[2]) * b;
    return out;
  }

  hitFlash(actor, o) { return this.flash.flash(actor, o); }
  burst(kind, o) { return this.emitter.burst(kind, o); }
  ringBurst(kind, o) { return this.emitter.ring(kind, o); }

  /** Emit a camera shake through the shared event, from a REUSED payload. */
  shake(amount, duration = 0.25, frequency = 26) {
    this._shake.amount = amount;
    this._shake.duration = duration;
    this._shake.frequency = frequency;
    this.ctx.events.emit('camera:shake', this._shake);
    // Our own shakes feed the overlay here rather than through the listener —
    // the listener recognises `_shake` by identity and skips it, so this is the
    // single path and there is no double-counting.
    this.screen.impulse(Math.min(1.0, amount * 0.30));
    return this;
  }

  impulse(dx, dy, dz, amount) {
    this._impulse.dir.set(dx, dy, dz);
    this._impulse.amount = amount;
    this.ctx.events.emit('camera:impulse', this._impulse);
    return this;
  }

  emitCue(cue, x, y, z, gain = 1) {
    this._cue.cue = cue;
    this._cue.position.set(x, y, z);
    this._cue.gain = gain;
    this.ctx.events.emit('audio:cue', this._cue);
  }

  /** Fill in `groundY` from physics when the caller did not. Effects that draw
   *  on the floor need it and almost no caller knows it. */
  _withGround(o) {
    if (o.groundY === undefined) {
      o.groundY = this.physics?.groundAt
        ? (this.physics.groundAt(o.x, o.z, o.y + 2.5)?.y ?? o.y)
        : o.y;
    }
    return o;
  }

  // =========================================================================
  // the frame
  // =========================================================================

  /**
   * Everything happens in `lateUpdate`: trails have to sample actors AFTER
   * `player` and `ai` have moved them, and the particle shader needs the final
   * camera. Splitting the work across `update` and `lateUpdate` would leave
   * every trail one frame behind its owner, which at dash speed is 12 cm of
   * visible detachment.
   */
  lateUpdate(dt, ctx) {
    // Scaled dt: hit-stop must freeze the sparks with the world.
    const d = Math.min(0.05, dt);
    this.time += d;

    this._stepDebug(ctx);
    this._step(d, this.time);

    // The screen impulse is a lens effect and runs on the UNSCALED clock — a
    // flash that freezes with hit-stop reads as a stuck overlay rather than as
    // impact.
    this.screen.update(Math.min(0.05, ctx.time.rawDt || d), ctx.camera);

    // Depth + projection for every soft-particle shader, written ONCE into the
    // shared uniform objects that particles, ribbons and mesh effects all hold
    // by reference.
    this.particles.setCamera(
      ctx.camera, this.render.depthTexture,
      this.render.screenSize.width, this.render.screenSize.height
    );
  }

  /** The simulation step, factored out so `debugBurst` can pre-roll an effect
   *  into the right phase before the shutter without touching `ctx.time`. */
  _step(dt, time) {
    this.shadow.update(dt, time);
    this.spells.update(dt);
    this.blood.update(dt);
    this.flash.update(dt);
    this.lights.update(dt);
    this.mesh.update(dt, time);
    this.ribbons.update(dt);
    this.decals.update(dt);
    // Particles last: every system above may have emitted this frame, and a
    // particle spawned now must be integrated and uploaded before the draw.
    this.particles.update(dt, time);
    if (this._noParticles) {
      this.particles.add.mesh.visible = false;
      this.particles.alpha.mesh.visible = false;
    }
  }

  resize(w, h) {
    this.screen.resize(w, h);
  }

  // =========================================================================
  // pre-warm
  // =========================================================================

  /**
   * Contract: build and compile everything without spawning gameplay objects,
   * drawing a gameplay frame, or touching the clock or the RNG.
   *
   * Almost nothing is needed here, and that is by design rather than by
   * omission: every mesh this subsystem can ever draw is already in `ctx.scene`
   * by the end of `init()` (invisible, with a zero instance count), and
   * `render.prewarmMaterials` runs BEFORE ours with the HDR target bound and
   * calls `renderer.compile(scene, camera)`, which traverses the scene
   * regardless of visibility. So every fx program is compiled against the right
   * colour space and the right light count without us doing anything.
   *
   * The two things that are NOT covered by that, and are done here:
   *
   *  - the 1 MB atlas upload, which would otherwise stall the first frame that
   *    draws a particle — i.e. the first hit of the game;
   *  - the screen-impulse pass, which draws to the CANVAS rather than to the HDR
   *    target and therefore needs a different program. It is registered
   *    `enabled` from `init()` precisely so that render's prewarm runs it once
   *    with the canvas bound; `lateUpdate` disables it on the very first frame.
   */
  async prewarmMaterials(ctx) {
    const r = this.render.renderer;
    r.initTexture(this.atlas);
    const detail = ctx.get('materials').detailTexture;
    if (detail) r.initTexture(detail);
  }

  // =========================================================================
  // debug (src/dev/shots.js and tools/ only)
  // =========================================================================

  /**
   * Frames after the burst is triggered at which each effect looks its best.
   *
   * This is the number that makes a captured frame of a transient useful. A nova
   * captured at frame 0 is a white dot; at frame 40 it is smoke. Every one of
   * these was chosen by capturing the effect and looking at it.
   */
  static PEAK_FRAME = {
    impacts: 4,
    blood: 14,
    explosion: 7,
    extract: 78,      // 1.30 s: the silhouette is ~80% materialised and the
                      // shockwave is at two thirds of its travel — the single
                      // most information-dense frame of the whole 1.55 s beat
    nova: 10,
    none: 0,
  };

  /**
   * `fx.debugBurst(name, opts)` — see src/dev/shots.js.
   *
   * `opts.grabFrame` is how many frames the harness will pump before the
   * shutter. Two mechanisms use it:
   *
   *  1. The burst is SCHEDULED so its peak frame coincides with the shutter,
   *     rather than fired immediately and already over by the time the frame is
   *     taken.
   *  2. When the shot does not pump enough frames for the effect to reach its
   *     peak — the ARISE beat needs 72 and a typical settle is 16 — the burst
   *     fires early and the whole fx simulation is PRE-ROLLED by the difference
   *     in 1/60 steps. The result is the exact frame the effect would have
   *     produced, without asking every capture to pump 72 frames at ten seconds
   *     each.
   */
  debugBurst(name, opts = {}) {
    const d = this._debug;
    const which = name ?? 'none';

    if (which === 'none') {
      d.name = 'none';
      d.fireFrame = -1;
      this.clearTransients(false);
      return 'none';
    }

    const ideal = FxSystem.PEAK_FRAME[which] ?? 8;
    const grab = Math.max(2, opts.grabFrame ?? 0);
    // Leave one frame of margin: the harness pumps `grabFrame` frames and then
    // presents, so the last SIMULATED frame is grabFrame, not grabFrame + 1.
    const avail = Math.max(1, Math.min(ideal, grab - 1));

    d.name = which;
    d.opts = opts;
    d.ideal = ideal;
    d.avail = avail;
    d.fireFrame = this.ctx.time.frame + Math.max(0, grab - avail);
    // Re-fire periodically so a live browser (no shutter) shows the effect over
    // and over instead of once, 20 seconds ago.
    d.loop = ideal + 110;
    return which;
  }

  _stepDebug(ctx) {
    const d = this._debug;
    if (d.name === 'none' || d.fireFrame < 0) {
      // `?fxburst=...&fxframe=N` on the URL. RE-ARMED rather than consumed: the
      // shot harness calls `debugBurst('none')` on every `__APPLY_SHOT__` to
      // clear the previous shot's transients, which would otherwise cancel a
      // URL burst that had already been scheduled during boot. Re-arming here
      // means the burst is (re)scheduled relative to the frame the shot was
      // applied on, which is exactly what `grabFrame` has to be measured from.
      if (this._urlBurst && ctx.time.frame > 1) {
        this.debugBurst(this._urlBurst, { grabFrame: this._urlFrame });
      }
      return;
    }
    if (ctx.time.frame < d.fireFrame) return;

    d.fireFrame = ctx.time.frame + d.loop;
    this._fireBurst(d.name);

    // Pre-roll: advance the whole simulation to where it would have been if the
    // harness had pumped `ideal` frames instead of `avail`.
    const deficit = d.ideal - d.avail;
    if (deficit > 0) {
      const h = 1 / 60;
      for (let i = 0; i < deficit; i++) {
        this.time += h;
        this._step(h, this.time);
      }
    }
  }

  /** Where a debug burst happens: the player, else the point the camera looks
   *  at on the ground. Never a hardcoded coordinate — the level is procedural. */
  _debugFocus(out) {
    const p = this.ctx.peek('player')?.position;
    if (p && p.isVector3) { out.copy(p); return out; }
    const cam = this.ctx.camera;
    cam.getWorldDirection(this._camDir);
    const t = this._camDir.y < -1e-3 ? -cam.position.y / this._camDir.y : 0;
    out.copy(cam.position).addScaledVector(this._camDir, t);
    return out;
  }

  _fireBurst(name) {
    const f = this._debugFocus(this._focus);
    const gy = this.physics?.groundAt ? (this.physics.groundAt(f.x, f.z, f.y + 3)?.y ?? f.y) : f.y;
    const rng = this.rng;

    switch (name) {
      // ------------------------------------------------------------ impacts --
      case 'impacts': {
        // One of each major surface x element pairing, arranged in an arc
        // up-screen of the focus (-X-Z is screen up, so this reads as a row
        // across the frame rather than a pile behind the player).
        const set = [
          ['stone', 'physical', 1.4],
          ['metal', 'lightning', 1.8],
          ['wood', 'fire', 1.6],
          ['bone', 'physical', 1.2],
          ['crystal', 'frost', 1.7],
          ['flagstone', 'shadow', 2.0],
        ];
        for (let i = 0; i < set.length; i++) {
          const a = -Math.PI * 0.75 + (i / (set.length - 1)) * Math.PI * 0.55;
          const r = 1.5 + (i % 2) * 0.9;
          const x = f.x + Math.cos(a) * r;
          const z = f.z + Math.sin(a) * r;
          const y = gy + 0.55 + (i % 3) * 0.42;
          const [surface, element, mag] = set[i];
          this.impacts.spawn({
            x, y, z,
            nx: -Math.cos(a) * 0.4, ny: 0.86, nz: -Math.sin(a) * 0.4,
            dx: Math.cos(a) * 0.5, dy: -0.75, dz: Math.sin(a) * 0.5,
            surface, element, magnitude: mag, crit: i === 1,
            coalesce: false,
          });
        }
        this.shake(0.3, 0.25, 28);
        break;
      }

      // -------------------------------------------------------------- blood --
      case 'blood': {
        for (let i = 0; i < 4; i++) {
          const a = -Math.PI * 0.8 + (i / 3) * Math.PI * 0.6;
          const r = 1.1 + i * 0.55;
          const x = f.x + Math.cos(a) * r;
          const z = f.z + Math.sin(a) * r;
          this.blood.spray({
            x, y: gy + 1.05, z,
            // Thrown across the screen (toward +X+Z, i.e. down-screen) so the
            // arc is seen side-on rather than end-on.
            dx: 0.62, dy: 0.22, dz: 0.62,
            amount: 1.6 + i * 0.35, crit: i === 2, groundY: gy,
          });
        }
        this.blood.gib({ x: f.x - 1.0, y: gy + 0.85, z: f.z - 1.0, dx: 0.7, dz: 0.7, groundY: gy });
        this.blood.pool({ x: f.x + 0.7, y: gy, z: f.z + 0.7, size: 1.5, grow: 0.9 });
        this.blood.weapon = 1;
        break;
      }

      // ----------------------------------------------------------- explosion --
      case 'explosion': {
        this.explosion({
          x: f.x - 0.8, y: gy + 1.0, z: f.z - 0.8, groundY: gy,
          radius: 4.2, element: 'fire', magnitude: 1.6,
        });
        this.nova({
          x: f.x + 1.4, y: gy, z: f.z + 1.4, groundY: gy,
          radius: 4.6, element: 'shadow', magnitude: 1.3,
        });
        // Debris being thrown by the blast, as physics bodies, so they bounce
        // off the real architecture rather than floating through it.
        const P = this.physics;
        if (P?.spawnBody) {
          for (let i = 0; i < 10; i++) {
            const a = rng.range(0, Math.PI * 2);
            const sp = rng.range(3, 9);
            this.tmpA.set(f.x - 0.8 + Math.cos(a) * 0.4, gy + 0.8, f.z - 0.8 + Math.sin(a) * 0.4);
            this.tmpB.set(Math.cos(a) * sp, rng.range(3, 7), Math.sin(a) * sp);
            this.tmpC.set(rng.range(-12, 12), rng.range(-12, 12), rng.range(-12, 12));
            P.spawnBody({
              shape: 'box',
              size: { x: rng.range(0.08, 0.2), y: rng.range(0.06, 0.16), z: rng.range(0.08, 0.2) },
              position: this.tmpA, velocity: this.tmpB, angular: this.tmpC,
              surface: 'stone', mass: 6, restitution: 0.2, friction: 0.7, lifetime: 8,
            });
          }
        }
        break;
      }

      // ------------------------------------------------------------- extract --
      case 'extract': {
        // THE signature shot. Three corpses caught in three DIFFERENT phases, so
        // one frame shows the whole beat: one still gathering, one dissolving
        // into its column, one that has already risen — plus the monarch aura on
        // the hero.
        //
        // The stagger is bought with DURATION, not with a head start. All three
        // begin on the same frame and the shutter lands 1.20 s later (see
        // PEAK_FRAME.extract), so a 1.55 s extraction is at its ARISE, a 2.55 s
        // one is mid-dissolve, and a 4.0 s one is still scribing its circle.
        // Giving them a head start instead — the obvious approach — runs the
        // slower ones off the end of their own timeline before the shutter.
        // It is also true to the fiction: a higher-rank shadow takes longer.
        //
        // Placement matters as much as timing. Screen up is -X-Z, so a corpse
        // at -X-Z sits BEHIND the hero and competes with the architecture at
        // the top of frame; one at +X+Z is nearer the lens, on open floor, and
        // reads at twice the size. The one that ARISES goes there.
        const spots = [
          [1.7, 1.5, 3, 1.55],      // nearest the lens: the ARISE
          [-1.9, 0.9, 2, 2.55],     // mid-screen left: dissolving
          [0.8, -2.3, 4, 4.00],     // up-screen: still gathering
        ];
        for (let i = 0; i < spots.length; i++) {
          const [ox, oz, rank, duration] = spots[i];
          const x = f.x + ox, z = f.z + oz;
          const y = this.physics?.groundAt ? (this.physics.groundAt(x, z, gy + 3)?.y ?? gy) : gy;
          // A pool of blood under each corpse, so the extraction has something
          // to take away.
          this.blood.pool({ x, y, z, size: 1.1, grow: 0.4 });
          this.extract({ x, y, z, groundY: y, rank, duration, yaw: rng.range(0, Math.PI * 2) });
        }
        // The monarch aura on the hero, at full power.
        const player = this.ctx.peek('player');
        // 0.7, not 1: `player` runs its own monarch aura on the hero and the
        // two stack. A debug beat must show what THIS subsystem produces, not
        // twice what the game will.
        this._debugAura = this.aura({
          target: player ?? null,
          x: f.x, y: gy, z: f.z, power: 0.7,
        });
        break;
      }

      default:
        return false;
    }
    return true;
  }

  /**
   * Drop every transient. `hard` also clears decals, which is right for a level
   * transition and wrong between two shots in one session (a critic comparing
   * `blood` and `hero` should see the same floor).
   */
  clearTransients(hard) {
    this.particles.clear();
    this.ribbons.clear();
    this.mesh.clear();
    this.lights.clear();
    this.screen.clear();
    this.spells.clear();
    this.shadow.clear();
    this.flash.clear();
    this.blood.clear();
    this._debugAura = null;
    if (hard) this.decals.clear();
  }

  // =========================================================================
  // introspection
  // =========================================================================

  stats() {
    return {
      time: +this.time.toFixed(2),
      atlasMs: +this._atlasMs.toFixed(0),
      particles: this.particles.stats(),
      decals: this.decals.stats(),
      ribbons: this.ribbons.stats(),
      mesh: this.mesh.stats(),
      lights: this.lights.stats(),
      screen: this.screen.stats(),
      blood: this.blood.stats(),
      spells: this.spells.stats(),
      shadow: this.shadow.stats(),
      flash: this.flash.stats(),
      impacts: this.impacts.stats(),
      debug: this._debug.name,
      physics: !!this.physics,
    };
  }

  /**
   * Fire every effect once and report what survived, without a screenshot.
   *
   *   node arpg/tools/probe.mjs --port=5282 --eval="ctx.peek('fx').selfTest()"
   *
   * Exists because "did I break the particle system" must be answerable in
   * fifteen seconds rather than by looking at a 110-second capture.
   */
  selfTest() {
    const out = { ok: true, checks: [] };
    const check = (name, pass, detail) => {
      out.checks.push({ name, pass, detail });
      if (!pass) out.ok = false;
    };

    this.clearTransients(true);
    const f = this._debugFocus(this._focus);
    const gy = this.physics?.groundAt ? (this.physics.groundAt(f.x, f.z, f.y + 3)?.y ?? f.y) : f.y;

    check('atlas built', !!this.atlas?.image, `${this.atlas?.image?.width}px in ${this._atlasMs.toFixed(0)}ms`);
    check('particle capacity within budget', this.particles.capacity <= this.q.particleBudget,
      `${this.particles.capacity} <= ${this.q.particleBudget}`);
    check('decal capacity within budget', this.decals.capacity <= this.q.decalBudget,
      `${this.decals.capacity} <= ${this.q.decalBudget}`);

    // ---- impacts, one per surface ----------------------------------------
    const surfaces = ['stone', 'flagstone', 'dirt', 'wood', 'metal', 'bone', 'flesh', 'cloth', 'water', 'crystal', 'ash', 'blood'];
    let impactOk = 0;
    for (const s of surfaces) {
      const before = this.particles.live;
      this.impacts.spawn({ x: f.x, y: gy + 1, z: f.z, surface: s, element: 'physical', magnitude: 1.5, coalesce: false });
      if (this.particles.live > before) impactOk++;
    }
    check('every surface produces particles', impactOk === surfaces.length, `${impactOk}/${surfaces.length}`);

    // ---- elements ---------------------------------------------------------
    let elemOk = 0;
    for (const e of ['physical', 'shadow', 'fire', 'frost', 'lightning', 'holy']) {
      const before = this.particles.live;
      this.impacts.spawn({ x: f.x, y: gy + 1, z: f.z, surface: 'stone', element: e, magnitude: 1.5, coalesce: false });
      if (this.particles.live > before) elemOk++;
    }
    check('every element produces particles', elemOk === 6, `${elemOk}/6`);

    // ---- decals -----------------------------------------------------------
    const decalsBefore = this.decals.live;
    this.blood.spray({ x: f.x, y: gy + 1.1, z: f.z, dx: 1, dy: 0.2, dz: 0, amount: 2, groundY: gy });
    this.blood.pool({ x: f.x, y: gy, z: f.z, size: 1.2 });
    check('blood places decals', this.decals.live > decalsBefore, `${this.decals.live - decalsBefore} placed`);

    // ---- lights -----------------------------------------------------------
    this.explosion({ x: f.x, y: gy + 1, z: f.z, groundY: gy, radius: 4, element: 'fire', magnitude: 1.5 });
    this._step(1 / 60, this.time);
    check('explosion lights the scene', this.lights.stats().lit > 0, JSON.stringify(this.lights.stats()));

    // ---- the shadow set ---------------------------------------------------
    const e = this.extract({ x: f.x, y: gy, z: f.z, groundY: gy, rank: 3 });
    check('extraction starts', !!e?.active);
    // Run the whole 1.55 s timeline and confirm every phase produced something.
    let sawColumn = false, sawSil = false, peakLight = 0;
    for (let i = 0; i < 110; i++) {
      this.time += 1 / 60;
      this._step(1 / 60, this.time);
      if (e.column >= 0 && this.mesh.isBusy('columns', e.column)) sawColumn = true;
      if (e.arose) sawSil = true;
      for (const l of this.lights.lights) peakLight = Math.max(peakLight, l.intensity);
    }
    check('extraction raises a column', sawColumn);
    check('extraction reaches ARISE', sawSil);
    check('extraction peaks the light', peakLight > 40, `${peakLight.toFixed(1)} cd`);
    check('extraction finishes', !e.active);

    // ---- ribbons ----------------------------------------------------------
    const h = this.trail({ color: ELEMENTS.shadow.core, width: 0.2, life: 0.4 });
    for (let i = 0; i < 12; i++) this.trailPush(h, f.x + i * 0.2, gy + 1, f.z, 0, 0, 0);
    this.ribbons.update(1 / 60);
    check('ribbon accepts samples', this.ribbons.stats().live > 0, JSON.stringify(this.ribbons.stats()));
    this.trailStop(h);

    // ---- budgets ----------------------------------------------------------
    // Hammer the emitter and confirm it clamps rather than growing.
    for (let i = 0; i < 60; i++) {
      this.explosion({ x: f.x, y: gy + 1, z: f.z, groundY: gy, radius: 5, element: 'shadow', magnitude: 2 });
    }
    check('particle budget respected', this.particles.live <= this.particles.capacity,
      `${this.particles.live}/${this.particles.capacity}`);
    check('decal budget respected', this.decals.live <= this.decals.capacity,
      `${this.decals.live}/${this.decals.capacity}`);

    // Everything must drain. A leak here is a permanent frame-rate loss.
    for (let i = 0; i < 400; i++) { this.time += 1 / 60; this._step(1 / 60, this.time); }
    check('particles drain', this.particles.live === 0, `${this.particles.live} left`);
    check('lights release', this.lights.stats().busy === 0, JSON.stringify(this.lights.stats()));
    check('mesh effects release', this.mesh.stats().rings.startsWith('0/'), JSON.stringify(this.mesh.stats()));

    this.clearTransients(true);
    out.stats = this.stats();
    return out;
  }

  dispose() {
    for (const off of this._offs ?? []) off();
    this._offs = null;

    this.flash.dispose();
    this.screen.dispose();
    this.mesh.dispose();
    this.ribbons.dispose();
    this.decals.dispose();
    this.lights.dispose(this.render);
    this.particles.dispose();
    this.atlas.dispose();
    this.root?.parent?.remove(this.root);
  }
}
