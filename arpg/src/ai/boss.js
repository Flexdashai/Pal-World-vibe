import * as THREE from 'three';
import { EnemyActor, ACTOR_STATE as S, distXZ } from './actor.js';
import { BOSS, TELEGRAPH, clamp, clamp01, lerp } from './tuning.js';
import { ELEMENTS } from '../core/palette.js';

/**
 * MONARCH — THE RELIQUARY WARDEN.
 *
 * The boss is an `EnemyActor` with a different brain. Everything below the
 * behaviour — the rig, the mesh, the animator, the ragdoll, the damage
 * plumbing — is the same code every ghoul uses, which is the point: a boss that
 * is a separate system is a boss that drifts out of sync with the rest of the
 * game every time anything changes.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES IT A BOSS FIGHT AND NOT A BIG ENEMY
 *
 *  1. **PHASES.** Three, at 100% / 66% / 32%. Each unlocks attacks and shortens
 *     the cadence. The transition is a real beat: 1.55 s of unmoving roar with
 *     the core flaring and every live telegraph cancelled, so the player gets a
 *     free breath and an unmissable signal that the rules just changed.
 *
 *  2. **A ROTATION, NOT A RANDOM PICK.** Attacks are weighted and the last one
 *     is excluded, so the fight has a rhythm the player can learn without it
 *     ever becoming a fixed loop. Learning the tell for each attack is the
 *     entire skill of the encounter.
 *
 *  3. **A VULNERABILITY WINDOW.** The heavy attacks (`opensWindow`) leave the
 *     Warden over-committed: for 3.1 s the chest cavity opens, the core light
 *     goes from 4.5 to 26, `vulnerable` goes true and its armour drops to zero.
 *     That window is where the fight is actually won, and it is deliberately
 *     opened by the attacks that are hardest to survive — so the reward is
 *     proportional to the risk the player just took.
 *
 *  4. **ADDS.** Phase II summons ghouls. They are not filler: they exist so the
 *     player's shadow army has something to fight while the player concentrates
 *     on the Warden, which is when the army stops being decoration.
 *
 *  5. **ONE LIGHT.** The core is the only light this subsystem owns. It is
 *     created once at init and never removed, and it is driven by INTENSITY —
 *     the visible light count is a shader permutation key (ARCHITECTURE.md) and
 *     a light that appears mid-fight recompiles every material in the scene.
 */

const PHASE_TITLES = BOSS.phases.map((p) => p.title);

export class BossActor extends EnemyActor {
  constructor(ai, asset, index) {
    super(ai, asset, index);

    this.phase = 0;
    this.phaseName = BOSS.phases[0].name;
    this.phases = BOSS.phases.map((p) => p.name);
    this.title = BOSS.phases[0].title;
    this.breakUntil = 0;
    this.nextAttackAt = 0;
    this.lastAttackId = '';
    this.vulnerableUntil = 0;
    this.vulnerableCd = 0;
    this.baseArmour = 0;
    this.coreGlow = 1;
    this._pending = null;      // a multi-part attack still resolving
    this._pendingT = 0;
    this._pendingN = 0;
    this._shardHandles = [];
    this._shardAt = [];
    this._flailTick = 0;
    this._corePos = new THREE.Vector3();
  }

  spawn(o) {
    super.spawn(o);
    this.phase = 0;
    this.phaseName = BOSS.phases[0].name;
    this.title = BOSS.phases[0].title;
    this.breakUntil = 0;
    this.nextAttackAt = this.ctx.time.elapsed + 1.4;
    this.lastAttackId = '';
    this.vulnerableUntil = 0;
    this.vulnerableCd = 0;
    this.vulnerable = false;
    this.baseArmour = this.stats.armour;
    this._pending = null;
    this._shardHandles.length = 0;
    this._shardAt.length = 0;
    this.coreGlow = 1;
    // The Warden enters with a roar. It is the first thing the player sees of
    // it and it establishes the scale before the fight starts.
    this.anim.play('roar', 2.0, { restart: true, fade: 0.1 });
    this._cueVox('growl', 1.0);
    this.ai.onBossSpawned(this);
    return this;
  }

  /* ==================================================================== */
  /* damage → phases and the window                                       */
  /* ==================================================================== */

  applyDamage(o) {
    const before = this.stats.hp;
    const taken = super.applyDamage(o);
    if (!this.alive) return taken;

    // ---- poise break --------------------------------------------------------
    // Sustained damage inside a short window cracks the Warden open even if the
    // player never punishes an attack. It is the pressure valve that keeps a
    // patient fight from becoming a stalemate.
    this._poiseAccum = (this._poiseAccum ?? 0) + taken;
    const now = this.ctx.time.elapsed;
    if (this._poiseAccum > this.stats.hpMax * 0.055 && this.vulnerableCd <= 0) {
      this._poiseAccum = 0;
      this.openWindow(BOSS.vulnerable.poiseBreak);
    }

    // ---- phase --------------------------------------------------------------
    const frac = this.stats.hp / Math.max(1, this.stats.hpMax);
    for (let i = BOSS.phases.length - 1; i > this.phase; i--) {
      if (frac <= BOSS.phases[i].at) { this._enterPhase(i); break; }
    }
    void before;
    return taken;
  }

  _enterPhase(i) {
    this.phase = i;
    this.phaseName = BOSS.phases[i].name;
    this.title = BOSS.phases[i].title;
    const now = this.ctx.time.elapsed;
    this.breakUntil = now + BOSS.phaseBreak;
    this.nextAttackAt = this.breakUntil + 0.35;
    this._cancelAttack(true);
    this._closeWindow();
    this.ai.telegraphs.clear();
    this.anim.play('roar', BOSS.phaseBreak * 1.1, { restart: true, fade: 0.08 });
    this._cueVox('growl', 1.0);

    // The beat. Screen shake, a violet detonation from the core, a SYSTEM
    // window, and the boss bar re-labelled.
    this.ai.shake(0.55, 1.0);
    this.ai.explosion(this.position, 7.0, 'shadow', 1.6, this.height * 0.55);
    this.ai.ui?.setBossPhase?.(i, this.title);
    this.ai.system('THE WARDEN STIRS', [
      `Phase ${this.phaseName} — ${this.title}`,
      i === 1 ? 'The seals are breaking.' : 'Nothing is holding it now.',
    ], 3.4);
    this.coreGlow = 2.2;
  }

  /** Open the vulnerability window. Public so a scripted moment can too. */
  openWindow(seconds = BOSS.vulnerable.duration) {
    const now = this.ctx.time.elapsed;
    this.vulnerableUntil = now + seconds;
    this.vulnerableCd = BOSS.vulnerable.cooldown;
    this.vulnerable = true;
    // Armour to zero rather than a damage multiplier: `combat/damage.js` already
    // reads `vulnerable` for its own multiplier, and stacking a second one on
    // top of it produced a window that deleted a third of the health bar.
    this.stats.armour = 0;
    this.coreGlow = 2.6;
    this.ai.system('EXPOSED', ['The core is open.', 'Strike now.'], 1.8);
    this.ai.toast('EXPOSED', 'good');
    this._cueVox('hurt', 1.0);
    this.ai.shake(0.18, 0.7);
  }

  _closeWindow() {
    if (!this.vulnerable) return;
    this.vulnerable = false;
    this.vulnerableUntil = 0;
    this.stats.armour = this.baseArmour;
  }

  /* ==================================================================== */
  /* the brain                                                            */
  /* ==================================================================== */

  _think(h, now) {
    if (this.vulnerableCd > 0) this.vulnerableCd -= h;
    if (this.vulnerable && now > this.vulnerableUntil) this._closeWindow();

    // ---- the phase break ----------------------------------------------------
    if (now < this.breakUntil) {
      this.velocity.x = 0; this.velocity.z = 0;
      this.anim.alert = 1;
      return;
    }

    // ---- multi-part attacks still resolving ---------------------------------
    if (this._pending) { this._stepPending(h, now); return; }

    const t = this.target;
    if (!t) {
      // No target: the Warden does not wander. It stands in its arena, which is
      // most of why the arena reads as its.
      if (this.state !== S.IDLE) this._enter(S.IDLE);
      this.anim.alert = lerp(this.anim.alert, 0.2, h * 2);
      return;
    }
    this.anim.alert = 1;

    if (this.state === S.WINDUP || this.state === S.STRIKE || this.state === S.SPECIAL) {
      this._stepAttack(h, now);
      return;
    }
    if (this.state === S.RECOVER) {
      if (this.stateT > this.act.duration * 0.55) this._enter(S.CHASE);
      return;
    }

    // ---- choose ------------------------------------------------------------
    const dist = distXZ(this.position, t.position);
    if (now >= this.nextAttackAt && dist < BOSS.engageRange * 2.4) {
      const pick = this._chooseAttack(dist);
      if (pick) { this._beginBossAttack(pick); return; }
    }
    if (this.state !== S.CHASE) this._enter(S.CHASE);
  }

  /**
   * Weighted pick from the attacks unlocked by the current phase, excluding the
   * one just used and anything out of range. Deterministic through `ai.rng`.
   */
  _chooseAttack(dist) {
    const list = this.ai._bossPicks;
    list.length = 0;
    let total = 0;
    for (const key of Object.keys(BOSS.attacks)) {
      const a = BOSS.attacks[key];
      if (a.phase > this.phase) continue;
      if (a.id === this.lastAttackId && Object.keys(BOSS.attacks).length > 2) continue;
      // Range gating: a sweep is useless at 14 m and a fissure is wasted at 2 m.
      const reach = a.range ?? a.radius ?? 6;
      if (a.id === 'fissure' && dist < 5) continue;
      if (a.id === 'sweep' && dist > reach * this.scale * 1.15) continue;
      if (a.id === 'slam' && dist > reach * this.scale * 1.4) continue;
      if (a.id === 'summon' && this.ai.enemyCount() > this.ai.maxActors * 0.55) continue;
      list.push(a);
      total += a.weight;
    }
    if (list.length === 0) return null;
    let r = this.ai.rng.float() * total;
    for (const a of list) { r -= a.weight; if (r <= 0) return a; }
    return list[list.length - 1];
  }

  _beginBossAttack(spec) {
    this.lastAttackId = spec.id;
    const now = this.ctx.time.elapsed;
    this.nextAttackAt = now + spec.windup + spec.recover + BOSS.cadence[this.phase];

    switch (spec.id) {
      case 'shards':
      case 'summon':
      case 'nova':
      case 'flail':
        this._beginPending(spec, now);
        return;
      default:
        // sweep, slam and fissure are ordinary telegraphed attacks and go
        // through exactly the same path a knight's heavy does.
        this._beginAttack(spec.id, spec);
        return;
    }
  }

  /** Resolve an ordinary attack, then open the window if it is one of the
   *  over-committing ones. */
  _resolve(kind, spec) {
    switch (kind) {
      case 'sweep': {
        const hits = this.ai.queryCone(this, spec.range * this.scale, spec.halfAngle);
        for (let i = 0; i < hits.count; i++) {
          const target = hits.actors[i];
          if (!target || target.alive === false) continue;
          const atk = this._atk;
          atk.source = this;
          atk.target = target;
          atk.amount = this.stats.damage * spec.damage;
          atk.element = 'physical';
          atk.skill = 'boss.sweep';
          atk.stagger = spec.stagger;
          atk.knockback = spec.knockback;
          atk.shakeWeight = 0.85;
          this.ai.combat?.attack?.(atk);
        }
        this.ai.shake(0.36, 0.9);
        break;
      }
      case 'slam':
        this._areaHit(this.position, spec.radius * this.scale, spec.damage,
          'physical', 12, spec.knockback, true);
        this.ai.shake(0.55, 1.0);
        this.ai.hitstop(0.09);
        // Two expanding shock rings after the impact — a slam that produces one
        // ring reads as a stomp, two reads as the floor breaking.
        for (let i = 0; i < (spec.shockRings ?? 0); i++) {
          this.ai.telegraphs.circle({
            x: this.position.x, y: this.position.y, z: this.position.z,
            radius: spec.radius * this.scale * (1.4 + i * 0.5),
            windup: 0.28 + i * 0.12, hold: 0.18,
            colour: TELEGRAPH.colour, intensity: 0.7,
          });
        }
        break;
      case 'fissure': {
        // A corridor of damage running out from the Warden. Resolved as three
        // overlapping circles along the axis rather than one long box, because
        // that is what `combat.areaAttack` can express and the difference is
        // invisible at this scale.
        const dx = Math.sin(this.yaw), dz = Math.cos(this.yaw);
        for (let i = 1; i <= 3; i++) {
          const d = (spec.range / 3) * i * 0.85;
          this._v.set(this.position.x + dx * d, this.position.y, this.position.z + dz * d);
          this._areaHit(this._v, spec.halfWidth * 2.1, spec.damage / 3,
            'physical', 6, spec.knockback, i === 2);
        }
        this.ai.shake(0.40, 1.0);
        break;
      }
      default:
        super._resolve(kind, spec);
        return;
    }
    if (spec.opensWindow && this.vulnerableCd <= 0) {
      this.openWindow(BOSS.vulnerable.duration);
    }
  }

  /* ==================================================================== */
  /* multi-part attacks                                                   */
  /* ==================================================================== */

  _beginPending(spec, now) {
    this._pending = spec;
    this._pendingT = 0;
    this._pendingN = 0;
    this._flailTick = 0;
    this._shardHandles.length = 0;
    this._shardAt.length = 0;
    this.act.kind = spec.id;
    this.act.spec = spec;
    this.act.windup = spec.windup;
    this.act.duration = spec.windup + spec.recover;
    this.act.t = 0;
    this._enter(S.SPECIAL);
    this.anim.play(spec.id === 'summon' ? 'roar' : 'heavy',
      spec.windup + spec.recover, { restart: true, fade: 0.08 });
    this._cueVox('attack', 1.0);

    const t = this.target;
    if (t) this.yawTarget = Math.atan2(t.position.x - this.position.x, t.position.z - this.position.z);

    // ---- the indicators ------------------------------------------------------
    const T = this.ai.telegraphs;
    const hot = TELEGRAPH.bossColour;
    if (spec.id === 'shards' && t) {
      // A SEQUENCE the player walks out of, not a wall. Each circle lands a
      // beat after the last, biased along the player's movement so standing
      // still is safe and panicking is not.
      const vx = t.velocity?.x ?? 0, vz = t.velocity?.z ?? 0;
      for (let i = 0; i < spec.count; i++) {
        const lead = 0.30 + i * 0.28;
        const a = (i / spec.count) * Math.PI * 2 + this.ai.rng.range(-0.4, 0.4);
        const r = this.ai.rng.range(0, spec.spread * 0.5);
        const x = t.position.x + vx * lead + Math.sin(a) * r;
        const z = t.position.z + vz * lead + Math.cos(a) * r;
        this._shardHandles.push(T.circle({
          x, y: this.position.y, z, radius: spec.radius,
          windup: spec.windup + i * (spec.stagger_ ?? 0.3),
          colour: hot, intensity: TELEGRAPH.bossIntensity * 0.85,
        }));
        this._shardAt.push(spec.windup + i * (spec.stagger_ ?? 0.3));
      }
    } else if (spec.id === 'nova') {
      // THE ROOM-WIDE ONE. Three rings, expanding, resolving outward. There is
      // no safe spot inside them — the answer is to be outside when it lands,
      // which is why the wind-up is the longest in the fight.
      for (let i = 0; i < (spec.rings ?? 3); i++) {
        this._shardHandles.push(T.circle({
          x: this.position.x, y: this.position.y, z: this.position.z,
          radius: spec.radius * (0.42 + i * 0.29),
          windup: spec.windup, colour: hot,
          intensity: TELEGRAPH.bossIntensity * (1.0 - i * 0.16),
        }));
        this._shardAt.push(spec.windup + i * 0.16);
      }
    } else if (spec.id === 'flail') {
      this._shardHandles.push(T.circle({
        x: this.position.x, y: this.position.y, z: this.position.z,
        radius: spec.radius * this.scale, windup: spec.windup,
        hold: spec.strike, colour: TELEGRAPH.bossColour, intensity: TELEGRAPH.bossIntensity,
      }));
      this._shardAt.push(spec.windup);
    } else if (spec.id === 'summon') {
      this._shardHandles.push(T.circle({
        x: this.position.x, y: this.position.y, z: this.position.z,
        radius: spec.radius, windup: spec.windup, colour: hot,
        intensity: TELEGRAPH.bossIntensity * 0.7,
      }));
      this._shardAt.push(spec.windup);
    }
    void now;
  }

  _stepPending(h, now) {
    const spec = this._pending;
    this._pendingT += h;
    this.act.t = this._pendingT;
    this.velocity.x *= 0.82;
    this.velocity.z *= 0.82;

    switch (spec.id) {
      case 'shards':
      case 'nova': {
        while (this._pendingN < this._shardAt.length &&
               this._pendingT >= this._shardAt[this._pendingN]) {
          const handle = this._shardHandles[this._pendingN];
          const s = handle?.slot;
          this.ai.telegraphs.strike(handle);
          if (s) {
            this._v.set(s.x, this.position.y, s.z);
            this._areaHit(this._v, s.radius, spec.damage, 'shadow', 8,
              spec.knockback ?? 0.8, true);
          }
          this.ai.shake(spec.id === 'nova' ? 0.30 : 0.14, 0.8);
          this._pendingN++;
        }
        break;
      }
      case 'flail': {
        // A sustained spin: five ticks over `strike`, so standing inside it is
        // survivable for a moment and lethal if the player does not leave.
        if (this._pendingT >= spec.windup) {
          if (this._pendingN === 0) {
            this.ai.telegraphs.strike(this._shardHandles[0]);
            this._pendingN = 1;
          }
          this._flailTick += h;
          const step = spec.strike / spec.ticks;
          if (this._flailTick >= step && this._pendingN <= spec.ticks) {
            this._flailTick -= step;
            this._pendingN++;
            this._areaHit(this.position, spec.radius * this.scale, spec.damage,
              'physical', 10, spec.knockback, false);
            this.ai.shake(0.12, 0.6);
          }
          // Spin on the spot: the flail chain is a dynamic bone chain, so the
          // rotation alone makes the ball fly out on its own.
          this.yaw += h * 7.5;
          this.yawTarget = this.yaw;
        }
        break;
      }
      case 'summon': {
        if (this._pendingT >= spec.windup && this._pendingN === 0) {
          this._pendingN = 1;
          this.ai.telegraphs.strike(this._shardHandles[0]);
          this.ai.summonAdds(this, spec.spawn, spec.count, spec.radius);
          this.ai.explosion(this.position, spec.radius, 'shadow', 1.2, 0.3);
          this.ai.system('THE WARDEN CALLS', ['Its dead answer.'], 2.2);
        }
        break;
      }
      default:
        break;
    }

    if (this._pendingT >= spec.windup + spec.recover) {
      this._pending = null;
      this.act.spec = null;
      this.act.kind = '';
      this._shardHandles.length = 0;
      this._shardAt.length = 0;
      this._enter(S.RECOVER);
      if (spec.opensWindow && this.vulnerableCd <= 0) this.openWindow();
    }
    void now;
  }

  /* ==================================================================== */
  /* steering                                                             */
  /* ==================================================================== */

  _steer(h, now) {
    const t = this.target;
    if (!t) { this._integrate(h, 0, 0); return; }
    const dist = distXZ(this.position, t.position);
    const committed = this.state !== S.CHASE && this.state !== S.IDLE;

    let vx = 0, vz = 0;
    if (!committed && dist > BOSS.engageRange) {
      // The Warden walks. It never sprints and it never uses the flow field —
      // it is five metres across, it does not fit through a doorway and it has
      // no business leaving its arena.
      const dx = t.position.x - this.position.x, dz = t.position.z - this.position.z;
      const l = Math.max(0.01, Math.hypot(dx, dz));
      const speed = dist > BOSS.engageRange * 2 ? this.arch.speedRun : this.arch.speedWalk;
      vx = (dx / l) * speed;
      vz = (dz / l) * speed;
    }
    this._integrate(h, vx, vz);

    const turn = this.arch.turnRate * (committed ? 0.30 : 1);
    this.yawTarget = Math.atan2(t.position.x - this.position.x, t.position.z - this.position.z);
    let d = this.yawTarget - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += clamp(d, -turn * h, turn * h);
    void now;
  }

  /* ==================================================================== */
  /* the frame                                                            */
  /* ==================================================================== */

  update(dt, camFocus) {
    super.update(dt, camFocus);

    // ---- the core -----------------------------------------------------------
    // Its brightness is the boss's health bar, readable from anywhere in the
    // arena: dim while sealed, flaring on a phase turn, and a violet floodlight
    // while the window is open.
    const target = this.vulnerable ? 2.4 : this.alive ? 1.0 : 0.0;
    this.coreGlow = lerp(this.coreGlow, target, Math.min(1, dt * 3.2));
    const glow = this.materials.glow;
    if (glow) glow.emissiveIntensity = this.asset.skin.eyeGain * this.coreGlow;

    const light = this.ai.bossLight;
    if (light) {
      // The core sits in the chest cavity, which is at 0.62 of the body height
      // and pushed forward. Placing the light AT the mesh rather than at the
      // actor's feet is what makes the arena floor take a violet bounce.
      this._corePos.set(
        this.position.x + Math.sin(this.yaw) * this.height * 0.10,
        this.position.y + this.height * 0.62,
        this.position.z + Math.cos(this.yaw) * this.height * 0.10
      );
      light.position.copy(this._corePos);
      const c = BOSS.coreLight;
      light.intensity = this.alive
        ? lerp(c.base, c.vulnerable, clamp01((this.coreGlow - 1) / 1.4))
        : 0;
      light.distance = c.distance;
    }
  }

  _die(o) {
    super._die(o);
    const light = this.ai.bossLight;
    if (light) light.intensity = 0;
    this.ai.telegraphs.clear();
    this.ai.shake(0.85, 1.0);
    this.ai.hitstop(0.13);
    this.ai.explosion(this.position, 11, 'shadow', 2.4, this.height * 0.5);
    this.ai.system('THE WARDEN FALLS', [
      'Keeper of the Ash, undone.',
      'Its shadow is yours to take.',
    ], 5.0);
    this.ai.ui?.setBoss?.(null);
  }

  debug() {
    const d = super.debug();
    d.phase = this.phaseName;
    d.vulnerable = this.vulnerable;
    d.nextAttack = +Math.max(0, this.nextAttackAt - this.ctx.time.elapsed).toFixed(2);
    d.last = this.lastAttackId;
    return d;
  }
}

/** The one light this subsystem owns. Created at init, never removed, driven by
 *  intensity — see the class docblock and ARCHITECTURE.md's note on the visible
 *  point-light count being a shader permutation key. */
export function makeCoreLight(ctx) {
  const c = BOSS.coreLight;
  const light = new THREE.PointLight(
    new THREE.Color().setRGB(c.colour[0], c.colour[1], c.colour[2], THREE.LinearSRGBColorSpace),
    0, c.distance, 2
  );
  light.name = 'mn.ai.bossCore';
  light.castShadow = false;
  light.visible = true;      // ALWAYS visible; intensity 0 contributes nothing
  ctx.scene.add(light);
  ctx.peek('render')?.addLight?.(light);
  return light;
}

export { PHASE_TITLES, ELEMENTS };
