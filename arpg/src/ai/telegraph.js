import * as THREE from 'three';
import { TELEGRAPH, clamp01 } from './tuning.js';

/**
 * MONARCH — ground telegraphs.
 *
 * The single most important readability system in the game. Diablo's whole
 * combat contract is "every dangerous thing paints the floor first", and a
 * telegraph that is late, ambiguous or subtle turns a fight into a stat check.
 *
 * ---------------------------------------------------------------------------
 * WHAT A GOOD TELEGRAPH DOES, AND WHAT THIS ONE DOES ABOUT IT
 *
 *  1. **Shows the SHAPE immediately.** The full outline appears on the wind-up's
 *     first frame at low intensity. If the shape grows in, the player cannot
 *     judge where its edge will be until it is too late to leave.
 *  2. **Shows the TIME.** A fill sweeps from the origin to the edge over the
 *     wind-up, so "how long have I got" is readable without a timer. The sweep
 *     direction matches the attack: radial for a slam, angular for a sweep,
 *     along the axis for a line.
 *  3. **Shows the MOMENT.** On the strike frame the whole shape flashes to
 *     white far above its fill brightness for ~90 ms and then collapses. A
 *     telegraph that merely fades out never tells the player when the damage
 *     actually landed, which is what makes a hit feel unfair.
 *  4. **Never competes with the player's own magic.** The colour is amber,
 *     never the signature violet: during a nova a violet telegraph is
 *     invisible, and the whole art direction depends on violet meaning "the
 *     Monarch". The boss's telegraphs are a hotter, redder amber — the same
 *     family, so they read as danger, but unmistakably its own.
 *
 * ---------------------------------------------------------------------------
 * ONE DRAW CALL FOR EVERY TELEGRAPH IN THE GAME
 *
 * All three shapes are the same instanced unit quad lying in the XZ plane; the
 * fragment shader picks a signed distance function from a per-instance shape id.
 * A boss fight with a cone, three shard circles and a fissure line up at once is
 * therefore ONE draw, which matters on a software rasteriser where the quads are
 * large and overlapping.
 */

const VERT = /* glsl */ `
attribute vec4 aParams;    // x = fill 0..1, y = shape parameter, z = intensity, w = flash
attribute vec3 aColor;
attribute float aShape;    // 0 = circle, 1 = cone, 2 = line

varying vec2 vLocal;
varying vec4 vParams;
varying vec3 vColor;
varying float vShape;

void main() {
	vLocal = position.xz;
	vParams = aParams;
	vColor = aColor;
	vShape = aShape;
	vec4 world = instanceMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * modelViewMatrix * world;
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec2 vLocal;
varying vec4 vParams;
varying vec3 vColor;
varying float vShape;

uniform float uEdge;
uniform float uTime;

// Signed distance to the shape's boundary in the same 0..1 units the fill uses,
// plus the "progress" coordinate the fill sweeps along. Packed into one call so
// the three shapes share every line of the shading below them.
void shapeOf( out float d, out float prog ) {
	if ( vShape < 0.5 ) {
		// CIRCLE — radial fill from the centre.
		float r = length( vLocal );
		d = r;
		prog = r;
	} else if ( vShape < 1.5 ) {
		// CONE — radial fill, clipped to a half-angle. The angle is measured
		// from local +Z so the caller can just point the instance at its target.
		float r = length( vLocal );
		float a = abs( atan( vLocal.x, vLocal.y ) );
		float ang = vParams.y;
		// The angular boundary is folded into the same distance field, so the
		// straight edges of the sector get the same bright rim as the arc.
		float angD = ( a - ang ) * max( r, 0.06 ) * 1.6;
		d = max( r, angD * 1.0 + r * step( ang, a ) );
		if ( a > ang + 0.06 ) discard;
		prog = r;
	} else {
		// LINE — a capsule swept along local +Z, filling from the origin out.
		float halfW = vParams.y;
		float ax = abs( vLocal.x ) / max( halfW, 0.02 );
		float az = vLocal.y * 0.5 + 0.5;         // 0 at the near end, 1 at the far
		if ( ax > 1.0 ) discard;
		d = max( ax, abs( vLocal.y ) );
		prog = az;
	}
}

void main() {
	float d, prog;
	shapeOf( d, prog );
	if ( d > 1.0 ) discard;

	float fill = vParams.x;
	float intensity = vParams.z;
	float flash = vParams.w;

	// 1. THE OUTLINE. Present from frame zero at full width so the player can
	// read where the edge will be before the fill gets there. It carries most of
	// the telegraph's total energy, because an outline is INFORMATION and a fill
	// is a wash — an early build made the fill bright and the result was a
	// blown-out white slab that erased the boss standing in the middle of it.
	float edge = 1.0 - smoothstep( 1.0 - uEdge, 1.0, d );
	float rim = ( 1.0 - edge );

	// 2. THE FILL. A hard leading front with a very dark body behind it. The
	// front is what the eye tracks; the body only has to say "inside".
	float front = 1.0 - smoothstep( 0.0, 0.055, prog - fill );
	float body = front * ( 0.045 + 0.075 * smoothstep( 0.0, 0.7, prog / max( fill, 0.02 ) ) );
	float lead = ( 1.0 - smoothstep( 0.0, 0.085, abs( prog - fill ) ) ) * 0.62 * step( fill, 0.999 );

	// 3. A scan of thin radial ticks, so a large circle is not a flat wash.
	float ticks = 0.045 * front * ( 0.5 + 0.5 * sin( prog * 46.0 - uTime * 3.0 ) );

	float a = rim * 1.15 + body + lead + ticks;
	vec3 col = vColor * a;
	// 4. THE MOMENT. Hot, well above the fill's brightness, for ~90 ms. This is
	// the only part of a telegraph allowed anywhere near white.
	col += vec3( 1.0, 0.74, 0.50 ) * flash * ( 0.9 + rim * 2.2 );

	gl_FragColor = vec4( col * intensity, 1.0 );
}
`;

/** A single pooled instance's state. */
class Slot {
  constructor() {
    this.active = false;
    this.shape = 0;
    this.x = 0; this.y = 0; this.z = 0;
    this.yaw = 0;
    this.radius = 1;
    this.param = 1;          // half-angle (cone) or half-width ratio (line)
    this.length = 1;         // line only
    this.t = 0;
    this.windup = 1;
    this.hold = 0;           // seconds the shape stays after the strike
    this.flash = 0;
    this.intensity = 1;
    this.colour = new THREE.Color(1, 1, 1);
    this.done = false;
    this.ticket = 0;
  }
}

export class Telegraphs {
  constructor(ctx) {
    this.ctx = ctx;
    this.capacity = TELEGRAPH.circles + TELEGRAPH.cones + TELEGRAPH.lines;

    // A unit quad in the XZ plane, local coordinates in [-1, 1].
    const geo = new THREE.PlaneGeometry(2, 2, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      name: 'mn.ai.telegraph',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uEdge: { value: TELEGRAPH.edge },
        uTime: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.name = 'mn.ai.telegraphs';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Additive, depth-write-off geometry must stay out of the depth/normal
    // prepass or it writes a normal for a surface that does not exist, and it
    // must never cast a shadow.
    this.mesh.userData.mnNoPrepass = true;
    this.mesh.userData.mnNoShadow = true;
    // Into the bloom-only emissive buffer: a telegraph should bleed a little,
    // because that is what makes it read through the fog it is sitting in.
    this.mesh.userData.mnGlow = 1.0;
    this.mesh.renderOrder = 4;

    this._params = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this._colors = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this._shapes = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this._params.setUsage(THREE.DynamicDrawUsage);
    this._colors.setUsage(THREE.DynamicDrawUsage);
    this._shapes.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aParams', this._params);
    geo.setAttribute('aColor', this._colors);
    geo.setAttribute('aShape', this._shapes);

    this.slots = [];
    for (let i = 0; i < this.capacity; i++) this.slots.push(new Slot());

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._ticket = 1;
    this.frozen = false;
    this._spawned = 0;

    ctx.scene.add(this.mesh);
  }

  /* ==================================================================== */
  /* spawning                                                             */
  /* ==================================================================== */

  _acquire() {
    for (const s of this.slots) if (!s.active) return s;
    // Steal the one furthest through its life: it has already delivered most of
    // its information, and dropping a NEW telegraph would hide an attack that
    // has not happened yet.
    let best = this.slots[0];
    for (const s of this.slots) {
      if (s.t / Math.max(0.01, s.windup) > best.t / Math.max(0.01, best.windup)) best = s;
    }
    return best;
  }

  _begin(s, o) {
    s.active = true;
    s.done = false;
    s.t = 0;
    s.flash = 0;
    s.windup = Math.max(0.08, o.windup ?? 0.8);
    s.hold = o.hold ?? TELEGRAPH.collapse;
    s.intensity = o.intensity ?? TELEGRAPH.intensity;
    const c = o.colour ?? TELEGRAPH.colour;
    s.colour.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
    s.ticket = this._ticket++;
    this._spawned++;
    return { slot: s, ticket: s.ticket };
  }

  /** A filled circle: slams, novas, shards, channels. */
  circle(o) {
    const s = this._acquire();
    s.shape = 0;
    s.x = o.x; s.y = (o.y ?? 0) + TELEGRAPH.lift; s.z = o.z;
    s.yaw = 0;
    s.radius = Math.max(0.3, o.radius ?? 3);
    s.param = 1;
    return this._begin(s, o);
  }

  /** A sector, pointing along `yaw`. Sweeps and cleaves. */
  cone(o) {
    const s = this._acquire();
    s.shape = 1;
    s.x = o.x; s.y = (o.y ?? 0) + TELEGRAPH.lift; s.z = o.z;
    s.yaw = o.yaw ?? 0;
    s.radius = Math.max(0.3, o.range ?? 4);
    s.param = clamp01((o.halfAngle ?? 0.9) / Math.PI) * Math.PI;
    return this._begin(s, o);
  }

  /** A corridor from the origin along `yaw`. Charges, leaps, fissures. */
  line(o) {
    const s = this._acquire();
    s.shape = 2;
    s.x = o.x; s.y = (o.y ?? 0) + TELEGRAPH.lift; s.z = o.z;
    s.yaw = o.yaw ?? 0;
    s.length = Math.max(0.5, o.length ?? 8);
    s.radius = Math.max(0.1, o.halfWidth ?? 1);
    s.param = 1;
    return this._begin(s, o);
  }

  /** Move a live telegraph — a boss that keeps turning during its wind-up must
   *  keep its cone pointed at the player, or the telegraph is a lie. */
  aim(handle, x, z, yaw) {
    const s = handle?.slot;
    if (!s || !s.active || s.ticket !== handle.ticket) return false;
    s.x = x; s.z = z;
    if (yaw !== undefined) s.yaw = yaw;
    return true;
  }

  /** Fire the strike flash and begin the collapse. */
  strike(handle) {
    const s = handle?.slot;
    if (!s || !s.active || s.ticket !== handle.ticket) return false;
    s.t = s.windup;
    s.flash = 1;
    s.done = true;
    return true;
  }

  /** Cancel without a flash — the attack was interrupted. This is important
   *  feedback in itself: a telegraph that vanishes tells the player their
   *  interrupt worked. */
  cancel(handle) {
    const s = handle?.slot;
    if (!s || !s.active || s.ticket !== handle.ticket) return false;
    s.active = false;
    s.flash = 0;
    return true;
  }

  clear() {
    for (const s of this.slots) { s.active = false; s.flash = 0; s.t = 0; }
    this.mesh.count = 0;
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  update(dt) {
    const step = this.frozen ? 0 : dt;
    this.material.uniforms.uTime.value = this.ctx.time.elapsed;

    let n = 0;
    const params = this._params.array;
    const colors = this._colors.array;
    const shapes = this._shapes.array;

    for (const s of this.slots) {
      if (!s.active) continue;
      s.t += step;

      let fill;
      if (!s.done) {
        // A gentle ease-out: the sweep runs a little ahead early so the shape's
        // interior is legible from the start, then crawls into the edge, which
        // is the part the player is actually reading.
        //
        // NOT `easeOutExpo`. That was the first build and it is far too
        // aggressive — `easeOutExpo(0.08)` is already 0.39 and `easeOutExpo(0.4)`
        // is 0.94, so a telegraph appeared 40% filled and was visually complete
        // a third of the way through its wind-up. It stopped being a timer.
        fill = Math.pow(clamp01(s.t / s.windup), 0.70) * 1.02;
      } else {
        fill = 1.02;
        s.flash = Math.max(0, s.flash - step / TELEGRAPH.flash);
        if (s.t > s.windup + s.hold) { s.active = false; continue; }
      }
      // The collapse: the shape shrinks and dims over `hold` after the strike.
      const collapse = s.done
        ? clamp01(1 - (s.t - s.windup) / Math.max(0.01, s.hold))
        : 1;

      // ---- transform --------------------------------------------------------
      this._q.setFromAxisAngle(this._up, s.yaw);
      if (s.shape === 2) {
        // The line quad spans local z ∈ [−1,1]; push it forward so its near end
        // sits on the origin, and scale x by the half-width.
        const halfLen = s.length * 0.5;
        this._pos.set(
          s.x + Math.sin(s.yaw) * halfLen, s.y, s.z + Math.cos(s.yaw) * halfLen
        );
        this._scl.set(s.radius * collapse, 1, halfLen);
        params[n * 4 + 1] = 1;   // half-width in local units is exactly 1
      } else {
        this._pos.set(s.x, s.y, s.z);
        const r = s.radius * (0.35 + 0.65 * collapse) * (s.done ? 1 + (1 - collapse) * 0.06 : 1);
        this._scl.set(r, 1, r);
        params[n * 4 + 1] = s.shape === 1 ? s.param : 1;
      }
      this._m.compose(this._pos, this._q, this._scl);
      this.mesh.setMatrixAt(n, this._m);

      params[n * 4] = fill;
      params[n * 4 + 2] = s.intensity * (0.35 + 0.65 * collapse);
      params[n * 4 + 3] = s.flash * s.flash;
      colors[n * 3] = s.colour.r;
      colors[n * 3 + 1] = s.colour.g;
      colors[n * 3 + 2] = s.colour.b;
      shapes[n] = s.shape;
      n++;
    }

    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this._params.needsUpdate = true;
      this._colors.needsUpdate = true;
      this._shapes.needsUpdate = true;
    }
  }

  stats() {
    let live = 0;
    for (const s of this.slots) if (s.active) live++;
    return { live, capacity: this.capacity, spawned: this._spawned };
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
    this.slots.length = 0;
  }
}
