/**
 * Floating damage numbers — world-anchored, screen-animated, one draw call.
 *
 * This is the ARPG dopamine loop made visible, so it gets more care than its
 * size suggests. The rules it follows, each of which is a thing shipped ARPGs do
 * and hobby ones do not:
 *
 *  1. ANCHORED IN WORLD, ANIMATED IN SCREEN SPACE. The number sticks to the
 *     point in the world where the hit happened (so it stays on the enemy as
 *     the camera pans) but its arc, its size and its spacing are in pixels, so
 *     a number never becomes unreadable because the enemy was far away.
 *
 *  2. SIZE ENCODES MAGNITUDE, logarithmically. Linear scaling makes a 5000 hit
 *     forty times the height of a 125 hit, which is unusable; log scaling makes
 *     a big hit obviously bigger while keeping everything on screen.
 *
 *  3. PUNCH-IN WITH OVERSHOOT. The number appears at 1.35x over ~90 ms and
 *     settles. This is the entire difference between "a number faded in" and
 *     "something got hit".
 *
 *  4. MERGING. Repeated hits on the same target inside 180 ms add into the
 *     existing number and re-punch it, rather than stacking six overlapping
 *     numbers. A flurry then reads as one growing number, which is both more
 *     legible AND more satisfying.
 *
 *  5. CRITS ARE A DIFFERENT OBJECT. Bigger, gold, longer-lived, with a radial
 *     burst behind them and a harder punch.
 *
 *  6. ELEMENT COLOUR COMES FROM palette.ELEMENTS, never from here.
 *
 * EXPOSURE. `uiScene` composites into the HDR buffer BEFORE the exposure
 * multiply, so a fixed emissive value reads dim in a lit hall and hot in a
 * black corridor. The shader tracks the auto-exposure only PARTIALLY —
 * `pow(ev, -0.45)` — see the long note in the fragment shader for why fully
 * cancelling it turns every crit into a screen-crossing bloom star. That is why
 * `render.exposure` is fetched lazily at runtime rather than being a dependency.
 */

import * as THREE from 'three';
import { ELEMENTS, UI } from '../core/palette.js';
import { GlyphAtlas } from './glyphatlas.js';
import { easeOutBack, clamp01, hexToRgb } from './theme.js';

const MAX_NUMBERS = 56;
const GLYPHS_PER = 9;
const MAX_GLYPHS = MAX_NUMBERS * GLYPHS_PER;
const MAX_BURSTS = 20;

/** Screen-space motion, in CSS pixels per second at the design scale. */
const RISE = 172;
const GRAVITY = -300;
const MERGE_WINDOW = 0.18;

const VERT = /* glsl */ `
attribute vec3 iAnchor;
attribute vec2 iOff;
attribute vec4 iUv;
attribute vec4 iCol;
attribute vec2 iSize;   // x = glyph pixel height, y = emissive intensity

uniform vec2 uRes;
uniform float uCellAspect;

varying vec2 vUv;
varying vec4 vCol;
varying float vI;
varying float vY;

void main() {
  vUv = iUv.xy + uv * iUv.zw;
  vCol = iCol;
  vI = iSize.y;
  vY = uv.y;

  vec4 clip = projectionMatrix * modelViewMatrix * vec4( iAnchor, 1.0 );
  // Offset in device pixels: multiplying by clip.w before the perspective
  // divide makes the offset exactly N pixels regardless of depth.
  vec2 px = position.xy * vec2( iSize.x * uCellAspect, iSize.x ) + iOff;
  clip.xy += px / uRes * 2.0 * clip.w;
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tAtlas;
uniform sampler2D tExposure;
uniform float uUseExposure;

varying vec2 vUv;
varying vec4 vCol;
varying float vI;
varying float vY;

void main() {
  vec4 t = texture2D( tAtlas, vUv );
  float fill = t.r;
  float line = t.g;
  float halo = t.b;

  float a = clamp( max( fill, line ) + halo * 0.30, 0.0, 1.0 ) * vCol.a;
  if ( a < 0.006 ) discard;

  // Vertical ramp: hot at the cap, deeper at the baseline. Flat-filled text is
  // the fastest way to make a number look like a debug overlay.
  vec3 body = vCol.rgb * ( 1.18 - 0.42 * vY );
  vec3 rim  = vCol.rgb * 0.04;
  vec3 col  = mix( rim, body, smoothstep( 0.28, 0.66, fill ) );
  col += vCol.rgb * halo * 0.22 * ( 1.0 - fill );
  col *= vI;

  // Exposure coupling, DELIBERATELY PARTIAL.
  //
  // uiScene composites into the HDR buffer before the exposure multiply, so a
  // fixed emissive value reads dim in a lit hall and hot in a black corridor.
  // Dividing it out entirely fixes the final brightness but is a disaster for
  // bloom: bloom is built from the PRE-exposure image, so in a dark room
  // (exposure ~3x) a number lands at 3x the intended radiance in the pyramid
  // and every crit grows a screen-wide star. The first capture of this system
  // was exactly that.
  //
  // pow(ev, -0.45) tracks about half the exposure swing in stops, which keeps
  // the numbers legible across rooms while keeping their pre-exposure radiance
  // inside the range the bloom pass was tuned for.
  float ev = mix( 1.0, texture2D( tExposure, vec2( 0.5 ) ).g, uUseExposure );
  gl_FragColor = vec4( col * pow( max( ev, 1e-3 ), -0.45 ), a );
}
`;

const BURST_VERT = /* glsl */ `
attribute vec3 iAnchor;
attribute vec2 iOff;
attribute vec4 iCol;
attribute vec2 iSize;   // x = pixel radius, y = intensity
uniform vec2 uRes;
varying vec2 vP;
varying vec4 vCol;
varying float vI;
void main() {
  vP = position.xy;
  vCol = iCol;
  vI = iSize.y;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4( iAnchor, 1.0 );
  clip.xy += ( position.xy * iSize.x + iOff ) / uRes * 2.0 * clip.w;
  gl_Position = clip;
}
`;

const BURST_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tExposure;
uniform float uUseExposure;
varying vec2 vP;
varying vec4 vCol;
varying float vI;
void main() {
  float r = length( vP ) * 2.0;
  if ( r > 1.0 ) discard;
  // soft core plus four thin spikes — a star, not a blob
  float core = pow( 1.0 - r, 3.2 );
  float ang = atan( vP.y, vP.x );
  // Thin, short spikes. The first pass used exponent 22 and a 1.3 falloff and
  // produced a screen-crossing star per crit; a crit flash is punctuation, not
  // a light source.
  float spike = pow( max( 0.0, abs( cos( ang * 2.0 ) ) ), 60.0 ) * pow( 1.0 - r, 2.4 );
  float m = core * 0.75 + spike * 0.55;
  float ev = mix( 1.0, texture2D( tExposure, vec2( 0.5 ) ).g, uUseExposure );
  gl_FragColor = vec4( vCol.rgb * vI * m * pow( max( ev, 1e-3 ), -0.45 ), m * vCol.a );
}
`;

function quadGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  // y-up quad; uv has y DOWN so atlas rects match canvas pixel coordinates.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 0,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 0, 3, 2]), 1));
  return g;
}

export class DamageNumbers {
  constructor(ctx, rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.atlas = new GlyphAtlas();
    this.scale = 1;          // UI scale (`--u`)
    this._exposure = null;
    this._white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._white.needsUpdate = true;

    // ---- per-number state (structure of arrays; nothing allocated at runtime)
    this.nActive = new Uint8Array(MAX_NUMBERS);
    this.nAge = new Float32Array(MAX_NUMBERS);
    this.nLife = new Float32Array(MAX_NUMBERS);
    this.nAnchor = new Float32Array(MAX_NUMBERS * 3);
    this.nVel = new Float32Array(MAX_NUMBERS * 2);
    this.nSize = new Float32Array(MAX_NUMBERS);
    this.nCol = new Float32Array(MAX_NUMBERS * 3);
    this.nInt = new Float32Array(MAX_NUMBERS);
    this.nCount = new Uint8Array(MAX_NUMBERS);
    this.nCrit = new Uint8Array(MAX_NUMBERS);
    this.nAmount = new Float32Array(MAX_NUMBERS);
    this.nKey = new Float64Array(MAX_NUMBERS);
    this.nWidth = new Float32Array(MAX_NUMBERS);
    this.nBase = new Float32Array(MAX_NUMBERS);   // unpunched pixel height
    this.gAdv = new Float32Array(MAX_GLYPHS);     // per-glyph x offset, in ems
    this._cursor = 0;

    // ---- geometry ---------------------------------------------------------
    const geo = quadGeometry();
    this.aAnchor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 3), 3);
    this.aOff = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 2), 2);
    this.aUv = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 4), 4);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 4), 4);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * 2), 2);
    for (const a of [this.aAnchor, this.aOff, this.aUv, this.aCol, this.aSize]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iAnchor', this.aAnchor);
    geo.setAttribute('iOff', this.aOff);
    geo.setAttribute('iUv', this.aUv);
    geo.setAttribute('iCol', this.aCol);
    geo.setAttribute('iSize', this.aSize);
    geo.instanceCount = MAX_GLYPHS;
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tAtlas: { value: this.atlas.texture },
        tExposure: { value: this._white },
        uUseExposure: { value: 0 },
        uRes: { value: new THREE.Vector2(1280, 720) },
        uCellAspect: { value: this.atlas.cellAspect },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 900;
    this.mesh.userData.mnNoPrepass = true;
    this.mesh.userData.mnNoShadow = true;
    ctx.uiScene.add(this.mesh);

    // ---- crit bursts ------------------------------------------------------
    const bgeo = quadGeometry();
    this.bActive = new Uint8Array(MAX_BURSTS);
    this.bAge = new Float32Array(MAX_BURSTS);
    this.bLife = new Float32Array(MAX_BURSTS);
    this.bAnchor = new Float32Array(MAX_BURSTS * 3);
    this.bSize = new Float32Array(MAX_BURSTS);
    this.bCol = new Float32Array(MAX_BURSTS * 3);
    this.bCursor = 0;

    this.baAnchor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BURSTS * 3), 3);
    this.baOff = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BURSTS * 2), 2);
    this.baCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BURSTS * 4), 4);
    this.baSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BURSTS * 2), 2);
    for (const a of [this.baAnchor, this.baOff, this.baCol, this.baSize]) a.setUsage(THREE.DynamicDrawUsage);
    bgeo.setAttribute('iAnchor', this.baAnchor);
    bgeo.setAttribute('iOff', this.baOff);
    bgeo.setAttribute('iCol', this.baCol);
    bgeo.setAttribute('iSize', this.baSize);
    bgeo.instanceCount = MAX_BURSTS;
    this.bgeo = bgeo;

    this.bmat = new THREE.ShaderMaterial({
      vertexShader: BURST_VERT,
      fragmentShader: BURST_FRAG,
      uniforms: {
        tExposure: { value: this._white },
        uUseExposure: { value: 0 },
        uRes: { value: this.mat.uniforms.uRes.value },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.bmesh = new THREE.Mesh(bgeo, this.bmat);
    this.bmesh.frustumCulled = false;
    this.bmesh.renderOrder = 899;   // behind the glyphs
    this.bmesh.userData.mnNoPrepass = true;
    ctx.uiScene.add(this.bmesh);

    // Pre-resolved element colours in LINEAR space, indexed by name.
    this.colours = {};
    for (const [k, v] of Object.entries(ELEMENTS)) this.colours[k] = v.light ?? v.core;
    this.critColour = hexToRgb(UI.critYellow).map((c) => Math.pow(c / 255, 2.2));
    this.playerColour = hexToRgb(UI.hpRed).map((c) => Math.pow(c / 255, 2.2) * 1.5);

    this._mergeKeys = new Map();
    this._tmp = new THREE.Vector3();
  }

  setResolution(w, h) {
    this.mat.uniforms.uRes.value.set(w, h);
  }

  setScale(u) { this.scale = u; }

  /**
   * The public entry point. `opts`:
   *   position  THREE.Vector3 (read, not retained)
   *   amount    number
   *   element   palette element name
   *   crit      bool
   *   kind      'damage' | 'player' | 'heal' | 'xp'
   *   key       merge key (an actor id); omit to never merge
   */
  spawn(opts) {
    const key = opts.key ?? 0;
    if (key) {
      const slot = this._mergeKeys.get(key);
      if (slot !== undefined && this.nActive[slot] && this.nAge[slot] < MERGE_WINDOW) {
        // Merge: grow the existing number and re-punch it.
        this.nAmount[slot] += opts.amount;
        this.nAge[slot] = 0;
        this.nCrit[slot] |= opts.crit ? 1 : 0;
        this._layout(slot, this._format(slot, opts));
        this._sizeFor(slot, this.nAmount[slot], this.nCrit[slot]);
        if (opts.crit) this._burst(slot);
        return slot;
      }
    }

    const slot = this._alloc();
    if (slot < 0) return -1;

    this.nActive[slot] = 1;
    this.nAge[slot] = 0;
    this.nCrit[slot] = opts.crit ? 1 : 0;
    this.nAmount[slot] = opts.amount ?? 0;
    this.nKey[slot] = key;
    if (key) this._mergeKeys.set(key, slot);

    const p = opts.position;
    const j = this.rng;
    // Jitter the anchor so simultaneous hits on a pack do not stack.
    this.nAnchor[slot * 3 + 0] = p.x + j.range(-0.30, 0.30);
    this.nAnchor[slot * 3 + 1] = (p.y ?? 0) + j.range(0.05, 0.30);
    this.nAnchor[slot * 3 + 2] = p.z + j.range(-0.30, 0.30);

    const lateral = j.range(-46, 46);
    this.nVel[slot * 2 + 0] = lateral;
    this.nVel[slot * 2 + 1] = RISE * j.range(0.86, 1.16);

    const kind = opts.kind ?? 'damage';
    let col;
    if (opts.crit) col = this.critColour;
    else if (kind === 'player') col = this.playerColour;
    else if (kind === 'xp') col = this.colours.holy;
    else col = this.colours[opts.element] ?? this.colours.physical;

    this.nCol[slot * 3 + 0] = col[0];
    this.nCol[slot * 3 + 1] = col[1];
    this.nCol[slot * 3 + 2] = col[2];

    this.nLife[slot] = opts.crit ? 1.42 : (kind === 'player' ? 1.30 : 1.05);
    // Linear radiance multipliers, tuned against AgX: ~1.0 lands mid-bright,
    // ~2.2 is as hot as anything should get without clipping to white and
    // losing the element colour, which is the whole point of colouring them.
    this.nInt[slot] = opts.crit ? 2.1 : (kind === 'player' ? 1.25 : 0.95);

    this._layout(slot, this._format(slot, opts));
    this._sizeFor(slot, this.nAmount[slot], this.nCrit[slot]);
    if (opts.crit) this._burst(slot);
    return slot;
  }

  /** Free-form world text: MISS, IMMUNE, BLOCKED, +250 XP. */
  spawnText(position, text, colourLinear, opts = {}) {
    const slot = this._alloc();
    if (slot < 0) return -1;
    this.nActive[slot] = 1;
    this.nAge[slot] = 0;
    this.nCrit[slot] = 0;
    this.nAmount[slot] = 0;
    this.nKey[slot] = 0;
    this.nAnchor[slot * 3 + 0] = position.x;
    this.nAnchor[slot * 3 + 1] = (position.y ?? 0) + 0.2;
    this.nAnchor[slot * 3 + 2] = position.z;
    this.nVel[slot * 2 + 0] = this.rng.range(-20, 20);
    this.nVel[slot * 2 + 1] = RISE * 0.72;
    this.nCol[slot * 3 + 0] = colourLinear[0];
    this.nCol[slot * 3 + 1] = colourLinear[1];
    this.nCol[slot * 3 + 2] = colourLinear[2];
    this.nLife[slot] = opts.life ?? 1.15;
    this.nInt[slot] = opts.intensity ?? 1.05;
    this._layout(slot, text);
    this.nBase[slot] = (opts.size ?? 20) * this.scale;
    return slot;
  }

  _alloc() {
    // Ring allocation with an oldest-victim fallback: at 56 slots a horde fight
    // will wrap, and stealing the oldest is the right eviction — the newest
    // number is always the one the player is looking at.
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const s = (this._cursor + i) % MAX_NUMBERS;
      if (!this.nActive[s]) { this._cursor = (s + 1) % MAX_NUMBERS; return s; }
    }
    let best = 0, bestAge = -1;
    for (let s = 0; s < MAX_NUMBERS; s++) {
      const a = this.nAge[s] / Math.max(0.001, this.nLife[s]);
      if (a > bestAge) { bestAge = a; best = s; }
    }
    return best;
  }

  _format(slot, opts) {
    const v = Math.round(this.nAmount[slot]);
    const kind = opts.kind ?? 'damage';
    let s;
    if (v >= 100000) s = `${(v / 1000).toFixed(0)}K`;
    else if (v >= 10000) s = `${(v / 1000).toFixed(1)}K`;
    else s = String(v);
    if (kind === 'player') return `-${s}`;
    if (kind === 'heal') return `+${s}`;
    if (kind === 'xp') return `+${s} XP`;
    return s;
  }

  /**
   * Log-scaled pixel height: 340 -> 22 px, 3 000 -> 29 px, 20 000 crit -> 51 px.
   *
   * The first tuning peaked at 97 px including the punch overshoot, which put a
   * five-character crit across a sixth of the frame and buried the fight behind
   * its own feedback. The useful range for a damage number is roughly 20-55 px:
   * below 18 it stops reading at 720p, above ~60 it stops being a number and
   * starts being a graphic.
   */
  _sizeFor(slot, amount, crit) {
    const a = Math.max(1, amount);
    const base = 15 + 7.4 * Math.log10(1 + a / 40);
    this.nBase[slot] = base * (crit ? 1.45 : 1) * this.scale;
  }

  _layout(slot, text) {
    const n = Math.min(GLYPHS_PER, text.length);
    this.nCount[slot] = n;
    let w = 0;
    for (let i = 0; i < n; i++) w += this.atlas.glyph(text[i]).adv;
    this.nWidth[slot] = w;

    let pen = -w * 0.5;
    const g0 = slot * GLYPHS_PER;
    for (let i = 0; i < n; i++) {
      const g = this.atlas.glyph(text[i]);
      const gi = g0 + i;
      this.gAdv[gi] = pen + g.adv * 0.5;
      pen += g.adv;
      const o4 = gi * 4;
      this.aUv.array[o4 + 0] = g.u;
      this.aUv.array[o4 + 1] = g.v;
      this.aUv.array[o4 + 2] = g.du;
      this.aUv.array[o4 + 3] = g.dv;
    }
    this.aUv.needsUpdate = true;
  }

  _burst(slot) {
    const b = this.bCursor;
    this.bCursor = (b + 1) % MAX_BURSTS;
    this.bActive[b] = 1;
    this.bAge[b] = 0;
    this.bLife[b] = 0.40;
    this.bAnchor[b * 3 + 0] = this.nAnchor[slot * 3 + 0];
    this.bAnchor[b * 3 + 1] = this.nAnchor[slot * 3 + 1];
    this.bAnchor[b * 3 + 2] = this.nAnchor[slot * 3 + 2];
    this.bSize[b] = this.nBase[slot] * 2.0;
    this.bCol[b * 3 + 0] = this.nCol[slot * 3 + 0];
    this.bCol[b * 3 + 1] = this.nCol[slot * 3 + 1];
    this.bCol[b * 3 + 2] = this.nCol[slot * 3 + 2];
  }

  /** Number of live numbers — used by debugState verification and stats(). */
  get liveCount() {
    let n = 0;
    for (let i = 0; i < MAX_NUMBERS; i++) if (this.nActive[i]) n++;
    return n;
  }

  update(dt) {
    // Bind the exposure texture once it exists. Doing this lazily keeps `ui`
    // dependency-free while still getting exposure-correct brightness.
    if (!this._exposure) {
      const tex = this.ctx.peek('render')?.exposure?.texture ?? null;
      if (tex) {
        this._exposure = tex;
        this.mat.uniforms.tExposure.value = tex;
        this.mat.uniforms.uUseExposure.value = 1;
        this.bmat.uniforms.tExposure.value = tex;
        this.bmat.uniforms.uUseExposure.value = 1;
      }
    }

    const A = this.aAnchor.array, O = this.aOff.array, C = this.aCol.array, S = this.aSize.array;

    for (let s = 0; s < MAX_NUMBERS; s++) {
      const g0 = s * GLYPHS_PER;
      if (!this.nActive[s]) {
        // Collapse the whole run to zero size — degenerate quads cost nothing.
        for (let i = 0; i < GLYPHS_PER; i++) { S[(g0 + i) * 2] = 0; C[(g0 + i) * 4 + 3] = 0; }
        continue;
      }

      const age = (this.nAge[s] += dt);
      const life = this.nLife[s];
      if (age >= life) {
        this.nActive[s] = 0;
        if (this.nKey[s] && this._mergeKeys.get(this.nKey[s]) === s) this._mergeKeys.delete(this.nKey[s]);
        for (let i = 0; i < GLYPHS_PER; i++) { S[(g0 + i) * 2] = 0; C[(g0 + i) * 4 + 3] = 0; }
        continue;
      }

      // punch-in: overshoot then settle, crits harder and slightly slower
      const crit = this.nCrit[s] === 1;
      const pt = clamp01(age / (crit ? 0.135 : 0.095));
      const punch = easeOutBack(pt, crit ? 2.6 : 1.8);
      const size = this.nBase[s] * punch;

      // fade: hold, then a soft tail
      const t = age / life;
      let a = t < 0.05 ? t / 0.05 : 1;
      if (t > 0.55) a *= Math.pow(1 - (t - 0.55) / 0.45, 1.35);

      // screen-space arc
      const ox = this.nVel[s * 2 + 0] * age * (1 - age * 0.35) * this.scale;
      const oy = (this.nVel[s * 2 + 1] * age + 0.5 * GRAVITY * age * age) * this.scale;

      const ax = this.nAnchor[s * 3 + 0], ay = this.nAnchor[s * 3 + 1], az = this.nAnchor[s * 3 + 2];
      const cr = this.nCol[s * 3 + 0], cg = this.nCol[s * 3 + 1], cb = this.nCol[s * 3 + 2];
      const inten = this.nInt[s] * (crit ? (1 + 0.55 * Math.max(0, 1 - age / 0.16)) : 1);
      const n = this.nCount[s];

      for (let i = 0; i < GLYPHS_PER; i++) {
        const gi = g0 + i;
        if (i >= n) { S[gi * 2] = 0; C[gi * 4 + 3] = 0; continue; }
        const o3 = gi * 3, o2 = gi * 2, o4 = gi * 4;
        A[o3] = ax; A[o3 + 1] = ay; A[o3 + 2] = az;
        O[o2] = ox + this.gAdv[gi] * size;
        O[o2 + 1] = oy;
        C[o4] = cr; C[o4 + 1] = cg; C[o4 + 2] = cb; C[o4 + 3] = a;
        S[o2] = size;
        S[o2 + 1] = inten;
      }
    }

    this.aAnchor.needsUpdate = true;
    this.aOff.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;

    // ---- bursts ------------------------------------------------------------
    const BA = this.baAnchor.array, BO = this.baOff.array, BC = this.baCol.array, BS = this.baSize.array;
    for (let b = 0; b < MAX_BURSTS; b++) {
      if (!this.bActive[b]) { BS[b * 2] = 0; BC[b * 4 + 3] = 0; continue; }
      const age = (this.bAge[b] += dt);
      const t = age / this.bLife[b];
      if (t >= 1) { this.bActive[b] = 0; BS[b * 2] = 0; BC[b * 4 + 3] = 0; continue; }
      const e = 1 - Math.pow(1 - t, 3);
      BA[b * 3] = this.bAnchor[b * 3];
      BA[b * 3 + 1] = this.bAnchor[b * 3 + 1];
      BA[b * 3 + 2] = this.bAnchor[b * 3 + 2];
      BO[b * 2] = 0; BO[b * 2 + 1] = 0;
      BS[b * 2] = this.bSize[b] * (0.35 + e * 1.15);
      BS[b * 2 + 1] = 1.5 * (1 - t) * (1 - t);
      BC[b * 4] = this.bCol[b * 3];
      BC[b * 4 + 1] = this.bCol[b * 3 + 1];
      BC[b * 4 + 2] = this.bCol[b * 3 + 2];
      BC[b * 4 + 3] = 1 - t;
    }
    this.baAnchor.needsUpdate = true;
    this.baOff.needsUpdate = true;
    this.baCol.needsUpdate = true;
    this.baSize.needsUpdate = true;
  }

  clear() {
    this.nActive.fill(0);
    this.bActive.fill(0);
    this._mergeKeys.clear();
    this.update(0);
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.bmesh.parent?.remove(this.bmesh);
    this.geo.dispose();
    this.bgeo.dispose();
    this.mat.dispose();
    this.bmat.dispose();
    this.atlas.dispose();
    this._white.dispose();
  }
}
