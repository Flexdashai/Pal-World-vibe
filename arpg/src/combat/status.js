/**
 * MONARCH — status effects.
 *
 * Burn, bleed, chill/freeze, shock and the Monarch's mark. Five effects with
 * five genuinely different stacking rules, because a status system where every
 * effect stacks to five and refreshes on reapplication is a system nobody made
 * a decision about.
 *
 *   burn    intensity   stacks raise the tick, one shared timer, refreshes
 *   bleed   independent each application is its own timer; they overlap
 *   chill   intensity   slows; reaching max stacks CONVERTS into freeze
 *   freeze  replace     roots, opens a large vulnerability window
 *   shock   duration    reapplication extends the timer, amplification is flat
 *   mark    replace     never diluted; guarantees the corpse can be extracted
 *
 * ---------------------------------------------------------------------------
 * MEMORY
 *
 * One `ActorStatus` record per afflicted actor, taken from a free list and
 * returned when the last effect on it expires. Nothing here allocates while the
 * game is running: the stack arrays are fixed-length, the per-effect state is
 * five preallocated slots, and iteration is over a dense array of live records.
 *
 * ---------------------------------------------------------------------------
 * VISUAL STATE
 *
 * A status the player cannot SEE on the actor is a status that does not exist.
 * Two channels, and both are needed:
 *
 *   1. `actor.statusTint` (THREE.Color, linear) and `actor.statusPulse` (0..1)
 *      are written every tick. `ai` owns enemy materials and can multiply its
 *      emissive by them; this is the contract for doing so.
 *   2. Combat draws its own layer regardless — a low additive ring under the
 *      feet in the dominant status's colour, plus rising motes for burn and a
 *      crust of frost planes for chill. That way the effect is legible even
 *      before `ai` exists, and it survives an `ai` that chooses not to
 *      participate.
 */

import { STATUS, DAMAGE, clamp, clamp01 } from './tuning.js';
import { ELEMENTS } from '../core/palette.js';

const IDS = ['burn', 'bleed', 'chill', 'freeze', 'shock', 'mark'];
const INDEX = Object.create(null);
for (let i = 0; i < IDS.length; i++) INDEX[IDS[i]] = i;

/** Per-actor status record. Fixed shape, pooled, never resized. */
class ActorStatus {
  constructor() {
    this.actor = null;
    this.live = false;
    /** Stack count per effect, indexed by INDEX. */
    this.count = new Int8Array(IDS.length);
    /** Expiry time (absolute, seconds) per effect. */
    this.until = new Float32Array(IDS.length);
    /** Per-tick damage per effect, already scaled by stacks. */
    this.tick = new Float32Array(IDS.length);
    /** Who applied it — kill credit for a burn must go to the caster. */
    this.source = new Array(IDS.length).fill(null);
    /**
     * `bleed` stacks independently, so its stacks need their own timers rather
     * than one shared one. Eight slots, matching STATUS.bleed.maxStacks.
     */
    this.bleedUntil = new Float32Array(8);
    this.bleedTick = new Float32Array(8);
    this.bleedSource = new Array(8).fill(null);

    /** Accumulator toward the next DoT tick. */
    this.dotAccum = 0;
    /** Movement multiplier from chill/freeze, 0..1. */
    this.slow = 1;
    /** Explicit vulnerability multiplier opened by a skill (the domain). */
    this.vulnerable = 1;
    this.vulnerableUntil = 0;
    /** Set true while the actor may not act (freeze, or a stagger lockout). */
    this.rooted = false;
    /** Dominant effect for the visual layer, and its intensity 0..1. */
    this.dominant = -1;
    this.intensity = 0;
    /** Wall time the record was created — the visual ring fades in over 0.15 s
     *  so a status appearing does not pop. */
    this.since = 0;
  }

  reset(actor, now) {
    this.actor = actor;
    this.live = true;
    this.count.fill(0);
    this.until.fill(0);
    this.tick.fill(0);
    for (let i = 0; i < IDS.length; i++) this.source[i] = null;
    this.bleedUntil.fill(0);
    this.bleedTick.fill(0);
    for (let i = 0; i < this.bleedSource.length; i++) this.bleedSource[i] = null;
    this.dotAccum = 0;
    this.slow = 1;
    this.vulnerable = 1;
    this.vulnerableUntil = 0;
    this.rooted = false;
    this.dominant = -1;
    this.intensity = 0;
    this.since = now;
    return this;
  }

  /** Stack count of an effect. The public read used by the damage model. */
  stacks(id) {
    const i = INDEX[id];
    if (i === undefined) return 0;
    if (id === 'bleed') {
      let n = 0;
      for (let s = 0; s < this.bleedUntil.length; s++) if (this.bleedUntil[s] > 0) n++;
      return n;
    }
    return this.count[i];
  }

  has(id) { return this.stacks(id) > 0; }

  /** Any effect at all? Used to decide when the record can be recycled. */
  get empty() {
    for (let i = 0; i < IDS.length; i++) if (this.count[i] > 0) return false;
    for (let s = 0; s < this.bleedUntil.length; s++) if (this.bleedUntil[s] > 0) return false;
    return this.vulnerableUntil <= 0;
  }
}

/**
 * The status registry.
 *
 * `apply` / `tick` are pure gameplay and run in `fixedUpdate`. The visual layer
 * is driven from `sync`, which runs once per frame and writes into a pooled set
 * of meshes owned by `fxstatus.js`.
 */
export class StatusSystem {
  constructor(ctx, rng, onTickDamage) {
    this.ctx = ctx;
    this.rng = rng;
    /** Callback into `index.js` so a DoT tick goes through the same emit path as
     *  a real hit (and therefore still produces a damage number and audio) while
     *  bypassing the full impact pipeline. */
    this.onTickDamage = onTickDamage;

    /** actor -> ActorStatus. */
    this.byActor = new Map();
    /** Dense array of live records, so ticking is a linear scan. */
    this.live = [];
    /** Free list. Sized for the actor budget; grows only if a level somehow
     *  exceeds it, which would be a bug elsewhere. */
    this._pool = [];
    const cap = Math.max(24, (ctx.config?.q?.maxActors ?? 60) + 24);
    for (let i = 0; i < cap; i++) this._pool.push(new ActorStatus());

    this.counters = { applied: 0, expired: 0, ticks: 0, freezes: 0, marks: 0 };
  }

  /** The record for an actor, or null. Never creates one. */
  get(actor) {
    const r = this.byActor.get(actor);
    return r && r.live ? r : null;
  }

  _acquire(actor, now) {
    let r = this.byActor.get(actor);
    if (r && r.live) return r;
    r = this._pool.pop() ?? new ActorStatus();
    r.reset(actor, now);
    this.byActor.set(actor, r);
    this.live.push(r);
    return r;
  }

  /**
   * Apply `stacks` of `id` to `actor`.
   *
   * @param tickDamage per-tick damage BEFORE the stack multiplier, normally
   *        `hitDamage * STATUS[id].tickFraction`.
   * @returns the resulting stack count.
   */
  apply(actor, id, stacks, tickDamage, source, now) {
    const def = STATUS[id];
    if (!def || !actor || actor.alive === false || stacks <= 0) return 0;
    const i = INDEX[id];
    if (i === undefined) return 0;
    const rec = this._acquire(actor, now);
    this.counters.applied++;

    switch (def.stacking) {
      // ---- independent: each application is its own timer -----------------
      case 'independent': {
        for (let n = 0; n < stacks; n++) {
          // Take a free slot, or overwrite the one expiring soonest so a
          // sustained bleed cannot be starved by its own old stacks.
          let slot = -1, soonest = Infinity;
          for (let s = 0; s < rec.bleedUntil.length; s++) {
            if (rec.bleedUntil[s] <= 0) { slot = s; break; }
            if (rec.bleedUntil[s] < soonest) { soonest = rec.bleedUntil[s]; slot = s; }
          }
          rec.bleedUntil[slot] = now + def.duration;
          rec.bleedTick[slot] = tickDamage;
          rec.bleedSource[slot] = source;
        }
        rec.count[i] = rec.stacks('bleed');
        break;
      }

      // ---- duration: reapplication extends, intensity is flat -------------
      case 'duration': {
        rec.count[i] = Math.min(def.maxStacks, rec.count[i] + stacks);
        const base = Math.max(rec.until[i], now);
        rec.until[i] = Math.min(now + def.duration * def.maxStacks, base + def.duration);
        rec.tick[i] = tickDamage * rec.count[i];
        rec.source[i] = source;
        break;
      }

      // ---- replace: never diluted, strongest application wins -------------
      case 'replace': {
        const next = Math.min(def.maxStacks, Math.max(rec.count[i], stacks));
        rec.count[i] = next;
        rec.until[i] = Math.max(rec.until[i], now + def.duration);
        rec.tick[i] = Math.max(rec.tick[i], tickDamage * next);
        rec.source[i] = source;
        if (id === 'mark') {
          this.counters.marks++;
          // The mark's mechanical payload: this corpse WILL be raisable. The
          // shadow army rolls extraction chance; a marked target skips the roll.
          actor.guaranteedExtract = true;
        }
        if (id === 'freeze') this.counters.freezes++;
        break;
      }

      // ---- intensity: stacks raise the tick, one shared refreshing timer ---
      default: {
        const before = rec.count[i];
        rec.count[i] = Math.min(def.maxStacks, before + stacks);
        rec.until[i] = now + def.duration;
        rec.tick[i] = tickDamage * rec.count[i];
        rec.source[i] = source;
        // Chill converts to freeze at max stacks. The conversion consumes the
        // chill entirely, which is what makes freeze feel earned rather than a
        // slow that happens to be worse.
        if (def.convertsTo && rec.count[i] >= def.maxStacks) {
          rec.count[i] = 0;
          rec.until[i] = 0;
          rec.tick[i] = 0;
          this.apply(actor, def.convertsTo, 1, 0, source, now);
        }
        break;
      }
    }

    this._recompute(rec, now);
    return rec.count[i];
  }

  /** Open an explicit vulnerability window (the domain does this to everything
   *  standing inside it). `mult` is a multiplier, not a fraction. */
  makeVulnerable(actor, mult, duration, now) {
    if (!actor || actor.alive === false) return;
    const rec = this._acquire(actor, now);
    rec.vulnerable = Math.max(rec.vulnerable, mult);
    rec.vulnerableUntil = Math.max(rec.vulnerableUntil, now + duration);
  }

  /** Strip every status from every actor — a level transition, a shot reset.
   *  Unlike `dispose()` this returns the records to the pool and stays usable. */
  clearAll() {
    for (let i = this.live.length - 1; i >= 0; i--) this.clear(this.live[i].actor);
    this.live.length = 0;
    this.byActor.clear();
  }

  /** Strip everything from an actor — death, a cleanse, a level transition. */
  clear(actor) {
    const rec = this.byActor.get(actor);
    if (!rec) return;
    rec.live = false;
    this.byActor.delete(actor);
    const i = this.live.indexOf(rec);
    if (i >= 0) { this.live[i] = this.live[this.live.length - 1]; this.live.pop(); }
    if (actor) {
      actor.statusSlow = 1;
      actor.statusRooted = false;
      actor.statusPulse = 0;
    }
    this._pool.push(rec);
  }

  /**
   * Advance every live record. Runs in `fixedUpdate`, so it is deterministic and
   * independent of frame rate.
   *
   * DoT damage is emitted through `onTickDamage` rather than applied here: the
   * target owns its own health (ARCHITECTURE.md), and routing ticks through the
   * same emit path means a burn still produces a damage number and an audio
   * transient without producing hit-stop or camera shake.
   */
  tick(h, now) {
    for (let li = this.live.length - 1; li >= 0; li--) {
      const rec = this.live[li];
      const actor = rec.actor;
      if (!actor || actor.alive === false) { this.clear(actor); continue; }

      // ---- expiries -------------------------------------------------------
      for (let i = 0; i < IDS.length; i++) {
        if (rec.count[i] > 0 && rec.until[i] <= now) {
          rec.count[i] = 0;
          rec.tick[i] = 0;
          rec.source[i] = null;
          this.counters.expired++;
          if (IDS[i] === 'mark') actor.guaranteedExtract = false;
        }
      }
      for (let s = 0; s < rec.bleedUntil.length; s++) {
        if (rec.bleedUntil[s] > 0 && rec.bleedUntil[s] <= now) {
          rec.bleedUntil[s] = 0; rec.bleedTick[s] = 0; rec.bleedSource[s] = null;
        }
      }
      rec.count[INDEX.bleed] = rec.stacks('bleed');
      if (rec.vulnerableUntil > 0 && rec.vulnerableUntil <= now) {
        rec.vulnerableUntil = 0;
        rec.vulnerable = 1;
      }

      // ---- damage over time ------------------------------------------------
      rec.dotAccum += h;
      if (rec.dotAccum >= DAMAGE.dotTick) {
        rec.dotAccum -= DAMAGE.dotTick;
        this._tickDot(rec, actor, now);
      }

      this._recompute(rec, now);

      if (rec.empty) { this.clear(actor); continue; }
    }
  }

  _tickDot(rec, actor, now) {
    // Burn and shock: one payment each, scaled by stacks (already folded into
    // rec.tick when the stack was applied).
    for (const id of ['burn', 'shock']) {
      const i = INDEX[id];
      if (rec.count[i] > 0 && rec.tick[i] > 0) {
        this.counters.ticks++;
        this.onTickDamage?.(actor, STATUS[id].element, rec.tick[i], rec.source[i], id);
      }
    }
    // Bleed: every live stack pays independently, and pays nearly double if the
    // victim is moving. That is the only status in the game whose damage depends
    // on what the target is doing, and it is what makes bleed worth a slot.
    let bleed = 0;
    for (let s = 0; s < rec.bleedUntil.length; s++) {
      if (rec.bleedUntil[s] > 0) bleed += rec.bleedTick[s];
    }
    if (bleed > 0) {
      const v = actor.velocity;
      const moving = v ? (v.x * v.x + v.z * v.z) > 1.2 : false;
      if (moving) bleed *= STATUS.bleed.movingMultiplier;
      this.counters.ticks++;
      this.onTickDamage?.(actor, 'physical', bleed, rec.bleedSource[0], 'bleed');
    }
  }

  /** Recompute the derived fields the rest of the game reads. */
  _recompute(rec, now) {
    const actor = rec.actor;

    // ---- movement --------------------------------------------------------
    let slow = 1;
    const chill = rec.count[INDEX.chill];
    if (chill > 0) slow -= chill * STATUS.chill.slowPerStack;
    const frozen = rec.count[INDEX.freeze] > 0;
    if (frozen) slow = 0;
    rec.slow = clamp(slow, 0, 1);
    rec.rooted = frozen;

    // Published on the actor so `ai` and the character controller can read it
    // without knowing this file exists.
    if (actor) {
      actor.statusSlow = rec.slow;
      actor.statusRooted = rec.rooted;
    }

    // ---- dominant effect, for the visual layer ---------------------------
    // Priority is deliberately not "most stacks": freeze and mark are the two
    // that change how the player should PLAY, so they win the actor's colour
    // even at one stack.
    let dom = -1, best = -1;
    const weight = [1.0, 0.8, 1.2, 3.0, 1.1, 2.2]; // burn bleed chill freeze shock mark
    for (let i = 0; i < IDS.length; i++) {
      if (rec.count[i] <= 0) continue;
      const remain = clamp01((rec.until[i] - now) / Math.max(0.001, STATUS[IDS[i]].duration));
      const score = weight[i] * (0.4 + 0.6 * remain) * (0.6 + 0.4 * rec.count[i] / STATUS[IDS[i]].maxStacks);
      if (score > best) { best = score; dom = i; }
    }
    rec.dominant = dom;
    rec.intensity = dom < 0 ? 0 : clamp01(best / 2.6);
    if (actor) actor.statusPulse = rec.intensity;
  }

  /** Linear-space colour of a record's dominant effect. */
  colourOf(rec) {
    if (!rec || rec.dominant < 0) return ELEMENTS.shadow.core;
    return (ELEMENTS[STATUS[IDS[rec.dominant]].element] ?? ELEMENTS.shadow).core;
  }

  /** The name of a record's dominant effect, or null. */
  nameOf(rec) {
    return rec && rec.dominant >= 0 ? IDS[rec.dominant] : null;
  }

  /**
   * The buff row `ui` draws for the PLAYER: `[{ glyph, element, seconds, stacks }]`.
   * Written into a preallocated array so the HUD poll is allocation-free.
   */
  buffList(actor, out, now) {
    out.length = 0;
    const rec = this.get(actor);
    if (!rec) return out;
    for (let i = 0; i < IDS.length; i++) {
      if (rec.count[i] <= 0) continue;
      const slot = this._buffSlot(out.length);
      slot.glyph = GLYPH[IDS[i]] ?? 'ward';
      slot.element = STATUS[IDS[i]].element;
      slot.seconds = Math.max(0, rec.until[i] - now);
      slot.stacks = rec.count[i];
      out.push(slot);
    }
    return out;
  }

  _buffSlot(i) {
    this._buffPool ??= [];
    while (this._buffPool.length <= i) {
      this._buffPool.push({ glyph: 'ward', element: 'shadow', seconds: 0, stacks: 1 });
    }
    return this._buffPool[i];
  }

  stats() {
    const per = {};
    for (const id of IDS) per[id] = 0;
    for (const rec of this.live) {
      for (let i = 0; i < IDS.length; i++) if (rec.count[i] > 0) per[IDS[i]]++;
    }
    return { afflicted: this.live.length, per, ...this.counters };
  }

  dispose() {
    for (const rec of this.live) {
      if (rec.actor) { rec.actor.statusSlow = 1; rec.actor.statusRooted = false; }
    }
    this.live.length = 0;
    this.byActor.clear();
    this._pool.length = 0;
  }
}

/** Glyph names `ui.BuffRow` understands. */
const GLYPH = {
  burn: 'nova', bleed: 'cleave', chill: 'lance', freeze: 'lance',
  shock: 'lance', mark: 'crown',
};

export { IDS as STATUS_IDS };
