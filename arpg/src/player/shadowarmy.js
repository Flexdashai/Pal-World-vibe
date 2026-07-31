import * as THREE from 'three';

/**
 * MONARCH — shadow extraction.
 *
 * The single most important system in the game's identity. A corpse dissolves
 * into a violet vortex and re-forms as a black soldier with glowing eyes, and
 * from then on it fights for you. The escalation has to be VISIBLE: by the end
 * of a run there should be a dozen shadows on screen and the player should be
 * doing less than a third of the killing.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP SPLIT (ARCHITECTURE.md)
 *
 *   player  decides WHETHER a corpse can be extracted and emits `shadow:extract`
 *   fx      plays the vortex on that event
 *   ai      spawns the soldier and emits `shadow:arise`
 *   ui      shows the SYSTEM window on both
 *
 * This file therefore never spawns anything. It owns the roll, the corpse
 * bookkeeping and the army ledger, and it is careful to emit exactly once per
 * corpse — a double extract would give `ai` two soldiers from one body.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO EXTRACT
 *
 *   AUTOMATIC   on `combat:kill`, roll against the rank-adjusted chance. Keeps
 *               the army growing during a fight with no input.
 *   ARISE (F)   deliberately raise every eligible corpse in radius at once,
 *               with the full pose and the SYSTEM window. This is the beat the
 *               player presses when they have just cleared a room, and it is
 *               why corpses are remembered for `CORPSE_TTL` seconds instead of
 *               being resolved instantly.
 *
 * A corpse is only ever counted once because it is keyed on the ACTOR object,
 * and the record is dropped the moment it is consumed.
 */

/** How long a corpse stays extractable. Long enough to finish the fight and
 *  then press ARISE; short enough that the ledger cannot grow without bound. */
const CORPSE_TTL = 22;
/** Hard cap on remembered corpses. Beyond this the oldest is dropped. */
const MAX_CORPSES = 48;

/** Rank multipliers on the base extraction chance, and the soldier's strength.
 *  Bosses are always extractable — failing that roll would be a catastrophic
 *  anticlimax at the exact moment the game is trying to be at its best. */
const RANK = {
  common: { chance: 1.0, duration: 1.15, power: 1.0 },
  elite: { chance: 0.62, duration: 1.55, power: 1.9 },
  boss: { chance: 4.0, duration: 2.5, power: 4.5 },
};

export class ShadowArmy {
  /**
   * @param {object} ctx      engine context
   * @param {import('./stats.js').Stats} stats
   * @param {import('../core/rng.js').Rng} rng   a fork owned by the player
   */
  constructor(ctx, stats, rng) {
    this.ctx = ctx;
    this.stats = stats;
    this.rng = rng;

    /** Corpses awaiting extraction. Kept in insertion order. */
    this.corpses = [];
    /** Soldiers currently standing, as reported by `ai` via `shadow:arise`. */
    this.count = 0;
    this.totalExtracted = 0;
    this.totalFailed = 0;

    /** Reused payload for `shadow:extract`. */
    this._payload = {
      actor: null, position: new THREE.Vector3(), rank: 'common', duration: 1.15, power: 1,
    };
    this._systemPayload = { kind: 'system', title: '', lines: [], duration: 4.2 };
    this._v = new THREE.Vector3();
  }

  get capacity() { return this.stats.armyCapacity; }
  get full() { return this.count >= this.capacity; }

  // =========================================================================
  // bookkeeping
  // =========================================================================

  /**
   * Record a kill. Called from the player system's `combat:kill` listener.
   *
   * @returns {'extracted'|'remembered'|'ignored'}
   */
  onKill(e, now) {
    const actor = e?.actor;
    if (!actor || actor.isPlayer || actor.isShadow) return 'ignored';

    const rank = normaliseRank(actor);
    const record = {
      actor,
      rank,
      level: actor.stats?.level ?? this.stats.level,
      x: e.position?.x ?? actor.position?.x ?? 0,
      y: e.position?.y ?? actor.position?.y ?? 0,
      z: e.position?.z ?? actor.position?.z ?? 0,
      time: now,
      consumed: false,
    };

    // Automatic extraction, rolled immediately. A boss always passes, so the
    // roll is skipped rather than rolled with a chance above 1 — that keeps the
    // RNG stream identical whether or not a boss died, which matters for
    // capture reproducibility.
    const r = RANK[rank] ?? RANK.common;
    const chance = Math.min(0.95, this.stats.extractChance * r.chance);
    const auto = rank === 'boss' || this.rng.float() < chance;

    if (auto && !this.full) {
      this._emitExtract(record);
      return 'extracted';
    }

    if (!auto) this.totalFailed++;
    // Remembered either way: a failed automatic roll can still be raised by
    // hand with ARISE, which is what makes the button worth pressing.
    this.corpses.push(record);
    if (this.corpses.length > MAX_CORPSES) this.corpses.shift();
    return 'remembered';
  }

  /** Drop corpses that have gone cold. */
  prune(now) {
    if (!this.corpses.length) return;
    let w = 0;
    for (let i = 0; i < this.corpses.length; i++) {
      const c = this.corpses[i];
      if (!c.consumed && now - c.time < CORPSE_TTL) this.corpses[w++] = c;
    }
    this.corpses.length = w;
  }

  /** `ai` confirms a soldier stood up. */
  onArise() {
    this.count = Math.min(this.capacity, this.count + 1);
  }

  /** A soldier died or expired. */
  onShadowLost() {
    this.count = Math.max(0, this.count - 1);
  }

  // =========================================================================
  // ARISE
  // =========================================================================

  /**
   * Raise every eligible corpse within `radius` of `origin`.
   *
   * Returns the number raised, so the player system knows whether to play the
   * pose at all — an ARISE with nothing to raise should fizzle rather than
   * commit the hero to a 2.6 s animation.
   */
  arise(origin, radius = 11) {
    if (this.full || !this.corpses.length) return 0;
    const r2 = radius * radius;
    let raised = 0;

    // Nearest first, so a partial raise (capacity-limited) takes the bodies the
    // player is standing over rather than the ones across the room.
    this.corpses.sort((a, b) => sqDist(a, origin) - sqDist(b, origin));

    for (const c of this.corpses) {
      if (this.count + raised >= this.capacity) break;
      if (c.consumed) continue;
      if (sqDist(c, origin) > r2) continue;
      this._emitExtract(c);
      c.consumed = true;
      raised++;
    }
    if (raised) this.corpses = this.corpses.filter((c) => !c.consumed);
    return raised;
  }

  /** How many corpses ARISE would raise right now — used to decide whether the
   *  button does anything, and by `ui` for the prompt. */
  eligible(origin, radius = 11) {
    if (this.full) return 0;
    const r2 = radius * radius;
    let n = 0;
    for (const c of this.corpses) {
      if (!c.consumed && sqDist(c, origin) <= r2) n++;
      if (this.count + n >= this.capacity) break;
    }
    return n;
  }

  // =========================================================================

  _emitExtract(record) {
    const r = RANK[record.rank] ?? RANK.common;
    const p = this._payload;
    p.actor = record.actor;
    p.position.set(record.x, record.y, record.z);
    p.rank = record.rank;
    p.duration = r.duration;
    // Scaled by the hero's shadow power, so a soldier raised at level 20 is
    // meaningfully stronger than one raised at level 3. `ai` reads it when it
    // builds the soldier.
    p.power = r.power * (0.6 + this.stats.shadowPower / 90);
    record.consumed = true;
    this.totalExtracted++;
    this.ctx.events.emit('shadow:extract', p);
  }

  stats_() {
    return {
      count: this.count,
      capacity: this.capacity,
      corpses: this.corpses.length,
      extracted: this.totalExtracted,
      failed: this.totalFailed,
    };
  }
}

function sqDist(c, o) {
  const dx = c.x - o.x, dz = c.z - o.z;
  return dx * dx + dz * dz;
}

/** Map whatever `ai` calls a rank onto the three this system knows. */
function normaliseRank(actor) {
  const r = actor.rank ?? actor.stats?.rank ?? actor.tier;
  if (r === 'boss' || actor.isBoss) return 'boss';
  if (r === 'elite' || r === 'champion' || actor.isElite) return 'elite';
  return 'common';
}
