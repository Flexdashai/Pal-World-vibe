/**
 * MONARCH — the skill runtime.
 *
 * Cooldowns, charges, resource cost, and the wind-up → strike → recovery state
 * machine that turns a skill definition into a sequence of callbacks. It knows
 * nothing about damage, hitboxes or VFX; it only decides WHEN.
 *
 * ---------------------------------------------------------------------------
 * WHY A STATE MACHINE AND NOT A TIMER
 *
 * A skill that resolves its damage on the frame the button is pressed is the
 * single most common reason combat feels like clicking a spreadsheet. The three
 * phases each do a job:
 *
 *   WIND-UP    the animation's anticipation plays; the effect's gather phase
 *              runs; the player is committed but has not yet acted. This is the
 *              window an enemy can react in, and it is what makes a big skill a
 *              decision.
 *   STRIKE     damage lands. Zero-length: it is a frame, not a duration. A skill
 *              with several windows (the finisher's double hit, the nova's
 *              rebound) declares them as `pulses` offsets.
 *   RECOVERY   the player cannot move or act. Every skill's power is paid for
 *              here, and a skill with no recovery is free.
 *
 * A CHANNEL skill (the domain) additionally stays "running" after its last
 * pulse, with `tick` called every fixed step until it reports done.
 *
 * ---------------------------------------------------------------------------
 * INPUT AND SUBSTEPS
 *
 * `Engine.step` can run `fixedUpdate` up to MAX_SUBSTEPS times in one frame
 * while `input.keysPressed` is only cleared in `endFrame`. Reading an edge in
 * `fixedUpdate` without a frame guard therefore fires the skill up to five times
 * per press — and on a machine where one frame costs a second, that is EVERY
 * frame. `index.js` owns the guard; this file is only ever told "cast".
 */

import * as THREE from 'three';
import { SKILLS, SLOT_ORDER, CHAIN_WINDOW } from './skills.js';
import { clamp01 } from './tuning.js';

/** Per-skill runtime state. */
class SkillState {
  constructor(def) {
    this.def = def;
    this.id = def.id;
    /** Seconds remaining on the (next) cooldown. */
    this.cooldown = 0;
    /** Available charges. A skill with `charges: 0` uses `cooldown` alone. */
    this.charges = def.charges || 0;
    this.maxCharges = def.charges || 0;
    /** Total casts, for the debug readout. */
    this.casts = 0;
    this.lastCastAt = -1e9;
  }

  get ready() {
    return this.maxCharges > 0 ? this.charges > 0 : this.cooldown <= 0;
  }

  /** 0..1 progress of the running cooldown, for the HUD. */
  get progress() {
    const cd = this.def.cooldown || 1;
    return 1 - clamp01(this.cooldown / cd);
  }
}

export class Executor {
  /**
   * @param handlers { begin, strike, tick, end, blocked } — all optional.
   *   begin(cast)          the wind-up starts. Fire the animation and the
   *                        effect's anticipation phase here.
   *   strike(cast, index)  a damage window opens. Resolve the hitbox.
   *   tick(cast, h)        every fixed step while the skill runs. Return false
   *                        from a channel skill to end it early.
   *   end(cast)            recovery finished; the player is free.
   */
  constructor(ctx, handlers = {}) {
    this.ctx = ctx;
    this.on = handlers;

    this.states = new Map();
    for (const id of SLOT_ORDER) this.states.set(id, new SkillState(SKILLS[id]));

    /** The running cast, or null. Preallocated and reused — a fresh object per
     *  cast is an allocation every time the player presses a button. */
    this.cast = {
      active: false, def: null, id: null,
      t: 0, phase: 'idle', pulse: 0, pulses: 0,
      origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
      target: null, seed: 0, scale: 1,
      /** Chain step for the primary attack, or null. */
      step: null, stepIndex: 0,
      /** Resolved schedule for this cast — the chain step may override all
       *  three. Declared here rather than added in `start` so the object keeps
       *  one hidden class for the life of the process. */
      windup: 0, pulseTimes: null, recovery: 0,
      /** Set by a handler to keep a channel alive. */
      channelUntil: 0,
    };

    /** Primary-attack chain position and its expiry. */
    this.chainIndex = 0;
    this.chainAt = -1e9;

    /** Reused payloads. */
    this._ready = { skill: null, slot: 0 };
    this._castEvent = {
      skill: null, origin: new THREE.Vector3(), dir: new THREE.Vector3(),
      target: null, seed: 0, element: 'physical',
    };

    this.counters = { casts: 0, refused: 0, interrupted: 0 };
  }

  state(id) { return this.states.get(id) ?? null; }

  /** True while a cast is committed — used to gate further input and to tell
   *  `player` that movement should be locked. */
  get busy() { return this.cast.active; }

  /** True while the player may not act at all (wind-up and recovery). A channel
   *  skill releases control the moment its last pulse has fired. */
  get locked() {
    return this.cast.active && this.cast.phase !== 'channel';
  }

  /* ================================================================== */
  /* Availability                                                       */
  /* ================================================================== */

  /**
   * @returns '' when castable, otherwise the reason: 'unknown' | 'busy' |
   *          'cooldown' | 'mana' | 'dead'.
   */
  why(id, caster) {
    const s = this.states.get(id);
    if (!s) return 'unknown';
    if (caster && caster.alive === false) return 'dead';
    // A running cast can be superseded only by the primary attack chaining into
    // itself; everything else waits. Letting the ultimate interrupt a cleave
    // mid-swing looks broken because the animation snaps.
    if (this.cast.active) {
      const chaining = id === 'skill1' && this.cast.id === 'skill1' &&
        this.cast.phase === 'recovery';
      if (!chaining) return 'busy';
    }
    if (!s.ready) return 'cooldown';
    const mana = caster?.stats?.mana;
    if (s.def.cost > 0 && typeof mana === 'number' && mana < s.def.cost) return 'mana';
    return '';
  }

  canCast(id, caster) { return this.why(id, caster) === ''; }

  /* ================================================================== */
  /* Casting                                                            */
  /* ================================================================== */

  /**
   * Start a skill.
   *
   * @param opts { origin: Vector3, dir: Vector3, target, caster, seed }
   * @returns true if the cast started.
   */
  start(id, opts) {
    const s = this.states.get(id);
    const reason = this.why(id, opts.caster);
    if (reason) {
      this.counters.refused++;
      this.on.blocked?.(id, reason);
      return false;
    }

    const def = s.def;
    const now = this.ctx.time.elapsed;

    // ---- pay ---------------------------------------------------------------
    if (def.cost > 0) {
      const stats = opts.caster?.stats;
      if (stats?.spendMana) { if (!stats.spendMana(def.cost)) return false; }
      else if (typeof stats?.mana === 'number') stats.mana = Math.max(0, stats.mana - def.cost);
    }
    if (s.maxCharges > 0) {
      s.charges--;
      // The recharge timer only starts if it was not already running: two
      // charges spent back to back must not reset the first one's progress.
      if (s.cooldown <= 0) s.cooldown = def.cooldown;
    } else {
      s.cooldown = def.cooldown;
    }
    s.casts++;
    s.lastCastAt = now;
    this.counters.casts++;

    // ---- the chain ---------------------------------------------------------
    let step = null;
    if (def.chain) {
      if (now - this.chainAt > CHAIN_WINDOW) this.chainIndex = 0;
      step = def.chain[this.chainIndex % def.chain.length];
      this.cast.stepIndex = this.chainIndex % def.chain.length;
      this.chainIndex++;
      this.chainAt = now;
    } else {
      this.cast.stepIndex = 0;
    }

    // ---- arm the state machine ---------------------------------------------
    const c = this.cast;
    c.active = true;
    c.def = def;
    c.id = id;
    c.t = 0;
    c.phase = 'windup';
    c.pulse = 0;
    c.step = step;
    c.scale = opts.scale ?? 1;
    c.target = opts.target ?? null;
    c.seed = opts.seed ?? 0;
    c.channelUntil = 0;
    c.origin.copy(opts.origin);
    c.dir.copy(opts.dir);

    // The pulse schedule: window 0 at `windup`, then any declared offsets. The
    // chain step may override both the wind-up and the pulse list.
    const windup = step?.windup ?? def.windup ?? 0.2;
    const pulses = step?.pulses ?? def.pulses ?? null;
    c.windup = windup;
    c.pulseTimes = pulses;
    c.pulses = 1 + (pulses ? pulses.length : 0);
    c.recovery = step?.recovery ?? def.recovery ?? 0.2;

    // ---- announce -----------------------------------------------------------
    // `player:cast` is the contract: `player` plays the animation, `ui` starts
    // the cooldown sweep and deducts mana, `audio` plays the cast layer.
    const e = this._castEvent;
    e.skill = id;
    e.origin.copy(c.origin);
    e.dir.copy(c.dir);
    e.target = c.target;
    e.seed = c.seed;
    e.element = def.element;
    this.ctx.events.emit('player:cast', e);

    this.on.begin?.(c);
    return true;
  }

  /** Abort the running cast — death, a stagger, a level transition. */
  cancel(interrupted = true) {
    if (!this.cast.active) return;
    if (interrupted) this.counters.interrupted++;
    this.on.end?.(this.cast, interrupted);
    this.cast.active = false;
    this.cast.phase = 'idle';
    this.cast.def = null;
    this.cast.id = null;
  }

  /** Keep a channel skill alive until `t` seconds from now. */
  hold(seconds) {
    this.cast.channelUntil = Math.max(this.cast.channelUntil, this.cast.t + seconds);
  }

  /* ================================================================== */
  /* Fixed step                                                         */
  /* ================================================================== */

  update(h, caster) {
    // ---- cooldowns ---------------------------------------------------------
    for (const s of this.states.values()) {
      if (s.cooldown <= 0) continue;
      s.cooldown -= h;
      if (s.cooldown > 0) continue;
      if (s.maxCharges > 0) {
        s.charges = Math.min(s.maxCharges, s.charges + 1);
        // Still short of full: immediately start the next charge's timer, so
        // charges recharge back to back rather than only on demand.
        s.cooldown = s.charges < s.maxCharges ? s.def.cooldown : 0;
        if (s.charges === 1 || s.charges === s.maxCharges) this._announceReady(s);
      } else {
        s.cooldown = 0;
        this._announceReady(s);
      }
    }

    // ---- the running cast ---------------------------------------------------
    const c = this.cast;
    if (!c.active) return;
    if (caster?.alive === false) { this.cancel(true); return; }

    c.t += h;

    // Fire every damage window crossed this step. A step can cross more than
    // one when the frame rate collapses, and a skipped window is a hit the
    // player watched happen and did not get paid for. On this container, where
    // one frame can cost a second and MAX_SUBSTEPS caps catch-up at five, that
    // is not hypothetical.
    while (c.pulse < c.pulses) {
      const at = c.pulse === 0 ? c.windup : c.windup + c.pulseTimes[c.pulse - 1];
      if (c.t < at) break;
      c.phase = 'strike';
      const index = c.pulse;
      c.pulse++;
      this.on.strike?.(c, index);
    }

    this.on.tick?.(c, h);

    // ---- phase bookkeeping ---------------------------------------------------
    const lastPulse = c.windup + (c.pulseTimes?.length ? c.pulseTimes[c.pulseTimes.length - 1] : 0);
    if (c.t < c.windup) {
      c.phase = 'windup';
    } else if (c.pulse < c.pulses) {
      c.phase = 'active';
    } else if (c.def.channel && c.t < Math.max(c.channelUntil, lastPulse)) {
      // A channel releases the player's control (movement is theirs again) but
      // the skill keeps running and keeps pulsing.
      c.phase = 'channel';
    } else if (c.t < lastPulse + c.recovery) {
      c.phase = 'recovery';
    } else {
      this.on.end?.(c, false);
      c.active = false;
      c.phase = 'idle';
      c.def = null;
      c.id = null;
    }
  }

  _announceReady(s) {
    const e = this._ready;
    e.skill = s.id;
    e.slot = s.def.slot;
    this.ctx.events.emit('skill:ready', e);
  }

  /* ================================================================== */
  /* Introspection                                                      */
  /* ================================================================== */

  /** Reset every cooldown — the shot harness and the dev console. */
  refresh() {
    for (const s of this.states.values()) {
      s.cooldown = 0;
      s.charges = s.maxCharges;
    }
    this.chainIndex = 0;
  }

  stats() {
    const out = {};
    for (const [id, s] of this.states) {
      out[id] = {
        cd: +s.cooldown.toFixed(2),
        charges: s.maxCharges > 0 ? `${s.charges}/${s.maxCharges}` : '-',
        casts: s.casts,
      };
    }
    return {
      skills: out,
      casting: this.cast.active ? `${this.cast.id}:${this.cast.phase}` : 'idle',
      chain: this.chainIndex % 4,
      ...this.counters,
    };
  }
}
