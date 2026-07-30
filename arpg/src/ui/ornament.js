/**
 * Procedural HUD frame art — canvas 2D only, no image files, no SVG assets.
 *
 * WHY THIS FILE EXISTS AT ALL: a HUD drawn with CSS gradients and border-radius
 * reads as a web page. What separates a shipped ARPG frame from that is the
 * material: metal that is lit from a consistent direction, tarnished unevenly,
 * pitted, scratched, and darker in the crevices than on the faces. None of that
 * is expressible in CSS, and all of it is cheap to bake ONCE into a canvas and
 * hand to CSS as a background image.
 *
 * Everything here is baked at init (and on a resize that actually changes the
 * bucket) and never touched again, so the per-frame cost of the entire frame
 * art is exactly zero.
 *
 * THE LIGHTING CONVENTION, obeyed by every primitive: the key is at the upper
 * left, ~35 degrees above horizontal. Top-left bevels catch the highlight,
 * bottom-right bevels fall to the crevice colour, and interiors are darker than
 * edges. Break it in one widget and the whole HUD stops reading as one object.
 */

import { BRASS, SLATE, alpha, shade, mixHex } from './theme.js';

/** Key light direction in canvas space (y down), normalised. */
export const LIGHT_X = -0.72;
export const LIGHT_Y = -0.69;

// ---------------------------------------------------------------------------
// deterministic value noise (ctx.rng-seeded — never Math.random)
// ---------------------------------------------------------------------------

/**
 * 2D value noise + fbm from a shuffled permutation table. Used for tarnish
 * blotching, edge wear masks and the grain tile. Value noise (not gradient
 * noise) on purpose: we want soft blobby stains, not the directional streaks
 * Perlin produces.
 */
export function makeNoise(rng) {
  const P = new Uint8Array(512);
  const V = new Float32Array(256);
  for (let i = 0; i < 256; i++) P[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rng.int(0, i);
    const t = P[i]; P[i] = P[j]; P[j] = t;
  }
  for (let i = 0; i < 256; i++) { P[256 + i] = P[i]; V[i] = rng.float(); }

  const hash = (x, y) => V[P[(P[x & 255] + (y & 255)) & 255]];
  // Quintic smootherstep: C2 continuous, so fbm has no visible grid creases.
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  function noise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  }

  function fbm(x, y, octaves = 4, gain = 0.5, lac = 2.03) {
    let s = 0, amp = 0.5, norm = 0, fx = x, fy = y;
    for (let o = 0; o < octaves; o++) {
      s += noise2(fx, fy) * amp;
      norm += amp;
      amp *= gain;
      fx *= lac; fy *= lac;
    }
    return s / norm;
  }

  return { noise2, fbm };
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

export function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

/**
 * A clipped octagon — the shape every Diablo-lineage skill slot actually is.
 * A pure rounded rectangle looks like a mobile app button; chamfering the four
 * corners at 45 degrees instantly reads as a metal plate that was cut, not
 * moulded.
 */
export function octRect(c, x, y, w, h, cut) {
  c.beginPath();
  c.moveTo(x + cut, y);
  c.lineTo(x + w - cut, y);
  c.lineTo(x + w, y + cut);
  c.lineTo(x + w, y + h - cut);
  c.lineTo(x + w - cut, y + h);
  c.lineTo(x + cut, y + h);
  c.lineTo(x, y + h - cut);
  c.lineTo(x, y + cut);
  c.closePath();
}

/** The five-stop brass ramp along an arbitrary axis. */
export function brassGradient(c, x0, y0, x1, y1, tint = 1) {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  const t = (hex) => (tint === 1 ? hex : shade(hex, tint));
  g.addColorStop(0.0, t(BRASS.hot));
  g.addColorStop(0.16, t(BRASS.warm));
  g.addColorStop(0.42, t(BRASS.mid));
  g.addColorStop(0.72, t(BRASS.base));
  g.addColorStop(1.0, t(BRASS.dark));
  return g;
}

/**
 * An annulus of metal lit per angle. Drawn as N short arc strokes whose colour
 * is `dot(surfaceNormal, light)` — the same maths a shader would use. This is
 * what makes the ring read as a torus instead of as a flat donut, and it is why
 * we cannot just use `border: 6px solid goldenrod`.
 */
export function bevelRing(c, cx, cy, rOuter, rInner, opts = {}) {
  const segs = opts.segs ?? 120;
  const rMid = (rOuter + rInner) * 0.5;
  const width = rOuter - rInner;
  const tint = opts.tint ?? 1;
  const ambient = opts.ambient ?? 0.20;

  c.save();
  c.lineCap = 'butt';
  c.lineWidth = width + 0.8; // slight overlap kills seams between segments
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1.04) / segs) * Math.PI * 2;
    const am = (a0 + a1) * 0.5;
    // Outward normal of the torus at this angle, in canvas space.
    const nx = Math.cos(am), ny = Math.sin(am);
    let l = nx * LIGHT_X + ny * LIGHT_Y;         // -1 .. 1
    l = ambient + (1 - ambient) * Math.max(0, l * 0.5 + 0.5);
    // A tight specular lobe on top of the diffuse term: metal has a hot line,
    // not a smooth ramp.
    const spec = Math.pow(Math.max(0, nx * LIGHT_X + ny * LIGHT_Y), 12) * 0.55;
    const k = Math.min(1.6, (l + spec) * 1.55) * tint;
    c.strokeStyle = k < 1
      ? mixHex(BRASS.crevice, BRASS.mid, k)
      : mixHex(BRASS.mid, BRASS.hot, Math.min(1, k - 1));
    c.beginPath();
    c.arc(cx, cy, rMid, a0, a1);
    c.stroke();
  }
  c.restore();

  // Crevice lines at both edges of the band: the shadow where the metal meets
  // whatever it is set into. Two 1px darks are worth more than any amount of
  // gradient work.
  c.save();
  c.lineWidth = Math.max(1, width * 0.10);
  c.strokeStyle = alpha(BRASS.crevice, 0.85);
  c.beginPath(); c.arc(cx, cy, rOuter - c.lineWidth * 0.5, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = alpha(BRASS.crevice, 0.7);
  c.beginPath(); c.arc(cx, cy, rInner + c.lineWidth * 0.5, 0, Math.PI * 2); c.stroke();
  c.restore();
}

/** A domed rivet: sphere shading plus a contact shadow underneath. */
export function rivet(c, x, y, r) {
  // contact shadow first, offset along the light
  c.save();
  c.fillStyle = alpha('#000000', 0.55);
  c.beginPath();
  c.ellipse(x - LIGHT_X * r * 0.55, y - LIGHT_Y * r * 0.55, r * 1.05, r * 0.95, 0, 0, Math.PI * 2);
  c.fill();

  const g = c.createRadialGradient(
    x + LIGHT_X * r * 0.42, y + LIGHT_Y * r * 0.42, r * 0.08,
    x, y, r
  );
  g.addColorStop(0.0, BRASS.hot);
  g.addColorStop(0.35, BRASS.warm);
  g.addColorStop(0.78, BRASS.base);
  g.addColorStop(1.0, BRASS.crevice);
  c.fillStyle = g;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();

  // specular pinprick — one bright pixel cluster is what says "polished"
  c.fillStyle = alpha('#fff6df', 0.75);
  c.beginPath();
  c.arc(x + LIGHT_X * r * 0.46, y + LIGHT_Y * r * 0.46, Math.max(0.6, r * 0.20), 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/**
 * An engraved slate plate: recessed dark field, brass-lipped edge, inner
 * shadow along the lit side (because a recess is dark where a boss is bright).
 */
export function engravedPlate(c, x, y, w, h, opts = {}) {
  const cut = opts.cut ?? Math.min(w, h) * 0.16;
  const lip = opts.lip ?? 2.0;
  const fill = opts.fill ?? SLATE.base;

  // outer brass lip
  c.save();
  octRect(c, x, y, w, h, cut);
  c.fillStyle = brassGradient(c, x, y, x + w * 0.35, y + h, opts.tint ?? 1);
  c.fill();

  // recessed field
  octRect(c, x + lip, y + lip, w - lip * 2, h - lip * 2, Math.max(0, cut - lip));
  const g = c.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, shade(fill, 0.55));
  g.addColorStop(0.45, fill);
  g.addColorStop(1, shade(fill, 1.22));
  c.fillStyle = g;
  c.fill();

  // inner shadow on the top-left edge of the recess
  c.save();
  c.clip();
  c.strokeStyle = alpha('#000000', 0.8);
  c.lineWidth = lip * 1.7;
  c.beginPath();
  octRect(c, x + lip, y + lip, w - lip * 2, h - lip * 2, Math.max(0, cut - lip));
  c.stroke();
  c.restore();

  // bounce light on the bottom-right inside face
  c.save();
  octRect(c, x + lip, y + lip, w - lip * 2, h - lip * 2, Math.max(0, cut - lip));
  c.clip();
  const b = c.createLinearGradient(x + w, y + h, x + w * 0.55, y + h * 0.4);
  b.addColorStop(0, alpha(BRASS.mid, 0.20));
  b.addColorStop(1, alpha(BRASS.mid, 0.0));
  c.fillStyle = b;
  c.fillRect(x, y, w, h);
  c.restore();

  c.restore();
}

/**
 * Parametric scroll-work. A logarithmic spiral swept as a tapering brass ribbon.
 * Three of these at different phases around a corner is the entire "ornate"
 * read — real filigree is just spirals of varying tightness.
 */
export function scroll(c, x, y, scale, rot, turns = 1.35, opts = {}) {
  const steps = 46;
  const grow = opts.grow ?? 0.30;
  const flip = opts.flip ? -1 : 1;
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.scale(1, flip);
  c.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    // pass 0 = dark underlay offset away from the light (the shadow the ribbon
    // casts on itself); pass 1 = the lit ribbon.
    if (pass === 0) c.strokeStyle = alpha(BRASS.crevice, 0.9);
    c.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = t * Math.PI * 2 * turns;
      const r = scale * Math.exp(-grow * a) ;
      const px = Math.cos(a) * r - scale + (pass === 0 ? -LIGHT_X * scale * 0.055 : 0);
      const py = Math.sin(a) * r + (pass === 0 ? -LIGHT_Y * scale * 0.055 : 0);
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    if (pass === 1) {
      const g = c.createLinearGradient(-scale, -scale, scale * 0.4, scale);
      g.addColorStop(0, BRASS.hot);
      g.addColorStop(0.4, BRASS.mid);
      g.addColorStop(1, BRASS.dark);
      c.strokeStyle = g;
    }
    c.lineWidth = Math.max(1, scale * (opts.weight ?? 0.115));
    c.stroke();
  }
  c.restore();
}

/**
 * Tarnish + pitting. Multiplied blotches of oxidised green-black, denser toward
 * the bottom (where a real object collects grime), plus a sparse pit field.
 * This single call is the difference between "gold" and "brass that has been in
 * a crypt".
 */
export function tarnish(c, x, y, w, h, rng, noise, strength = 1) {
  c.save();
  c.globalCompositeOperation = 'multiply';
  const blobs = Math.round(18 + (w * h) / 5200);
  for (let i = 0; i < blobs; i++) {
    const bx = x + rng.float() * w;
    // bias downward: grime settles
    const by = y + Math.pow(rng.float(), 0.62) * h;
    const r = (6 + rng.float() * 26) * (0.6 + strength * 0.7);
    const g = c.createRadialGradient(bx, by, 0, bx, by, r);
    const a = (0.10 + rng.float() * 0.26) * strength;
    const col = rng.float() < 0.42 ? BRASS.verdigris : BRASS.crevice;
    g.addColorStop(0, alpha(col, a));
    g.addColorStop(1, alpha(col, 0));
    c.fillStyle = g;
    c.fillRect(bx - r, by - r, r * 2, r * 2);
  }
  c.restore();

  // pits: tiny dark dots with a light rim on the lit side
  c.save();
  const pits = Math.round((w * h) / 900 * strength);
  for (let i = 0; i < pits; i++) {
    const px = x + rng.float() * w;
    const py = y + rng.float() * h;
    const r = 0.5 + rng.float() * 1.4;
    c.fillStyle = alpha(BRASS.crevice, 0.5 + rng.float() * 0.35);
    c.beginPath(); c.arc(px, py, r, 0, Math.PI * 2); c.fill();
    c.fillStyle = alpha(BRASS.hot, 0.16);
    c.beginPath(); c.arc(px + LIGHT_X * r * 0.9, py + LIGHT_Y * r * 0.9, r * 0.7, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

/** Fine directional scratches. Two colours: a dark gouge and its bright lip. */
export function scratches(c, x, y, w, h, rng, count = 30, len = 40) {
  c.save();
  c.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const sx = x + rng.float() * w;
    const sy = y + rng.float() * h;
    // Mostly horizontal: wear comes from things being dragged past, not from
    // random directions. A uniform angular distribution looks like noise.
    const a = (rng.float() - 0.5) * 0.55 + (rng.float() < 0.12 ? Math.PI * 0.5 : 0);
    const l = len * (0.25 + rng.float() * 0.95);
    const ex = sx + Math.cos(a) * l, ey = sy + Math.sin(a) * l;
    c.lineWidth = 0.6 + rng.float() * 0.6;
    c.strokeStyle = alpha(BRASS.crevice, 0.18 + rng.float() * 0.3);
    c.beginPath(); c.moveTo(sx, sy); c.lineTo(ex, ey); c.stroke();
    c.strokeStyle = alpha(BRASS.hot, 0.10 + rng.float() * 0.16);
    c.beginPath();
    c.moveTo(sx + LIGHT_X, sy + LIGHT_Y);
    c.lineTo(ex + LIGHT_X, ey + LIGHT_Y);
    c.stroke();
  }
  c.restore();
}

/** Per-pixel grain, applied through ImageData so it lands under everything's
 *  antialiasing rather than as a visible overlay. Cheap: run once, at bake. */
export function grain(c, x, y, w, h, rng, strength = 7) {
  const iw = Math.max(1, Math.round(w)), ih = Math.max(1, Math.round(h));
  const img = c.getImageData(x, y, iw, ih);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 4) continue;
    const n = (rng.float() - 0.5) * strength * 2;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  c.putImageData(img, x, y);
}

/** A soft drop shadow under an arbitrary path, drawn by stroking it blurred. */
export function dropShadow(c, pathFn, blur, offX, offY, a = 0.6) {
  c.save();
  c.shadowColor = alpha('#000000', a);
  c.shadowBlur = blur;
  c.shadowOffsetX = offX;
  c.shadowOffsetY = offY;
  c.fillStyle = '#000';
  pathFn(c);
  c.fill();
  c.restore();
}

// ---------------------------------------------------------------------------
// composed widgets
// ---------------------------------------------------------------------------

/**
 * The globe socket + glass, baked once. Transparent in the middle so the
 * animated liquid canvas underneath shows through, with the glass specular
 * drawn HERE (i.e. above the liquid) because a highlight under the liquid is
 * the single most common tell of a fake orb.
 */
export function bakeGlobeFrame(c, size, glassD, rng, noise, opts = {}) {
  const cx = size * 0.5, cy = size * 0.5;
  const rOut = size * 0.5 - 1;
  const rGlass = glassD * 0.5;
  const ringW = (rOut - rGlass) * 0.62;

  c.clearRect(0, 0, size, size);

  // --- filigree behind the ring, radiating outward on the diagonals ---------
  const wings = opts.wings ?? [Math.PI * 0.22, Math.PI * 0.78, Math.PI * 1.22, Math.PI * 1.78];
  for (const a of wings) {
    const s = size * 0.155;
    scroll(c, cx + Math.cos(a) * (rOut - s * 0.35), cy + Math.sin(a) * (rOut - s * 0.35),
      s, a + Math.PI * 0.5, 1.25, { flip: Math.sin(a) < 0, weight: 0.14 });
  }

  // --- outer torus ---------------------------------------------------------
  bevelRing(c, cx, cy, rOut, rOut - ringW, { segs: 150 });
  // --- inner socket lip, darker and narrower -------------------------------
  bevelRing(c, cx, cy, rOut - ringW + 1, rGlass + 1.5, { segs: 120, tint: 0.72, ambient: 0.12 });

  // --- rivets around the torus --------------------------------------------
  const rivets = opts.rivets ?? 10;
  for (let i = 0; i < rivets; i++) {
    const a = (i / rivets) * Math.PI * 2 + Math.PI * 0.13;
    rivet(c, cx + Math.cos(a) * (rOut - ringW * 0.5), cy + Math.sin(a) * (rOut - ringW * 0.5), size * 0.0245);
  }

  tarnish(c, 0, 0, size, size, rng, noise, 1.0);
  scratches(c, cx - rOut, cy - rOut, rOut * 2, rOut * 2, rng, 34, size * 0.13);

  // --- the glass ------------------------------------------------------------
  c.save();
  c.beginPath(); c.arc(cx, cy, rGlass + 2, 0, Math.PI * 2); c.clip();

  // Refraction darkening at the rim. A sphere of coloured liquid is nearly
  // opaque where you look through it edge-on; without this the orb reads flat.
  const rim = c.createRadialGradient(cx, cy, rGlass * 0.42, cx, cy, rGlass + 2);
  rim.addColorStop(0, 'rgba(0,0,0,0)');
  rim.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  rim.addColorStop(0.82, 'rgba(0,0,0,0.62)');
  rim.addColorStop(1, 'rgba(0,0,0,0.94)');
  c.fillStyle = rim;
  c.fillRect(cx - rGlass - 2, cy - rGlass - 2, rGlass * 2 + 4, rGlass * 2 + 4);

  // Broad soft specular, upper left. Small and tight: a big soft highlight over
  // half the ball is what makes a sphere read as matte plastic.
  const sx = cx + LIGHT_X * rGlass * 0.48, sy = cy + LIGHT_Y * rGlass * 0.48;
  const sg = c.createRadialGradient(sx, sy, 0, sx, sy, rGlass * 0.50);
  sg.addColorStop(0, 'rgba(255,255,255,0.17)');
  sg.addColorStop(0.40, 'rgba(255,255,255,0.045)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = sg;
  c.fillRect(cx - rGlass, cy - rGlass, rGlass * 2, rGlass * 2);

  // Hard crescent along the lit rim — the actual "glass" cue.
  c.save();
  c.lineWidth = Math.max(1.2, rGlass * 0.055);
  c.strokeStyle = 'rgba(255,252,244,0.42)';
  c.shadowColor = 'rgba(255,255,255,0.5)';
  c.shadowBlur = rGlass * 0.10;
  c.beginPath();
  c.arc(cx, cy, rGlass * 0.905, Math.PI * 1.02, Math.PI * 1.47);
  c.stroke();
  c.restore();

  // Cool bounce on the opposite rim, much weaker — light from the room.
  c.save();
  c.lineWidth = Math.max(1, rGlass * 0.038);
  c.strokeStyle = 'rgba(190,210,255,0.16)';
  c.beginPath();
  c.arc(cx, cy, rGlass * 0.90, Math.PI * 0.05, Math.PI * 0.44);
  c.stroke();
  c.restore();

  c.restore();

  // Hairline where glass meets socket.
  c.save();
  c.lineWidth = 1;
  c.strokeStyle = 'rgba(0,0,0,0.85)';
  c.beginPath(); c.arc(cx, cy, rGlass + 1, 0, Math.PI * 2); c.stroke();
  c.restore();
}

/**
 * A skill slot plate: chamfered brass frame with a recessed field the icon is
 * drawn into. Baked once and shared by all six slots via a data URL.
 */
export function bakeSlotFrame(c, size, rng, noise, opts = {}) {
  const cut = size * (opts.cut ?? 0.17);
  const lip = size * 0.085;
  c.clearRect(0, 0, size, size);

  // Cast shadow so the slot sits ON the plinth rather than in it.
  dropShadow(c, (cc) => octRect(cc, lip * 0.4, lip * 0.4, size - lip * 0.8, size - lip * 0.8, cut), size * 0.13, 0, size * 0.045, 0.75);

  engravedPlate(c, 1, 1, size - 2, size - 2, { cut, lip: Math.max(2, lip * 0.55), fill: SLATE.deep });

  // Corner accents: four tiny brass wedges in the chamfers. Small, deliberate,
  // and the thing that makes six identical squares read as "designed".
  c.save();
  for (let i = 0; i < 4; i++) {
    const fx = i & 1 ? size - 1 : 1;
    const fy = i & 2 ? size - 1 : 1;
    const dx = i & 1 ? -1 : 1;
    const dy = i & 2 ? -1 : 1;
    c.beginPath();
    c.moveTo(fx + dx * cut * 0.15, fy + dy * cut * 1.15);
    c.lineTo(fx + dx * cut * 1.15, fy + dy * cut * 0.15);
    c.lineTo(fx + dx * cut * 1.45, fy + dy * cut * 0.9);
    c.lineTo(fx + dx * cut * 0.9, fy + dy * cut * 1.45);
    c.closePath();
    c.fillStyle = brassGradient(c, fx, fy, fx + dx * cut * 2, fy + dy * cut * 2);
    c.fill();
  }
  c.restore();

  tarnish(c, 0, 0, size, size, rng, noise, 0.85);
  scratches(c, 0, 0, size, size, rng, 16, size * 0.35);
}

/** Round socket for the two signature abilities flanking the bar. */
export function bakeRoundSlot(c, size, rng, noise) {
  const cx = size * 0.5, cy = size * 0.5;
  const rOut = size * 0.5 - 1;
  c.clearRect(0, 0, size, size);
  dropShadow(c, (cc) => { cc.beginPath(); cc.arc(cx, cy + size * 0.04, rOut, 0, Math.PI * 2); }, size * 0.16, 0, size * 0.05, 0.8);
  bevelRing(c, cx, cy, rOut, rOut - size * 0.13, { segs: 96 });
  // recessed field
  const g = c.createRadialGradient(cx, cy - rOut * 0.3, rOut * 0.1, cx, cy, rOut);
  g.addColorStop(0, shade(SLATE.deep, 1.5));
  g.addColorStop(1, '#000000');
  c.fillStyle = g;
  c.beginPath(); c.arc(cx, cy, rOut - size * 0.125, 0, Math.PI * 2); c.fill();
  c.save();
  c.lineWidth = size * 0.05;
  c.strokeStyle = 'rgba(0,0,0,0.8)';
  c.beginPath(); c.arc(cx, cy, rOut - size * 0.11, 0, Math.PI * 2); c.stroke();
  c.restore();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    rivet(c, cx + Math.cos(a) * (rOut - size * 0.065), cy + Math.sin(a) * (rOut - size * 0.065), size * 0.032);
  }
  tarnish(c, 0, 0, size, size, rng, noise, 0.9);
}

/**
 * The full-width bottom plinth: a stone slab with a brass rail that sweeps up
 * into two wings toward the globes, with a raised centre platform under the
 * skill bar. This is the piece that makes the bottom of the frame read as ONE
 * designed object rather than three widgets that happen to be adjacent.
 */
export function bakePlinth(c, w, h, u, rng, noise) {
  c.clearRect(0, 0, w, h);
  const cx = w * 0.5;
  const slabTop = h - 62 * u;

  // --- stone slab ----------------------------------------------------------
  // The gradient starts well above the rail: the bottom of the frame has to
  // darken into the HUD, or a lit floor runs straight under the skill bar and
  // the whole bar loses its ground.
  const g = c.createLinearGradient(0, slabTop - 56 * u, 0, h);
  g.addColorStop(0, 'rgba(7,6,9,0.0)');
  g.addColorStop(0.32, 'rgba(7,6,9,0.45)');
  g.addColorStop(0.56, 'rgba(6,5,8,0.86)');
  g.addColorStop(1, 'rgba(3,3,5,0.97)');
  c.fillStyle = g;
  c.fillRect(0, slabTop - 56 * u, w, h - slabTop + 56 * u);

  // Stone breakup so the slab is not a flat wash: broad fbm bands.
  c.save();
  c.globalAlpha = 0.5;
  for (let x = 0; x < w; x += 3) {
    const n = noise.fbm(x * 0.006, 3.1, 4);
    const a = 0.05 + n * 0.16;
    c.fillStyle = `rgba(30,26,24,${a.toFixed(3)})`;
    c.fillRect(x, slabTop - 10 * u, 3, h - slabTop + 10 * u);
  }
  c.restore();

  // --- the rail: a curve that is flat across the centre then sweeps up ------
  // y(x) as a function of distance from centre, in u.
  const wingStart = 190 * u;          // where the sweep begins
  const wingEnd = Math.max(wingStart + 60 * u, cx - 46 * u); // stops short of the globe
  const railY = (x) => {
    const d = Math.abs(x - cx);
    if (d <= wingStart) return slabTop;
    const t = Math.min(1, (d - wingStart) / Math.max(1, wingEnd - wingStart));
    // ease-in-out so the wing leaves the rail tangentially — a straight ramp
    // reads as a chart, a tangential curve reads as forged metal.
    const e = t * t * (3 - 2 * t);
    return slabTop - e * 34 * u;
  };

  const railPath = (yOff, thick) => {
    c.beginPath();
    for (let x = 0; x <= w; x += 2) c[x === 0 ? 'moveTo' : 'lineTo'](x, railY(x) + yOff);
    for (let x = w; x >= 0; x -= 2) c.lineTo(x, railY(x) + yOff + thick);
    c.closePath();
  };

  // shadow under the rail
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.85)';
  c.shadowBlur = 10 * u;
  c.shadowOffsetY = 3 * u;
  c.fillStyle = '#000';
  railPath(0, 7 * u);
  c.fill();
  c.restore();

  // the rail itself, lit from above. Thicker than it looks like it needs to be:
  // a 7px ribbon across 1280px reads as a drawn line, a 10px one with a visible
  // top bevel and a crevice under it reads as a forged bar.
  railPath(0, 10 * u);
  const rg = c.createLinearGradient(0, slabTop - 34 * u, 0, slabTop + 11 * u);
  rg.addColorStop(0, BRASS.base);
  rg.addColorStop(0.26, BRASS.hot);
  rg.addColorStop(0.42, BRASS.mid);
  rg.addColorStop(0.72, BRASS.base);
  rg.addColorStop(1, BRASS.crevice);
  c.fillStyle = rg;
  c.fill();

  // a hairline crevice under the rail
  c.save();
  c.strokeStyle = 'rgba(0,0,0,0.85)';
  c.lineWidth = Math.max(1.5, u * 1.6);
  c.beginPath();
  for (let x = 0; x <= w; x += 2) c[x === 0 ? 'moveTo' : 'lineTo'](x, railY(x) + 10.5 * u);
  c.stroke();
  c.restore();

  // --- rivets along the rail ------------------------------------------------
  for (let x = 26 * u; x < w; x += 58 * u) {
    if (Math.abs(x - cx) < 210 * u) continue; // the centre carries the skill bar
    rivet(c, x, railY(x) + 5 * u, 2.8 * u);
  }

  // --- wing terminals: a scroll where each wing stops ------------------------
  for (const s of [-1, 1]) {
    const x = cx + s * wingEnd;
    const y = railY(x) + 3 * u;
    scroll(c, x, y, 15 * u, s > 0 ? -0.35 : Math.PI + 0.35, 1.4, { flip: s < 0, weight: 0.16 });
    // a bracket dropping from the terminal to the slab, so the wing is supported
    c.save();
    c.strokeStyle = alpha(BRASS.base, 0.85);
    c.lineWidth = 2.4 * u;
    c.beginPath();
    c.moveTo(x + s * 6 * u, y + 2 * u);
    c.quadraticCurveTo(x + s * 16 * u, y + 16 * u, x + s * 12 * u, h);
    c.stroke();
    c.restore();
  }

  // --- centre platform under the skill bar ---------------------------------
  const pw = 430 * u, ph = 20 * u;
  engravedPlate(c, cx - pw * 0.5, slabTop + 4 * u, pw, ph, { cut: 8 * u, lip: 2.2 * u, fill: SLATE.deep });
  // a row of engraved tick marks on the platform: cheap, and reads as "machined"
  c.save();
  c.strokeStyle = alpha(BRASS.base, 0.35);
  c.lineWidth = Math.max(1, u * 0.8);
  for (let x = cx - pw * 0.5 + 14 * u; x < cx + pw * 0.5 - 10 * u; x += 11 * u) {
    c.beginPath();
    c.moveTo(x, slabTop + 9 * u);
    c.lineTo(x, slabTop + 15 * u);
    c.stroke();
  }
  c.restore();

  tarnish(c, 0, slabTop - 36 * u, w, h - slabTop + 36 * u, rng, noise, 0.8);
  scratches(c, 0, slabTop - 30 * u, w, h - slabTop + 30 * u, rng, 70, 60 * u);
}

/**
 * A horizontal frame strip for the boss / target bars, baked at a fixed size
 * and stretched by CSS `border-image` so it survives arbitrary widths without
 * distorting the ends.
 */
export function bakeBarFrame(c, w, h, u, rng, noise, opts = {}) {
  c.clearRect(0, 0, w, h);
  const inset = opts.inset ?? 4 * u;
  const capW = h * 0.58;

  dropShadow(c, (cc) => octRect(cc, inset, inset, w - inset * 2, h - inset * 2, h * 0.28), 9 * u, 0, 2 * u, 0.8);
  engravedPlate(c, inset, inset, w - inset * 2, h - inset * 2, {
    cut: h * 0.26, lip: 2.4 * u, fill: SLATE.deep, tint: opts.tint ?? 1,
  });

  // end caps: a heavier brass block at each end with a rivet
  for (const s of [0, 1]) {
    const x = s ? w - inset - capW : inset;
    engravedPlate(c, x, inset - 1.5 * u, capW, h - inset * 2 + 3 * u, { cut: h * 0.22, lip: 2.6 * u, fill: SLATE.base });
    rivet(c, x + capW * 0.5, h * 0.5, 3.0 * u);
  }
  tarnish(c, 0, 0, w, h, rng, noise, 0.9);

  // PUNCH THE MIDDLE OUT, LAST.
  //
  // The frame is composited ABOVE the health fill so its end caps can overlap
  // the ends of the track. That means the recessed field `engravedPlate` paints
  // would otherwise cover the fill completely and the bar renders as an empty
  // slot — which is exactly what the first capture showed. The punch has to run
  // after `tarnish`, because canvas separable blend modes still composite
  // source-over and would repaint grime into the hole.
  c.save();
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = '#000';
  const hx = inset + capW * 0.86, hy = inset + 2.5 * u;
  octRect(c, hx, hy, w - hx * 2, h - hy * 2, h * 0.16);
  c.fill();
  c.restore();
}

/** Turn a canvas into a CSS-usable url() once. Called at bake time only. */
export function toUrl(cv) {
  return `url("${cv.toDataURL('image/png')}")`;
}

/** Offscreen canvas + 2D context in one call. */
export function offscreen(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return { cv, c: cv.getContext('2d') };
}
