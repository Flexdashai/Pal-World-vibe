import { DIRECTOR, ARCHETYPES, clamp, clamp01 } from './tuning.js';

/**
 * MONARCH — the spawn director.
 *
 * Encounter pacing, not a spawner. The difference is that a spawner answers
 * "may I create an enemy"; a director answers "what should the next sixty
 * seconds feel like".
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE IT IS TRYING TO PRODUCE
 *
 * Solo Leveling's power curve moves inside a single session, so the fights have
 * to move with it. The director therefore:
 *
 *   - spends a WAVE BUDGET rather than picking a count, so composition changes
 *     as the budget grows: five ghouls, then ghouls with a beast, then a knight
 *     appears, then a brute. The player learns each archetype in isolation
 *     before meeting it in a mix, which is how a game teaches without a tutorial.
 *   - escalates monotonically. There is no plateau; wave six is not the last
 *     wave, it is the last DEFINED wave, and past it the budget keeps climbing.
 *   - inserts a LULL after a wave is cleared. The gap is what makes a fight feel
 *     like a fight rather than a treadmill, and it is when the player presses
 *     ARISE — which is the beat the whole game is built around.
 *   - never spawns in view. `nav.findSpawn` rejects any cell in front of the
 *     camera; an enemy that materialises inside the frame is the clearest
 *     possible admission that the world is fake.
 *   - stands down entirely while the boss is alive. Its adds are its own.
 */
export class Director {
  constructor(ai) {
    this.ai = ai;
    this.enabled = true;
    this.wave = 0;
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
    this.pending = [];              // archetype ids queued for this wave
    this.nextTickAt = 0;
    this.lullUntil = 0;
    this.state = 'idle';            // idle | spawning | fighting | lull
    this.totalSpawned = 0;
    this._budget = 0;
  }

  reset() {
    this.wave = 0;
    this.pending.length = 0;
    this.state = 'idle';
    this.lullUntil = 0;
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
  }

  /** The budget for a wave index, extrapolated past the authored table. */
  budgetFor(i) {
    const table = DIRECTOR.waves;
    if (i < table.length) return table[i].budget;
    // Past the table the budget keeps climbing at the same rate the last two
    // authored waves did — the escalation must not plateau.
    const a = table[table.length - 2].budget;
    const b = table[table.length - 1].budget;
    return b + (b - a) * (i - table.length + 1);
  }

  kindsFor(i) {
    const table = DIRECTOR.waves;
    return table[Math.min(i, table.length - 1)].kinds;
  }

  /** Compose the next wave into `pending`, spending the budget. */
  compose() {
    const rng = this.ai.rng;
    const kinds = this.kindsFor(this.wave);
    let budget = this.budgetFor(this.wave);
    this._budget = budget;
    this.pending.length = 0;

    // A guaranteed leader for anything past the second wave. A pack with an
    // elite in it reads completely differently from a pack of the same size
    // without one, because the player has to decide what to kill first.
    if (this.wave >= 3) {
      const elites = kinds.filter((k) => ARCHETYPES[k]?.rank === 'elite');
      if (elites.length) {
        const pick = elites[rng.u32() % elites.length];
        this.pending.push(pick);
        budget -= DIRECTOR.cost[pick] ?? 3;
      }
    }

    let guard = 0;
    while (budget > 0.5 && guard++ < 64) {
      const pick = kinds[rng.u32() % kinds.length];
      const cost = DIRECTOR.cost[pick] ?? 1;
      if (cost > budget + 0.5) continue;
      this.pending.push(pick);
      budget -= cost;
    }
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
    return this.pending.length;
  }

  /**
   * One director tick. Called from the AI system's fixed step; it decides when
   * to work rather than being called on a schedule.
   */
  update(dt, now) {
    if (!this.enabled) return;
    if (now < this.nextTickAt) return;
    this.nextTickAt = now + DIRECTOR.tick;

    const ai = this.ai;
    if (ai.bossAlive) return;                 // the Warden brings its own
    const player = ai.player;
    if (!player || player.alive === false) return;
    if (!ai.flow.ready) return;

    const alive = ai.enemyCount();
    const cap = Math.floor(ai.maxActors * DIRECTOR.softCap);

    switch (this.state) {
      case 'idle':
        this.compose();
        this.state = 'spawning';
        break;

      case 'spawning': {
        if (this.pending.length === 0) { this.state = 'fighting'; break; }
        if (alive >= cap) break;
        // Two per tick, so a wave arrives over a few seconds rather than as a
        // block. An instant wall of bodies is unreadable and it is also the
        // frame that hitches.
        for (let i = 0; i < 2 && this.pending.length && alive + i < cap; i++) {
          const kind = this.pending.pop();
          if (!this.spawnOne(kind)) { this.pending.push(kind); break; }
          this.spawnedThisWave++;
          this.totalSpawned++;
        }
        break;
      }

      case 'fighting':
        if (alive === 0) {
          this.state = 'lull';
          this.lullUntil = now + DIRECTOR.lull;
          this.wave++;
          // The player is told the room is clear, because that is the cue to
          // press ARISE — and ARISE is the beat the whole game is built around.
          ai.system('AREA CLEAR', [
            `Wave ${this.wave} defeated.`,
            'Raise your shadows.',
          ], 2.6);
        }
        break;

      case 'lull':
        if (now >= this.lullUntil) this.state = 'idle';
        break;

      default:
        this.state = 'idle';
        break;
    }
    void dt;
  }

  /** Place one enemy out of sight, on the navigation grid. */
  spawnOne(kind) {
    const ai = this.ai;
    const p = ai.player;
    if (!p) return false;
    ai.cameraForward(ai._camDir);
    const spot = ai.flow.findSpawn(
      ai.rng, p.position.x, p.position.z,
      DIRECTOR.spawnMin, DIRECTOR.spawnMax,
      ai._camDir.x, ai._camDir.z
    );
    if (!spot) return false;
    const yaw = Math.atan2(p.position.x - spot.x, p.position.z - spot.z);
    const level = ai.levelFor();
    return !!ai.spawn(kind, spot.x, spot.y, spot.z, { yaw, level });
  }

  stats() {
    return {
      state: this.state,
      wave: this.wave,
      budget: this._budget,
      pending: this.pending.length,
      spawned: this.totalSpawned,
      enabled: this.enabled,
    };
  }
}

export { clamp, clamp01 };
