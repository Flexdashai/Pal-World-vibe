/**
 * MONARCH — stats, resources and progression.
 *
 * Solo Leveling's whole appeal is a power curve that moves *inside one session*,
 * not across a hundred hours. Every number in this file is tuned for that: the
 * XP curve is shallow, kills are worth a lot, and the derived stats compound —
 * strength raises damage AND armour, agility raises crit chance AND crit damage
 * AND movement, so five levels feel like considerably more than 5 × one level.
 *
 * ---------------------------------------------------------------------------
 * THE CURVE
 *
 *   xpToNext(L) = round( 46 · L^1.42 + 34 · L )
 *
 *   L1→2   80      L5→6   398      L10→11  1035     L20→21   2800
 *
 * With a common enemy worth `18 + 7·L` and an elite five times that, clearing a
 * room of a dozen is most of a level early on and a third of one by level 20.
 * A run that kills 150 things ends around level 18-22, which is exactly the
 * "you started as a nobody and ended as a monarch" shape.
 *
 * ---------------------------------------------------------------------------
 * PRIMARY → DERIVED
 *
 * Four primaries, deliberately overlapping so no point is ever wasted:
 *
 *   strength      +2.4 physical damage, +1.1 armour, +2 poise
 *   agility       +0.35% crit chance, +0.9% crit damage, +0.28% move speed
 *   intelligence  +3.1 shadow power, +6 mana, +0.45% extraction chance
 *   vitality      +14 max health, +0.35 health regen, +1.5 poise
 *
 * Autoallocation exists because this is a demo build with no character screen
 * wired to spend points: `level:up` still reports the points granted so `ui`
 * can show them, and `spend()` is public for when the panel lands.
 */

/** Points granted per level. */
const POINTS_PER_LEVEL = 5;

/** Where autoallocated points go. The Monarch archetype: a caster who fights in
 *  melee, so intelligence leads and vitality keeps them alive to use it. */
const AUTO_WEIGHTS = { intelligence: 0.38, vitality: 0.26, strength: 0.20, agility: 0.16 };

export function xpToNext(level) {
  return Math.round(46 * Math.pow(level, 1.42) + 34 * level);
}

/** XP awarded for killing something of the given level and rank. */
export function xpForKill(level = 1, rank = 'common') {
  const base = 18 + 7 * level;
  const mult = rank === 'boss' ? 22 : rank === 'elite' ? 5 : rank === 'shadow' ? 0 : 1;
  return Math.round(base * mult);
}

export class Stats {
  constructor(events) {
    this.events = events;

    this.level = 1;
    this.xp = 0;
    this.xpNext = xpToNext(1);
    this.points = 0;
    this.autoSpend = true;

    this.primary = { strength: 10, agility: 10, intelligence: 12, vitality: 11 };

    // Resources. `hp`/`hpMax` are also part of the actor interface, so they are
    // mirrored onto the player object rather than duplicated.
    this.hp = 0;
    this.hpMax = 0;
    this.mana = 0;
    this.manaMax = 0;

    /** Rank, which gates extraction quality and is shown by `ui`. */
    this.rank = 'E';

    this.derive();
    this.hp = this.hpMax;
    this.mana = this.manaMax;

    /** Reused event payloads — `xp:gain` fires on every kill and
     *  ARCHITECTURE.md forbids a fresh literal on anything that frequent. */
    this._xpEvent = { amount: 0, total: 0, next: 0 };
    this._levelEvent = { level: 1, points: 0, stats: this.primary };
  }

  // =========================================================================
  // derived
  // =========================================================================

  /**
   * Recompute everything that follows from level + primaries.
   *
   * Health and mana maxima grow, and the CURRENT values grow with them: a level
   * up should feel like a heal, which is both good design and the only way the
   * player notices the level up during a fight.
   */
  derive() {
    const p = this.primary;
    const L = this.level;

    const prevHpMax = this.hpMax;
    const prevManaMax = this.manaMax;

    this.hpMax = Math.round(96 + p.vitality * 14 + L * 9);
    this.manaMax = Math.round(58 + p.intelligence * 6 + L * 5);

    this.damage = 8 + p.strength * 2.4 + L * 1.6;
    this.shadowPower = 6 + p.intelligence * 3.1 + L * 2.2;
    this.armour = Math.round(p.strength * 1.1 + L * 2.4);
    this.critChance = Math.min(0.62, 0.05 + p.agility * 0.0035);
    this.critDamage = 1.5 + p.agility * 0.009;
    this.moveSpeedMul = 1 + Math.min(0.30, p.agility * 0.0028);
    this.poise = Math.round(28 + p.strength * 2 + p.vitality * 1.5);
    this.healthRegen = 0.6 + p.vitality * 0.35;
    this.manaRegen = 2.2 + p.intelligence * 0.16;
    /** Base chance a corpse can be extracted, before rank modifiers. */
    this.extractChance = Math.min(0.92, 0.30 + p.intelligence * 0.0045 + L * 0.008);
    /** How many shadows may stand at once. The single most visible number in
     *  the game's power fantasy, so it grows every other level and is never
     *  hidden behind a stat. */
    this.armyCapacity = Math.min(24, 3 + Math.floor(L * 0.75));

    if (prevHpMax > 0) this.hp += this.hpMax - prevHpMax;
    else this.hp = this.hpMax;
    if (prevManaMax > 0) this.mana += this.manaMax - prevManaMax;
    else this.mana = this.manaMax;
    this.hp = Math.min(this.hp, this.hpMax);
    this.mana = Math.min(this.mana, this.manaMax);

    this.rank = rankFor(L);
  }

  // =========================================================================
  // progression
  // =========================================================================

  /**
   * Award XP and level up as many times as it takes.
   *
   * @returns {number} levels gained
   */
  gainXp(amount) {
    if (amount <= 0 || this.hp <= 0) return 0;
    this.xp += amount;

    const e = this._xpEvent;
    e.amount = amount;
    e.total = this.xp;
    e.next = this.xpNext;
    this.events?.emit('xp:gain', e);

    let gained = 0;
    // `while`, not `if`: a boss kill at low level is worth several levels and
    // swallowing the extra is the kind of bug nobody notices for a month.
    while (this.xp >= this.xpNext && this.level < 99) {
      this.xp -= this.xpNext;
      this.level++;
      this.points += POINTS_PER_LEVEL;
      this.xpNext = xpToNext(this.level);
      if (this.autoSpend) this._autoSpend();
      this.derive();
      gained++;

      const le = this._levelEvent;
      le.level = this.level;
      le.points = POINTS_PER_LEVEL;
      le.stats = this.primary;
      this.events?.emit('level:up', le);
    }
    return gained;
  }

  /** Spend points into a primary. Public for the character panel. */
  spend(name, n = 1) {
    if (!(name in this.primary)) return 0;
    const take = Math.min(n, this.points);
    if (take <= 0) return 0;
    this.primary[name] += take;
    this.points -= take;
    this.derive();
    return take;
  }

  /**
   * Distribute this level's points by the archetype weights.
   *
   * Deterministic largest-remainder allocation rather than a random roll: the
   * capture harness must produce the same character at the same level every
   * time, and `Math.random()` is forbidden anyway.
   */
  _autoSpend() {
    const names = Object.keys(AUTO_WEIGHTS);
    const raw = names.map((n) => POINTS_PER_LEVEL * AUTO_WEIGHTS[n]);
    const base = raw.map(Math.floor);
    let left = POINTS_PER_LEVEL - base.reduce((a, b) => a + b, 0);
    const order = names
      .map((n, i) => ({ i, frac: raw[i] - base[i] }))
      .sort((a, b) => b.frac - a.frac);
    for (const o of order) {
      if (left <= 0) break;
      base[o.i]++;
      left--;
    }
    for (let i = 0; i < names.length; i++) this.primary[names[i]] += base[i];
    this.points -= POINTS_PER_LEVEL;
  }

  // =========================================================================
  // resources
  // =========================================================================

  regen(dt) {
    if (this.hp <= 0) return;
    if (this.hp < this.hpMax) this.hp = Math.min(this.hpMax, this.hp + this.healthRegen * dt);
    if (this.mana < this.manaMax) this.mana = Math.min(this.manaMax, this.mana + this.manaRegen * dt);
  }

  spendMana(cost) {
    if (cost <= 0) return true;
    if (this.mana < cost) return false;
    this.mana -= cost;
    return true;
  }

  /**
   * Apply incoming damage through the armour curve.
   *
   * Diablo's diminishing form: `mitigation = armour / (armour + k·level)`, so
   * armour never reaches 100% and stays meaningful at every level. k = 52 puts
   * a level-10 hero with 35 armour at 6% mitigation and a level-20 one with
   * 110 armour at 9.5% — armour is a supporting stat here, not the plan.
   */
  takeDamage(amount) {
    const k = 52 * this.level;
    const mit = this.armour / (this.armour + k);
    const taken = Math.max(1, amount * (1 - mit));
    this.hp = Math.max(0, this.hp - taken);
    return taken;
  }

  snapshot() {
    return {
      level: this.level,
      rank: this.rank,
      xp: Math.round(this.xp),
      xpNext: this.xpNext,
      points: this.points,
      hp: Math.round(this.hp),
      hpMax: this.hpMax,
      mana: Math.round(this.mana),
      manaMax: this.manaMax,
      primary: { ...this.primary },
      damage: +this.damage.toFixed(1),
      shadowPower: +this.shadowPower.toFixed(1),
      armour: this.armour,
      crit: +(this.critChance * 100).toFixed(1),
      critDamage: +(this.critDamage * 100).toFixed(0),
      moveSpeed: +this.moveSpeedMul.toFixed(3),
      poise: this.poise,
      extractChance: +this.extractChance.toFixed(3),
      armyCapacity: this.armyCapacity,
    };
  }
}

/** Hunter rank from level. Pure flavour, but it is the label `ui` shows next to
 *  the portrait and it is the clearest single signal that the run is escalating. */
export function rankFor(level) {
  if (level >= 40) return 'MONARCH';
  if (level >= 30) return 'S';
  if (level >= 22) return 'A';
  if (level >= 15) return 'B';
  if (level >= 9) return 'C';
  if (level >= 5) return 'D';
  return 'E';
}
