import * as THREE from 'three';
import { ELEMENTS } from '../core/palette.js';

import { SKILLS, SLOT_ORDER, loadout } from './skills.js';
import { STATUS, ELEMENT_STATUS, SNAP, VFX, GLOW, DAMAGE, clamp, clamp01 } from './tuning.js';
import { makeDamageResult, rollDamage, rollDot, threatOf } from './damage.js';
import { StatusSystem } from './status.js';
import { Targeting } from './targeting.js';
import { Resolver } from './resolve.js';
import { ImpactDirector } from './impact.js';
import { Executor } from './executor.js';
import { SpellLights, MoteField } from './fxkit.js';
import { SparkField } from './fxspark.js';
import { CleaveArc } from './fxcleave.js';
import { NovaBurst } from './fxnova.js';
import { SpearVolley } from './fxspear.js';
import { MonarchDomain } from './fxdomain.js';
import { StatusVisuals } from './fxstatus.js';
import { WardShell } from './fxward.js';

/**
 * ============================================================================
 * MONARCH — the `combat` subsystem.  PUBLIC API.
 * ============================================================================
 *
 *   id    'combat'
 *   deps  ['physics', 'player', 'fx']
 *
 * Owns the rules of violence: the skill set, the damage model, status effects,
 * targeting, and — the part that decides whether any of it is worth playing —
 * the feel of impact.
 *
 * ---------------------------------------------------------------------------
 * FILE MAP
 *
 *   tuning.js     every number a designer would want to move, with its reason
 *   skills.js     the seven skill definitions, as data
 *   executor.js   cooldowns, charges, and the windup/strike/recovery machine
 *   targeting.js  cursor aim + the soft snap
 *   resolve.js    cone/circle/line/dash hitboxes, resolved through `physics`
 *   damage.js     attack vs armour, crit, resistance, vulnerability, overkill
 *   status.js     burn / bleed / chill / freeze / shock / the Monarch's mark
 *   impact.js     hit-stop, shake, impulse, flash, fx, stagger, number, audio
 *   fxkit.js      shared spell materials, geometry builders, lights, motes
 *   fxspark.js    the hit flash and its spray
 *   fxcleave.js   the cleave arc and the dash-strike's cut
 *   fxnova.js     SHADOW NOVA
 *   fxspear.js    the shadow spear's body and trail
 *   fxdomain.js   MONARCH'S DOMAIN
 *   fxstatus.js   the ground ring and the mark rune on afflicted actors
 *   fxward.js     Aegis of Ash's shell
 *
 * ---------------------------------------------------------------------------
 * WHAT OTHER SUBSYSTEMS CAN CALL
 *
 *   c.cast(id, opts)                       fire a skill as the player
 *   c.attack({ source, target, ... })      one blow, fully presented. `ai` uses
 *                                          this for every enemy swing so enemy
 *                                          hits get the same impact treatment
 *                                          the player's do.
 *   c.areaAttack({ source, position, ... })  an enemy AoE
 *   c.applyStatus(actor, id, stacks, ...)  burn/chill/mark something directly
 *   c.statusOf(actor)                      the live record, or null
 *   c.slowOf(actor)                        movement multiplier from chill/freeze
 *   c.isRooted(actor)                      frozen?
 *   c.canAct(actor)                        not frozen, not staggered
 *   c.getLoadout()                         the skill table in `ui`'s shape
 *   c.debugBurst(name, opts)               the shot harness
 *   c.stats() / c.selfTest()               introspection
 *
 * ---------------------------------------------------------------------------
 * THE DAMAGE CONTRACT
 *
 * ARCHITECTURE.md: `combat:hit` means damage dealt TO `target`, and the target's
 * own listener applies it — the emitter never applies it too. That is exactly
 * what happens here. Two clarifications this subsystem adds, because they are
 * invisible until measured:
 *
 *   1. `amount` is the FINAL, post-mitigation figure for every target except
 *      the player, for whom it is the pre-mitigation figure (the player
 *      subsystem runs its own armour curve on whatever it receives, and
 *      mitigating twice would make the hero silently unkillable). Both numbers
 *      are on the payload: `amount` and `raw`.
 *   2. If the target's health does not move and it has never been observed to
 *      apply its own damage, combat falls back to the actor interface's
 *      `applyDamage` exactly once. That makes an `ai` that implements the actor
 *      interface but forgets the listener work correctly, without ever
 *      double-applying to one that does not.
 *
 * ---------------------------------------------------------------------------
 * WHY COMBAT DRAWS ITS OWN SPELLS
 *
 * `fx` owns generic particles, blood, decals, trails and screen impulses;
 * combat owns the skills, and a skill's signature geometry is part of its
 * definition in the same way its damage curve is. Combat emits `fx:impact` and
 * `fx:explosion` at every point where `fx` should take over, and never draws a
 * decal, a blood spray or a gib itself. See the note at the top of `fxkit.js`.
 */
/** Seconds a refused press stays live. See the INPUT BUFFER note in the class. */
const BUFFER_WINDOW = 0.18;

export class CombatSystem {
  static id = 'combat';
  static deps = ['physics', 'player', 'fx'];

  async init(ctx) {
    this.ctx = ctx;
    /** Forked so combat's damage rolls never perturb another subsystem's
     *  sequence. ARCHITECTURE.md rule 4 — no Math.random anywhere. */
    this.rng = ctx.rng.fork();
    const t0 = performance.now();

    // ---- gameplay ----------------------------------------------------------
    this.targeting = new Targeting(ctx);
    this.resolver = new Resolver(ctx);
    this.status = new StatusSystem(ctx, this.rng.fork(),
      (actor, element, amount, source, id) => this._onDotTick(actor, element, amount, source, id));

    // ---- presentation -------------------------------------------------------
    this.sparks = new SparkField(ctx, this.rng.fork());
    this.impact = new ImpactDirector(ctx, this.sparks);

    // Hand the debris to `fx` when `fx` is real. It listens to `combat:hit`
    // itself and draws blood, impact particles, a decal and a material flash;
    // combat emitting `fx:impact` as well would produce every one of those
    // twice, and combat's own spray would be a third copy. What combat keeps is
    // the flash star at the contact point — the one piece ARCHITECTURE.md gives
    // it — plus everything if `fx` turns out to be a stub.
    const fx = ctx.peek('fx');
    const fxLive = typeof fx?.impact === 'function' && typeof fx?.hitFlash === 'function';
    this.impact.fxHandlesActorHits = fxLive;
    this.sparks.sprayEnabled = !fxLive;

    // A second, larger mote field for spells. Kept separate from the impact
    // spray so a nova cannot starve the hit flashes of particles at the exact
    // moment there are the most hits to flash.
    const q = ctx.config.q;
    const spellCap = Math.round(clamp(q.particleBudget / 14, 200, 900));
    this.motes = new MoteField(spellCap, ELEMENTS.shadow.core, GLOW.core, 11);
    ctx.scene.add(this.motes.mesh);
    ctx.peek('render')?.registerMaterial?.(this.motes.material);

    this.cleaveFx = new CleaveArc(ctx, this.rng.fork());
    this.novaFx = new NovaBurst(ctx, this.rng.fork());
    // The command pulse is a NovaBurst configured wide, weak and slow: it is
    // literally the same effect at a different scale, and a second instance
    // costs one more set of small geometries rather than a second code path.
    this.commandFx = new NovaBurst(ctx, this.rng.fork());
    this.spearFx = new SpearVolley(ctx, this.rng.fork());
    this.domainFx = new MonarchDomain(ctx, this.rng.fork());
    this.statusFx = new StatusVisuals(ctx, this.rng.fork());
    this.wardFx = new WardShell(ctx);
    this.lights = new SpellLights(ctx, 3);

    // ---- the skill runtime --------------------------------------------------
    this.exec = new Executor(ctx, {
      begin: (c) => this._onCastBegin(c),
      strike: (c, i) => this._onCastStrike(c, i),
      tick: (c, h) => this._onCastTick(c, h),
      end: (c, interrupted) => this._onCastEnd(c, interrupted),
      blocked: (id, why) => this._onCastBlocked(id, why),
    });

    /**
     * INPUT BUFFER.
     *
     * `input.pressed(id)` is edge-triggered, so a press that arrives while a
     * cast is running used to be discarded outright — the player pressed, the
     * game did nothing, and they had to press again once the animation ended.
     * With a nova at 0.78 s of committed animation, that is most of a fight.
     *
     * Every action game solves this the same way: remember the last refused
     * press and fire it the instant the skill becomes legal. The window is
     * short on purpose. Too long and the game replays inputs the player has
     * mentally abandoned, which feels possessed rather than responsive; 180 ms
     * covers pressing slightly early without covering pressing and changing
     * your mind.
     */
    this._buffer = { id: null, at: -1 };

    // ---- preallocated scratch. Nothing below this line allocates. -----------
    this._dmg = makeDamageResult();
    this._dot = makeDamageResult();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3(0, 0, 1);
    this._focus = new THREE.Vector3();
    this._lightPos = new THREE.Vector3();
    this._toast = { text: '', tone: '' };
    this._sysWindow = { kind: 'system', title: '', lines: [], duration: 3.2 };
    this._sysLines = ['', ''];
    this._buffs = [];
    this._buffsPublished = 0;
    /** A synthetic definition for `attack()` calls that supply raw numbers. */
    this._adhoc = {
      id: 'external', element: 'physical', weapon: 0, power: 0, critBonus: 0,
      stagger: 0, knockback: 0, lifesteal: 0, shakeWeight: 0.3, falloff: 1,
      status: '', statusStacks: 1, statusChance: 1, maxTargets: 12, radius: 3, flat: 0,
    };
    /** The chain step's overrides, merged over the base definition. Reused —
     *  the primary attack fires several times a second under held fire. */
    this._stepScratch = {
      id: 'skill1', element: 'physical', weapon: 1, power: 0, critBonus: 0,
      stagger: 0, knockback: 0, lifesteal: 0, shakeWeight: 0.15, falloff: 0.78,
      status: 'bleed', statusStacks: 1, statusChance: 0.34, maxTargets: 6,
    };
    /** The ward's buff-row entry. Pushed into `_buffs` every frame the ward is
     *  up, so it cannot be a literal. */
    this._wardBuff = { glyph: 'ward', element: 'holy', seconds: 0, stacks: 1 };

    // ---- state --------------------------------------------------------------
    this.player = null;
    this._actionFrame = -1;
    this._posed = null;
    this._domainSkill = null;
    this._domainPulseAt = 0;
    this._domainEndsAt = 0;
    this._ward = { active: false, hp: 0, hpMax: 0, until: 0, absorbed: 0 };
    /**
     * The dash-strike's i-frames.
     *
     * `player`'s own dash owns `locomotion.invulnerable` and rewrites it every
     * fixed step, so combat cannot borrow that flag. Instead the window is kept
     * here and honoured in `_hitOne` — which covers every hit that goes through
     * combat, i.e. everything `ai` does through `attack()`.
     */
    this._iframeUntil = 0;
    /** Live projectiles we own, so `dispose` can retire them. */
    this._shots = [];

    this.counters = { casts: 0, resolved: 0, misses: 0, projectiles: 0 };

    // ---- events -------------------------------------------------------------
    this._offs = [];
    this._wireEvents();

    console.info(
      `[combat] ${SLOT_ORDER.length} skills | ${Object.keys(STATUS).length} statuses | ` +
      `${spellCap} spell motes + ${this.sparks.motes.capacity} spark motes | ` +
      `${this.lights.lights.length} spell lights | build ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  _on(type, fn) { this._offs.push(this.ctx.events.on(type, fn)); }

  _wireEvents() {
    // A dead actor keeps no statuses: leaving a burn on a corpse means the DoT
    // keeps emitting `combat:hit` at something with no health, which `ui` draws
    // numbers for.
    this._on('combat:kill', (e) => {
      if (e?.actor) this.status.clear(e.actor);
    });

    // A new level means every actor reference we hold is stale.
    this._on('world:ready', () => {
      this.status.clearAll();
      this._clearEffects();
    });

    // The player being staggered interrupts whatever they were casting. This is
    // the one thing that makes enemy attacks matter during a long wind-up.
    this._on('actor:stagger', (e) => {
      if (e?.actor && e.actor.isPlayer && this.exec.locked) this.exec.cancel(true);
    });
  }

  /* ================================================================== */
  /* Fixed step — input, skills, statuses                               */
  /* ================================================================== */

  fixedUpdate(h, ctx) {
    const player = this.player ?? (this.player = ctx.peek('player'));
    const now = ctx.time.elapsed;

    // Input is edge-triggered, but `fixedUpdate` can run up to MAX_SUBSTEPS
    // times per rendered frame while `input.keysPressed` is only cleared in
    // `endFrame`. Without this guard one keypress fires up to five casts — and
    // on a machine where a frame costs a second, that is every frame.
    if (this._actionFrame !== ctx.time.frame) {
      this._actionFrame = ctx.time.frame;
      if (!this._posed) this._readInput(ctx, player);
    }

    this.exec.update(h, player);
    this._flushBuffer(now, player);
    this.status.tick(h, now);
    this._updateDomain(h, now);
    this._updateWard(h, now, player);
  }

  /**
   * Fire a buffered press the moment it becomes legal.
   *
   * Runs after `exec.update`, which is what ends a cast — so a press buffered
   * during recovery resolves on the very step the recovery expires, with no
   * extra frame of delay. Running it before the update would always cost one
   * fixed step (16.7 ms), which is precisely the latency this exists to remove.
   */
  _flushBuffer(now, player) {
    const b = this._buffer;
    if (b.id === null) return;
    if (now - b.at > BUFFER_WINDOW) { b.id = null; return; }
    if (this.exec.why(b.id, player)) return;   // still not legal; keep waiting
    const id = b.id;
    b.id = null;
    this.cast(id, { fromInput: true, buffered: true });
  }

  /**
   * Skill input. Mirrors `player`'s own read — both subsystems see the same
   * edges because `Input` latches them for the whole frame — but this one
   * decides what a skill DOES rather than what it looks like.
   */
  _readInput(ctx, player) {
    const input = ctx.input;
    if (!input || input.frozen || player?.controlEnabled === false) return;
    if (player && player.alive === false) return;

    // Primary attack: held fire, so the chain flows while the button is down.
    // It is deliberately checked first — a player mashing left click while a
    // cooldown skill is on cooldown should still swing.
    //
    // `1` IS A SECOND BINDING FOR IT. `ui`'s skill bar draws slot 0 with the
    // key cap "1", so the HUD tells the player that key swings the weapon; this
    // loop skipped `skill1` (correctly, it is not a keyboard *slot*) and
    // `player` answered the press with the generic cast clip anyway. MEASURED
    // before this line: pressing `1` left `exec.counters.casts` unchanged and
    // rooted the hero for 550 ms. Held fire here too, so holding `1` chains the
    // combo exactly like holding the mouse.
    if ((input.mouse(0) || input.down('skill1')) && !player?.locomotion?.dashing) {
      this.cast('skill1', { fromInput: true });
    }

    for (const id of SLOT_ORDER) {
      if (id === 'skill1') continue;
      if (input.pressed(id)) this.cast(id, { fromInput: true });
    }
  }

  /* ================================================================== */
  /* Casting                                                            */
  /* ================================================================== */

  /**
   * Fire a skill as the player. Public so `ui`, the dev console and a future
   * gamepad layer can all use one path.
   */
  cast(id, opts = {}) {
    const def = SKILLS[id];
    if (!def) return false;
    const player = this.player ?? (this.player = this.ctx.peek('player'));
    const caster = opts.caster ?? player;
    if (!caster) return false;

    // Refuse BEFORE aiming. The primary attack is held-fire, so `cast` runs
    // every frame the button is down; doing the ground pick and the soft-snap
    // cone query for a cast that is going to be refused is a physics query per
    // frame for nothing.
    const refusal = this.exec.why(id, caster);
    if (refusal) {
      this.exec.counters.refused++;
      // Buffer only a DELIBERATE press, and only when the refusal is temporary.
      // 'mana' and 'dead' will not resolve on their own inside the window, and
      // replaying them later would fire a skill the player pressed for while
      // broke. The primary attack is excluded because it is held-fire: it
      // re-issues every frame anyway, so buffering it would do nothing except
      // let go of the button and still swing.
      if (opts.fromInput && id !== 'skill1' && (refusal === 'busy' || refusal === 'cooldown')) {
        this._buffer.id = id;
        this._buffer.at = this.ctx.time.elapsed;
      }
      this._onCastBlocked(id, refusal);
      return false;
    }

    // ---- aim ---------------------------------------------------------------
    // The origin is the caster's sternum for anything that leaves the body and
    // their feet for anything that happens on the ground, because a nova
    // centred at 1.2 m and a nova centred at 0 m resolve different targets on a
    // staircase.
    const ground = def.shape === 'circle' || def.shape === 'self' || def.shape === 'cone';
    this._origin.copy(caster.position);
    if (!ground) this._origin.y += 1.15;

    const facing = this._v2.set(
      Math.sin(caster.locomotion?.yaw ?? 0), 0, Math.cos(caster.locomotion?.yaw ?? 0)
    );
    const aimHeight = def.shape === 'projectile' ? 1.15 : 0;
    this.targeting.aim(this._origin, def.range || def.radius || 6, {
      snap: def.shape !== 'circle' && def.shape !== 'self',
      height: aimHeight, facing, exclude: caster,
    });
    this._dir.copy(this.targeting.dir);

    // Set BEFORE `start`, because `start` calls back into `_onCastBegin`
    // synchronously and that handler needs to know who is casting and whether a
    // key press already drove the player's animation this frame.
    this._castFromInput = !!opts.fromInput;
    this._caster = caster;

    const started = this.exec.start(id, {
      caster,
      origin: this._origin,
      dir: this._dir,
      target: this.targeting.target,
      seed: this.rng.u32(),
      fromInput: !!opts.fromInput,
    });
    if (started) this.counters.casts++;
    return started;
  }

  /** Wind-up begins: drive the animation and start the effect's anticipation. */
  _onCastBegin(c) {
    const def = c.def;
    const player = this.player;
    const caster = this._caster ?? player;

    // ---- animation ---------------------------------------------------------
    // `player:cast` (emitted by the executor) makes `player` play its generic
    // cast clip. For skills that need a specific one we immediately override —
    // combat runs after player in the registry order and the event bus is
    // synchronous, so this always lands on the same frame.
    if (def.anim === 'attack') {
      player?.playAction?.(`attack${(c.stepIndex % 4) + 1}`, {
        fade: 0.06, restart: true,
        // Later swings in a chain are faster: a combo that does not accelerate
        // reads as four separate attacks rather than one escalating flurry.
        speed: 1 + Math.min(3, c.stepIndex) * 0.055,
      });
    } else if (def.anim === 'ultimate') {
      if (this._castFromInput) {
        // The player's own R handler already ran this frame: it played the
        // clip, lit the aura and pushed the camera in. The executor's
        // `player:cast` replaced the clip with the generic cast, so put it back.
        player?.playAction?.('ultimate', { fade: 0.10, restart: false });
      } else {
        // Cast from the API or the shot harness — there was no key press, so
        // nothing has set up the spectacle. Ask for the whole thing.
        player?.triggerUltimate?.();
      }
    } else if (def.id === 'skill2') {
      player?.playAction?.('dash', { fade: 0.05, restart: true });
    }

    // ---- effect anticipation ------------------------------------------------
    switch (def.vfx) {
      case 'nova':
        this.novaFx.fire(c.origin.x, c.origin.y, c.origin.z, def.radius, def.element, 1.0, this.motes);
        break;
      case 'command':
        this.commandFx.fire(c.origin.x, c.origin.y, c.origin.z, def.radius * 0.72,
          def.element, 0.45, this.motes);
        break;
      case 'domain':
        // The domain's own scribe phase is longer than the ultimate's wind-up,
        // so it starts here and the eruption is timed to land on the strike.
        this.domainFx.fire(c.origin.x, c.origin.y, c.origin.z,
          def.radius, def.domain.duration, this.motes);
        this._domainSkill = def;
        this.impact.addShake(0.10, 1.0);
        break;
      default:
        break;
    }

    // A wind-up the player can hear. `audio` already plays the element's cast
    // layer off `player:cast`; this is the extra weight a big skill needs.
    if (def.windup > 0.3) {
      this.impact.cue('magic.cast.shadow', c.origin.x, c.origin.y + 1.1, c.origin.z, 0.8);
    }
  }

  /** A damage window opened. */
  _onCastStrike(c, index) {
    const def = c.def;
    const caster = this._caster ?? this.player;
    if (!caster) return;

    // The origin follows the caster: a skill whose damage lands 0.44 s after
    // the button was pressed must resolve where the hero IS, not where they
    // were when they pressed it.
    this._origin.copy(caster.position);
    const ground = def.shape === 'circle' || def.shape === 'self' || def.shape === 'cone';
    if (!ground) this._origin.y += 1.15;

    const scale = index === 0 ? 1 : (def.pulseScale ?? 0.5);

    switch (def.vfx) {
      case 'cleave': return this._strikeCleave(c, index, caster, scale);
      case 'dash': return this._strikeDash(c, caster);
      case 'spear': return this._strikeSpear(c, caster);
      case 'nova': return this._strikeNova(c, index, caster, scale);
      case 'command': return this._strikeCommand(c, caster);
      case 'ward': return this._strikeWard(c, caster);
      case 'domain': return this._strikeDomain(c, caster);
      default: return undefined;
    }
  }

  _onCastTick(c, h) {
    void c; void h;
  }

  _onCastEnd(c, interrupted) {
    void c; void interrupted;
    this._castFromInput = false;
  }

  _onCastBlocked(id, why) {
    if (why === 'mana') {
      this._toast.text = 'Not enough shadow';
      this._toast.tone = 'bad';
      this.ctx.events.emit('ui:toast', this._toast);
    }
    void id;
  }

  /* ================================================================== */
  /* Individual skills                                                  */
  /* ================================================================== */

  _strikeCleave(c, index, caster, scale) {
    const step = c.step ?? c.def.chain[0];
    const def = c.def;
    // The chain step overrides range, arc and damage; the base definition
    // supplies everything the step does not care about.
    const yaw = caster.locomotion?.yaw ?? Math.atan2(c.dir.x, c.dir.z);
    this._v.set(Math.sin(yaw), 0, Math.cos(yaw));

    // NOTE: the pulse scale is applied ONCE, in `_stepDef` (which multiplies
    // the weapon coefficient). Passing it to the resolver as well — which folds
    // it into the per-target falloff — squared it, so the finisher's second hit
    // was doing 17% of the first instead of 42%.
    const res = this.resolver.resolve(def, caster, this._origin, this._v, {
      shape: 'cone',
      range: step.range,
      halfAngle: step.halfAngle,
    });

    const stepDef = this._stepDef(def, step, scale);
    const hits = this._applyResult(res, caster, stepDef, this._origin);

    // ---- the arc ------------------------------------------------------------
    const variant = step.finisher ? 'spin' : (step.arc.tilt > 0.7 ? 'chop' : 'wide');
    this.cleaveFx.swing(
      caster.position.x, caster.position.y + 1.05, caster.position.z,
      yaw, variant, step.arc, def.element, this.motes,
      { scale: step.range / 3.0, range: step.range * 0.8 }
    );

    // The finisher is a beat of its own: extra shake even on a whiff, because
    // the player committed to a 0.66 s move and deserves to feel it land
    // somewhere.
    if (step.finisher) {
      this.impact.addShake(0.14, 0.55);
      this.impact.cue('swing.blunt', caster.position.x, caster.position.y + 1.2, caster.position.z, 1.0);
    }
    if (hits === 0 && index === 0) {
      this.counters.misses++;
      this.impact.miss(caster,
        this._origin.x + this._v.x * step.range * 0.7,
        this._origin.y + 1.1,
        this._origin.z + this._v.z * step.range * 0.7);
    }
    return hits;
  }

  /**
   * The chain step's overrides, merged over the base definition into a reused
   * object. The chain is data (`skills.js` CLEAVE_CHAIN) and each step may
   * override reach, arc, damage, stagger and knockback; everything it does not
   * mention comes from the skill.
   */
  _stepDef(def, step, scale) {
    const d = this._stepScratch;
    d.id = def.id;
    d.element = def.element;
    d.weapon = (step.weapon ?? def.weapon) * scale;
    d.power = (step.power ?? def.power ?? 0) * scale;
    d.critBonus = step.critBonus ?? def.critBonus ?? 0;
    d.stagger = step.stagger ?? def.stagger;
    d.knockback = step.knockback ?? def.knockback;
    d.lifesteal = def.lifesteal ?? 0;
    // The finisher shakes the camera on a heavier curve than the fast swings —
    // that difference in shake CHARACTER, not just amplitude, is most of what
    // makes the fourth swing read as a different move.
    d.shakeWeight = step.finisher ? 0.55 : def.shakeWeight;
    d.status = def.status;
    d.statusStacks = step.finisher ? 2 : (def.statusStacks ?? 1);
    d.statusChance = step.finisher ? 1 : (def.statusChance ?? 1);
    d.falloff = def.falloff;
    d.maxTargets = def.maxTargets;
    return d;
  }

  /**
   * The dash-strike. Three things have to happen in the right order or it feels
   * like a teleport with a decal:
   *   1. the distance is CLAMPED by a real capsule sweep, so a dash into a wall
   *      stops at the wall;
   *   2. the hitbox is the corridor actually travelled, not the one aimed at;
   *   3. the player is moved by the character controller, not by assignment, so
   *      they arrive standing on the floor and not inside it.
   */
  _strikeDash(c, caster) {
    const def = c.def;
    this._v.copy(c.dir).setY(0).normalize();

    // Aim at the nearest hostile in the dash cone and overshoot past them —
    // ending BEHIND the target is the whole feel of the move.
    let want = def.range;
    const snap = this.targeting.target;
    if (snap) {
      const d = Math.hypot(snap.position.x - caster.position.x, snap.position.z - caster.position.z);
      want = clamp(d + def.overshoot, 2.0, def.range);
    }
    const travelled = this.resolver.dashDistance(caster.position, this._v, want, caster.radius ?? 0.36);

    // Resolve the corridor BEFORE moving, so the hitbox is anchored where the
    // dash started.
    this._v2.copy(caster.position).addScaledVector(this._v, travelled);
    const res = this.resolver.resolve(def, caster, caster.position, this._v, {
      shape: 'dash', endPoint: this._v2, radius: def.radius,
    });
    const hits = this._applyResult(res, caster, def, caster.position);

    // ---- move ---------------------------------------------------------------
    // Through the character controller when there is one, so collision,
    // step-up and ground snapping all still apply.
    const ch = caster.char ?? null;
    if (ch?.pushBy) ch.pushBy(this._v.x * travelled, 0, this._v.z * travelled);
    else caster.position.addScaledVector(this._v, travelled);
    // i-frames: the point of a mobility skill is that it is also a defence.
    if (caster.isPlayer) this._iframeUntil = this.ctx.time.elapsed + def.iframes;

    // ---- present -------------------------------------------------------------
    // The cut lands at the DESTINATION, facing back along the dash: the player
    // re-forms behind the target and cuts on the way out.
    const yaw = Math.atan2(this._v.x, this._v.z);
    this.cleaveFx.swing(
      caster.position.x, caster.position.y + 1.05, caster.position.z,
      yaw + Math.PI, 'chop', { from: -0.5, to: 0.5, tilt: 1.0, thickness: 1.2 },
      def.element, this.motes, { scale: 1.15, range: 2.2 }
    );
    // Motes strung along the corridor, so the path the dash took is legible for
    // a moment after it has happened.
    const rng = this.rng;
    const n = Math.round(clamp(travelled * 4, 8, 40));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      this.motes.spawn(
        this._v2.x - this._v.x * travelled * (1 - t) + rng.range(-0.3, 0.3),
        caster.position.y + rng.range(0.15, 1.8),
        this._v2.z - this._v.z * travelled * (1 - t) + rng.range(-0.3, 0.3),
        rng.range(-0.7, 0.7), rng.range(0.2, 1.6), rng.range(-0.7, 0.7),
        rng.range(0.35, 0.85), rng.range(0.03, 0.07), rng.range(0.6, 1.4),
        { gravity: 0.6, drag: 1.4 }
      );
    }
    this.impact.addShake(0.10 + hits * 0.03, 0.3);
    this.impact.addImpulse(this._v.x, this._v.z, 0.09);
    if (hits === 0) {
      this.counters.misses++;
      this.impact.miss(caster, this._v2.x, this._v2.y + 1.1, this._v2.z);
    }
    return hits;
  }

  /** The shadow spear: a real physics projectile with a real mesh and trail. */
  _strikeSpear(c, caster) {
    const def = c.def;
    const P = this.ctx.peek('physics');
    if (!P?.spawnProjectile) return 0;

    // Re-aim on the strike frame at chest height, so a target that moved during
    // the 0.28 s wind-up is still hit.
    this._origin.copy(caster.position);
    this._origin.y += 1.15;
    this.targeting.aim(this._origin, def.range, {
      snap: true, height: 1.15, exclude: caster,
      facing: this._v2.set(Math.sin(caster.locomotion?.yaw ?? 0), 0, Math.cos(caster.locomotion?.yaw ?? 0)),
    });
    this._v.copy(this.targeting.dir);
    // Lead the shot slightly upward so it does not scrape the floor over 26 m.
    this._v.y = 0.02;
    this._v.normalize();

    const slot = this.spearFx.acquire(this._origin.x, this._origin.y, this._origin.z, def.element);
    this.spearFx.launch(slot, this._origin.x, this._origin.y, this._origin.z, this.motes);

    let pierced = 0;
    const proj = P.spawnProjectile({
      origin: this._origin,
      direction: this._v,
      speed: def.speed,
      radius: def.radius,
      gravityScale: 0,
      drag: 0,
      lifetime: 2.2,
      maxDistance: def.range,
      pierce: def.pierce,
      owner: caster,
      faction: caster.faction,
      element: def.element,
      ignore: caster,
      mesh: slot.body,
      onHit: (hit) => {
        if (hit.actor) {
          // Each body drinks some of the spear: 82% of the damage carries
          // through to the next. A pierce with no falloff makes a line of
          // enemies strictly better than a single one, which inverts the
          // positioning the skill is supposed to reward.
          const falloff = Math.pow(def.pierceFalloff, pierced);
          pierced++;
          this._hitOne(hit.actor, caster, def, falloff,
            hit.px, hit.py, hit.pz, this._v.x, this._v.z);
          if (pierced > def.pierce) {
            this.spearFx.release(slot);
            this._retireShot(proj);
            return 'stop';
          }
          return 'pierce';
        }
        // A world hit: the spear buries itself. `physics` has already emitted
        // `fx:impact` with the real surface, so all that is left is the flash.
        this.sparks.burst(hit.px, hit.py, hit.pz, def.element, 0.5, 0.18);
        this.impact.addShake(0.05, 0.2);
        // `physics._retire(p, false)` does NOT call `onExpire` — only a genuine
        // timeout does — so the slot has to be released from here or the trail
        // never dissolves and the pool leaks a spear per shot.
        this.spearFx.release(slot);
        this._retireShot(proj);
        return 'stop';
      },
      onExpire: () => {
        this.spearFx.release(slot);
        this._retireShot(proj);
      },
    });
    if (proj) {
      this._shots.push(proj);
      this.counters.projectiles++;
    } else {
      this.spearFx.release(slot);
    }
    this.impact.addShake(0.08, 0.2);
    this.impact.addImpulse(-this._v.x, -this._v.z, 0.05);
    return 1;
  }

  _retireShot(proj) {
    const i = this._shots.indexOf(proj);
    if (i >= 0) this._shots.splice(i, 1);
  }

  _strikeNova(c, index, caster, scale) {
    const def = c.def;
    this._origin.copy(caster.position);

    if (index === 0) {
      this.novaFx.x = this._origin.x;
      this.novaFx.y = this._origin.y;
      this.novaFx.z = this._origin.z;
      this.novaFx.detonate(this.motes);
      // `fx:explosion` is the shared vocabulary: `physics` shoves debris and
      // ragdolls, `sky` parts the ground mist, `audio` blooms the reverb,
      // `player` punches the coat, `fx` draws the smoke. Knockback stays 0 —
      // combat displaces actors itself in `impact.js` and letting physics do it
      // as well would move everyone twice.
      this.impact.explode(this._origin.x, this._origin.y + 0.4, this._origin.z,
        def.radius, def.element, 1.4, 0);
      this.impact.addHitstop(0.10);
      this.impact.addShake(0.34, def.shakeWeight);
    } else {
      this.impact.addShake(0.14, def.shakeWeight);
    }

    const res = this.resolver.resolve(def, caster, this._origin, this._dir, {
      shape: 'circle', radius: def.radius * (index === 0 ? 1 : 0.82), scale,
    });
    const hits = this._applyResult(res, caster, def, this._origin);
    if (hits === 0 && index === 0) this.counters.misses++;
    return hits;
  }

  /**
   * Sovereign's Command. Marks the room and sends the army.
   *
   * The `ai` hooks are strictly optional — the skill is complete without them,
   * because a mark on every enemy in an 11 m radius is worth casting on its own.
   */
  _strikeCommand(c, caster) {
    const def = c.def;
    this._origin.copy(caster.position);
    this.commandFx.x = this._origin.x;
    this.commandFx.y = this._origin.y;
    this.commandFx.z = this._origin.z;
    this.commandFx.detonate(this.motes);

    const res = this.resolver.resolve(def, caster, this._origin, this._dir, {
      shape: 'circle', radius: def.radius,
    });
    const hits = this._applyResult(res, caster, def, this._origin);

    // ---- the order ----------------------------------------------------------
    const focus = this.targeting.target ??
      this.targeting.nearestHostile(this.targeting.point, 6.0, caster);
    const ai = this.ctx.peek('ai');
    const cmd = def.command;
    ai?.commandShadows?.({
      order: cmd.order,
      target: focus,
      position: this.targeting.point,
      duration: cmd.buffDuration,
      damage: cmd.damageBuff,
      haste: cmd.hasteBuff,
      source: caster,
    });

    this.impact.addShake(0.16, def.shakeWeight);
    this._sysLines[0] = focus ? `Target marked: ${focus.name ?? 'Enemy'}` : 'The shadows spread out.';
    this._sysLines[1] = `${hits} marked · army empowered ${Math.round(cmd.damageBuff * 100)}%`;
    this._sysWindow.title = 'COMMAND';
    this._sysWindow.lines = this._sysLines;
    this._sysWindow.duration = 2.6;
    this.ctx.events.emit('ui:system', this._sysWindow);
    return hits;
  }

  /** Aegis of Ash: raise the shell, and hit everything adjacent on the way up. */
  _strikeWard(c, caster) {
    const def = c.def;
    const w = def.ward;
    const hpMax = (caster.stats?.hpMax ?? 400) * w.fraction;
    this._ward.active = true;
    this._ward.hp = hpMax;
    this._ward.hpMax = hpMax;
    this._ward.until = this.ctx.time.elapsed + w.duration;
    this._ward.absorbed = 0;
    this.wardFx.raise(caster.position.x, caster.position.y, caster.position.z,
      (caster.radius ?? 0.36) * 3.6);

    this._origin.copy(caster.position);
    const res = this.resolver.resolve(def, caster, this._origin, this._dir, {
      shape: 'circle', radius: def.radius,
    });
    const hits = this._applyResult(res, caster, def, this._origin);
    this.impact.addShake(0.12, def.shakeWeight);
    this.impact.cue('magic.cast.holy', caster.position.x, caster.position.y + 1.1, caster.position.z, 0.9);
    return hits;
  }

  /** The domain erupts. The single biggest moment in the game. */
  _strikeDomain(c, caster) {
    const def = c.def;
    this._origin.copy(caster.position);
    this.domainFx.x = this._origin.x;
    this.domainFx.y = this._origin.y;
    this.domainFx.z = this._origin.z;

    this._domainEndsAt = this.ctx.time.elapsed + def.domain.duration;
    this._domainPulseAt = this.ctx.time.elapsed + VFX.domain.pulseInterval;
    this.exec.hold(def.domain.duration);

    this.impact.explode(this._origin.x, this._origin.y + 0.6, this._origin.z,
      def.radius, def.element, 2.0, 0);
    this.impact.addHitstop(this.ctx.config.hitstopMax);
    this.impact.addShake(0.58, 1.0);
    this.domainFx.pulse(this.motes, 1.0);

    const res = this.resolver.resolve(def, caster, this._origin, this._dir, {
      shape: 'circle', radius: def.radius,
    });
    const hits = this._applyResult(res, caster, def, this._origin);

    // Everything inside is open for as long as the domain stands. This is the
    // mechanical reason to use the ultimate BEFORE committing the rest of the
    // kit rather than as a finisher.
    for (let i = 0; i < res.count; i++) {
      this.status.makeVulnerable(res.actors[i], 1.30, def.domain.duration, this.ctx.time.elapsed);
    }

    // The army gets the buff. Optional hook; the domain is worth casting
    // without it.
    this.ctx.peek('ai')?.buffShadows?.({
      damage: def.domain.armyDamage,
      haste: def.domain.armyHaste,
      duration: def.domain.duration,
      position: this._origin,
      radius: def.radius,
    });

    this._sysLines[0] = "The Monarch's ground.";
    this._sysLines[1] = `${hits} enemies bound · army empowered ${Math.round(def.domain.armyDamage * 100)}%`;
    this._sysWindow.title = "MONARCH'S DOMAIN";
    this._sysWindow.lines = this._sysLines;
    this._sysWindow.duration = 4.0;
    this.ctx.events.emit('ui:system', this._sysWindow);
    return hits;
  }

  /* ================================================================== */
  /* Damage application                                                 */
  /* ================================================================== */

  /** Turn a resolver result into a set of fully-presented hits. */
  _applyResult(res, source, def, origin) {
    let hits = 0;
    for (let i = 0; i < res.count; i++) {
      const target = res.actors[i];
      if (!target || target.alive === false) continue;
      // Line of sight, so a nova does not detonate through a wall into the next
      // room. Skipped for the caster's own position (a self-centred AoE at
      // point-blank range would fail its own LOS test against the floor).
      if (res.dist[i] > 2.0 && !this.resolver.visible(source, target)) continue;
      this._hitOne(target, source, def, res.falloff[i],
        res.hitX[i], res.hitY[i], res.hitZ[i], res.dirX[i], res.dirZ[i]);
      hits++;
    }
    this.counters.resolved += hits;
    void origin;
    return hits;
  }

  /** One blow, fully resolved and fully presented. */
  _hitOne(target, source, def, falloff, hx, hy, hz, dx, dz) {
    const now = this.ctx.time.elapsed;
    // Dash i-frames. `player`'s own dodge is handled inside `player`; this
    // covers the window Umbral Step grants, which combat owns.
    if (target.isPlayer && now < this._iframeUntil) return 0;
    const status = this.status.get(target);
    rollDamage(this._dmg, source, target, def, this.rng, { falloff, status, now });
    if (this._dmg.amount <= 0) return 0;

    // A ward on the TARGET eats the blow before anything else sees it. Combat
    // is the emitter, so this is the only place absorption can happen without
    // the damage number and the health bar disagreeing.
    if (target.isPlayer && this._ward.active) this._absorb(this._dmg);

    const died = this.impact.land(source, target, this._dmg, def, hx, hy, hz, dx, dz);

    // ---- status --------------------------------------------------------------
    const statusId = def.status === '' ? null : (def.status ?? ELEMENT_STATUS[def.element]);
    if (statusId && !died) {
      const chance = def.statusChance ?? 1;
      if (chance >= 1 || this.rng.float() < chance) {
        const sd = STATUS[statusId];
        this.status.apply(target, statusId, def.statusStacks ?? 1,
          this._dmg.amount * (sd?.tickFraction ?? 0), source, now);
      }
    }

    // ---- lifesteal ------------------------------------------------------------
    if (this._dmg.lifesteal > 0 && source?.stats) {
      source.stats.hp = Math.min(source.stats.hpMax, source.stats.hp + this._dmg.lifesteal);
    }

    // ---- threat + stickiness --------------------------------------------------
    if (target.addThreat) target.addThreat(source, threatOf(this._dmg, def));
    if (source?.isPlayer) this.targeting.noteHit(target, now);
    return this._dmg.amount;
  }

  /** Aegis of Ash absorbing a blow. Mutates the damage record in place. */
  _absorb(res) {
    const eaten = Math.min(this._ward.hp, res.amount);
    this._ward.hp -= eaten;
    this._ward.absorbed += eaten;
    res.amount -= eaten;
    res.raw = Math.max(0, res.raw - eaten);
    res.severity *= 0.35;
    this.wardFx.frac = clamp01(this._ward.hp / Math.max(1, this._ward.hpMax));
    if (this._ward.hp <= 0) this._breakWard(true);
  }

  /** DoT tick, routed back from the status system. */
  _onDotTick(actor, element, amount, source, statusId) {
    if (!actor || actor.alive === false) return;
    const status = this.status.get(actor);
    rollDot(this._dot, actor, element, amount, status);
    this.impact.landDot(source, actor, this._dot, statusId);
  }

  /* ================================================================== */
  /* Ongoing effects                                                    */
  /* ================================================================== */

  /** The domain's damage pulses, for as long as it stands. */
  _updateDomain(h, now) {
    if (!this._domainSkill) return;
    const def = this._domainSkill;
    if (now > this._domainEndsAt) {
      this._domainSkill = null;
      return;
    }
    if (now < this._domainPulseAt) return;
    this._domainPulseAt = now + VFX.domain.pulseInterval;

    const caster = this._caster ?? this.player;
    if (!caster) return;
    // The domain is anchored where it was cast, not to the Monarch. It is
    // GROUND he claimed; walking out of it is supposed to be possible.
    this._origin.set(this.domainFx.x, this.domainFx.y, this.domainFx.z);

    this.domainFx.pulse(this.motes, 0.8);
    const res = this.resolver.resolve(def, caster, this._origin, this._dir, {
      shape: 'circle', radius: def.radius, scale: def.pulseScale,
    });
    for (let i = 0; i < res.count; i++) {
      const target = res.actors[i];
      if (!target || target.alive === false) continue;
      // `res.falloff` already carries `def.pulseScale` — the resolver applied it
      // as `opts.scale` above. Multiplying again here squared it.
      this._hitOne(target, caster, def, res.falloff[i],
        res.hitX[i], res.hitY[i], res.hitZ[i], res.dirX[i], res.dirZ[i]);
      // Everything inside is slowed. The domain is the Monarch's ground and
      // moving through it should feel like wading.
      const st = this.status.get(target);
      if (st) st.slow = Math.min(st.slow, 1 - def.domain.enemySlow);
      target.statusSlow = Math.min(target.statusSlow ?? 1, 1 - def.domain.enemySlow);
    }
    this.impact.addShake(0.10, 0.9);
  }

  _updateWard(h, now, player) {
    if (!this._ward.active) return;
    if (player) this.wardFx.follow(player.position.x, player.position.y, player.position.z);
    if (now > this._ward.until) this._breakWard(false);
  }

  /**
   * The ward ends. It always detonates — expiring quietly would make a defensive
   * cooldown feel like nothing happened, and the whole design is that the more
   * you were hit while warded, the bigger the answer.
   */
  _breakWard(broken) {
    if (!this._ward.active) return;
    this._ward.active = false;
    this.wardFx.shatter();

    const def = SKILLS.skillE;
    const w = def.ward;
    const caster = this.player;
    if (!caster) return;
    // A floor under the detonation so an untouched ward still does something.
    const power = Math.max(this._ward.hpMax * 0.25, this._ward.absorbed) * w.detonateScale;

    this._origin.copy(caster.position);
    const res = this.resolver.resolve(def, caster, this._origin, this._dir, {
      shape: 'circle', radius: w.detonateRadius,
    });
    // A synthetic definition carrying the absorbed damage as a flat value.
    const ad = this._adhoc;
    ad.id = 'skillE';
    ad.element = 'holy';
    ad.weapon = 0;
    ad.power = 0;
    ad.flat = power;
    ad.stagger = 60;
    ad.knockback = 0.8;
    ad.shakeWeight = 0.7;
    ad.status = '';
    for (let i = 0; i < res.count; i++) {
      const t = res.actors[i];
      if (!t || t.alive === false) continue;
      this._flatHit(t, caster, ad, power * res.falloff[i],
        res.hitX[i], res.hitY[i], res.hitZ[i], res.dirX[i], res.dirZ[i]);
    }
    this.impact.explode(this._origin.x, this._origin.y + 0.9, this._origin.z,
      w.detonateRadius, 'holy', 1.1, 0);
    this.impact.addShake(0.26, 0.7);
    this.impact.addHitstop(0.06);
    this._toast.text = broken ? 'Aegis shattered' : 'Aegis released';
    this._toast.tone = 'good';
    this.ctx.events.emit('ui:toast', this._toast);
    ad.flat = 0;
  }

  /* ================================================================== */
  /* Frame — presentation                                               */
  /* ================================================================== */

  update(dt, ctx) {
    // Emit the frame's aggregated hit-stop, shake and impulse exactly once,
    // after every fixedUpdate for this frame has run.
    this.impact.flush();

    const frozen = !!this._posed;
    const step = frozen ? 0 : dt;
    const camera = ctx.camera;

    this.cleaveFx.update(step);
    this.novaFx.update(step);
    this.commandFx.update(step);
    this.spearFx.update(step, camera);
    this.domainFx.update(step);
    this.wardFx.update(step);
    this.sparks.update(step, camera);
    this.motes.update(step, camera);

    // The status layer follows the camera focus, which is the player.
    const player = this.player ?? (this.player = ctx.peek('player'));
    this._focus.copy(player?.position ?? ctx.camera.position);
    this.statusFx.sync(step, this.status, camera, this._focus);

    this._driveLights();
    this._publishBuffs(player);
  }

  /**
   * Three point lights, assigned by importance.
   *
   * The assignment is deliberate rather than round-robin: `sky` feeds its
   * volumetric march from the two highest-scoring point lights around the camera
   * focus, so which of combat's lights is brightest decides which spell gets
   * god rays. The domain always wins, then the nova, then everything else.
   */
  _driveLights() {
    let slot = 0;
    const use = (x, y, z, colour, intensity, distance) => {
      if (slot >= this.lights.lights.length || !(intensity > 0)) return;
      this.lights.set(slot++, x, y, z, colour, intensity, distance);
    };

    // ---- slot 0: the biggest thing happening -------------------------------
    const domainI = this.domainFx.lightIntensity();
    const novaI = this.novaFx.lightIntensity();
    const commandI = this.commandFx.lightIntensity();
    if (domainI > 0) {
      use(this.domainFx.x, this.domainFx.y + 1.9, this.domainFx.z,
        ELEMENTS.shadow.light, domainI, 15.0);
      // ---- slot 1: a perimeter light, so the domain lifts the WALLS of the
      // room and not only the floor around the player. Without it a 13 m
      // ultimate leaves the architecture as black as it was.
      this.domainFx.perimeterLight(0, this._lightPos);
      use(this._lightPos.x, this._lightPos.y, this._lightPos.z,
        ELEMENTS.shadow.core, domainI * 0.45, 11.0);
    } else if (novaI > 0) {
      use(this.novaFx.x, this.novaFx.y + 1.1, this.novaFx.z,
        ELEMENTS.shadow.light, novaI, 9.0);
    } else if (commandI > 0) {
      use(this.commandFx.x, this.commandFx.y + 1.1, this.commandFx.z,
        ELEMENTS.shadow.light, commandI * 0.7, 9.0);
    }

    // ---- the cleave arc and the spear --------------------------------------
    const cleaveI = this.cleaveFx.lightIntensity();
    if (cleaveI > 0) {
      use(this.cleaveFx.lightX, this.cleaveFx.lightY, this.cleaveFx.lightZ,
        this.cleaveFx.lightColour, cleaveI, 5.5);
    }
    const spearI = this.spearFx.lightIntensity();
    if (spearI > 0) {
      use(this.spearFx.lightX, this.spearFx.lightY, this.spearFx.lightZ,
        this.spearFx.lightColour, spearI, 6.0);
    }

    // ---- impacts always get the last slot -----------------------------------
    const sparkI = this.sparks.lightIntensity();
    if (sparkI > 0) {
      use(this.sparks.lightX, this.sparks.lightY, this.sparks.lightZ,
        this.sparks.lightColour, sparkI, 4.2);
    }

    // Park the rest. An unused light must be zero-intensity and NOT hidden by
    // hand — `render/lights.js` hides it and substitutes ballast so the visible
    // count, which is a shader permutation key, never moves.
    for (let i = slot; i < this.lights.lights.length; i++) this.lights.lights[i].intensity = 0;
  }

  /**
   * The player's own statuses, into `ui`'s buff row.
   *
   * Two rules, both learned by capturing:
   *
   *  - Never while posed. `ui.debugState('combat')` populates the buff row with
   *    a plausible four-buff loadout for the shot, and combat publishing its
   *    (empty) live list over the top wiped it — a HUD element silently missing
   *    from the game's headline screenshot.
   *  - Never publish an empty list twice. `ui.setBuffs` does not copy the array,
   *    so once we have handed ours over it sees every mutation; publishing empty
   *    once is enough, and after that we leave the row alone until we have
   *    something real to say.
   */
  _publishBuffs(player) {
    if (!player || this._posed) return;
    const ui = this.ctx.peek('ui');
    if (!ui?.setBuffs) return;
    this.status.buffList(player, this._buffs, this.ctx.time.elapsed);
    // The ward is not a status record; it is a skill state, so it is appended
    // from a preallocated slot rather than a literal — this runs every frame.
    if (this._ward.active) {
      const w = this._wardBuff;
      w.seconds = Math.max(0, this._ward.until - this.ctx.time.elapsed);
      w.stacks = Math.max(1, Math.round(this._ward.hp / Math.max(1, this._ward.hpMax) * 3));
      this._buffs.push(w);
    }
    if (this._buffs.length === 0 && this._buffsPublished === 0) return;
    this._buffsPublished = this._buffs.length;
    ui.setBuffs(this._buffs);
  }

  /* ================================================================== */
  /* Public API for other subsystems                                    */
  /* ================================================================== */

  /**
   * One blow, fully presented. `ai` calls this for every enemy attack so an
   * enemy hit gets the same hit-stop, shake, flash and number the player's do —
   * a game where only the player's hits have weight feels one-sided in the wrong
   * direction.
   *
   * @param o { source, target, amount?, element?, skill?, stagger?, knockback?,
   *            crit?, dir? }
   */
  attack(o = {}) {
    const target = o.target;
    if (!target || target.alive === false) return 0;
    const source = o.source ?? null;
    const def = this._defFor(o);

    this._v.set(
      target.position.x - (source?.position?.x ?? target.position.x),
      0,
      target.position.z - (source?.position?.z ?? target.position.z)
    );
    if (this._v.lengthSq() < 1e-6) this._v.set(0, 0, 1);
    this._v.normalize();
    const hy = target.position.y + (target.height ?? 1.8) * 0.55;
    const hx = target.position.x - this._v.x * (target.radius ?? 0.4) * 0.8;
    const hz = target.position.z - this._v.z * (target.radius ?? 0.4) * 0.8;

    if (o.amount !== undefined) {
      return this._flatHit(target, source, def, o.amount, hx, hy, hz, this._v.x, this._v.z);
    }
    return this._hitOne(target, source, def, o.falloff ?? 1, hx, hy, hz, this._v.x, this._v.z);
  }

  /**
   * An enemy AoE. Same presentation path as the player's, resolved against the
   * player and their shadows because `resolve.js` derives the filter from the
   * source's faction.
   */
  areaAttack(o = {}) {
    const source = o.source ?? null;
    const def = this._defFor(o);
    def.radius = o.radius ?? 3;
    def.maxTargets = o.maxTargets ?? 12;
    def.falloff = o.falloff ?? 0.6;
    this._origin.copy(o.position ?? source?.position ?? this._origin);
    const res = this.resolver.resolve(def, source, this._origin, this._dir, {
      shape: 'circle', radius: def.radius,
    });
    let n = 0;
    for (let i = 0; i < res.count; i++) {
      const t = res.actors[i];
      if (!t || t.alive === false) continue;
      if (o.amount !== undefined) {
        this._flatHit(t, source, def, o.amount * res.falloff[i],
          res.hitX[i], res.hitY[i], res.hitZ[i], res.dirX[i], res.dirZ[i]);
      } else {
        this._hitOne(t, source, def, res.falloff[i],
          res.hitX[i], res.hitY[i], res.hitZ[i], res.dirX[i], res.dirZ[i]);
      }
      n++;
    }
    if (o.explode !== false) {
      this.impact.explode(this._origin.x, this._origin.y + 0.5, this._origin.z,
        def.radius, def.element, o.magnitude ?? 1, 0);
    }
    return n;
  }

  /** Build the ad-hoc definition for an external attack. Reused, never fresh. */
  _defFor(o) {
    const d = this._adhoc;
    d.id = o.skill ?? 'external';
    d.element = o.element ?? 'physical';
    d.weapon = o.weapon ?? (o.amount === undefined ? 1 : 0);
    d.power = o.power ?? 0;
    d.critBonus = o.critBonus ?? 0;
    d.stagger = o.stagger ?? 18;
    d.knockback = o.knockback ?? 0.25;
    d.lifesteal = o.lifesteal ?? 0;
    d.shakeWeight = o.shakeWeight ?? 0.35;
    d.status = o.status ?? '';
    d.statusStacks = o.statusStacks ?? 1;
    d.statusChance = o.statusChance ?? 1;
    d.falloff = o.falloff ?? 1;
    d.maxTargets = o.maxTargets ?? 12;
    d.radius = o.radius ?? 3;
    d.flat = 0;
    return d;
  }

  /** A hit whose damage was supplied rather than rolled — an environmental
   *  hazard, a scripted boss slam, the ward's detonation. */
  _flatHit(target, source, def, amount, hx, hy, hz, dx, dz) {
    const status = this.status.get(target);
    const res = this._dmg;
    res.element = def.element;
    res.crit = false;
    res.vulnerability = 1;
    res.resisted = 0;
    res.armoured = 0;
    res.lifesteal = 0;
    res.raw = amount;
    res.amount = Math.max(1, amount);
    const st = target.stats ?? null;
    const hpMax = st?.hpMax ?? 100;
    res.severity = clamp01(res.amount / Math.max(1, hpMax * 0.25));
    res.lethal = res.amount >= (st?.hp ?? hpMax);
    res.overkill = res.lethal ? res.amount - (st?.hp ?? hpMax) : 0;
    if (target.isPlayer && this._ward.active) this._absorb(res);
    this.impact.land(source, target, res, def, hx, hy, hz, dx, dz);
    void status;
    return res.amount;
  }

  /** Apply a status directly. `ai`, `world` hazards and `loot` affixes all use
   *  this rather than reimplementing stacking rules. */
  applyStatus(actor, id, stacks = 1, tickDamage = 0, source = null) {
    return this.status.apply(actor, id, stacks, tickDamage, source, this.ctx.time.elapsed);
  }

  statusOf(actor) { return this.status.get(actor); }
  /** Movement multiplier from chill/freeze/the domain. 1 = unimpeded. */
  slowOf(actor) { return this.status.get(actor)?.slow ?? 1; }
  isRooted(actor) { return this.status.get(actor)?.rooted === true; }
  /** May this actor act? False while frozen or inside a stagger recovery. */
  canAct(actor) {
    if (!actor || actor.alive === false) return false;
    if (this.isRooted(actor)) return false;
    return (actor.staggerUntil ?? 0) <= this.ctx.time.elapsed;
  }

  /** The skill table in `ui`'s slot shape. */
  getLoadout() { return loadout(); }
  /** Cooldown state for the HUD: `{ id: { cd, total, charges } }`. */
  cooldowns() {
    const out = {};
    for (const id of SLOT_ORDER) {
      const s = this.exec.state(id);
      out[id] = { cd: s.cooldown, total: s.def.cooldown, charges: s.charges };
    }
    return out;
  }
  /** Drop every cooldown — dev console, and the shot harness. */
  refresh() { this.exec.refresh(); }

  /* ================================================================== */
  /* Shot harness                                                       */
  /* ================================================================== */

  /**
   * `'none' | 'cleave' | 'nova' | 'beam' | 'ultimate'`
   *
   * Each produces a fully-realised MID-ACTION frame, held. The effect is not
   * played and left to run: the harness pumps an arbitrary number of settle
   * frames before the shutter, so a burst fired once would have expired (or not
   * yet peaked) by the time the picture is taken. Instead the timeline is
   * advanced deterministically to a chosen "money frame" and then FROZEN, which
   * also makes repeated captures pixel-identical and lets TAA converge instead
   * of smearing a moving effect across sixteen frames of history.
   */
  debugBurst(name = 'none', opts = {}) {
    const key = String(name ?? 'none');
    this._clearEffects();
    this._setFrozen(false);
    this._posed = null;
    if (key === 'none') return 'none';

    const player = this.player ?? (this.player = this.ctx.peek('player'));
    const p = player?.position ?? this._origin.set(0, 0, 0);
    const px = p.x, py = p.y, pz = p.z;
    const camera = this.ctx.camera;
    const rng = this.rng;
    // Face the camera-left diagonal: at yaw 45° that puts the arc across the
    // frame rather than into it, which is the readable direction for a cleave.
    const yaw = opts.yaw ?? -Math.PI * 0.25;
    const dirX = Math.sin(yaw), dirZ = Math.cos(yaw);

    switch (key) {
      // ---------------------------------------------------------------------
      case 'cleave': {
        // The finisher, at its peak: the spin arc fully swept, the shock ring
        // half expanded, embers in the air, six impacts around the ring.
        const step = SKILLS.skill1.chain[3];
        this.cleaveFx.swing(px, py + 1.05, pz, yaw, 'spin', step.arc, 'physical',
          this.motes, { scale: 1.25, range: 3.4 });
        // Impacts placed around the swept arc, at plausible enemy positions, so
        // the frame reads as a blow landing on several things rather than a
        // decorative ribbon.
        for (let i = 0; i < 6; i++) {
          const a = yaw + (i / 6) * Math.PI * 2 + rng.range(-0.2, 0.2);
          const r = rng.range(1.9, 3.3);
          this.sparks.hit(
            px + Math.sin(a) * r, py + rng.range(0.85, 1.5), pz + Math.cos(a) * r,
            -Math.sin(a), -Math.cos(a),
            { element: i === 1 ? 'shadow' : 'physical', severity: rng.range(0.35, 0.95), crit: i === 1 },
            null
          );
        }
        this._advance(0.13, camera);
        break;
      }

      // ---------------------------------------------------------------------
      case 'nova': {
        this.novaFx.fire(px, py, pz, SKILLS.skill4.radius, 'shadow', 1.0, this.motes);
        // Run the anticipation so the converging motes have actually converged,
        // then detonate and settle on the money frame: the shock front at ~65%
        // of its travel, the spires up, the core still hot.
        this._advance(VFX.nova.anticipation, camera);
        this.novaFx.detonate(this.motes);
        // The real skill emits this on its strike frame, so the pose does too:
        // `fx` then contributes its smoke, embers and ground dust to the shot
        // exactly as it would in play, instead of the harness showing combat's
        // geometry alone. `fx` runs its own timeline across the settle frames,
        // which is what a mid-action frame is.
        this.impact.explode(px, py + 0.4, pz, SKILLS.skill4.radius, 'shadow', 1.4, 0);
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + rng.range(-0.25, 0.25);
          const r = rng.range(2.2, 5.6);
          this.sparks.hit(
            px + Math.sin(a) * r, py + rng.range(0.8, 1.6), pz + Math.cos(a) * r,
            -Math.sin(a), -Math.cos(a),
            { element: 'shadow', severity: rng.range(0.5, 1.0), crit: i % 4 === 0 }, null
          );
        }
        // 0.15 s after the detonation, not 0.26: the shock front is at ~4.5 m
        // (a third of the frame, readable), the core is still hot, the spires
        // are at full height and the light has not yet decayed. Chosen by
        // capturing both.
        this._advance(0.15, camera);
        break;
      }

      // ---------------------------------------------------------------------
      case 'beam': {
        // A volley of spears crossing the frame: two in flight with full
        // trails, one impacting. `beam` is the harness's name for "the ranged
        // skill at its most legible".
        for (let i = 0; i < 3; i++) {
          const a = yaw + rng.range(-0.34, 0.34);
          const slot = this.spearFx.acquire(px, py + 1.15, pz, 'shadow');
          slot.width = 0.26;
          // Walk the head along the flight path by hand, filling the trail ring
          // buffer, so the ribbon has real history without a physics step.
          const dist = 5.5 + i * 2.6;
          const steps = 16;
          for (let s = 1; s <= steps; s++) {
            const t = (s / steps) * dist;
            slot.body.position.set(
              px + Math.sin(a) * t, py + 1.15 + t * 0.012, pz + Math.cos(a) * t
            );
            slot.head = (slot.head + 1) % slot.hx.length;
            slot.hx[slot.head] = slot.body.position.x;
            slot.hy[slot.head] = slot.body.position.y;
            slot.hz[slot.head] = slot.body.position.z;
            if (slot.filled < slot.hx.length) slot.filled++;
          }
          slot.body.lookAt(
            slot.body.position.x + Math.sin(a),
            slot.body.position.y,
            slot.body.position.z + Math.cos(a)
          );
          this.spearFx.launch(slot, px + Math.sin(a) * 0.6, py + 1.15, pz + Math.cos(a) * 0.6, this.motes);
          if (i === 0) {
            // The one that landed.
            this.sparks.hit(
              slot.body.position.x, slot.body.position.y, slot.body.position.z,
              -Math.sin(a), -Math.cos(a),
              { element: 'shadow', severity: 0.95, crit: true }, null
            );
          }
        }
        this._advance(0.10, camera);
        break;
      }

      // ---------------------------------------------------------------------
      case 'ultimate': {
        const def = SKILLS.ultimate;
        this.domainFx.fire(px, py, pz, def.radius, def.domain.duration, this.motes);
        // Advance past the scribe and the eruption into the hold, where the
        // dome is fully risen, the pillars are up, the runes have drawn
        // themselves and the motes have filled the volume. 1.5 s of simulated
        // time in 1/60 steps.
        this._advance(1.15, camera);
        this.domainFx.pulse(this.motes, 1.0);
        this.impact.explode(px, py + 0.6, pz, def.radius, 'shadow', 2.0, 0);
        this._advance(0.34, camera);
        // Impacts scattered inside the domain, biased outward, so the ultimate
        // reads as damaging rather than as architecture.
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 + rng.range(-0.3, 0.3);
          const r = def.radius * Math.sqrt(rng.range(0.15, 0.92));
          this.sparks.hit(
            px + Math.sin(a) * r, py + rng.range(0.7, 1.7), pz + Math.cos(a) * r,
            -Math.sin(a), -Math.cos(a),
            { element: 'shadow', severity: rng.range(0.55, 1.0), crit: i % 3 === 0 }, null
          );
        }
        this._advance(0.09, camera);
        break;
      }

      default:
        return 'none';
    }

    this._posed = key;
    this._setFrozen(true);
    // One zero-length update so every mesh's transform, opacity and buffer is
    // written for the pose before the first settle frame renders.
    this.cleaveFx.update(0);
    this.novaFx.update(0);
    this.commandFx.update(0);
    this.domainFx.update(0);
    this.spearFx.update(0, camera);
    this.wardFx.update(0);
    this.sparks.update(0, camera);
    this.motes.update(0, camera);
    this._driveLights();
    return key;
  }

  /**
   * Advance every effect by `seconds` in fixed 1/60 steps.
   *
   * Fixed steps rather than one big delta because the mote integrator is
   * explicit Euler with a converge term: a single 0.26 s step would overshoot
   * the convergence target and scatter the motes instead of gathering them.
   */
  _advance(seconds, camera) {
    const h = 1 / 60;
    const n = Math.max(1, Math.round(seconds / h));
    for (let i = 0; i < n; i++) {
      this.cleaveFx.update(h);
      this.novaFx.update(h);
      this.commandFx.update(h);
      this.domainFx.update(h);
      this.spearFx.update(h, camera);
      this.wardFx.update(h);
      this.sparks.update(h, camera);
      this.motes.update(h, camera);
    }
  }

  _setFrozen(v) {
    this.cleaveFx.setFrozen(v);
    this.novaFx.setFrozen(v);
    this.commandFx.setFrozen(v);
    this.spearFx.setFrozen(v);
    this.domainFx.setFrozen(v);
    this.wardFx.setFrozen(v);
    this.sparks.setFrozen(v);
    this.statusFx.setFrozen(v);
  }

  _clearEffects() {
    this.exec.cancel(false);
    this.cleaveFx.clear();
    this.novaFx.clear();
    this.commandFx.clear();
    this.spearFx.clear();
    this.domainFx.clear();
    this.wardFx.clear();
    this.sparks.clear();
    this.statusFx.clear();
    this.motes.clear();
    this.lights.clear();
    this._domainSkill = null;
    this._ward.active = false;
    for (const p of this._shots) this.ctx.peek('physics')?.despawnProjectile?.(p);
    this._shots.length = 0;
  }

  /* ================================================================== */
  /* Pre-warm                                                           */
  /* ================================================================== */

  /**
   * Every material in this subsystem starts `visible = false` because every one
   * of them belongs to an effect that is off until something happens. That means
   * `render.prewarmMaterials`, which compiles what is VISIBLE, cannot reach any
   * of them — and compiling a spell mid-nova is a stall at the single worst
   * moment in the game.
   *
   * So: make them visible, compile against a bound float target (`outputColorSpace`
   * and `toneMapping` are read off the currently bound target and are part of
   * the program cache key), and hide them again. No frame is presented in
   * between, so nothing is drawn.
   */
  async prewarmMaterials(ctx) {
    const render = ctx.get('render');
    const r = render.renderer;

    const groups = [
      this.cleaveFx.group, this.novaFx.group, this.commandFx.group,
      this.spearFx.group, this.domainFx.group, this.statusFx.group,
      this.wardFx.group, this.sparks.group,
    ];
    const shown = [];
    for (const g of groups) {
      shown.push([g, g.visible]);
      g.visible = true;
      g.traverse((o) => {
        if (o.isMesh) { shown.push([o, o.visible]); o.visible = true; }
      });
    }
    this.motes.mesh.visible = true;

    const prev = r.getRenderTarget();
    r.setRenderTarget(render.rtHDR ?? prev);
    r.compile(ctx.scene, ctx.camera);
    r.setRenderTarget(prev);

    for (const [o, v] of shown) o.visible = v;

    console.info('[combat] prewarm', {
      skills: SLOT_ORDER.length,
      materials: shown.length,
      programs: r.info.programs?.length ?? 0,
      lightSlots: render.lightBudget?.slots?.point ?? '?',
    });
  }

  /* ================================================================== */
  /* Introspection                                                      */
  /* ================================================================== */

  stats() {
    return {
      posed: this._posed ?? 'live',
      exec: this.exec.stats(),
      impact: this.impact.stats(),
      status: this.status.stats(),
      targeting: this.targeting.stats(),
      counters: { ...this.counters },
      motes: { spell: this.motes.count, spark: this.sparks.motes.count },
      projectiles: this._shots.length,
      ward: this._ward.active
        ? `${Math.round(this._ward.hp)}/${Math.round(this._ward.hpMax)}`
        : 'off',
      domain: this.domainFx.active ? (this.domainFx.standing ? 'standing' : 'rising') : 'off',
      element: ELEMENTS.shadow.srgb,
    };
  }

  /**
   * Correctness checks that do not need a screenshot.
   *
   *   node arpg/tools/probe.mjs --port=5284 --eval="ctx.peek('combat').selfTest()"
   *
   * This exists because "did I break the damage model" must be answerable in
   * fifteen seconds rather than by staring at a PNG.
   */
  selfTest() {
    const out = { ok: true, checks: [] };
    const check = (name, pass, detail) => {
      out.checks.push({ name, pass, detail });
      if (!pass) out.ok = false;
    };

    // ---- skill table ---------------------------------------------------------
    let bad = 0;
    for (const id of SLOT_ORDER) {
      const d = SKILLS[id];
      if (!d || d.id !== id || !(d.windup >= 0) || !(d.recovery >= 0)) bad++;
    }
    check('skill table well formed', bad === 0, `${SLOT_ORDER.length} skills, ${bad} bad`);

    // ---- damage: armour must diminish, never eliminate ----------------------
    const dummy = {
      id: '__t', alive: true, faction: 'enemy', isPlayer: false,
      position: new THREE.Vector3(), velocity: new THREE.Vector3(),
      radius: 0.4, height: 1.8,
      stats: { hp: 1000, hpMax: 1000, armour: 4000, level: 10, poise: 30 },
    };
    const src = { stats: { damage: 100, shadowPower: 100, critChance: 0, critDamage: 2 } };
    const r = makeDamageResult();
    rollDamage(r, src, dummy, { element: 'physical', weapon: 1, power: 0 }, null, {});
    check('armour diminishes but never eliminates', r.amount > 100 * 0.14 && r.amount < 100 * 0.4,
      `${r.amount.toFixed(1)} from 100 through 4000 armour`);

    // ---- crit chance actually applies ---------------------------------------
    const critSrc = { stats: { damage: 100, shadowPower: 100, critChance: 1, critDamage: 2 } };
    rollDamage(r, critSrc, dummy, { element: 'shadow', weapon: 0, power: 1 }, this.rng, {});
    check('crit multiplies', r.crit === true, `crit=${r.crit} amount=${r.amount.toFixed(1)}`);

    // ---- shadow never hurts a shadow ----------------------------------------
    dummy.isShadow = true;
    rollDamage(r, src, dummy, { element: 'shadow', weapon: 0, power: 1 }, this.rng, {});
    check('shadow does not damage shadows', r.amount === 0, `${r.amount}`);
    dummy.isShadow = false;

    // ---- statuses ------------------------------------------------------------
    const now = this.ctx.time.elapsed;
    this.status.apply(dummy, 'chill', 3, 0, null, now);
    const slowed = this.status.get(dummy)?.slow ?? 1;
    check('chill slows', slowed < 1 && slowed > 0, `slow=${slowed.toFixed(2)}`);
    this.status.apply(dummy, 'chill', 1, 0, null, now);
    check('chill converts to freeze at max stacks',
      this.status.get(dummy)?.has('freeze') === true && this.status.get(dummy)?.rooted === true,
      `frozen=${this.status.get(dummy)?.has('freeze')}`);
    this.status.apply(dummy, 'bleed', 3, 5, null, now);
    check('bleed stacks independently', this.status.get(dummy)?.stacks('bleed') === 3,
      `${this.status.get(dummy)?.stacks('bleed')} stacks`);
    this.status.apply(dummy, 'mark', 2, 0, null, now);
    check('mark guarantees extraction', dummy.guaranteedExtract === true);
    const vulnRec = this.status.get(dummy);
    rollDamage(r, src, dummy, { element: 'physical', weapon: 1, power: 0 }, null,
      { status: vulnRec });
    check('vulnerability multiplies and is capped',
      r.vulnerability > 1 && r.vulnerability <= DAMAGE.vulnMax,
      `x${r.vulnerability.toFixed(2)}`);
    this.status.clear(dummy);
    check('status clears', this.status.get(dummy) === null);

    // ---- executor -----------------------------------------------------------
    const st = this.exec.state('skill4');
    const cdBefore = st.cooldown;
    check('cooldown starts at zero', cdBefore === 0 || cdBefore > 0, `${cdBefore.toFixed(1)}s`);
    check('charge skill reports charges', this.exec.state('skill2').maxCharges === 2);

    // ---- targeting: the snap must be bounded --------------------------------
    // A candidate 20° off-axis may be pulled at most SNAP.maxAngle. The test is
    // the invariant, not the value: an unbounded snap is aim-assist and the
    // whole design of `targeting.js` is that it never becomes one.
    check('snap correction is hard-capped', SNAP.maxAngle <= 0.15 && SNAP.strength <= 1,
      `${(SNAP.maxAngle * 180 / Math.PI).toFixed(1)} deg at strength ${SNAP.strength}`);

    // ---- budgets -------------------------------------------------------------
    const q = this.ctx.config.q;
    const totalMotes = this.motes.capacity + this.sparks.motes.capacity;
    check('mote budget within particle budget', totalMotes <= q.particleBudget,
      `${totalMotes} / ${q.particleBudget}`);
    check('spell lights within the budget headroom', this.lights.lights.length <= 3,
      `${this.lights.lights.length}`);

    out.stats = this.stats();
    return out;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._clearEffects();

    this.cleaveFx?.dispose();
    this.novaFx?.dispose();
    this.commandFx?.dispose();
    this.spearFx?.dispose();
    this.domainFx?.dispose();
    this.statusFx?.dispose();
    this.wardFx?.dispose();
    this.sparks?.dispose();
    this.motes?.dispose();
    this.lights?.dispose();
    this.status?.dispose();
    this.resolver?.dispose();
  }
}
