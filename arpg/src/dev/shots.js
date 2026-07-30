import * as THREE from 'three';
import { CAMERA } from '../core/config.js';

/**
 * Named setups the screenshot harness can request. Each shot freezes input, poses
 * the camera and forces gameplay state, so critics always review the same framing
 * across iterations.
 *
 * A shot is
 *   { focus, offset?, boom?, fov?, time?, apply?(engine, opts), doc }
 *
 * `focus` is a LANDMARK NAME, not a coordinate. The world generator is
 * procedural, so hardcoded camera positions rot the moment anyone touches the
 * layout. `world.debugFocus(name)` returns `{ pos:[x,y,z], look:[x,y,z] }` for a
 * landmark and the shot frames it isometrically; if world has no opinion the shot
 * falls back to framing the origin.
 *
 * ---------------------------------------------------------------------------
 * DEBUG HOOKS every subsystem must implement (called only from here and from
 * tools/, never from gameplay). All are optional but their absence shows up as a
 * blank critic shot, which reads as a defect.
 *
 *   world.debugFocus(name)   -> { pos, look } | null   'hall'|'corridor'|'arena'|'shrine'|'gate'
 *   world.debugStage(name)                              'clean'|'lit'|'dark'
 *   player.debugPose(name, opts)                        'idle'|'run'|'cast'|'dash'|'arise'|'ultimate'
 *   combat.debugBurst(name, opts)                       'none'|'cleave'|'nova'|'beam'|'ultimate'
 *   ai.debugStage(name, opts)                           'none'|'idle'|'horde'|'boss'|'dying'
 *   fx.debugBurst(name, opts)                           'none'|'impacts'|'blood'|'extract'|'explosion'
 *   loot.debugDrop(name)                                'none'|'legendary'|'field'
 *   ui.debugState(name)                                 'clean'|'combat'|'levelup'|'inventory'|'arise'
 *   sky.setTimeOfDay(hours)
 *
 * `opts.grabFrame` is how many frames the harness will pump before the shutter —
 * shots whose subject is a transient (a nova lives ~0.4 s) use it to land the
 * event ON the captured frame instead of guessing.
 */
export const SHOTS = {
  // ---- environment / art direction ----
  hero: {
    focus: 'hall', boom: 24, fov: 34, time: 1.2,
    apply: (e) => { e.ctx.peek('ai')?.debugStage?.('idle'); e.ctx.peek('player')?.debugPose?.('idle'); },
    doc: 'Wide establishing shot of the cathedral hall — reads overall art direction, ' +
         'brazier key light, fog depth, floor wetness, architecture silhouette.',
  },
  corridor: {
    focus: 'corridor', boom: 17, fov: 34, time: 1.2,
    apply: (e) => e.ctx.peek('ai')?.debugStage?.('idle'),
    doc: 'Tight crypt corridor — oppression, contact shadow, light falloff, ' +
         'material detail at close camera range.',
  },
  shrine: {
    focus: 'shrine', boom: 18, fov: 32, time: 1.2,
    doc: 'The shadow shrine — violet rim light against cold stone. The one place ' +
         'the signature colour dominates the frame with no combat running.',
  },
  detail: {
    focus: 'corridor', boom: 9.5, fov: 30, time: 1.2,
    doc: 'Camera pushed in on floor and wall — texel density, normal maps, POM, ' +
         'grime in crevices, moss, cracked flagstone. Any flat surface fails here.',
  },
  depth: {
    focus: 'gate', boom: 26, fov: 36, time: 1.2,
    doc: 'Long sightline through a lit gate — volumetric shafts, height fog, ' +
         'aerial perspective, foreground/background separation.',
  },

  // ---- character ----
  character: {
    focus: 'hall', boom: 11, fov: 30, time: 1.2,
    apply: (e) => e.ctx.peek('player')?.debugPose?.('idle'),
    doc: 'Hero at close range — armour materials, cloth, rim light, silhouette ' +
         'readability, the violet monarch aura.',
  },

  // ---- combat ----
  combat: {
    focus: 'hall', boom: 22, fov: 34, time: 1.2,
    apply: (e, o) => {
      e.ctx.peek('ai')?.debugStage?.('horde', o);
      e.ctx.peek('player')?.debugPose?.('cast', o);
      e.ctx.peek('combat')?.debugBurst?.('cleave', o);
      e.ctx.peek('ui')?.debugState?.('combat');
    },
    doc: 'Mid-fight against a horde — impact FX density, damage numbers, blood, ' +
         'enemy readability, screen energy.',
  },
  nova: {
    focus: 'hall', boom: 20, fov: 34, time: 1.2,
    apply: (e, o) => {
      e.ctx.peek('ai')?.debugStage?.('horde', o);
      e.ctx.peek('combat')?.debugBurst?.('nova', o);
      e.ctx.peek('ui')?.debugState?.('combat');
    },
    doc: 'Shadow nova at peak — AoE spell VFX, bloom bleed, light spill onto ' +
         'geometry, enemy hit reactions all at once.',
  },
  arise: {
    focus: 'hall', boom: 20, fov: 34, time: 1.2,
    apply: (e, o) => {
      e.ctx.peek('ai')?.debugStage?.('dying', o);
      e.ctx.peek('player')?.debugPose?.('arise', o);
      e.ctx.peek('fx')?.debugBurst?.('extract', o);
      e.ctx.peek('ui')?.debugState?.('arise');
    },
    doc: 'ARISE — corpses dissolving into violet vortices and re-forming as shadow ' +
         'soldiers. The signature Solo Leveling beat; must be the best frame in the game.',
  },
  ultimate: {
    focus: 'arena', boom: 23, fov: 36, time: 1.2,
    apply: (e, o) => {
      e.ctx.peek('ai')?.debugStage?.('boss', o);
      e.ctx.peek('player')?.debugPose?.('ultimate', o);
      e.ctx.peek('combat')?.debugBurst?.('ultimate', o);
      e.ctx.peek('ui')?.debugState?.('combat');
    },
    doc: 'Monarch ultimate against the boss — maximum spectacle, shadow army, ' +
         'screen-filling violet, the overwhelming-power payoff.',
  },
  boss: {
    focus: 'arena', boom: 25, fov: 36, time: 1.2,
    apply: (e, o) => { e.ctx.peek('ai')?.debugStage?.('boss', o); e.ctx.peek('ui')?.debugState?.('combat'); },
    doc: 'Boss arena, boss idle — creature silhouette, scale, materials, arena staging.',
  },

  // ---- loot / UI ----
  loot: {
    focus: 'hall', boom: 15, fov: 32, time: 1.2,
    apply: (e) => { e.ctx.peek('loot')?.debugDrop?.('field'); e.ctx.peek('ui')?.debugState?.('combat'); },
    doc: 'A field of drops after a fight — rarity beams, ground labels, the ' +
         'dopamine read of a legendary.',
  },
  hud: {
    focus: 'hall', boom: 22, fov: 34, time: 1.2,
    apply: (e, o) => {
      e.ctx.peek('ai')?.debugStage?.('horde', o);
      e.ctx.peek('ui')?.debugState?.('levelup');
    },
    doc: 'Full HUD with a SYSTEM window open — globes, skill bar, typography, ' +
         'the blue Solo Leveling panel. Layout and legibility.',
  },
};

/**
 * Frame a landmark isometrically: place the eye on the fixed camera boom.
 *
 * The signs matter and are easy to get backwards. With THREE's YXZ euler, a
 * camera at rotation (pitch, yaw, 0) looks along
 *   forward = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch))
 * so the eye is `look - forward·boom`, which at yaw=45° puts it at +X+Z of the
 * focus. That is what makes -X-Z read as "into the distance" (screen up) and both
 * +X and +Z read as screen-down, exactly as ARCHITECTURE.md promises. Negating
 * these puts the camera on the far side looking away, and the frame fills with
 * empty floor — which is not obviously wrong in a screenshot.
 */
function frame(camera, look, boom, fov) {
  const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch);
  camera.position.set(
    look.x + Math.sin(CAMERA.yaw) * boom * cp,
    look.y - sp * boom,
    look.z + Math.cos(CAMERA.yaw) * boom * cp
  );
  camera.rotation.set(CAMERA.pitch, CAMERA.yaw, 0);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

export function installShotApi(engine, { capture, lockstep = false } = {}) {
  window.__SHOTS__ = SHOTS;
  const look = new THREE.Vector3();

  window.__APPLY_SHOT__ = (name, opts = {}) => {
    const shot = SHOTS[name];
    if (!shot) return { error: `unknown shot "${name}"`, available: Object.keys(SHOTS) };

    engine.input.frozen = true;
    engine.input.enabled = false;
    const player = engine.ctx.peek('player');
    player?.setControlEnabled?.(false);

    // Shots run back to back in one browser session, so clear the previous shot's
    // LOOPING debug state first. Without this, `nova`'s AoE is still expanding
    // during `arise` and the loot field from `loot` litters `hud`.
    engine.ctx.peek('combat')?.debugBurst?.('none');
    engine.ctx.peek('fx')?.debugBurst?.('none');
    engine.ctx.peek('ai')?.debugStage?.('none');
    engine.ctx.peek('loot')?.debugDrop?.('none');
    engine.ctx.peek('ui')?.debugState?.('clean');
    engine.ctx.peek('player')?.debugPose?.('idle');

    const world = engine.ctx.peek('world');
    const spot = world?.debugFocus?.(shot.focus ?? 'hall') ?? null;
    look.set(0, 0, 0);
    if (spot?.look) look.fromArray(spot.look);
    else if (spot?.pos) look.fromArray(spot.pos);

    // The player is the visual anchor of an ARPG frame — teleport them to the
    // landmark so shots are never of an empty room, unless the shot opts out.
    if (shot.noPlayer !== true) player?.teleport?.(look);
    look.y += CAMERA.focusLift;

    frame(engine.camera, look, shot.boom ?? CAMERA.boom, shot.fov ?? CAMERA.fov);

    if (shot.time !== undefined) engine.ctx.peek('sky')?.setTimeOfDay?.(shot.time);
    shot.apply?.(engine, opts);

    engine.events.emit('shot:applied', { name, shot });
    return {
      applied: name,
      focus: shot.focus ?? null,
      resolved: spot ? [+look.x.toFixed(2), +look.y.toFixed(2), +look.z.toFixed(2)] : 'origin-fallback',
      fov: shot.fov ?? CAMERA.fov,
    };
  };

  if (capture) {
    engine.input.frozen = true;
    // Fixed timestep in capture mode so temporal effects converge identically.
    // `this._last = fake` before each step forces rawDt to be EXACTLY 1000/60 on
    // every frame including the first, whatever else touched `_last` (Engine.start
    // and prewarm both assign performance.now() to it). Without it, frame 1's dt
    // is 0 when `_last` holds a real clock and 1/60 when it does not — a
    // boot-path-dependent one-frame difference in every accumulator.
    let fake = 0;
    engine.step = ((orig) =>
      function () {
        this._last = fake;
        fake += 1000 / 60;
        return orig.call(this, fake);
      })(engine.step);
  }

  window.__RENDER_INFO__ = null;
  const snapInfo = () => {
    const r = engine.ctx.peek('render');
    window.__RENDER_INFO__ = {
      frame: engine.time.frame,
      calls: r?.renderer?.info.render.calls ?? 0,
      tris: r?.renderer?.info.render.triangles ?? 0,
      programs: r?.renderer?.info.programs?.length ?? 0,
      textures: r?.renderer?.info.memory.textures ?? 0,
      geometries: r?.renderer?.info.memory.geometries ?? 0,
      ms: engine.time.rawDt * 1000,
    };
  };

  /**
   * LOCKSTEP CAPTURE (`?capture=1&lockstep=1`).
   *
   * The engine's own rAF loop keeps stepping while the driver does round trips
   * (waitForFunction on __READY__, the evaluate that applies the shot, the
   * screenshot RPC). How many frames fit inside those round trips is wall-clock
   * dependent, so `time.frame` at the shutter drifts run to run — and everything
   * phase-locked to the absolute frame index (TAA jitter, AO noise rotation,
   * exposure adaptation, scripted transients) resolves differently every time.
   * On a software rasteriser, where a frame can take a second, the drift is
   * enormous.
   *
   * In lockstep the engine NEVER schedules its own frames. Frames happen only
   * inside __PUMP__(n). The frame index at the shutter is then a constant.
   */
  if (lockstep) {
    engine.start = function () { this._running = true; };
    window.__LOCKSTEP__ = true;

    window.__PUMP__ = (n = 1) => new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        engine.step();
        snapInfo();
        if (++i >= n) resolve(engine.time.frame);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    /** Yield `n` rAFs WITHOUT stepping, so the compositor picks up the last
     *  rendered frame before the screenshot. Advances no simulation state. */
    window.__PRESENT__ = (n = 2) => new Promise((resolve) => {
      let i = 0;
      const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
  } else {
    window.__LOCKSTEP__ = false;
    window.__PUMP__ = (n = 1) => new Promise((resolve) => {
      let i = 0;
      const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    window.__PRESENT__ = window.__PUMP__;
    const info = () => { snapInfo(); requestAnimationFrame(info); };
    requestAnimationFrame(info);
  }

  return { pump: window.__PUMP__, present: window.__PRESENT__, lockstep: !!lockstep };
}
