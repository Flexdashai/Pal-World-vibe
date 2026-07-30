# MONARCH — engine contract

**Every agent must read this before writing code. It is the only coordination mechanism.**

Target: a browser isometric action RPG whose *visual and tactile quality* stands next
to **Diablo IV**, carrying the **dark fantasy atmosphere, explosive combat and
overwhelming power fantasy of Solo Leveling**. WebGL2 + Three.js r180, no external
art assets — every texture, mesh, animation and sound is generated procedurally at
load time.

Everything lives under `arpg/`. The FPS project at the repository root is a
different game; **never edit anything outside `arpg/`.**

## The two references, precisely

| axis | reference | what it means concretely |
|---|---|---|
| lighting, materials, grounding | **Diablo IV** | Physically-lit, desaturated, damp. Ground reads wet — broad specular lobes and a visible reflection of every flame. Stone is chipped, mossy, blood-stained, never flat. Deep shadow with real bounce, not lifted blacks. Fog sits in the room, catches light from braziers, and separates depth planes. |
| combat readability & spectacle | **Diablo IV** | Every hit produces impact frames, a decal, a particle burst, a light flash and a damage number. The screen never goes quiet during a fight. |
| power fantasy & colour signature | **Solo Leveling** | Violet/indigo shadow energy against a near-monochrome world. Shadow extraction: a corpse dissolves into a rising violet vortex and re-forms as a black soldier with glowing eyes. Monarch aura — a standing column of purple light and orbiting glyphs. Blue translucent SYSTEM windows for progression. |
| escalation | **Solo Leveling** | Power should visibly, aggressively snowball inside a single run: more shadows, bigger AoE, more screen coverage of purple. |

## Hard rules

1. **You own your directory. Never edit files outside it.** Another agent owns every
   other directory and your edit will be clobbered or will break them.
2. **Never import another subsystem's module.** Get it at runtime:
   `const fx = ctx.get('fx')`. This is what makes parallel work safe.
3. **No new npm dependencies.** `three` only. No CDN fetches, no external
   images/HDRIs/models/audio files — the game must run fully offline.
4. **No `Math.random()` in gameplay or visuals.** Use `ctx.rng` (see
   `src/core/rng.js`) or a `ctx.rng.fork()` you keep in `init()`. Capture
   reproducibility depends on it.
5. **Allocate nothing per-frame.** Preallocate vectors, matrices and arrays in
   `init()` and reuse. A `new THREE.Vector3()` inside `update()` is a bug.
6. **Dispose what you create.** Geometries, materials, textures and render targets
   get freed in `dispose()`.
7. `npm run arpg:build` must pass and `node arpg/tools/capture.mjs --shot=hero` must
   produce a frame after your change. **If you break the boot, nobody else can
   work.** Verify before you finish, every time.

## The renderer is a software rasteriser here

This container has **no GPU**. Chromium falls back to SwiftShader, so a 720p frame
costs ~0.4–1.5 s. Consequences that are not optional:

- Capture at **1280×720** (`--w`/`--h` default to it). Never benchmark fps here and
  never conclude anything about real performance from a measurement taken in this
  container; `tools/perf.mjs` reports *relative* cost only.
- Keep the post chain's full-resolution float passes few. Bloom, GTAO and
  volumetrics run at half or quarter resolution.
- Respect `config.q` budgets. Exceeding them makes every other agent's capture
  loop slower, which is a shared cost.

## Subsystem interface

```js
export class MySystem {
  static id = 'mysystem';       // unique; how others reach you
  static deps = ['render'];     // ids that must init before you

  async init(ctx) {}            // build resources; may await
  fixedUpdate(h, ctx) {}        // optional, 60 Hz, deterministic gameplay
  update(dt, ctx) {}            // optional, once per frame
  lateUpdate(dt, ctx) {}        // optional, after all update()
  resize(w, h, ctx) {}          // optional
  prewarmMaterials(ctx) {}      // optional, see Pre-warm below
  dispose() {}                  // optional
}
```

`ctx` provides: `scene`, `camera`, `uiScene`, `uiCamera`, `canvas`, `config`,
`events`, `input`, `time`, `rng`, `get(id)`, `peek(id)`, `has(id)`.

- `scene` / `camera` — the world, viewed isometrically. `uiScene` / `uiCamera` —
  an orthographic overlay scene drawn after the world with a cleared depth buffer,
  for anything that must never be occluded (selection rings on top of fog,
  world-space damage numbers, the cursor decal).
- `time` — `{ elapsed, raw, dt, fixed, alpha, scale, frame }`. `scale` is driven by
  the hit-stop system; **gameplay must read `dt` (scaled), never `raw`**, or hit-stop
  will not read as impact. Use `alpha` to interpolate rendered transforms between
  fixed steps.
- `config.q` — the active quality preset (`src/core/config.js`). Respect `q.taa`,
  `q.gtao`, `q.ssr`, `q.volumetrics`, `q.shadowMapSize`, `q.particleBudget`,
  `q.decalBudget`, `q.maxActors`. Never exceed a budget.

## Camera convention — read this before placing anything

The camera is a **perspective** camera posed isometrically, exactly like Diablo IV
(a true orthographic camera reads as flat and dated).

- Yaw is fixed at **45°**, pitch at **−52°**, vertical FOV **34°**, boom length
  ~**21 m**, so the focus point sits at the lower third of frame.
- **+X is screen right-and-down, +Z is screen left-and-down.** Screen "up" is `−X−Z`.
- The player stands at world origin height 0. **Ground is the XZ plane, Y is up.**
  All units are metres, seconds, kilograms.
- Anything taller than **4 m** near the player will occlude them. `world` must keep
  the north and west sides of every room low or fade them — `render` exposes
  `r.registerOccluderFade(mesh)`.

## Ownership map

| id | directory | owns |
|---|---|---|
| `render` | `src/render/` | WebGLRenderer, HDR pipeline, all post-processing, shadows, the final composite, colour grade, occluder fade |
| `materials` | `src/materials/` | procedural PBR texture generation, the shared material library, triplanar/detail/parallax mapping |
| `sky` | `src/sky/` | sky dome, moon/sun, time of day, IBL/env map generation, height fog, volumetric light shafts |
| `world` | `src/world/` | dungeon generation, the modular gothic kit, props, set dressing, practicals, static collision |
| `physics` | `src/physics/` | BVH, raycasts, character collision, projectiles, rigid bodies, ragdolls, spatial queries |
| `player` | `src/player/` | player character, movement, dodge, the isometric camera rig, stats, resources, levelling |
| `combat` | `src/combat/` | skills, cooldowns, damage model, crits, status effects, stagger, hit-stop, threat |
| `fx` | `src/fx/` | GPU particles, spell VFX, trails, decals, blood, gibs, shadow-extraction VFX, screen impulses |
| `ai` | `src/ai/` | enemy actors, animation rigs, navigation, perception, behaviour, bosses, shadow-soldier allies |
| `loot` | `src/loot/` | item generation, affixes, rarity, drops, ground beams, inventory, equipment |
| `ui` | `src/ui/` | HUD, globes, skill bar, damage numbers, SYSTEM windows, inventory, minimap, menus |
| `audio` | `src/audio/` | synthesized combat/foley/ambience, spatialisation, reverb, ducking, mix |

Shared, owned by the lead (**do not edit**): `src/core/`, `src/main.js`, `src/dev/`,
`tools/`, `vite.config.js`, `index.html`, this file.

## Cross-subsystem events

Emit and listen via `ctx.events`. Payloads are plain objects, and **must be reused
objects, not fresh literals**, on any event that can fire more than a few times a
second. The canonical set:

| event | payload | emitted by |
|---|---|---|
| `player:state` | `{ position, velocity, moving, dashing, casting }` | player |
| `player:cast` | `{ skill, origin: Vector3, dir: Vector3, target, seed }` | combat |
| `skill:ready` | `{ skill, slot }` | combat |
| `combat:hit` | `{ source, target, amount, element, crit, position, normal, stagger }` | combat |
| ↳ | means *damage dealt **to** `target`*. `target.isPlayer === true` when the player is hit — filter it before drawing an enemy hit reaction. Damage is applied by the target's own listener, never by the emitter as well. | |
| `combat:kill` | `{ actor, killer, position, overkill, element }` | combat |
| `combat:miss` | `{ source, position }` | combat |
| `actor:spawn` | `{ actor }` | ai |
| `actor:stagger` | `{ actor, amount, dir }` | combat |
| `shadow:extract` | `{ actor, position, rank, duration }` | player |
| `shadow:arise` | `{ soldier, position, rank }` | ai |
| `fx:impact` | `{ position, normal, surface, element, magnitude }` | combat / physics |
| `fx:explosion` | `{ position, radius, element, magnitude }` | any |
| `camera:shake` | `{ amount, duration, frequency }` | any |
| `camera:impulse` | `{ dir: Vector3, amount }` | any |
| `time:hitstop` | `{ duration, scale }` | combat |
| `loot:drop` | `{ item, position }` | loot |
| `loot:pickup` | `{ item }` | loot |
| `xp:gain` | `{ amount, total, next }` | player |
| `level:up` | `{ level, points, stats }` | player |
| `ui:system` | `{ kind, title, lines, duration }` | any — the Solo Leveling blue window |
| `ui:toast` | `{ text, tone }` | any |
| `world:ready` | `{ level, rooms, spawn: Vector3 }` | world |
| `world:room` | `{ room, cleared }` | world |
| `audio:cue` | `{ cue, position, gain }` | any |
| `resize` | `{ width, height }` | engine |

If you need an event that is not listed, add a row here in the same commit.

## Shared vocabularies

**Surface types** — physics tags every collider with one of: `stone`, `flagstone`,
`dirt`, `wood`, `metal`, `bone`, `flesh`, `cloth`, `water`, `crystal`, `ash`,
`blood`. Impact FX, decals, footsteps and audio all switch on these.

**Elements** — `physical`, `shadow`, `fire`, `frost`, `lightning`, `holy`. Every
element has one canonical colour, defined once in `src/core/palette.js`; **read it
from there, never hardcode a spell colour.** The whole game's colour identity
depends on `shadow` (violet #7B4BFF core, #C9A8FF hot) being the only saturated
thing on screen most of the time.

**Rarity** — `common`, `magic`, `rare`, `legendary`, `mythic`. Colours also in
`palette.js`.

## Actor interface

`ai`, `player` and `loot` all produce things `combat` and `physics` must reason
about. Every actor exposes:

```js
{
  id, isPlayer, isShadow, faction,        // 'player' | 'enemy'
  position: Vector3, velocity: Vector3,   // live references, do not copy-assign
  radius, height,
  stats: { hp, hpMax, armour, poise, level },
  alive,
  applyDamage({ amount, element, crit, dir, source }),  // owner applies, returns actual
  applyStagger(amount, dir),
  root: THREE.Object3D,                   // scene graph node
}
```

## Render integration

```js
const r = ctx.get('render');
r.renderer               // THREE.WebGLRenderer — do not change its state outside a frame
r.registerPass(pass)     // insert a custom post pass
r.addLight(light)        // register a punctual light so it participates in culling/budgets
r.requestEnvMap()        // PMREM env map currently in use
r.screenSize             // { width, height } of the internal render target
r.depthTexture           // linear depth, for soft particles / SSR / fog
r.normalTexture          // view-space normals
r.velocityTexture        // motion vectors, for TAA / motion blur
r.registerOccluderFade(mesh)  // dithers out when it stands between camera and player
r.resetTemporal()        // drop TAA history + snap exposure (capture harness calls this)
```

Per-object opt-outs, honoured every frame by `render._collect`:

```js
mesh.userData.mnNoPrepass = true  // keep out of the depth/normal/velocity prepass
mesh.userData.mnNoShadow  = true  // do not cast a shadow
mesh.userData.mnGlow      = 1.0   // multiplier into the bloom-only emissive buffer
```

### The visible point-light count is a shader permutation key

Three bakes the number of **visible** point lights into every material's program
cache key, so one brazier crossing its cull radius recompiles every lit material in
the scene — measured on the sibling project at +33 programs and 640–900 ms on that
single frame. Anything that registers distance-culled point lights **must keep the
visible count constant**: drive `intensity` to 0 and leave `visible` true, or park
zero-intensity ballast lights and top the count up to a fixed slot budget every
`lateUpdate`. A light whose colour × intensity is exactly 0 adds a float `0.0` to the
irradiance accumulator, so extra lit slots cannot move a pixel.

### Pre-warm

`src/core/prewarm.js` runs before the first frame and calls `prewarmMaterials(ctx)`
on every subsystem that implements it. The contract: **build and compile every
material the subsystem can produce, without spawning gameplay objects, drawing a
gameplay frame, or touching the clock/RNG.** `renderer.compileAsync()` alone only
reaches the forward lit variant — not the shadow pass, the MRT prepass, or the post
chain. A render target must be bound while compiling: `outputColorSpace` and
`toneMapping` are part of the cache key and are read off the *currently bound*
target.

## Quality bar

Every visual subsystem is reviewed by an adversarial critic against real Diablo IV
frames and Solo Leveling stills. Non-negotiables:

- **No flat/untextured surfaces.** Every material needs albedo variation, a normal
  map, roughness variation, and a detail layer legible at 0.5 m.
- **No uniform lighting.** Contact shadows, bounce, ambient occlusion, and a clear
  key/fill/rim separation. In a crypt the key *is* the brazier — it must flicker,
  and everything near it must respond.
- **Physically plausible values.** Albedo in 0.02–0.9, metals are 0 or 1, real-world
  light intensities, exposure-driven not multiplier-driven.
- **Nothing perfectly straight, clean, or repeated.** Edge wear, grime in crevices,
  subtle warp, varied instance rotation/scale, cracked flagstones, no visible tiling.
- **Every action has weight.** Hit-stop, camera shake, screen-space impulse, an audio
  transient, a decal, a particle burst and a damage number on *every* impact.
- **Depth separation.** Fog, light falloff and a subtle vignette must make the
  foreground read against the background. A flat-lit readable-everywhere image is a
  failure even if every material is perfect.
