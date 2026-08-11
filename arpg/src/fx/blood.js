import { ELEMENTS } from '../core/palette.js';
import { DECAL_SPRITE } from './atlas.js';
import { FX } from './tuning.js';

/**
 * MONARCH — blood.
 *
 * Diablo is a blood game. The reference frames are unambiguous: every strike on
 * flesh throws an ARC of droplets that travel, land, and stay on the floor for
 * the rest of the fight; corpses pool; the player's weapon carries what it has
 * cut. None of that is decoration — it is the record of what the player has
 * done, and it is the single largest contributor to the "explosive combat"
 * read after the impact frame itself.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR THINGS BLOOD HAS TO DO, AND HOW EACH IS BUILT
 *
 *  1. **ARTERIAL SPRAY.** Droplets thrown along the blow, under gravity, with a
 *     visible ballistic arc. They are `MODE.STRETCH` particles so each one
 *     points the way it is travelling; a round blob reads as a bubble.
 *     Emission is a SHEET, not a cone — `flatten` squashes the cone across the
 *     cut, because a slash throws blood in the plane of the swing. A radially
 *     symmetric spray from a side slash is the exact failure ARCHITECTURE.md
 *     calls out under "Effects are directional".
 *
 *  2. **DROPLETS BECOME DECALS.** Each droplet caches the floor height under the
 *     wound at spawn time (ONE raycast per spray, not per droplet) and carries
 *     the `LANDS` flag. When it crosses that height the particle system calls
 *     back and a splat decal is placed. Only a fraction leave a mark, or one
 *     fight exhausts the decal pool.
 *
 *  3. **POOLING.** A corpse grows a decal from a fifth of its final size over
 *     `poolGrow` seconds, with a cubic ease-out — fast spread, then creep, which
 *     is how a real film behaves as it thins.
 *
 *  4. **WEAPON BLOOD.** A scalar that rises on every flesh hit and dries over
 *     `weaponDry` seconds. `fx` publishes it; the swing ribbon tints toward
 *     blood with it and sheds drips from the blade, so a player who has just cut
 *     through a pack swings a visibly wet weapon.
 *
 * ---------------------------------------------------------------------------
 * COLOUR
 *
 * `palette.ELEMENTS.blood`. Deliberately dark and desaturated in linear space
 * (0.42, 0.028, 0.022) — the analyser measures luminance-weighted saturation
 * against a 0.30 target and the world already sits above it, so blood must not
 * be the second saturated thing on screen competing with the violet. It reads as
 * red because it is dark and wet and lit, not because it is saturated.
 */

const BLOOD = ELEMENTS.blood;

/** Decal tag values passed through the particle system's `tag` byte. */
export const LAND_TAG = { blood: 1, gobbet: 2, water: 3, ichor: 4 };

export class BloodSystem {
  /** @param {import('./index.js').FxSystem} fx */
  constructor(fx) {
    this.fx = fx;
    /** 0..1 — how bloodied the player's weapon is right now. */
    this.weapon = 0;
    this._pools = [];      // { slot, actor } so an extraction can evaporate one
    this._sprays = 0;
    this._landed = 0;
  }

  /** Floor height under a point, or the point's own height if physics has no
   *  opinion. One call per spray; every droplet in it shares the answer. */
  groundUnder(x, y, z) {
    const P = this.fx.physics;
    if (!P?.groundAt) return y - 1.0;
    const g = P.groundAt(x, z, y + 2.2);
    return g ? g.y : y - 1.0;
  }

  /**
   * The main entry point: something was cut.
   *
   * @param {object} o
   *   x,y,z        wound position (chest height, not the feet)
   *   dx,dy,dz     the direction the blow was travelling
   *   amount       0.3 light, 1 normal, 2.5 a killing blow
   *   crit         wider, faster, more of everything
   *   groundY      pass it in when the caller already knows (saves a raycast)
   */
  spray(o) {
    const fx = this.fx;
    const em = fx.emitter;
    const amount = Math.max(0.15, o.amount ?? 1);
    const crit = !!o.crit;

    let dx = o.dx ?? 0, dy = o.dy ?? 0.15, dz = o.dz ?? 1;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    const groundY = o.groundY ?? this.groundUnder(o.x, o.y, o.z);
    this._sprays++;

    const B = FX.blood;
    const k = Math.min(3.0, amount) * (crit ? 1.5 : 1);

    // ---- 1. the arterial arc ---------------------------------------------
    // Biased UPWARD as well as along the blow: blood leaves a wound with the
    // pressure behind it, and an arc that rises before it falls is the whole
    // reason the eye reads it as arterial rather than as splatter.
    em.burst('drop', {
      count: Math.round(9 * k),
      x: o.x, y: o.y, z: o.z,
      dx, dy: dy + 0.42, dz,
      spread: B.cone * (crit ? 1.35 : 1),
      flatten: 0.45,                     // a sheet in the plane of the swing
      speed: B.speed * (0.7 + 0.45 * amount), speedVar: 0.55,
      radius: 0.075, rise: 1.3,
      // `glow` rather than `core`, at 1.6. These sprites are unlit — they get
      // no light loop at all — so tinting them with blood's true albedo makes
      // them black on a black floor. This is what a droplet lit by a brazier
      // looks like, which is where a fight happens.
      color: BLOOD.glow, intensity: 1.6,
      size: 0.85 + 0.35 * amount,
      gravity: -9.81 * B.gravity,
      groundY, tag: LAND_TAG.blood,
    });

    // ---- 2. fine mist at the wound ---------------------------------------
    // This is what makes a cut read as WET rather than as a hole. Short-lived,
    // heavily dragged, so it hangs where the blade was and nowhere else.
    // Small and DARK. The mist exists to make the wound read as wet, not to be
    // seen from across the room: at the first draft's size and 0.9 alpha it grew
    // into a two-metre pink cloud that covered the droplets and the pool it is
    // supposed to introduce. `core` rather than `glow`, because blood in the air
    // is the darkest thing in the effect, not the brightest.
    em.burst('mist', {
      count: Math.round(5 * k),
      x: o.x, y: o.y, z: o.z,
      dx, dy: dy + 0.25, dz,
      spread: 1.0, speed: 2.3 * (0.6 + 0.5 * amount), speedVar: 0.7,
      radius: 0.09,
      color: BLOOD.core, intensity: 2.4,
      size: 0.55 + 0.25 * amount, alpha: 0.55,
    });

    // ---- 3. heavy gobbets on a real blow ---------------------------------
    if (amount > 0.9 || crit) {
      em.burst('gobbet', {
        count: Math.round(3 * k),
        x: o.x, y: o.y, z: o.z,
        dx, dy: dy + 0.30, dz,
        spread: B.cone * 0.8, flatten: 0.35,
        speed: B.speed * 0.62, speedVar: 0.5,
        radius: 0.07, rise: 0.9,
        color: BLOOD.glow, intensity: 1.3, size: 1.0,
        gravity: -9.81 * B.gravity,
        groundY, tag: LAND_TAG.gobbet,
      });
    }

    // ---- 4. a spatter on whatever is behind the wound --------------------
    // Cheap, and it is the difference between blood on the floor and blood in
    // the room: one ray along the blow, and if it finds a wall within 2.5 m the
    // spray marks it.
    if (amount > 0.7) this._sprayOnto(o.x, o.y, o.z, dx, dy, dz, amount);

    this.weapon = Math.min(1, this.weapon + 0.35 * amount);
    return true;
  }

  _sprayOnto(x, y, z, dx, dy, dz, amount) {
    const P = this.fx.physics;
    if (!P?.raycastFrom) return;
    const h = P.raycastFrom(x, y, z, dx, dy, dz, 2.6);
    if (!h) return;
    this.fx.decals.place({
      x: h.px, y: h.py, z: h.pz,
      nx: h.nx, ny: h.ny, nz: h.nz,
      sprite: DECAL_SPRITE.blood,
      size: (0.32 + 0.28 * amount) * (1 - h.t / 3.4),
      color: BLOOD.core, alpha: 0.85, rough: 0.85,
      rotation: this.fx.rng.range(0, Math.PI * 2),
      // A wall spatter runs and dries faster than a floor pool.
      life: FX.decals.life * 0.55, fade: FX.decals.fade,
      conform: false,
    });
  }

  /**
   * A droplet crossed its cached floor height. Called from the particle
   * system's landing callback, which means it is on the hot path — no
   * allocation, no raycast.
   */
  onLand(x, y, z, tag, vx, vy, vz) {
    const fx = this.fx;
    if (tag === LAND_TAG.water) {
      fx.decals.place({
        x, y, z, sprite: DECAL_SPRITE.ring, size: 0.28,
        color: [0.22, 0.28, 0.34], alpha: 0.5, rough: 0.28,
        rotation: fx.rng.range(0, Math.PI * 2), life: 2.5, fade: 1.5, conform: false,
      });
      return;
    }

    const gobbet = tag === LAND_TAG.gobbet;
    // Only a fraction of droplets mark the floor. All of them would exhaust the
    // pool inside one pack, and then the pool's LRU would start eating the marks
    // the player actually watched being made.
    if (!gobbet && fx.rng.float() > FX.blood.decalChance) {
      // Still worth a splash: two or three micro-droplets bouncing off the
      // stone. It is what makes the landing read as an event.
      fx.emitter.burst('mist', {
        count: 2, x, y: y + 0.02, z,
        dx: 0, dy: 1, dz: 0, spread: 0.9, speed: 0.8, speedVar: 0.6,
        color: BLOOD.core, intensity: 2.0, size: 0.35, alpha: 0.5, life: 0.5,
      });
      return;
    }
    this._landed++;

    // Impact speed decides the shape: a fast droplet makes a long thin mark with
    // satellites, a slow one makes a round blot. Approximated by size, since the
    // sprite is fixed.
    const speed = Math.hypot(vx, vy, vz);
    // Metres of DIAMETER. Larger than a real droplet mark for the same reason
    // the droplet sprite is: at 21 m a physical 8 mm spot is a quarter of a
    // pixel, and a floor that records the fight is the whole point.
    const size = (gobbet ? 0.44 : 0.26) * (0.75 + Math.min(1.6, speed * 0.075));

    fx.decals.place({
      x, y, z, nx: 0, ny: 1, nz: 0,
      sprite: DECAL_SPRITE.blood,
      size, color: BLOOD.core,
      alpha: gobbet ? 1.0 : 0.85,
      rough: 0.9,
      rotation: fx.rng.range(0, Math.PI * 2),
      conform: false,          // far too small to span a step
    });

    // A couple of micro-droplets bouncing out of the strike.
    fx.emitter.burst('drop', {
      count: gobbet ? 3 : 2, x, y: y + 0.03, z,
      dx: vx, dy: 1.0, dz: vz, spread: 1.0,
      speed: 1.1 + speed * 0.10, speedVar: 0.7,
      color: BLOOD.glow, intensity: 1.3, size: 0.55, life: 0.5,
      gravity: -9.81 * FX.blood.gravity,
      groundY: y, tag: 0,      // tag 0 = no decal on the second landing
    });
  }

  /**
   * Blood pooling under a corpse. Returns a decal slot so the caller (or the
   * extraction, which evaporates the body) can retire it.
   */
  pool(o) {
    const fx = this.fx;
    const size = o.size ?? 1.0;
    const slot = fx.decals.place({
      x: o.x, y: o.y, z: o.z, nx: 0, ny: 1, nz: 0,
      sprite: DECAL_SPRITE.blood,
      size, color: BLOOD.core,
      alpha: 1.0, rough: 0.72,
      rotation: fx.rng.range(0, Math.PI * 2),
      grow: o.grow ?? FX.blood.poolGrow, growFrom: 0.22,
      life: o.life ?? FX.decals.life, fade: o.fade ?? FX.decals.fade,
      conform: true,
    });
    if (slot >= 0) {
      this._pools.push({ slot, actor: o.actor ?? null });
      // Only the last handful matter (an extraction targets a fresh corpse);
      // keeping every one would leak.
      if (this._pools.length > 24) this._pools.shift();
    }
    return slot;
  }

  /** Evaporate the pool under an actor — ARISE takes the body AND the blood. */
  evaporatePool(actor, over = 0.5) {
    for (let i = this._pools.length - 1; i >= 0; i--) {
      if (this._pools[i].actor !== actor) continue;
      this.fx.decals.expire(this._pools[i].slot, over);
      this._pools.splice(i, 1);
    }
  }

  /**
   * A hit that killed something: much more of everything, plus chunks that are
   * real rigid bodies so they bounce off the architecture.
   */
  gib(o) {
    const fx = this.fx;
    const amount = o.amount ?? 2.2;
    this.spray({ ...o, amount: amount * 1.4, crit: true });

    // Big low arc of gobbets, all of which mark the floor.
    const groundY = o.groundY ?? this.groundUnder(o.x, o.y, o.z);
    fx.emitter.burst('gobbet', {
      count: 7, x: o.x, y: o.y, z: o.z,
      dx: o.dx ?? 0, dy: 0.75, dz: o.dz ?? 0,
      spread: 1.35, speed: 4.4, speedVar: 0.6, radius: 0.14, rise: 1.6,
      color: BLOOD.glow, intensity: 1.5, size: 1.25,
      gravity: -9.81 * FX.blood.gravity,
      groundY, tag: LAND_TAG.gobbet,
    });

    // Physical chunks. `physics.spawnBody` gives them collision and a lifetime;
    // they are tagged `flesh` so their own impacts sound and splash correctly.
    const P = fx.physics;
    if (P?.spawnBody && o.bodies !== false) {
      const G = FX.gibs;
      for (let i = 0; i < G.count; i++) {
        const a = (i / G.count) * Math.PI * 2 + fx.rng.range(0, 1.2);
        const sp = G.speed * fx.rng.range(0.6, 1.3);
        fx.tmpA.set(o.x + Math.cos(a) * 0.12, o.y + 0.1, o.z + Math.sin(a) * 0.12);
        fx.tmpB.set(Math.cos(a) * sp, G.lift * sp * fx.rng.range(0.8, 1.5), Math.sin(a) * sp);
        fx.tmpC.set(fx.rng.range(-14, 14), fx.rng.range(-14, 14), fx.rng.range(-14, 14));
        P.spawnBody({
          shape: 'box',
          size: { x: fx.rng.range(0.07, 0.16), y: fx.rng.range(0.06, 0.13), z: fx.rng.range(0.07, 0.15) },
          position: fx.tmpA, velocity: fx.tmpB, angular: fx.tmpC,
          surface: 'flesh', mass: 1.6, restitution: 0.08, friction: 0.9,
          lifetime: G.lifetime,
        });
      }
    }

    this.pool({ x: o.x, y: groundY, z: o.z, size: 1.35, actor: o.actor, grow: 2.2 });
    this.weapon = Math.min(1, this.weapon + 0.6);
  }

  update(dt) {
    // Weapon blood dries. Linear, because drying IS linear — it is evaporation
    // at a roughly constant rate, and this is one of the few places where a
    // linear ramp is the physically correct answer rather than a shortcut.
    if (this.weapon > 0) this.weapon = Math.max(0, this.weapon - dt / FX.blood.weaponDry);
  }

  clear() {
    this.weapon = 0;
    this._pools.length = 0;
  }

  stats() {
    return { sprays: this._sprays, landed: this._landed, pools: this._pools.length, weapon: +this.weapon.toFixed(2) };
  }
}
