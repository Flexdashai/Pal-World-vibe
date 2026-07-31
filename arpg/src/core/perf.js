import { QUALITY_PRESETS } from './config.js';

/**
 * Adaptive quality scaler.
 *
 * The machine this game is built on has no GPU, so no fps number measured during
 * development means anything. The only honest response to that is to stop trying
 * to pick settings ahead of time and instead measure on the player's machine and
 * react. That is also just what shipped games do — a fixed preset is a guess
 * about hardware nobody making the guess has seen.
 *
 * Design notes that matter:
 *
 *  - MEDIAN, NOT MEAN. One 300 ms hitch (a shader compiling, a GC pause, the OS
 *    scheduling something else) must not drop quality for everyone. A rolling
 *    median over ~40 frames ignores outliers by construction; a mean chases them.
 *
 *  - HYSTERESIS AND A COOLDOWN. Dropping at >20 ms and raising at <13 ms leaves a
 *    dead band around the 16.7 ms target, so a frame time sitting exactly at the
 *    threshold cannot oscillate. The cooldown stops the scaler from reacting to
 *    its own last change before the change has taken effect.
 *
 *  - DOWN FAST, UP SLOW. An unplayable frame rate is an emergency and a slightly
 *    softer image is not, so a drop needs 0.6 s of evidence and a raise needs
 *    2.5 s. Asymmetry here is the difference between "settles quickly" and
 *    "pumps between two settings forever".
 *
 *  - COMPLETELY DISABLED IN CAPTURE MODE. Every screenshot the critics review
 *    would otherwise be taken at a resolution and feature set determined by how
 *    busy the machine was at that moment, which would destroy both reproducibility
 *    and the pixel gate.
 *
 * The ladder is ordered by cost-to-quality ratio, cheapest visual loss first,
 * measured by ablation with tools/passcost.mjs. Screen-space reflections go early
 * because they are expensive and only read on wet floor; resolution goes late
 * because it costs everything at once.
 */

/** Each step is a partial override applied on top of the base preset. */
const LADDER = [
  { name: 'ultra',  over: {} },
  { name: 'high',   over: { renderScale: 0.92 } },
  { name: 'high-',  over: { renderScale: 0.92, ssr: false } },
  { name: 'mid+',   over: { renderScale: 0.85, ssr: false, dof: false } },
  { name: 'mid',    over: { renderScale: 0.80, ssr: false, dof: false, shadowMapSize: 2048, cascades: 3 } },
  { name: 'mid-',   over: { renderScale: 0.75, ssr: false, dof: false, shadowMapSize: 2048, cascades: 3, gtao: false } },
  { name: 'low+',   over: { renderScale: 0.70, ssr: false, dof: false, shadowMapSize: 1536, cascades: 2, gtao: false, volumetrics: false } },
  { name: 'low',    over: { renderScale: 0.62, ssr: false, dof: false, shadowMapSize: 1024, cascades: 2, gtao: false, volumetrics: false, bloomLevels: 4 } },
  { name: 'min',    over: { renderScale: 0.55, ssr: false, dof: false, shadowMapSize: 1024, cascades: 2, gtao: false, volumetrics: false, bloomLevels: 3, taa: false } },
];

const TARGET_MS = 1000 / 60;
const DROP_MS = 20.0;   // ~50 fps — below this, shed quality
const RAISE_MS = 13.0;  // ~77 fps — above this, there is headroom to spend
const WINDOW = 40;
/** Enough samples for a median to mean anything, few enough to react. */
const MIN_SAMPLES = 5;
const DROP_HOLD = 0.6;
const RAISE_HOLD = 2.5;
const COOLDOWN = 1.0;
/**
 * Frames to ignore at boot. Deliberately small, and this is the second value it
 * has had: at 45 frames a machine rendering at 1.7 s per frame during boot took
 * 76 SECONDS to reach its first correction — the whole point of the scaler is to
 * rescue exactly that machine, and it was the slowest to get help.
 *
 * A frame COUNT rather than a duration is still right (the noise being skipped is
 * per-frame work, not per-second), but it can be small because prewarm.js has
 * already compiled every shader permutation before the loop starts, so the first
 * frames are far less unrepresentative here than in an engine that compiles
 * lazily.
 */
const WARMUP = 12;

export class PerfSystem {
  static id = 'perf';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.enabled = !ctx.config.deterministic;
    this.base = { ...QUALITY_PRESETS[ctx.config.quality] };

    // Start partway down the ladder rather than at the top. Booting at ultra on a
    // laptop gives a terrible first impression that the scaler then takes several
    // seconds to correct; booting one notch light and climbing is invisible.
    this.step = Math.min(LADDER.length - 1, Number(this._param(ctx, 'step') ?? 3));

    this._samples = new Float32Array(WINDOW);
    this._sorted = new Float32Array(WINDOW);
    this._n = 0;
    this._i = 0;
    this._frames = 0;
    this._overMs = 0;
    this._underMs = 0;
    this._cooldown = 0;
    this.fps = 0;
    this.medianMs = 0;
    this.changes = 0;

    this._apply(this.step, ctx);

    // Manual override from the address bar, for anyone diagnosing a report:
    // ?q=low pins the preset, ?adaptive=0 turns the scaler off entirely.
    if (this._param(ctx, 'adaptive') === '0') this.enabled = false;

    window.__PERF__ = this;
    if (this._param(ctx, 'fps') === '1') this._installReadout();
  }

  _param(ctx, k) {
    try { return new URLSearchParams(location.search).get(k); } catch { return null; }
  }

  /** Apply ladder step `i` to the live config and re-point the render targets. */
  _apply(i, ctx = this.ctx) {
    this.step = Math.max(0, Math.min(LADDER.length - 1, i));
    const q = ctx.config.q;
    Object.assign(q, this.base, LADDER[this.step].over);
    this.quality = LADDER[this.step].name;

    const render = ctx.peek('render');
    // resize() re-reads q.renderScale and reallocates every internal target, so
    // this is what actually makes a step change take effect.
    render?.resize?.(
      Math.max(1, ctx.canvas.clientWidth || innerWidth),
      Math.max(1, ctx.canvas.clientHeight || innerHeight),
      ctx
    );
    // Discard the measurement history. It describes the SETTINGS THAT NO LONGER
    // APPLY, and a 40-sample median needs 20 new frames before it even begins to
    // reflect the change — at a low frame rate that is seconds of the scaler
    // judging a new setting by the old one's cost, which is how a scaler ends up
    // over-correcting and then oscillating.
    this._n = 0;
    this._i = 0;
    this._overMs = 0;
    this._underMs = 0;

    ctx.events.emit('perf:quality', { step: this.step, name: this.quality, q });
  }

  update(dt, ctx) {
    // Unscaled: hit-stop deliberately slows `dt`, and measuring quality against a
    // clock the game is intentionally distorting would drop settings every time
    // the player lands a heavy hit.
    //
    // CAVEAT worth knowing when reading a report from this scaler: rawDt is the
    // interval between rAF callbacks, which equals real frame cost only while the
    // driver keeps the command queue shallow — which is what vsync does on real
    // hardware. Under a software rasteriser with the frame-rate limiter off, rAF
    // runs ahead of a backed-up queue and rawDt measures callback cadence instead
    // of render cost. A conclusion drawn from it in that environment is worthless,
    // and one was: an early measurement here showed frame time unmoved as the
    // ladder walked from 'mid+' to 'min', which was read as "the frame is CPU
    // bound and resolution cannot help it". Direct measurement says the opposite —
    // renderScale 1.0 to 0.5 is 8493 ms to 2775 ms, very close to linear in pixel
    // count. The scaler works; the instrument used to check it did not.
    const ms = ctx.time.rawDt * 1000;
    this._frames++;

    this._samples[this._i] = ms;
    this._i = (this._i + 1) % WINDOW;
    if (this._n < WINDOW) this._n++;

    if (this._n >= MIN_SAMPLES) {
      this._sorted.set(this._samples.subarray(0, this._n));
      const view = this._sorted.subarray(0, this._n);
      view.sort();
      this.medianMs = view[this._n >> 1];
      this.fps = this.medianMs > 0 ? 1000 / this.medianMs : 0;
    }
    if (this._readout && (this._frames & 7) === 0) this._updateReadout();

    if (!this.enabled || this._frames < WARMUP || this._n < MIN_SAMPLES) return;

    if (this._cooldown > 0) { this._cooldown -= ctx.time.rawDt; return; }

    if (this.medianMs > DROP_MS) {
      this._overMs += ctx.time.rawDt;
      this._underMs = 0;
      if (this._overMs >= DROP_HOLD && this.step < LADDER.length - 1) {
        // Descend PROPORTIONALLY to how bad it is. One step at a time is correct
        // when the frame rate is merely disappointing, but a machine sitting at
        // 10 fps needs to reach playable in one reaction, not eight — and each
        // reaction costs a target reallocation, so taking them one at a time is
        // also slower than it looks. Measured on a struggling machine, single
        // stepping took ~50 s to walk three rungs.
        const jump = this.medianMs > 45 ? 3 : this.medianMs > 25 ? 2 : 1;
        this._overMs = 0;
        this._cooldown = COOLDOWN;
        this.changes++;
        this._apply(this.step + jump, ctx);
      }
    } else if (this.medianMs < RAISE_MS) {
      this._underMs += ctx.time.rawDt;
      this._overMs = 0;
      if (this._underMs >= RAISE_HOLD && this.step > 0) {
        this._underMs = 0;
        this._cooldown = COOLDOWN;
        this.changes++;
        this._apply(this.step - 1, ctx);
      }
    } else {
      this._overMs = 0;
      this._underMs = 0;
    }
  }

  /** Opt-in diagnostic readout (`?fps=1`). Deliberately not part of the HUD — ui
   *  owns that, and this must work even if ui failed to initialise. */
  _installReadout() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9fe8ff;' +
      'background:rgba(6,10,20,.72);border:1px solid rgba(120,190,255,.35);' +
      'padding:4px 10px;letter-spacing:.06em;pointer-events:none;white-space:pre';
    document.body.appendChild(el);
    this._readout = el;
  }

  _updateReadout() {
    const r = this.ctx.peek('render')?.renderer?.info?.render;
    this._readout.textContent =
      `${this.fps.toFixed(0)} fps  ${this.medianMs.toFixed(1)} ms   ` +
      `${this.quality} (${this.step})  x${(this.ctx.config.q.renderScale).toFixed(2)}   ` +
      `${r?.calls ?? 0} calls  ${((r?.triangles ?? 0) / 1000).toFixed(0)}k tris`;
  }

  stats() {
    return {
      fps: +this.fps.toFixed(1), medianMs: +this.medianMs.toFixed(2),
      step: this.step, quality: this.quality, changes: this.changes,
      enabled: this.enabled, renderScale: this.ctx.config.q.renderScale,
    };
  }

  dispose() {
    this._readout?.remove();
    if (window.__PERF__ === this) delete window.__PERF__;
  }
}
