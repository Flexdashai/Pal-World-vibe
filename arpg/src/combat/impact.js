/**
 * MONARCH — impact.
 *
 * THIS IS THE FILE THAT DECIDES WHETHER THE GAME FEELS GOOD.
 *
 * Every landed hit must produce, in this order and inside ~120 ms:
 *
 *   1. hit-stop            `time:hitstop`, scaled by damage, capped, NOT stacked
 *   2. camera shake        `camera:shake`, plus a directional `camera:impulse`
 *   3. a hit flash         on the target itself
 *   4. particles + a decal `fx:impact` — `fx` owns the burst and the decal
 *   5. stagger / knockback with real recovery, not a nudge
 *   6. a damage number     `ui` draws it off `combat:hit`
 *   7. an audio transient  `audio` plays it off `combat:hit`
 *
 * A hit missing any one of them reads as weightless, and the failure is not
 * obvious from a screenshot — which is why they are enumerated here rather than
 * scattered across the skills that fire them.
 *
 * ---------------------------------------------------------------------------
 * THE HARD PART IS DOING IT ONCE
 *
 * Producing seven cues per hit is easy. Producing them for a nova that strikes
 * fourteen enemies on one frame, without turning the frame into a stutter and a
 * mush, is the actual work:
 *
 *   hit-stop   ONE per IMPACT.hitstopRefractory (160 ms), duration taken from
 *              the LARGEST hit in the group — so twelve small hits never
 *              out-freeze one big one, and a six-hit flurry gets one stop per
 *              swing rather than six overlapping stops.
 *   shake      accumulated across the whole frame, then clamped, then emitted
 *              ONCE. Twelve 0.2 shakes summed and clamped to 0.62 is a big
 *              shake; twelve separate 0.2 shakes is a vibration.
 *   impulse    accumulated as a VECTOR, so an AoE that throws enemies in every
 *              direction produces almost no net camera push (correct — the
 *              player is at the centre) while a single side-on blow produces a
 *              clean directional punch.
 *   flash/fx   per hit, but capped at IMPACT.fullFxPerFrame. Beyond eight
 *              simultaneous impact bursts the frame is visually saturated and
 *              the extra ones cost 2.5x for nothing.
 *   number     always. Numbers are the readout; `ui` merges them by target key.
 *
 * ---------------------------------------------------------------------------
 * WHO APPLIES THE DAMAGE
 *
 * ARCHITECTURE.md: `combat:hit` means damage dealt TO `target`; the target's own
 * listener applies it and the emitter never applies it too. We emit, and then
 * observe. If the target's health did not move and it has never been seen to
 * self-apply, we fall back to the actor interface's `applyDamage` once — that
 * makes combat correct against an `ai` that implements the actor interface but
 * forgets the listener, without ever double-applying to one that does not.
 */

import * as THREE from 'three';
import { IMPACT, DAMAGE, clamp, clamp01 } from './tuning.js';

export class ImpactDirector {
  constructor(ctx, sparks) {
    this.ctx = ctx;
    this.sparks = sparks;

    // ---- reused event payloads ---------------------------------------------
    // ARCHITECTURE.md forbids fresh object literals on anything that can fire
    // more than a few times a second. Every one of these fires per hit.
    this._hit = {
      source: null, target: null, amount: 0, element: 'physical', crit: false,
      position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
      stagger: 0, skill: null, raw: 0, dot: false, surface: 'flesh',
    };
    this._kill = {
      actor: null, killer: null, position: new THREE.Vector3(),
      overkill: 0, element: 'physical', gib: false,
    };
    this._miss = { source: null, position: new THREE.Vector3() };
    this._stagger = { actor: null, amount: 0, dir: new THREE.Vector3() };
    this._fxImpact = {
      position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
      surface: 'flesh', element: 'physical', magnitude: 1,
    };
    this._hitstop = { duration: 0, scale: IMPACT.hitstopScale };
    this._shake = { amount: 0, duration: 0.2, frequency: 26 };
    this._impulse = { dir: new THREE.Vector3(), amount: 0 };
    this._explosion = {
      position: new THREE.Vector3(), radius: 3, element: 'shadow',
      magnitude: 1, knockback: 0,
    };
    this._cue = { cue: '', position: new THREE.Vector3(), gain: 1 };

    // ---- per-frame accumulators --------------------------------------------
    this._frame = -1;
    this._fullFx = 0;
    this._shakeSum = 0;
    this._shakeWeight = 0;
    this._impulseX = 0;
    this._impulseZ = 0;
    this._impulseMag = 0;
    this._stopWant = 0;
    this._stopCrit = false;
    this._lastStopAt = -1e9;

    this._v = new THREE.Vector3();

    /**
     * Actors currently inside a stagger recovery, so the flag can be cleared
     * when the window closes. Bounded: past 24 simultaneously staggered actors
     * the oldest is dropped, which at worst leaves one actor's boolean set for
     * a moment longer than it should be.
     */
    this._staggered = [];

    /**
     * True when a live `fx` subsystem is listening to `combat:hit` and drawing
     * the whole reaction itself (blood, impact particles, decal, material
     * flash). In that case combat must NOT also emit `fx:impact` for the same
     * blow: `fx` does not de-duplicate the two — `audio` does, `fx` does not —
     * and the result is two impact bursts and two decals on every hit.
     *
     * `fx:impact` then keeps its honest meaning: "something struck a SURFACE".
     * Actor hits travel on `combat:hit`, world hits on `fx:impact` (which
     * `physics` already emits for every projectile).
     */
    this.fxHandlesActorHits = false;

    this.counters = { hits: 0, kills: 0, crits: 0, stops: 0, staggers: 0, dots: 0 };
  }

  /** Reset the per-frame accumulators when the engine frame index moves. */
  _beginFrame() {
    const f = this.ctx.time.frame;
    if (f === this._frame) return;
    this._frame = f;
    this._fullFx = 0;
  }

  /* ================================================================== */
  /* The one entry point for a landed blow                              */
  /* ================================================================== */

  /**
   * @param source   attacking actor (may be null)
   * @param target   actor being hit
   * @param res      a `damage.js` result record
   * @param def      the skill definition (for stagger/knockback/shakeWeight)
   * @param hx,hy,hz the impact point
   * @param dx,dz    unit XZ direction from source to target (the blow's push)
   * @returns true if the target died from this blow
   */
  land(source, target, res, def, hx, hy, hz, dx, dz) {
    this._beginFrame();
    this.counters.hits++;
    if (res.crit) this.counters.crits++;

    const st = target?.stats ?? null;
    const hpBefore = st?.hp ?? Infinity;
    const aliveBefore = target?.alive !== false;
    const toPlayer = target?.isPlayer === true;

    // ---- 6/7. the payload everything else reads ---------------------------
    // Emitted FIRST so the target has applied the damage before we ask whether
    // it died, and so `ui`'s number and `audio`'s transient are in flight while
    // we do the rest of the presentation.
    //
    // `amount` for a player target is the PRE-mitigation figure, because the
    // player subsystem runs its own armour curve on whatever it receives.
    // Anything else gets the final figure. Both are on the payload.
    const e = this._hit;
    e.source = source;
    e.target = target;
    e.amount = toPlayer ? res.raw : res.amount;
    e.raw = res.raw;
    e.element = res.element;
    e.crit = res.crit;
    e.position.set(hx, hy, hz);
    e.normal.set(-dx, 0.28, -dz).normalize();
    e.stagger = def?.stagger ?? 0;
    e.skill = def?.id ?? null;
    e.dot = false;
    e.surface = surfaceOf(target);
    this.ctx.events.emit('combat:hit', e);

    // ---- did anyone actually apply it? ------------------------------------
    this._ensureApplied(target, res, source, hpBefore, e.amount);

    // ---- 1. hit-stop -------------------------------------------------------
    // Accumulated, not emitted: `flush()` fires at most one per frame and at
    // most one per refractory window, using the largest severity seen.
    const weight = def?.shakeWeight ?? 0.2;
    const sev = res.severity;
    const want = IMPACT.hitstopBase + sev * IMPACT.hitstopSpan;
    if (want > this._stopWant) { this._stopWant = want; this._stopCrit = res.crit; }
    else if (res.crit) this._stopCrit = true;

    // ---- 2. shake + impulse -----------------------------------------------
    this._shakeSum += IMPACT.shakeBase + sev * IMPACT.shakeSpan;
    this._shakeWeight = Math.max(this._shakeWeight, weight);
    const imp = IMPACT.impulseBase + sev * IMPACT.impulseSpan;
    // Vector accumulation: an AoE that throws bodies in all directions nets out
    // to nearly zero push, which is right — the player is standing in the
    // middle of it and should not be shoved sideways.
    this._impulseX += dx * imp;
    this._impulseZ += dz * imp;
    this._impulseMag += imp;

    // ---- 3/4. flash + particles -------------------------------------------
    const budget = this._fullFx < IMPACT.fullFxPerFrame;
    if (budget) {
      this._fullFx++;
      // The flash is ours (ARCHITECTURE gives `fx` the burst and the decal, and
      // gives combat "a hit flash on the target"). It is also the only piece of
      // impact feedback that still works when `fx` is a stub.
      this.sparks?.hit(hx, hy, hz, -dx, -dz, res, def);
      // The target's own material response, for whoever owns its material.
      if (target) {
        target.hitFlash = 1;
        target.hitFlashAt = this.ctx.time.elapsed;
      }
      if (!this.fxHandlesActorHits) {
        const fi = this._fxImpact;
        fi.position.set(hx, hy, hz);
        fi.normal.copy(e.normal);
        fi.surface = e.surface;
        fi.element = res.element;
        fi.magnitude = clamp(0.4 + sev * 1.6 + (res.crit ? 0.4 : 0), 0.3, 2.2);
        this.ctx.events.emit('fx:impact', fi);
      }
    }

    // ---- 5. stagger + knockback -------------------------------------------
    this._applyStagger(target, def, res, dx, dz);

    // ---- kill --------------------------------------------------------------
    const died = aliveBefore &&
      (target?.alive === false || (st ? st.hp <= 0 : false));
    if (died) this.kill(target, source, res, hx, hy, hz);
    return died;
  }

  /**
   * Damage-over-time. Emits `combat:hit` with `dot: true` so `ui` still shows a
   * number and `audio` still ticks, but skips the whole impact pipeline — a
   * four-stack burn must not shake the camera twice a second for four seconds.
   */
  landDot(source, target, res, statusId) {
    this.counters.dots++;
    const st = target?.stats ?? null;
    const hpBefore = st?.hp ?? Infinity;
    const aliveBefore = target?.alive !== false;
    const toPlayer = target?.isPlayer === true;

    const e = this._hit;
    e.source = source;
    e.target = target;
    e.amount = toPlayer ? res.raw : res.amount;
    e.raw = res.raw;
    e.element = res.element;
    e.crit = false;
    e.position.set(
      target.position.x,
      target.position.y + (target.height ?? 1.8) * 0.7,
      target.position.z
    );
    e.normal.set(0, 1, 0);
    e.stagger = 0;
    e.skill = statusId;
    e.dot = true;
    e.surface = surfaceOf(target);
    this.ctx.events.emit('combat:hit', e);
    this._ensureApplied(target, res, source, hpBefore, e.amount);

    if (aliveBefore && (target?.alive === false || (st ? st.hp <= 0 : false))) {
      this.kill(target, source, res, e.position.x, e.position.y, e.position.z);
      return true;
    }
    return false;
  }

  /**
   * Fall back to the actor interface if nothing applied the damage.
   *
   * The first time a target is observed to reduce its own health in response to
   * `combat:hit` we mark it and never fall back again, so a target that applies
   * damage through a shield (health unchanged, damage genuinely consumed) is
   * only ever at risk on its very first hit.
   */
  _ensureApplied(target, res, source, hpBefore, amount) {
    if (!target || target._mnSelfApplies) return;
    const st = target.stats;
    const after = st?.hp ?? hpBefore;
    if (after < hpBefore || target.alive === false) {
      target._mnSelfApplies = true;
      return;
    }
    if (typeof target.applyDamage === 'function') {
      this._v.set(0, 0, 0);
      target.applyDamage({
        amount, element: res.element, crit: res.crit, dir: null, source,
      });
    }
  }

  /** Stagger with real recovery, and a knockback the physics can see. */
  _applyStagger(target, def, res, dx, dz) {
    if (!target || target.alive === false) return;
    const poise = target.stats?.poise ?? 30;
    const amount = (def?.stagger ?? 0) * (res.crit ? 1.35 : 1);
    if (amount <= 0) return;

    this._v.set(dx, 0, dz);
    let staggered = false;
    if (typeof target.applyStagger === 'function') {
      staggered = target.applyStagger(amount, this._v) === true;
    } else if (amount > poise) {
      // No owner implementation: publish the window on the actor so whoever
      // drives it can read it, and let the velocity do the rest.
      staggered = true;
    }

    if (amount > poise) {
      // Recovery scales with how far the blow exceeded poise, so a heavy skill
      // against a light enemy is a real interruption and a light skill against
      // a boss is not.
      const over = clamp01((amount - poise) / Math.max(1, poise));
      const recover = IMPACT.staggerMin + over * (IMPACT.staggerMax - IMPACT.staggerMin);
      target.staggerUntil = this.ctx.time.elapsed + recover;
      target.staggered = true;
      this.counters.staggers++;
      if (this._staggered.indexOf(target) < 0) {
        if (this._staggered.length >= 24) this._staggered.shift();
        this._staggered.push(target);
      }
      const s = this._stagger;
      s.actor = target;
      s.amount = amount;
      s.dir.set(dx, 0, dz);
      this.ctx.events.emit('actor:stagger', s);
    }

    // Knockback goes into the actor's VELOCITY, which is a live reference the
    // character controller integrates — so a body knocked into a wall stops at
    // the wall instead of sliding through it. Never applied to the player by an
    // enemy hit here; the player subsystem owns its own reaction.
    const kb = def?.knockback ?? 0;
    if (kb > 0 && target.velocity && !target.isPlayer) {
      const mass = target.weight ?? (target.isBoss ? 6 : 1);
      const push = clamp(kb * IMPACT.knockbackScale / mass, 0, IMPACT.knockbackMax);
      target.velocity.x += dx * push;
      target.velocity.z += dz * push;
      // A little lift on a big hit: bodies that only slide read as furniture.
      if (staggered && kb > 0.7) target.velocity.y += Math.min(3.2, push * 0.22);
    }
  }

  /* ================================================================== */
  /* Kills                                                              */
  /* ================================================================== */

  kill(actor, killer, res, hx, hy, hz) {
    if (!actor || actor._mnKilled) return;
    actor._mnKilled = true;
    this.counters.kills++;
    const k = this._kill;
    k.actor = actor;
    k.killer = killer;
    k.position.set(hx, hy, hz);
    k.overkill = res?.overkill ?? 0;
    k.element = res?.element ?? 'physical';
    // Overkill past 55% of the victim's max health is an obliteration — `fx`
    // switches to gibs, `audio` to the heavier death layer.
    k.gib = k.overkill > (actor.stats?.hpMax ?? 100) * DAMAGE.gibFraction;
    this.ctx.events.emit('combat:kill', k);

    // A kill is a beat. It gets its own small stop and shake regardless of the
    // damage that caused it, because the LAST hit of a fight should never feel
    // like the fifth.
    this._stopWant = Math.max(this._stopWant, IMPACT.hitstopBase + 0.035);
    this._shakeSum += 0.06 + (k.gib ? 0.14 : 0);
  }

  /** A skill that resolved to nothing. `ui` draws MISS, `audio` plays the
   *  whiff. Without it a swing into empty air is completely silent, which is
   *  the most common thing a player does. */
  miss(source, x, y, z) {
    const m = this._miss;
    m.source = source;
    m.position.set(x, y, z);
    this.ctx.events.emit('combat:miss', m);
  }

  /* ================================================================== */
  /* Explosions and one-off cues                                        */
  /* ================================================================== */

  /**
   * Announce an explosion. `physics` shoves debris/ragdolls/chains off this,
   * `fx` draws it, `sky` parts the ground mist, `audio` blooms the reverb and
   * `player` punches the coat. Knockback defaults to 0 because combat applies
   * its own actor displacement in `_applyStagger`; passing it here as well
   * would move every actor twice.
   */
  explode(x, y, z, radius, element, magnitude, knockback = 0) {
    const e = this._explosion;
    e.position.set(x, y, z);
    e.radius = radius;
    e.element = element;
    e.magnitude = magnitude;
    e.knockback = knockback;
    this.ctx.events.emit('fx:explosion', e);
  }

  cue(name, x, y, z, gain = 1) {
    const c = this._cue;
    c.cue = name;
    c.position.set(x, y, z);
    c.gain = gain;
    this.ctx.events.emit('audio:cue', c);
  }

  /** Directly requested shake — a skill's cast, not a hit. Goes through the
   *  same accumulator so it merges with everything else this frame. */
  addShake(amount, weight = 0.5) {
    this._beginFrame();
    this._shakeSum += amount;
    this._shakeWeight = Math.max(this._shakeWeight, weight);
  }

  addImpulse(dx, dz, amount) {
    this._impulseX += dx * amount;
    this._impulseZ += dz * amount;
    this._impulseMag += amount;
  }

  /** Request a hit-stop directly (a skill's own impact frame, not a hit). */
  addHitstop(duration, crit = false) {
    this._stopWant = Math.max(this._stopWant, duration);
    if (crit) this._stopCrit = true;
  }

  /* ================================================================== */
  /* Frame flush                                                        */
  /* ================================================================== */

  /**
   * Emit the aggregated feel exactly once per frame. Call from `update()`,
   * after every `fixedUpdate` for the frame has run.
   */
  flush() {
    const now = this.ctx.time.raw;

    // ---- stagger recovery ---------------------------------------------------
    const t = this.ctx.time.elapsed;
    for (let i = this._staggered.length - 1; i >= 0; i--) {
      const a = this._staggered[i];
      if (!a || a.alive === false || (a.staggerUntil ?? 0) <= t) {
        if (a) a.staggered = false;
        this._staggered[i] = this._staggered[this._staggered.length - 1];
        this._staggered.pop();
      }
    }

    // ---- hit-stop ----------------------------------------------------------
    if (this._stopWant > 0) {
      if (now - this._lastStopAt >= IMPACT.hitstopRefractory) {
        this._lastStopAt = now;
        const h = this._hitstop;
        h.duration = Math.min(
          this.ctx.config.hitstopMax,
          this._stopWant * (this._stopCrit ? IMPACT.hitstopCrit : 1)
        );
        h.scale = IMPACT.hitstopScale;
        this.ctx.events.emit('time:hitstop', h);
        this.counters.stops++;
      }
      this._stopWant = 0;
      this._stopCrit = false;
    }

    // ---- shake -------------------------------------------------------------
    if (this._shakeSum > 0.004) {
      const s = this._shake;
      s.amount = Math.min(IMPACT.shakeFrameMax, this._shakeSum);
      // Weight blends between a fast tight rattle (a blade) and a slow heavy
      // roll (an explosion). A single duration for both makes every hit in the
      // game feel like the same hit.
      const w = clamp01(this._shakeWeight);
      s.duration = IMPACT.shakeFastDuration + (IMPACT.shakeHeavyDuration - IMPACT.shakeFastDuration) * w;
      s.frequency = IMPACT.shakeFastFreq + (IMPACT.shakeHeavyFreq - IMPACT.shakeFastFreq) * w;
      this.ctx.events.emit('camera:shake', s);
      this._shakeSum = 0;
      this._shakeWeight = 0;
    }

    // ---- impulse -----------------------------------------------------------
    const im = Math.hypot(this._impulseX, this._impulseZ);
    if (im > 0.002) {
      const p = this._impulse;
      p.dir.set(this._impulseX / im, 0, this._impulseZ / im);
      // The magnitude is the VECTOR length, not the scalar sum: a symmetric AoE
      // cancels to nothing while a side-on blow keeps all of it.
      p.amount = Math.min(IMPACT.impulseFrameMax, im);
      this.ctx.events.emit('camera:impulse', p);
    }
    this._impulseX = 0;
    this._impulseZ = 0;
    this._impulseMag = 0;
  }

  stats() {
    return { ...this.counters };
  }
}

/** Surface tag for an actor, from the shared vocabulary in ARCHITECTURE.md.
 *  Drives which impact sound and which decal texture gets used. */
function surfaceOf(target) {
  if (!target) return 'stone';
  if (target.surface) return target.surface;
  if (target.isShadow) return 'ash';
  const k = String(target.archetype ?? target.kind ?? target.name ?? '').toLowerCase();
  if (/skele|bone|lich|wraith/.test(k)) return 'bone';
  if (/golem|construct|armour|knight/.test(k)) return 'metal';
  if (/crystal|shard/.test(k)) return 'crystal';
  return 'flesh';
}
