/**
 * MONARCH — the hit flash.
 *
 * ARCHITECTURE.md hands `fx` the particle burst, the blood and the decal, and
 * hands `combat` "a hit flash on the target". This is that flash, and it is the
 * one piece of impact feedback that is guaranteed to be present regardless of
 * what any other subsystem is doing.
 *
 * A flash is three things on three different curves, which is what stops it
 * reading as a sprite scaling up:
 *
 *   core     a star of tapered shards, ELONGATED ALONG THE BLOW. 90 ms, step in
 *            and expo out. Effects are directional: a radially symmetric flash
 *            from a side slash is wrong.
 *   ring     a thin expanding disc perpendicular to the blow. 220 ms.
 *   sparks   a directional spray biased into the incident direction, with a few
 *            outliers that go the other way because a perfectly cone-shaped
 *            spray reads as a nozzle. 550 ms.
 *
 * Plus a light on its own envelope, peaking one frame BEFORE the visual peak and
 * decaying slower — a spell whose light snaps on and off with its sprite does
 * not illuminate anything and the eye notices.
 */

import * as THREE from 'three';
import { GLOW, IMPACT, VFX, clamp, clamp01, expoOut } from './tuning.js';
import { makeSpellMaterial, tagEffect, MoteField, elementRgb } from './fxkit.js';
import { ELEMENTS } from '../core/palette.js';

/** Concurrent flashes. Eight matches IMPACT.fullFxPerFrame, so a frame that
 *  saturates the impact budget can still show every one of its flashes. */
const FLASH_SLOTS = 10;

export class SparkField {
  constructor(ctx, rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.name = 'mn.combat.sparks';
    ctx.scene.add(this.group);

    this._geo = [];
    this._mat = [];

    // ---- the star core ------------------------------------------------------
    this.starGeo = buildStar(rng, 7);
    this._geo.push(this.starGeo);
    this.ringGeo = buildFlashRing(28);
    this._geo.push(this.ringGeo);

    this.slots = [];
    const render = ctx.peek('render');
    for (let i = 0; i < FLASH_SLOTS; i++) {
      const starMat = makeSpellMaterial(`flashCore${i}`, ELEMENTS.physical.glow, { opacity: 0 });
      const ringMat = makeSpellMaterial(`flashRing${i}`, ELEMENTS.physical.core, { opacity: 0 });
      this._mat.push(starMat, ringMat);
      render?.registerMaterial?.(starMat);
      render?.registerMaterial?.(ringMat);

      const star = new THREE.Mesh(this.starGeo, starMat);
      star.name = `mn.combat.flash${i}`;
      tagEffect(star, GLOW.spark, 12);
      const ring = new THREE.Mesh(this.ringGeo, ringMat);
      ring.name = `mn.combat.flashRing${i}`;
      tagEffect(ring, GLOW.ring, 11);

      this.group.add(star, ring);
      this.slots.push({
        star, ring, starMat, ringMat,
        t: -1, life: IMPACT.flashLife, ringLife: 0.22,
        scale: 1, ringScale: 1,
        x: 0, y: 0, z: 0, dx: 0, dz: 1, crit: false,
      });
    }

    // ---- the spray ---------------------------------------------------------
    // Budgeted against the quality preset like everything else. 1/28th of the
    // particle budget: combat's sparks are a small share of a frame whose
    // particle mass belongs to `fx`.
    const cap = Math.round(clamp((ctx.config?.q?.particleBudget ?? 8000) / 28, 96, 420));
    this.motes = new MoteField(cap, ELEMENTS.physical.glow, GLOW.spark, 12);
    render?.registerMaterial?.(this.motes.material);
    this.group.add(this.motes.mesh);

    this._colour = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
    this._look = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._dirV = new THREE.Vector3();

    /** Light envelope state — one shared slot driven by the strongest flash in
     *  flight, because ten impact lights would blow the point-light budget and
     *  push the braziers out of `sky`'s volumetric solution. */
    this.lightX = 0; this.lightY = 0; this.lightZ = 0;
    this.lightT = -1; this.lightLife = 0.18; this.lightPeak = 0;
    this.lightColour = ELEMENTS.physical.glow;

    this._frozen = false;

    /**
     * Draw the spray at all?
     *
     * When a live `fx` subsystem is present it already emits sparks, dust and
     * blood off `combat:hit`, and a second spray from here is the same
     * particles twice at the same point. So combat keeps only the piece
     * ARCHITECTURE.md actually assigns it — the flash on the target — and hands
     * the debris to `fx`. With `fx` absent or stubbed the spray comes back, so
     * an impact is never silent.
     */
    this.sprayEnabled = true;
  }

  /**
   * Fire a flash at an impact.
   *
   * @param nx,nz  unit XZ direction the blow CAME FROM (points back at the
   *               attacker), so the spray goes away from them.
   */
  hit(x, y, z, nx, nz, res, def) {
    const element = res?.element ?? 'physical';
    const sev = res?.severity ?? 0.3;
    const crit = !!res?.crit;
    const rng = this.rng;

    // ---- slot: take a free one, else the oldest -----------------------------
    let slot = null, oldest = -1, oldestAge = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.t < 0) { slot = s; break; }
      const age = s.t / s.life;
      if (age > oldestAge) { oldestAge = age; oldest = i; }
    }
    if (!slot) slot = this.slots[oldest];

    slot.t = 0;
    slot.life = IMPACT.flashLife * (crit ? 1.5 : 1);
    slot.ringLife = 0.20 + sev * 0.16;
    slot.x = x; slot.y = y; slot.z = z;
    slot.dx = nx; slot.dz = nz;
    slot.crit = crit;
    // Scale with the bite taken out of the target, not with the raw number:
    // a big hit on a boss and a big hit on a rat should not look the same size.
    //
    // The absolute size matters more than it looks. At the 21 m boom and 34 deg
    // FOV one metre is ~42 px at 540p, and the star geometry's longest shard is
    // 1.35 units — so a scale of 1.0 draws a 57 px asterisk over every enemy.
    // 0.12..0.42 puts a hit flash at 7-24 px, which reads as a spark.
    slot.scale = 0.085 + sev * 0.135 + (crit ? 0.055 : 0);
    slot.ringScale = 0.20 + sev * 0.38;

    // `core`, not `glow`. The star geometry already carries a 1.9-bright centre
    // quad that clips to white on its own — which is right, an impact HAS a hot
    // centre — but multiplying the whole star by the pastel `glow` turned every
    // flash into a pale grey shard and, ten at a time in a nova, into the
    // brightest thing in the frame. The core colour keeps the shards violet and
    // lets only the centre blow out.
    const glow = elementRgb(element, 'core', crit ? 1.9 : 1.4);
    slot.starMat.color.setRGB(glow[0], glow[1], glow[2], THREE.LinearSRGBColorSpace);
    const core = elementRgb(element, 'core', 1.0);
    slot.ringMat.color.setRGB(core[0], core[1], core[2], THREE.LinearSRGBColorSpace);

    // ---- the spray ----------------------------------------------------------
    // Directional: biased into -n (away from the attacker), with a 22° cone and
    // three or four deliberate outliers that spray back along the blade. A
    // perfectly conical spray reads as a nozzle rather than as matter being
    // knocked off something.
    const n = this.sprayEnabled
      ? Math.round(IMPACT.sparksPerHit * (0.6 + sev * 0.9) * (crit ? 1.5 : 1))
      : 0;
    for (let i = 0; i < n; i++) {
      const back = rng.float() < 0.22 ? -0.55 : 1;
      const spread = rng.range(-0.55, 0.55);
      const cs = Math.cos(spread), sn = Math.sin(spread);
      // Rotate (-nx, -nz) by `spread` about Y.
      const bx = (-nx * cs + -nz * sn) * back;
      const bz = (nx * sn + -nz * cs) * back;
      const speed = rng.range(2.4, 7.5) * (0.7 + sev);
      const up = rng.range(0.4, 3.4);
      this.motes.spawn(
        x + rng.range(-0.08, 0.08), y + rng.range(-0.10, 0.14), z + rng.range(-0.08, 0.08),
        bx * speed, up, bz * speed,
        VFX.cleave.sparkLife * rng.range(0.55, 1.25),
        rng.range(0.020, 0.052) * (crit ? 1.5 : 1),
        rng.range(0.7, 1.5) * (crit ? 1.7 : 1),
        { gravity: -11, drag: rng.range(1.1, 2.6) }
      );
    }

    // ---- the light ----------------------------------------------------------
    // One slot, strongest wins, and it lives ~2x the core so the flash lights
    // the wall behind the enemy after the flash itself has gone.
    const peak = (2.6 + sev * 9.0) * (crit ? 1.7 : 1);
    if (peak > this.lightPeak * (this.lightT < 0 ? 0 : Math.max(0, 1 - this.lightT / this.lightLife))) {
      this.lightX = x; this.lightY = y; this.lightZ = z;
      this.lightT = 0;
      this.lightLife = 0.16 + sev * 0.14;
      this.lightPeak = peak;
      this.lightColour = ELEMENTS[element]?.light ?? ELEMENTS.physical.light;
    }
    void def;
    return slot;
  }

  /**
   * A flash with no attacker — the nova's own ground impacts, the domain's
   * pulse markers. Same pool, no spray direction.
   */
  burst(x, y, z, element, scale, life = 0.16) {
    const rng = this.rng;
    const a = rng.float() * Math.PI * 2;
    // `_burstRes` rather than a literal: `burst` is called once per enemy per
    // domain pulse, which is several times a second at the worst moment.
    const r = this._burstRes ??= { element: 'shadow', severity: 0.3, crit: false };
    r.element = element;
    r.severity = clamp01(scale);
    const slot = this.hit(x, y, z, Math.sin(a), Math.cos(a), r, null);
    if (slot) slot.life = life;
    return slot;
  }

  update(dt, camera) {
    const frozen = this._frozen;
    for (const s of this.slots) {
      if (s.t < 0) continue;
      if (!frozen) s.t += dt;

      // ---- core: step in, expo out ---------------------------------------
      const ct = s.t / s.life;
      if (ct >= 1) {
        s.star.visible = false;
      } else {
        // A one-frame overshoot far above the final brightness, then collapse.
        const a = ct < 0.12 ? 1.0 : 1 - expoOut((ct - 0.12) / 0.88);
        const sc = s.scale * (0.55 + 0.65 * Math.pow(ct, 0.42));
        s.star.visible = a > 0.01;
        s.starMat.opacity = a * (s.crit ? 1.0 : 0.85);
        s.star.position.set(s.x, s.y, s.z);
        this._faceCamera(s.star, camera);
        // Elongate along the blow. The blow direction is in world XZ; after the
        // billboard rotation the mesh's local +X is the camera right vector, so
        // the elongation is applied as a non-uniform scale in the plane and is
        // approximate — at 21 m and 90 ms it reads exactly right and costs one
        // multiply instead of a per-flash basis.
        const elong = 1 + (1 - ct) * 0.55;
        s.star.scale.set(sc * elong, sc, sc);
      }

      // ---- ring: slower, thinner ------------------------------------------
      const rt = s.t / s.ringLife;
      if (rt >= 1) {
        s.ring.visible = false;
        if (ct >= 1) { s.t = -1; s.star.visible = false; }
      } else {
        const a = Math.pow(1 - rt, 2.2);
        s.ring.visible = a > 0.012;
        s.ringMat.opacity = a * 0.75;
        s.ring.position.set(s.x, s.y, s.z);
        this._faceCamera(s.ring, camera);
        const rs = s.ringScale * (0.25 + expoOut(rt) * 1.15);
        s.ring.scale.set(rs, rs, rs);
      }
    }

    if (!frozen) this.motes.update(dt, camera);
    else this.motes.update(0, camera);

    if (this.lightT >= 0) {
      if (!frozen) this.lightT += dt;
      if (this.lightT > this.lightLife) { this.lightT = -1; this.lightPeak = 0; }
    }
  }

  /** Current intensity of the shared impact light, 0 when nothing is flashing.
   *  Peaks slightly BEFORE the visual, which is what makes a flash illuminate
   *  rather than accompany. */
  lightIntensity() {
    if (this.lightT < 0) return 0;
    const t = this.lightT / this.lightLife;
    // Rise over the first 18%, then a squared decay: the light is at maximum
    // while the core is still stepping in.
    return this.lightPeak * (t < 0.18 ? t / 0.18 : Math.pow(1 - (t - 0.18) / 0.82, 2.0));
  }

  _faceCamera(mesh, camera) {
    this._look.copy(camera.position).sub(mesh.position);
    if (this._look.lengthSq() < 1e-6) return;
    this._look.normalize();
    this._quat.setFromUnitVectors(FORWARD, this._look);
    mesh.quaternion.copy(this._quat);
  }

  /** Freeze the whole field at its current phase — the shot harness pumps up to
   *  16 settle frames and a moving spark accumulates TAA history from positions
   *  it is no longer in, which ghosts every flash into a smear. */
  setFrozen(v) { this._frozen = !!v; }

  clear() {
    for (const s of this.slots) {
      s.t = -1;
      s.star.visible = false;
      s.ring.visible = false;
    }
    this.motes.clear();
    this.lightT = -1;
    this.lightPeak = 0;
  }

  dispose() {
    this.motes.dispose();
    for (const g of this._geo) g.dispose();
    for (const m of this._mat) m.dispose();
    this.group.removeFromParent();
  }
}

const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * A star of tapered shards in the XY plane, plus a small hot quad at the centre.
 * Shard count, length and angle all vary from the RNG so the flash is not a
 * symmetrical asterisk — real impact sparks are ragged.
 */
function buildStar(rng, points) {
  const pos = [];
  const col = [];
  const idx = [];

  // Hot centre.
  const c = 0.16;
  let base = 0;
  pos.push(-c, -c, 0, c, -c, 0, c, c, 0, -c, c, 0);
  for (let i = 0; i < 4; i++) col.push(1.9, 1.9, 1.9);
  idx.push(0, 1, 2, 0, 2, 3);

  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2 + rng.range(-0.30, 0.30);
    const len = rng.range(0.45, 1.35);
    const wid = rng.range(0.055, 0.16);
    const ca = Math.cos(a), sa = Math.sin(a);
    // A triangle: two base corners either side of the origin, one tip out along
    // the ray. The tip vertex is dark so each shard fades out along its length.
    base = pos.length / 3;
    pos.push(-sa * wid, ca * wid, 0);
    col.push(1.4, 1.4, 1.4);
    pos.push(sa * wid, -ca * wid, 0);
    col.push(1.4, 1.4, 1.4);
    pos.push(ca * len, sa * len, 0);
    col.push(0.02, 0.02, 0.02);
    idx.push(base, base + 1, base + 2);
  }

  const g = new THREE.BufferGeometry();
  g.name = 'mn.combat.flashStar';
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A thin annulus in the XY plane, hot on the outer edge. */
function buildFlashRing(segments) {
  const pos = [];
  const col = [];
  const idx = [];
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const wob = 1 + Math.sin(a * 5) * 0.05;
    pos.push(Math.cos(a) * 0.72 * wob, Math.sin(a) * 0.72 * wob, 0);
    col.push(0.05, 0.05, 0.05);
    pos.push(Math.cos(a) * 1.0 * wob, Math.sin(a) * 1.0 * wob, 0);
    col.push(1.0, 1.0, 1.0);
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2, b = s * 2 + 1;
    const c = ((s + 1) % segments) * 2 + 1, d = ((s + 1) % segments) * 2;
    idx.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.name = 'mn.combat.flashRing';
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
