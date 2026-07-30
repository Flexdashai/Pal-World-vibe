/**
 * MONARCH — the UI subsystem.
 *
 * Owns everything the player reads: the Diablo-lineage bottom HUD (resource
 * globes, action bar, experience), the top health tracks, the minimap, the
 * combat log, the Solo Leveling SYSTEM windows, the inventory / character /
 * skill panels, world-space damage numbers, the ground cursor, and the
 * full-screen damage / level-up / ARISE feedback.
 *
 * ARCHITECTURE NOTES
 *
 * - `deps` is empty and stays empty. Every other subsystem is reached through
 *   `ctx.peek(id)` at runtime, and the HUD is designed to be COMPLETE AND
 *   CORRECT when none of them exist: it keeps its own resource model, its own
 *   fog-of-war raster and its own plausible loadout, and defers to the real
 *   systems the moment they publish data. That is what lets this agent's work
 *   be reviewed on its own and what stops a missing subsystem from producing an
 *   empty screenshot.
 *
 * - Two rendering surfaces. DOM/CSS over the canvas for everything that is
 *   text, because DOM text is hinted and subpixel-positioned and a texture atlas
 *   of glyphs is not; canvas 2D for everything that is MATERIAL (brass, glass,
 *   liquid), because CSS gradients cannot make metal; and `ctx.uiScene` for the
 *   two things that must live in the world — damage numbers and the ground
 *   cursor.
 *
 * - Nothing is allocated per frame. Widgets cache their last written value and
 *   elide the DOM write; canvas gradients are built once and re-used through a
 *   transform; the damage-number system is a fixed pool of typed arrays feeding
 *   one instanced draw call.
 *
 * - All animation is driven from `ctx.time.raw`, never from CSS transitions, so
 *   the capture harness lands on a deterministic phase. The only CSS animations
 *   are ambient loops whose phase does not matter (the scanline sweep, the xp
 *   sheen, the caret blink).
 */

import * as THREE from 'three';
import { RARITY } from '../core/palette.js';
import { buildCss } from './style.js';
import { M, metricsFor, clamp01 } from './theme.js';
import { el, setStyle, groupNum } from './dom.js';
import { makeNoise, bakePlinth, offscreen, toUrl } from './ornament.js';
import { createGlobes } from './globes.js';
import { SkillBar, BuffRow, DEFAULT_SKILLS, SIGNATURE_SKILLS } from './skillbar.js';
import { XpBar, TargetBar, BossBar, ShadowRoster, bakeBarFrames } from './bars.js';
import { SystemStack, WINDOWS } from './system.js';
import { KillFeed, ToastStrip } from './feed.js';
import { MiniMap } from './minimap.js';
import { Panels } from './panels.js';
import { ScreenFx } from './screenfx.js';
import { DamageNumbers } from './damagenumbers.js';
import { GroundCursor } from './cursor.js';
import {
  makeInventory, makeEquipment, makeCharacter, makeDungeonField, makeBlips,
  seedFeed, ENEMY_NAMES, ELITE_AFFIXES, BOSSES, SHADOW_NAMES, SHADOW_RANKS,
} from './fakedata.js';

/** Resource model used when no `player` subsystem is publishing one. */
const FALLBACK = { hp: 980, hpMax: 980, mana: 220, manaMax: 280, level: 14, xp: 0.62, points: 0 };

export class UiSystem {
  static id = 'ui';
  static deps = [];

  async init(ctx) {
    this.ctx = ctx;
    // `?nohud=1` builds nothing. Environment/material critics occasionally want
    // a frame with no chrome over the floor, and it is also the control case
    // when measuring what the HUD costs a software-composited screenshot.
    this.disabled = new URLSearchParams(location.search).get('nohud') === '1';
    if (this.disabled) return;
    this.rng = ctx.rng.fork();
    this.artRng = this.rng.fork();
    this.dataRng = this.rng.fork();
    this.spawnRng = this.rng.fork();
    this.noise = makeNoise(this.artRng.fork());

    // ---- stylesheet --------------------------------------------------------
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'mn-ui-style';
    this.styleEl.textContent = buildCss();
    document.head.appendChild(this.styleEl);

    // ---- root --------------------------------------------------------------
    this.host = document.getElementById('ui') ?? document.body;
    this.root = el('div', 'mn', this.host);

    // ---- layers ------------------------------------------------------------
    this.fx = new ScreenFx(this.root);

    this.top = el('div', 'mn-top', this.root);
    this.boss = new BossBar(this.top);
    this.target = new TargetBar(this.top);

    this.map = new MiniMap(this.root, this.artRng.fork());
    this.roster = new ShadowRoster(this.root);
    this.feed = new KillFeed(this.root);
    this.toasts = new ToastStrip(this.root);

    this.bottom = el('div', 'mn-bottom', this.root);
    this.plinth = el('div', 'mn-plinth', this.bottom);
    this.globes = createGlobes(this.bottom, this.artRng.fork());
    this.buffs = new BuffRow(this.bottom);
    this.bar = new SkillBar(this.bottom, this.artRng.fork());
    this.xp = new XpBar(this.root);

    this.system = new SystemStack(this.root);
    this.panels = new Panels(this.root, this.dataRng.fork());
    this.cursor = new GroundCursor(ctx, this.root);
    this.numbers = new DamageNumbers(ctx, this.spawnRng.fork());

    // ---- state -------------------------------------------------------------
    this.state = {
      hp: FALLBACK.hp, hpMax: FALLBACK.hpMax,
      mana: FALLBACK.mana, manaMax: FALLBACK.manaMax,
      level: FALLBACK.level, xp: FALLBACK.xp * 4200, xpNext: 4200,
      points: 0, gold: 148_320,
      shadows: 4, shadowsMax: 12,
    };
    this.debug = 'clean';
    this._spawner = null;
    this._holdArise = false;
    this._posed = false;
    this._u = 1;
    this._pxRatio = 1;
    this._playerPos = new THREE.Vector3();
    this._playerFacing = 0;
    this._hitDir = new THREE.Vector3();
    this._tmpPos = new THREE.Vector3();
    this._buffList = [];
    this._blips = [];
    // Preallocated blip records: the minimap sync writes into these rather than
    // building an object per actor per sample.
    this._blipPool = Array.from({ length: 48 }, () => ({ x: 0, z: 0, type: 'enemy' }));
    this._blipAccum = 0;
    this._targetId = null;
    this._bossId = null;
    this._hasWorldMap = false;
    this._exploreAccum = 0;
    this._sizeW = 1280;
    this._sizeH = 720;

    // ---- seed the plausible-content model ---------------------------------
    // Present from frame one so the HUD is never empty, replaced the moment a
    // real `loot` / `player` / `world` subsystem publishes anything.
    this.inventory = makeInventory(this.dataRng, 34);
    this.equipment = makeEquipment(this.dataRng);
    this.character = makeCharacter(this.state.level);
    this.panels.setInventory(this.inventory, this.equipment, this.state.gold);
    this.panels.setCharacter(this.character);
    this.panels.setPoints(0);

    this.dungeon = makeDungeonField(this.dataRng.fork());
    this._paintSyntheticMap();

    this.roster.set(this.state.shadows, this.state.shadowsMax);

    // ---- events ------------------------------------------------------------
    this._off = [];
    const on = (type, fn) => this._off.push(ctx.events.on(type, fn));

    on('player:state', (e) => {
      if (e?.position) {
        this._playerPos.copy(e.position);
        if (e.velocity && (e.velocity.x || e.velocity.z)) {
          this._playerFacing = Math.atan2(e.velocity.x, e.velocity.z);
        }
      }
    });

    on('combat:hit', (e) => this._onHit(e));
    on('combat:kill', (e) => this._onKill(e));
    on('combat:miss', (e) => {
      if (e?.position) this.numbers.spawnText(e.position, 'MISS', [0.45, 0.44, 0.42], { size: 17, life: 0.9 });
    });

    on('xp:gain', (e) => {
      if (typeof e?.total === 'number') this.state.xp = e.total;
      else this.state.xp += e?.amount ?? 0;
      if (typeof e?.next === 'number') this.state.xpNext = e.next;
      if (e?.amount) this.feed.push('quest', `+${groupNum(e.amount)}`, 'experience', 0);
    });

    on('level:up', (e) => {
      this.state.level = e?.level ?? this.state.level + 1;
      this.state.points = (this.state.points ?? 0) + (e?.points ?? 5);
      this.state.xp = 0;
      this.character = makeCharacter(this.state.level);
      this.panels.setCharacter(this.character);
      this.panels.setPoints(this.state.points);
      this.fx.levelUp();
      this.system.push(WINDOWS.levelUp(this.state.level, e?.points ?? 5), ctx.time.raw);
      this.feed.push('level', `Level ${this.state.level}`, 'reached', 0);
    });

    on('ui:system', (e) => {
      this.system.push({
        kind: e?.kind ?? 'system',
        title: e?.title ?? 'System',
        lines: e?.lines ?? [],
        duration: e?.duration,
      }, ctx.time.raw);
    });

    on('ui:toast', (e) => this.toasts.push(String(e?.text ?? ''), e?.tone ?? ''));

    on('loot:pickup', (e) => {
      const it = e?.item;
      if (!it) return;
      const col = RARITY[it.rarity]?.srgb ?? RARITY.common.srgb;
      this.feed.push('loot', it.name ?? 'Item', '', 0, col);
      this.toasts.push(it.name ?? 'Item acquired', it.rarity === 'legendary' || it.rarity === 'mythic' ? 'good' : '');
    });

    on('skill:ready', (e) => {
      if (e?.skill) this.bar.setCooldown(e.skill, 0);
    });

    on('player:cast', (e) => {
      const id = e?.skill;
      if (!id) return;
      const cost = this.bar.costOf(id);
      if (cost) this.state.mana = Math.max(0, this.state.mana - cost);
      const def = [...DEFAULT_SKILLS, ...SIGNATURE_SKILLS].find((d) => d.id === id);
      if (def?.cd) this.bar.setCooldown(id, def.cd, def.cd);
    });

    on('shadow:extract', (e) => {
      const name = e?.actor?.name ?? this.dataRng.pick(ENEMY_NAMES);
      this.system.push(WINDOWS.extraction(name, e?.rank ?? 'Knight', 62 + this.dataRng.int(0, 30)), ctx.time.raw);
    });

    on('shadow:arise', (e) => {
      const name = e?.soldier?.name ?? this.dataRng.pick(SHADOW_NAMES);
      const rank = e?.rank ?? this.dataRng.pick(SHADOW_RANKS);
      this.state.shadows = Math.min(this.state.shadowsMax, this.state.shadows + 1);
      this.roster.set(this.state.shadows, this.state.shadowsMax);
      this.fx.arise(name);
      this.system.push(WINDOWS.arisen(name, rank), ctx.time.raw);
      this.feed.push('shadow', name, 'has arisen', 0);
    });

    on('world:ready', (e) => {
      this._hasWorldMap = true;
      this.map.reset();
      if (Array.isArray(e?.rooms)) this.map.setRooms(e.rooms);
      this.map.setLabel(`B${e?.level ?? 1}`, 'The Sunken Nave');
    });

    on('world:room', (e) => {
      if (e?.cleared && e?.room) this.map.markRoomCleared(e.room);
    });

    // ---- initial layout ----------------------------------------------------
    this.resize(ctx.canvas.clientWidth || 1280, ctx.canvas.clientHeight || 720, ctx);
    this.debugState('clean');
  }

  // =========================================================================
  // layout
  // =========================================================================

  resize(w, h, ctx) {
    if (this.disabled) return;
    this._sizeW = w; this._sizeH = h;
    const m = metricsFor(w, h);
    this._u = m.u;
    this.root.style.setProperty('--u', `${m.u.toFixed(4)}px`);

    // The plinth is the only art whose width depends on the viewport, so the
    // whole bake is keyed on (scale bucket, width bucket): re-rasterising a
    // 1280px filigree canvas on every tick of a window drag is a visible hitch,
    // and the engine calls resize() more than once during boot.
    const bucket = Math.ceil(w / 160) * 160;
    const key = `${Math.round(m.u * 200)}|${bucket}`;
    this._syncRenderResolution();
    if (key === this._bakeKey) { this._layoutTop(); return; }
    this._bakeKey = key;

    // A fresh fork per bake so the art is deterministic for a given size and
    // does not depend on how many times resize happened to fire.
    const rng = this.artRng.fork();

    const ph = Math.round(M.plinth * m.u);
    const a = offscreen(bucket, ph);
    bakePlinth(a.c, bucket, ph, m.u, rng.fork(), this.noise);
    setStyle(this.plinth, 'backgroundImage', toUrl(a.cv));

    for (const g of [this.globes.life, this.globes.shadow]) g.bake(m.u, rng.fork(), this.noise);
    this.bar.bake(m.u, rng.fork(), this.noise);
    this.map.bake(m.u, rng.fork(), this.noise);
    this.panels.bake(m.u, rng.fork(), this.noise);

    const frames = bakeBarFrames(m.u, rng.fork(), this.noise);
    this.boss.bake(m.u, frames.boss);
    this.target.bake(m.u, frames.target);

    this._layoutTop();
  }

  /** The target bar sits at the top unless a boss owns that space. */
  _layoutTop() {
    this.target.layout(this.boss.visible ? 96 : 16);
  }

  /**
   * Damage numbers offset in DEVICE pixels of the render target, which is
   * `renderScale` times the CSS size. Feeding the shader the CSS size makes
   * every number the wrong size at any preset below `high`.
   */
  _syncRenderResolution() {
    const r = this.ctx.peek('render');
    const s = r?.screenSize;
    const iw = s?.width || this._sizeW;
    const ih = s?.height || this._sizeH;
    if (iw === this._resW && ih === this._resH) return;
    this._resW = iw; this._resH = ih;
    this._pxRatio = iw / Math.max(1, this._sizeW);
    this.numbers.setResolution(iw, ih);
    this.numbers.setScale(this._u * this._pxRatio);
  }

  // =========================================================================
  // events
  // =========================================================================

  _onHit(e) {
    if (!e) return;
    const pos = e.position;
    const toPlayer = e.target?.isPlayer === true;

    if (toPlayer) {
      const max = e.target?.stats?.hpMax ?? this.state.hpMax;
      this.fx.hit(clamp01((e.amount ?? 0) / Math.max(1, max * 0.25)),
        e.source?.position ? this._hitDir.copy(e.source.position).sub(e.target.position) : null,
        this.ctx.camera);
      if (pos) {
        this.numbers.spawn({
          position: pos, amount: e.amount ?? 0, element: e.element ?? 'physical',
          crit: false, kind: 'player', key: 0,
        });
      }
      return;
    }

    if (pos) {
      this.numbers.spawn({
        position: pos,
        amount: e.amount ?? 0,
        element: e.element ?? 'physical',
        crit: !!e.crit,
        kind: 'damage',
        key: e.target?.id ?? 0,
      });
    }
    if (e.crit) this.feed.push('crit', 'Critical', '', e.amount ?? 0);
    if (e.target) this.noteTarget(e.target);
  }

  _onKill(e) {
    if (!e) return;
    const name = e.actor?.name ?? e.actor?.kind ?? 'Enemy';
    this.feed.push('kill', name, 'slain', e.overkill ?? 0);
    // Let the next thing the player hits claim the bar immediately rather than
    // waiting out the 5 s timeout on a corpse.
    if (e.actor?.id !== undefined && e.actor.id === this._targetId) this._targetId = null;
    if (e.actor?.id !== undefined && e.actor.id === this._bossId) { this._bossId = null; this.boss.hide(); this._layoutTop(); }
  }

  // =========================================================================
  // public API — how `ai`, `combat` and `loot` drive the HUD
  // =========================================================================

  /**
   * Show/refresh the enemy health bar for an ACTOR. Called automatically from
   * every `combat:hit`, so `ai` and `combat` get a working target bar without
   * doing anything at all; call it directly to show a bar for something the
   * player has selected but not yet hit.
   *
   * Duck-typed on purpose — it reads `name`, `stats.{hp,hpMax,level}`, and the
   * optional `rank` / `isBoss` / `title` / `phases` / `phase` / `affixes`, and
   * degrades gracefully when any of them are missing.
   */
  noteTarget(a) {
    if (this.disabled || this._posed || !a || a.isPlayer) return;
    const st = a.stats ?? {};
    const frac = st.hpMax > 0 ? clamp01(st.hp / st.hpMax) : 1;
    const isBoss = a.isBoss === true || a.rank === 'boss';

    if (isBoss) {
      if (this._bossId !== a.id) {
        this._bossId = a.id;
        this.boss.show({
          name: a.name ?? 'Nameless Thing',
          title: a.title,
          phases: a.phases ?? ['I', 'II', 'III'],
          phase: a.phase ?? 0,
          hpFrac: frac,
        });
        this._layoutTop();
      } else {
        this.boss.setFrac(frac);
        if (typeof a.phase === 'number') this.boss.setPhase(a.phase, a.title);
      }
      return;
    }

    if (this._targetId !== a.id) {
      this._targetId = a.id;
      this.target.show({
        name: a.name ?? 'Enemy',
        level: st.level ?? 1,
        rank: a.rank ?? 'normal',
        hpFrac: frac,
        affixes: a.affixes,
      });
    } else {
      this.target.setFrac(frac);
    }
  }

  /** Explicit boss control, for an encounter script that wants to name phases. */
  setBoss(b) {
    if (this.disabled) return;
    if (!b) { this._bossId = null; this.boss.hide(); this._layoutTop(); return; }
    this._bossId = b.id ?? 'boss';
    this.boss.show(b);
    this._layoutTop();
  }

  setBossPhase(i, title) { if (!this.disabled) this.boss.setPhase(i, title); }

  clearTarget() { this._targetId = null; this.target.hide(); }

  /** `list` is `[{ glyph, element, seconds, stacks }]`; the array is not copied. */
  setBuffs(list) { if (!this.disabled) this._buffList = list ?? []; }

  setShadows(count, max) {
    if (this.disabled) return;
    this.state.shadows = count;
    this.state.shadowsMax = max ?? this.state.shadowsMax;
    this.roster.set(this.state.shadows, this.state.shadowsMax);
  }

  /** Convenience wrappers so callers do not have to know the event names. */
  pushSystem(win) { if (!this.disabled) this.system.push(win, this.ctx.time.raw); }
  toast(text, tone) { if (!this.disabled) this.toasts.push(String(text), tone ?? ''); }
  log(kind, name, suffix, value) { if (!this.disabled) this.feed.push(kind, name, suffix, value); }

  /**
   * Pull enemy positions off `ai` for the minimap. Duck-typed and optional: the
   * map is complete without it. Runs at 3 Hz off a preallocated pool, because
   * this is the only place in the subsystem that would otherwise allocate an
   * object per actor per frame.
   */
  _syncBlips(dt) {
    this._blipAccum += dt;
    if (this._blipAccum < 0.33) return;
    this._blipAccum = 0;
    const ai = this.ctx.peek('ai');
    const list = ai?.actors ?? ai?.enemies ?? null;
    if (!Array.isArray(list) || list.length === 0) return;

    this._blips.length = 0;
    for (let i = 0; i < list.length && this._blips.length < this._blipPool.length; i++) {
      const a = list[i];
      if (!a || a.alive === false || !a.position) continue;
      const b = this._blipPool[this._blips.length];
      b.x = a.position.x;
      b.z = a.position.z;
      b.type = a.isShadow ? 'shadow'
        : a.isBoss || a.rank === 'boss' ? 'boss'
          : a.rank === 'elite' || a.rank === 'champion' ? 'elite' : 'enemy';
      this._blips.push(b);
    }
    this.map.setBlips(this._blips);
  }

  // =========================================================================
  // frame
  // =========================================================================

  lateUpdate(dt, ctx) {
    if (this.disabled) return;
    // UI animation reads the UNSCALED delta: hit-stop must freeze the world,
    // not the HUD. A cooldown that stops ticking during a hit-stop is a bug the
    // player would feel as input lag.
    const rdt = ctx.time.rawDt || dt;
    const t = ctx.time.raw;

    this._syncRenderResolution();
    this._pollPlayer(rdt);
    this._runSpawner(rdt);

    // ---- globes ------------------------------------------------------------
    // `impulse: true` is safe every frame: Globe.set only excites the slosh
    // oscillator when the value moved more than 0.2% in one frame, so mana
    // regen ripples nothing and a burst of damage sloshes hard.
    this.globes.life.set(this.state.hp, this.state.hpMax, true);
    this.globes.shadow.set(this.state.mana, this.state.manaMax, true);
    this.globes.life.update(rdt, t);
    this.globes.shadow.update(rdt, t);

    // ---- bars --------------------------------------------------------------
    this.xp.set(this.state.xp, this.state.xpNext, this.state.level);
    this.xp.update(rdt);
    this.boss.update(rdt);
    this.target.update(rdt);

    // ---- action bar --------------------------------------------------------
    this.bar.update(rdt);
    for (const def of DEFAULT_SKILLS) this.bar.setAffordable(def.id, this.state.mana >= def.cost);
    this.buffs.set(this._buffList, this._u);

    // ---- feeds -------------------------------------------------------------
    this.feed.update(rdt);
    this.toasts.update(rdt);
    this.system.update(t);

    // ---- screen fx ---------------------------------------------------------
    if (this._holdArise) this.fx.ariseA = 1;
    this.fx.setHealth(this.state.hp / Math.max(1, this.state.hpMax));
    this.fx.update(rdt, t);

    // ---- world-space -------------------------------------------------------
    this.numbers.update(rdt);
    this.cursor.anchor.copy(this._playerPos);
    this.cursor.update(rdt, ctx, this._sizeW, this._sizeH);

    // ---- minimap -----------------------------------------------------------
    this.map.setPlayer(this._playerPos.x, this._playerPos.z, this._playerFacing);
    if (!this._posed) this._syncBlips(rdt);
    this._exploreAccum += rdt;
    if (this._hasWorldMap && this._exploreAccum > 0.20) {
      this._exploreAccum = 0;
      this.map.markExplored(this._playerPos.x, this._playerPos.z, 10);
    }
    this.map.update(rdt, this._u);

    this._handleInput(ctx);
  }

  /**
   * Adopt whatever the player subsystem publishes; simulate the rest. The HUD
   * must look alive even when the systems that own these numbers do not exist
   * yet — a static bar reads as broken.
   */
  _pollPlayer(dt) {
    const p = this.ctx.peek('player');
    // A posed debug state is authoritative: the shot harness asked for level 15
    // with the health bar at 52%, and letting the live player subsystem write
    // its own values back over that produced a frame whose SYSTEM window said
    // "you have reached Level 15" above an experience bar reading "LEVEL 1".
    if (this._posed) {
      if (p?.position) this._playerPos.copy(p.position);
      return;
    }
    if (p?.stats) {
      if (typeof p.stats.hp === 'number') this.state.hp = p.stats.hp;
      if (typeof p.stats.hpMax === 'number') this.state.hpMax = p.stats.hpMax;
      if (typeof p.stats.level === 'number') this.state.level = p.stats.level;
      const mana = p.resources?.mana ?? p.mana ?? p.stats.mana;
      const manaMax = p.resources?.manaMax ?? p.manaMax ?? p.stats.manaMax;
      if (typeof mana === 'number') this.state.mana = mana;
      if (typeof manaMax === 'number') this.state.manaMax = manaMax;
      else this._regenMana(dt);
    } else {
      this._regenMana(dt);
    }
    if (p?.position) {
      this._playerPos.copy(p.position);
      if (p.velocity && (p.velocity.x || p.velocity.z)) {
        this._playerFacing = Math.atan2(p.velocity.x, p.velocity.z);
      }
    }
  }

  _regenMana(dt) {
    // 4%/s baseline regen. Slow enough that spending matters, fast enough that
    // the orb is visibly moving whenever the player is not casting.
    this.state.mana = Math.min(this.state.manaMax, this.state.mana + this.state.manaMax * 0.04 * dt);
  }

  _handleInput(ctx) {
    const i = ctx.input;
    if (!i || i.frozen) return;
    if (i.pressed('inventory')) this.panels.toggle('inventory');
    if (i.pressed('character')) this.panels.toggle('character');
    if (i.pressed('map')) {
      // Cycle the minimap through three zoom levels rather than opening a
      // second full map: an isometric dungeon crawler is read at one scale.
      this.map.zoom = this.map.zoom > 3.4 ? 1.7 : this.map.zoom > 2.2 ? 3.9 : 2.55;
      this.map._dirty = true;
    }
    if (i.pressed('menu')) this.panels.close();
    this.cursor.enabled = !this.panels.visible;
  }

  // =========================================================================
  // the demo spawner — keeps debug states populated at any settle count
  // =========================================================================

  /**
   * The screenshot harness pumps an arbitrary number of frames after applying a
   * shot, so a burst of damage numbers fired once at `debugState` time would
   * have expired (or not yet punched in) by the shutter. Instead the debug
   * states switch on a deterministic spawner that keeps a staggered population
   * of numbers alive indefinitely, which looks correct on every frame.
   */
  _runSpawner(dt) {
    const s = this._spawner;
    if (!s) return;
    s.t += dt;
    while (s.t > s.interval) {
      s.t -= s.interval;
      const r = this.spawnRng;
      const a = r.float() * Math.PI * 2;
      const rad = r.range(1.1, 5.6);
      this._tmpPos.set(
        this._playerPos.x + Math.cos(a) * rad,
        this._playerPos.y + r.range(0.6, 1.9),
        this._playerPos.z + Math.sin(a) * rad
      );
      const crit = r.float() < 0.22;
      const element = r.pick(s.elements);
      this.numbers.spawn({
        position: this._tmpPos,
        amount: crit ? r.int(9000, 26000) : r.int(340, 3800),
        element, crit, kind: 'damage',
        key: 0,
      });
      if (r.float() < 0.10) {
        this.numbers.spawn({
          position: this._tmpPos, amount: r.int(60, 240),
          element: 'physical', crit: false, kind: 'player', key: 0,
        });
      }
    }
  }

  // =========================================================================
  // debug states (driven by tools/ and src/dev/shots.js)
  // =========================================================================

  /**
   * `'clean' | 'combat' | 'levelup' | 'inventory' | 'arise'`
   *
   * Each state must produce a fully populated, convincing HUD — a critic
   * looking at the PNG cannot tell the difference between "this state is empty"
   * and "this HUD is broken", so none of them are allowed to be empty.
   */
  debugState(name = 'clean') {
    if (this.disabled) return 'disabled';
    const t = this.ctx.time.raw;
    this._resetDebug();
    this.debug = name;
    // 'clean' is also the live-play default, so it must NOT freeze the HUD to
    // fake values; every other state is a pose the harness asked for.
    this._posed = name !== 'clean';
    // A pose is fiction, and "52 / 100" reads as a tutorial character. Lift the
    // maxima to the fallback scale unless the live player subsystem is already
    // publishing something bigger, so posed shots show numbers with the weight
    // a level-14 ARPG character actually has.
    if (this._posed) {
      this.state.hpMax = Math.max(this.state.hpMax, FALLBACK.hpMax);
      this.state.manaMax = Math.max(this.state.manaMax, FALLBACK.manaMax);
    }
    const r = this.dataRng;

    switch (name) {
      // ---------------------------------------------------------------------
      case 'combat': {
        this.state.hp = Math.round(this.state.hpMax * 0.52);
        this.state.mana = Math.round(this.state.manaMax * 0.38);
        this.state.xp = this.state.xpNext * 0.71;

        this.bar.setCooldown('skill2', 3.6, 6.0);
        this.bar.setCharges('skill2', 1);
        this.bar.setCooldown('skill4', 9.1, 14.0);
        this.bar.setCooldown('skillQ', 1.2, 11.0);
        this.bar.setCooldown('ultimate', 41.0, 60.0);
        this.bar.setCooldown('arise', 8.4, 24.0);

        this._buffList = [
          { glyph: 'crown', element: 'shadow', seconds: 12.4, stacks: 1 },
          { glyph: 'dash', element: 'shadow', seconds: 4.2, stacks: 3 },
          { glyph: 'nova', element: 'fire', seconds: 7.8, stacks: 1 },
          { glyph: 'ward', element: 'holy', seconds: 2.1, stacks: 1 },
        ];

        const boss = BOSSES[0];
        this.boss.show({ name: boss.name, title: boss.title, phases: boss.phases, phase: 1, hpFrac: 0.44 });
        this.target.show({
          name: 'Fell Revenant', level: 16, rank: 'elite', hpFrac: 0.34, sticky: true,
          affixes: [ELITE_AFFIXES[0], ELITE_AFFIXES[3]],
        });
        this._layoutTop();

        seedFeed(this.feed, r.fork());
        this.state.shadows = 7;
        this.roster.set(this.state.shadows, this.state.shadowsMax);

        this.fx.dmg = 0.38;
        this.fx.dirX = -0.7; this.fx.dirY = 0.4; this.fx.dirA = 0.5;

        // 0.16 s between hits is roughly a real 6-attacks-per-second flurry
        // once merging is accounted for. The first pass ran at 0.075 s and put
        // 24 numbers on screen at once, which is illegible rather than
        // exciting — an ARPG frame should read as a handful of BIG numbers.
        this._spawner = { t: 0, interval: 0.16, elements: ['shadow', 'shadow', 'physical', 'fire', 'frost', 'lightning'] };
        // Prime it so the very first captured frame already has a full arc of
        // numbers at different ages rather than a single fresh one.
        for (let i = 0; i < 9; i++) this._runSpawner(0.115);
        break;
      }

      // ---------------------------------------------------------------------
      case 'levelup': {
        this.state.level = 15;
        this.state.hp = Math.round(this.state.hpMax * 0.86);
        this.state.mana = Math.round(this.state.manaMax * 0.58);
        this.state.xp = this.state.xpNext * 0.04;
        this.state.points = 5;
        this.character = makeCharacter(this.state.level);
        this.panels.setCharacter(this.character);
        this.panels.setPoints(5);

        this.bar.setCooldown('skill4', 4.2, 14.0);
        this.bar.setCooldown('ultimate', 12.0, 60.0);
        this._buffList = [
          { glyph: 'crown', element: 'shadow', seconds: 18.0, stacks: 1 },
          { glyph: 'ward', element: 'holy', seconds: 6.4, stacks: 1 },
        ];

        this.system.pose(WINDOWS.levelUp(15, 5), t, 1.0);
        this.system.pose(WINDOWS.skillUnlock('Rending Dark', 'Rank 3'), t, 0.74);

        this.feed.push('level', 'Level 15', 'reached', 0);
        seedFeed(this.feed, r.fork());
        this.state.shadows = 6;
        this.roster.set(this.state.shadows, this.state.shadowsMax);
        break;
      }

      // ---------------------------------------------------------------------
      case 'inventory': {
        this.state.hp = Math.round(this.state.hpMax * 0.74);
        this.state.mana = Math.round(this.state.manaMax * 0.62);
        this.state.xp = this.state.xpNext * 0.41;
        this.panels.open('inventory');
        // The mythic sits in the second row / second column, which puts the
        // tooltip fully inside the panel; pinning a right-hand cell would hang
        // it off the frame.
        this.panels.pinTip(21);
        this.bar.setCooldown('skill3', 2.4, 9.0);
        this.state.shadows = 5;
        this.roster.set(this.state.shadows, this.state.shadowsMax);
        this.cursor.enabled = false;
        break;
      }

      // ---------------------------------------------------------------------
      case 'arise': {
        this.state.hp = Math.round(this.state.hpMax * 0.66);
        this.state.mana = Math.round(this.state.manaMax * 0.21);
        this.state.xp = this.state.xpNext * 0.83;

        this.bar.setCooldown('arise', 23.6, 24.0);
        this.bar.setCooldown('skillQ', 6.2, 11.0);
        this._buffList = [
          { glyph: 'crown', element: 'shadow', seconds: 22.0, stacks: 1 },
          { glyph: 'siphon', element: 'shadow', seconds: 9.6, stacks: 2 },
        ];

        this._holdArise = true;
        this.fx.poseBanner('Arise', 'Igris answers the Monarch', 'violet');
        this.system.pose(WINDOWS.arisen('Igris', 'Knight'), t, 0.95);

        this.state.shadows = 8;
        this.roster.set(this.state.shadows, this.state.shadowsMax);
        this.feed.push('shadow', 'Igris', 'has arisen', 0);
        this.feed.push('kill', 'Fell Revenant', 'slain', 5140);
        break;
      }

      // ---------------------------------------------------------------------
      case 'clean':
      default: {
        this.state.hp = this.state.hpMax;
        this.state.mana = Math.round(this.state.manaMax * 0.78);
        this.state.xp = this.state.xpNext * 0.62;
        this.state.shadows = 4;
        this.roster.set(this.state.shadows, this.state.shadowsMax);
        break;
      }
    }

    // Snap the animated readouts to the posed values so the very first frame
    // after a shot is applied is already correct, instead of easing into it.
    this.globes.life.set(this.state.hp, this.state.hpMax, false);
    this.globes.shadow.set(this.state.mana, this.state.manaMax, false);
    this.globes.life.level = this.globes.life.value;
    this.globes.shadow.level = this.globes.shadow.value;
    this.xp.set(this.state.xp, this.state.xpNext, this.state.level);
    this.xp.shown = this.xp.value;
    this._layoutTop();
    return name;
  }

  _resetDebug() {
    this._posed = false;
    this._targetId = null;
    this._bossId = null;
    this._spawner = null;
    this._holdArise = false;
    this._buffList = [];
    this.numbers.clear();
    this.system.clear();
    this.feed.clear();
    this.toasts.clear();
    this.buffs.clear();
    this.bar.reset();
    this.boss.hide();
    this.target.hide();
    this.panels.close();
    this.fx.reset();
    this.cursor.enabled = true;
    this.state.hp = this.state.hpMax;
    this.state.level = FALLBACK.level;
    this.state.points = 0;
  }

  /** Deterministic synthetic map, so the minimap is never an empty circle in a
   *  screenshot. Replaced the instant `world:ready` arrives. */
  _paintSyntheticMap() {
    const d = this.dungeon;
    this.map.paintCells((x, z) => d.field(x, z));
    this.map.setRooms(d.rooms);
    this._blips = makeBlips(this.dataRng.fork(), d.rooms, 16);
    this.map.setBlips(this._blips);
    this.map.setLabel('B3', 'The Sunken Nave');
  }

  // =========================================================================
  // pre-warm + introspection
  // =========================================================================

  /**
   * The two uiScene materials are drawn into the HDR target after the lit pass,
   * so they must be compiled with that target bound — `outputColorSpace` and
   * `toneMapping` are read off the currently bound target and are part of the
   * program cache key.
   */
  async prewarmMaterials(ctx) {
    if (this.disabled) return;
    const r = ctx.peek('render');
    const renderer = r?.renderer;
    if (!renderer) return;
    const prev = renderer.getRenderTarget();
    if (r.rtHDR) renderer.setRenderTarget(r.rtHDR);
    try {
      await renderer.compileAsync(ctx.uiScene, ctx.uiCamera);
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  stats() {
    if (this.disabled) return { state: 'disabled' };
    return {
      state: this.debug,
      u: +this._u.toFixed(3),
      numbers: this.numbers.liveCount,
      systemWindows: this.system.live.length,
      panel: this.panels.page,
      hp: `${Math.round(this.state.hp)}/${this.state.hpMax}`,
      mana: `${Math.round(this.state.mana)}/${this.state.manaMax}`,
      level: this.state.level,
      shadows: `${this.state.shadows}/${this.state.shadowsMax}`,
      res: `${this._resW}x${this._resH}`,
    };
  }

  dispose() {
    if (this.disabled) return;
    for (const off of this._off) off();
    this._off.length = 0;
    this.numbers.dispose();
    this.cursor.dispose();
    this.panels.dispose();
    this.system.dispose();
    this.map.dispose();
    this.feed.dispose();
    this.toasts.dispose();
    this.roster.dispose();
    this.boss.dispose();
    this.target.dispose();
    this.xp.dispose();
    this.bar.dispose();
    this.buffs.dispose();
    this.globes.life.dispose();
    this.globes.shadow.dispose();
    this.fx.dispose();
    this.root.remove();
    this.styleEl.remove();
  }
}
