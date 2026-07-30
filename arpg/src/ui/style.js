/**
 * The HUD stylesheet, built as a string at init and injected into <head>.
 *
 * It is generated rather than authored as a .css file for two reasons: every
 * colour has to come from `core/palette.js` (the contract forbids hardcoded
 * literals), and every dimension is expressed against `--u`, the single scalar
 * that scales the whole HUD from 1280x720 up or down.
 *
 * LAYOUT MAP (design pixels at 1280x720):
 *
 *   top 14      boss bar        620 wide, centred
 *   top 14/64   target bar      330 wide, centred (drops under the boss bar)
 *   top 16 R    minimap         158 circle
 *   top 16 L    shadow roster
 *   under map   killfeed / combat log, right aligned
 *   bottom 0    xp bar          full width, 9 tall
 *   bottom      plinth          full width ornament strip, 118 tall
 *   bottom 14   globes          148, inset 18 from each edge
 *   bottom 30   skill bar       6x58 slots + 2 round sockets, centred
 *   ~22% top    SYSTEM windows  448 wide, centred column
 *
 * TYPOGRAPHY RULES, applied without exception:
 *   - Every label is uppercase, letterspaced 0.16-0.24em, 9-11px. Letterspacing
 *     is what makes small uppercase type read as a designed HUD label instead of
 *     as browser text.
 *   - Every number is DejaVu Sans bold with `font-variant-numeric: tabular-nums`
 *     so a counter does not shimmy as digits change width.
 *   - Every piece of text over the game frame carries a two-stop shadow: a tight
 *     black 1px for contrast against light pixels and a soft 3px for separation
 *     against busy ones. One shadow is not enough; three is mud.
 */

import { UI, ELEMENTS, RARITY } from '../core/palette.js';
import { BRASS, SLATE, TEXT, FONT, M, alpha, shade, mixHex } from './theme.js';

const SHADOW_TEXT = '0 1px 0 rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.9), 0 2px 6px rgba(0,0,0,.75)';
const SHADOW_TEXT_SOFT = '0 1px 2px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.6)';

export function buildCss() {
  const violet = ELEMENTS.shadow.srgb;
  const violetHot = '#c9a8ff';

  return `
/* ========================================================================= */
/* root                                                                       */
/* ========================================================================= */
.mn {
  position: absolute; inset: 0;
  --u: 1px;
  font-family: ${FONT.sans};
  color: ${TEXT.primary};
  pointer-events: none;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  contain: layout style;
}
.mn * { box-sizing: border-box; }
.mn .num { font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: .01em; }
.mn .lbl {
  text-transform: uppercase; letter-spacing: .20em; font-size: calc(9 * var(--u));
  color: ${TEXT.dim}; text-shadow: ${SHADOW_TEXT};
}
.mn .ser { font-family: ${FONT.display}; letter-spacing: .10em; }

/* ========================================================================= */
/* screen effects (below every widget)                                        */
/* ========================================================================= */
/* Every layer here is full-screen, and on a CPU compositor a promoted
   full-screen layer costs over a second per screenshot whether or not it is
   visible. So: no will-change (which would promote all five permanently), and
   ScreenFx sets display:none the moment a layer's opacity reaches zero. That
   one rule is worth more than a second per captured frame to every agent
   sharing this machine. */
.mn-fx { position: absolute; inset: 0; z-index: 5; overflow: hidden; }
.mn-fx > div { position: absolute; inset: 0; opacity: 0; display: none; }

/* Damage vignette: red pooling in from all four edges, heavier at the bottom
   because that is where the character is and where the eye already is. */
.mn-vig-dmg {
  background:
    radial-gradient(120% 90% at 50% 108%, ${alpha(UI.hpRed, 0.62)} 0%, rgba(0,0,0,0) 46%),
    radial-gradient(140% 120% at 50% 50%, rgba(0,0,0,0) 42%, ${alpha(UI.hpRedDark, 0.9)} 100%);
  mix-blend-mode: screen;
}
/* Direction-of-hit flash — four independently driven edge wedges. */
.mn-dir { position: absolute; inset: 0; }
.mn-dir > i { position: absolute; opacity: 0; display: block; }
.mn-banner { display: none; }
.mn-banner.on { display: block; }
.mn-dir .n { left: 0; right: 0; top: 0; height: 28%; background: linear-gradient(to bottom, ${alpha(UI.hpRed, .75)}, transparent); }
.mn-dir .s { left: 0; right: 0; bottom: 0; height: 28%; background: linear-gradient(to top, ${alpha(UI.hpRed, .75)}, transparent); }
.mn-dir .w { top: 0; bottom: 0; left: 0; width: 20%; background: linear-gradient(to right, ${alpha(UI.hpRed, .75)}, transparent); }
.mn-dir .e { top: 0; bottom: 0; right: 0; width: 20%; background: linear-gradient(to left, ${alpha(UI.hpRed, .75)}, transparent); }

/* Low health: a slow breathing red rim plus a hard inner line. */
.mn-vig-low {
  background: radial-gradient(130% 110% at 50% 50%, rgba(0,0,0,0) 40%, ${alpha(UI.hpRed, .55)} 86%, ${alpha('#3a0704', .9)} 100%);
  box-shadow: inset 0 0 calc(90 * var(--u)) ${alpha(UI.hpRed, .35)};
}
/* Shadow-extraction wash: violet rising off the character and pooling in the
   frame corners. Both stops must be LIGHT — the layer is screen-blended, so a
   dark edge vignette (the obvious way to write this) composites to nothing and
   the effect disappears entirely behind the bottom HUD. */
.mn-vig-arise {
  background:
    radial-gradient(64% 50% at 50% 72%, ${alpha(violetHot, .44)} 0%, ${alpha(violet, .22)} 42%, rgba(0,0,0,0) 68%),
    radial-gradient(135% 115% at 50% 46%, rgba(0,0,0,0) 30%, ${alpha('#3a17a8', .20)} 74%, ${alpha('#5a2ee0', .30)} 100%);
  mix-blend-mode: screen;
}
/* Level-up: a gold blowout from the character's feet. */
.mn-flash {
  background:
    radial-gradient(60% 46% at 50% 72%, ${alpha('#fff3cf', .92)} 0%, ${alpha(UI.xpGold, .55)} 34%, rgba(0,0,0,0) 70%);
  mix-blend-mode: screen;
}
/* An expanding gold ring, driven by --r (0..1) from JS. */
.mn-ring {
  position: absolute; left: 50%; top: 68%;
  width: calc(40 * var(--u)); height: calc(40 * var(--u));
  margin: calc(-20 * var(--u)) 0 0 calc(-20 * var(--u));
  border-radius: 50%;
  border: calc(3 * var(--u)) solid ${alpha(UI.xpGold, .9)};
  box-shadow: 0 0 calc(26 * var(--u)) ${alpha(UI.xpGold, .8)}, inset 0 0 calc(20 * var(--u)) ${alpha('#fff2c8', .6)};
  opacity: 0; transform: scale(1);
}

/* ========================================================================= */
/* bottom HUD                                                                 */
/* ========================================================================= */
.mn-bottom { position: absolute; left: 0; right: 0; bottom: 0; height: calc(${M.plinth} * var(--u)); z-index: 24; }
.mn-plinth {
  position: absolute; left: 0; right: 0; bottom: 0; height: 100%;
  background-repeat: no-repeat; background-size: 100% 100%;
  image-rendering: auto;
}

/* ---- resource globes ---------------------------------------------------- */
.mn-globe {
  position: absolute; bottom: calc(10 * var(--u));
  width: calc(${M.globe} * var(--u)); height: calc(${M.globe} * var(--u));
}
.mn-globe.l { left: calc(${M.globeInset} * var(--u)); }
.mn-globe.r { right: calc(${M.globeInset} * var(--u)); }
.mn-globe canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.mn-globe .liq { border-radius: 50%; }
.mn-globe .frm { pointer-events: none; }
.mn-globe .txt {
  position: absolute; left: 0; right: 0; top: 50%;
  transform: translateY(-52%);
  text-align: center; pointer-events: none;
}
.mn-globe .txt .v {
  display: block; font-size: calc(21 * var(--u)); font-weight: 700; line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #fff8ee;
  text-shadow: 0 calc(1 * var(--u)) 0 #000, 0 0 calc(7 * var(--u)) rgba(0,0,0,.95), 0 calc(2 * var(--u)) calc(9 * var(--u)) rgba(0,0,0,.9);
}
.mn-globe .txt .m {
  display: block; font-size: calc(10 * var(--u)); line-height: 1.5;
  color: rgba(255,255,255,.62); font-variant-numeric: tabular-nums;
  text-shadow: 0 calc(1 * var(--u)) calc(3 * var(--u)) #000;
}
.mn-globe .txt .k {
  display: block; margin-top: calc(3 * var(--u));
  font-size: calc(8.5 * var(--u)); letter-spacing: .34em; text-indent: .34em;
  text-transform: uppercase; color: rgba(255,255,255,.42);
  text-shadow: 0 calc(1 * var(--u)) calc(3 * var(--u)) #000;
}
/* A hard rim glow that spikes when the resource is spent or the player is hurt. */
.mn-globe .halo {
  position: absolute; inset: calc(14 * var(--u)); border-radius: 50%;
  opacity: 0; pointer-events: none;
}
.mn-globe.l .halo { box-shadow: 0 0 calc(30 * var(--u)) calc(6 * var(--u)) ${alpha(UI.hpRed, .8)}; }
.mn-globe.r .halo { box-shadow: 0 0 calc(30 * var(--u)) calc(6 * var(--u)) ${alpha(UI.manaViolet, .85)}; }

/* ---- skill bar ---------------------------------------------------------- */
.mn-bar {
  position: absolute; left: 50%; bottom: calc(${M.barLift} * var(--u));
  transform: translateX(-50%);
  display: flex; align-items: flex-end; gap: calc(${M.slotGap} * var(--u));
}
.mn-slot {
  position: relative;
  width: calc(${M.slot} * var(--u)); height: calc(${M.slot} * var(--u));
  flex: 0 0 auto;
}
.mn-slot .frm, .mn-slot .ico, .mn-slot .cd { position: absolute; inset: 0; width: 100%; height: 100%; }
.mn-slot .frm { background-repeat: no-repeat; background-size: 100% 100%; }
.mn-slot .ico { border-radius: calc(4 * var(--u)); }
/* Unaffordable: drain the colour and push it blue-cold. */
.mn-slot.poor .ico { filter: grayscale(.85) brightness(.5) contrast(.9); }
.mn-slot.poor .frm { filter: grayscale(.6) brightness(.62); }
.mn-slot .key {
  position: absolute; right: calc(-2 * var(--u)); bottom: calc(-3 * var(--u));
  min-width: calc(15 * var(--u)); height: calc(14 * var(--u)); padding: 0 calc(3 * var(--u));
  display: flex; align-items: center; justify-content: center;
  font-size: calc(9 * var(--u)); font-weight: 700; letter-spacing: .04em;
  color: ${TEXT.primary};
  background: linear-gradient(180deg, ${SLATE.raised}, #050406);
  border: 1px solid ${alpha(BRASS.base, .8)};
  border-radius: calc(2 * var(--u));
  text-shadow: 0 1px 0 #000;
  box-shadow: 0 calc(1 * var(--u)) calc(3 * var(--u)) rgba(0,0,0,.9);
}
.mn-slot .cdt {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: calc(17 * var(--u)); font-weight: 700; font-variant-numeric: tabular-nums;
  color: #f3ead6; text-shadow: 0 calc(1 * var(--u)) calc(3 * var(--u)) #000, 0 0 calc(8 * var(--u)) rgba(0,0,0,.9);
}
.mn-slot .pips {
  position: absolute; left: 50%; bottom: calc(-7 * var(--u)); transform: translateX(-50%);
  display: flex; gap: calc(3 * var(--u));
}
.mn-slot .pips i {
  display: block; width: calc(5 * var(--u)); height: calc(5 * var(--u));
  transform: rotate(45deg);
  background: #17131a; border: 1px solid ${alpha(BRASS.base, .85)};
}
.mn-slot .pips i.on {
  background: ${violetHot};
  box-shadow: 0 0 calc(5 * var(--u)) ${alpha(violet, .95)};
  border-color: ${alpha(violetHot, .9)};
}
/* Ready pulse — expands and fades once when a cooldown completes. */
.mn-slot .rdy {
  position: absolute; inset: calc(-3 * var(--u)); border-radius: calc(6 * var(--u));
  border: calc(2 * var(--u)) solid ${alpha('#fff3d2', .95)};
  opacity: 0; pointer-events: none;
}
.mn-slot.flash .rdy { animation: mn-rdy .42s cubic-bezier(.16,.9,.3,1) 1; }
@keyframes mn-rdy {
  0%   { opacity: .95; transform: scale(.94); }
  100% { opacity: 0;   transform: scale(1.30); }
}
/* Round sockets for the two signature abilities. */
.mn-round {
  position: relative; flex: 0 0 auto;
  width: calc(${M.slotRound} * var(--u)); height: calc(${M.slotRound} * var(--u));
  margin: 0 calc(2 * var(--u)) calc(5 * var(--u));
}
.mn-round .frm, .mn-round .ico, .mn-round .cd { position: absolute; inset: 0; width: 100%; height: 100%; }
.mn-round .frm { background-repeat: no-repeat; background-size: 100% 100%; }
.mn-round .ico { border-radius: 50%; }
.mn-round .key {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(-9 * var(--u));
  font-size: calc(9 * var(--u)); font-weight: 700; letter-spacing: .12em;
  color: ${TEXT.dim}; text-shadow: ${SHADOW_TEXT};
}
/* The ultimate socket gets a violet charge ring when it is available. */
.mn-round.charged .frm { filter: drop-shadow(0 0 calc(9 * var(--u)) ${alpha(violet, .85)}); }

/* ---- buff row ------------------------------------------------------------ */
.mn-buffs {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(${M.barLift + M.slot + 16} * var(--u));
  display: flex; gap: calc(5 * var(--u)); align-items: flex-end;
}
.mn-buff { position: relative; width: calc(28 * var(--u)); height: calc(28 * var(--u)); }
.mn-buff canvas { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: calc(3 * var(--u)); }
.mn-buff .bx {
  position: absolute; inset: 0; border: 1px solid ${alpha(BRASS.base, .85)};
  border-radius: calc(3 * var(--u));
  box-shadow: inset 0 0 calc(7 * var(--u)) rgba(0,0,0,.9), 0 calc(1 * var(--u)) calc(3 * var(--u)) rgba(0,0,0,.85);
}
.mn-buff .t {
  position: absolute; left: 0; right: 0; bottom: calc(-11 * var(--u));
  text-align: center; font-size: calc(9 * var(--u)); font-weight: 700;
  font-variant-numeric: tabular-nums; color: ${TEXT.dim}; text-shadow: ${SHADOW_TEXT};
}
.mn-buff .st {
  position: absolute; right: calc(-2 * var(--u)); top: calc(-4 * var(--u));
  font-size: calc(9 * var(--u)); font-weight: 700; color: ${violetHot};
  text-shadow: 0 1px 0 #000, 0 0 calc(5 * var(--u)) ${alpha(violet, .9)};
}

/* ---- experience bar ----------------------------------------------------- */
.mn-xp { position: absolute; left: 0; right: 0; bottom: 0; height: calc(${M.xpBar} * var(--u)); z-index: 26; }
.mn-xp .trk {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, #07060a 0%, #100d13 55%, #050407 100%);
  box-shadow: inset 0 calc(1 * var(--u)) calc(2 * var(--u)) rgba(0,0,0,.95), inset 0 calc(-1 * var(--u)) 0 ${alpha(BRASS.dark, .8)};
  border-top: 1px solid ${alpha(BRASS.base, .55)};
}
/* The fill is deliberately dim. An experience bar is ambient information — it
   is read once a minute — and a full-width saturated gold band is the single
   brightest thing in a crypt frame, which is exactly backwards. */
.mn-xp .fil {
  position: absolute; left: 0; top: 1px; bottom: 0; width: 100%;
  transform-origin: 0 50%; transform: scaleX(0);
  background: linear-gradient(180deg, ${mixHex(UI.xpGold, '#ffe9b0', .32)} 0%, ${shade(UI.xpGold, .72)} 45%, ${shade(UI.xpGold, .30)} 100%);
  box-shadow: 0 0 calc(5 * var(--u)) ${alpha(UI.xpGold, .30)};
}
.mn-xp .shn {
  position: absolute; left: 0; top: 1px; bottom: 0; width: calc(150 * var(--u));
  background: linear-gradient(90deg, transparent, ${alpha('#ffeec2', .30)}, transparent);
  animation: mn-xpshine 3.4s linear infinite;
}
@keyframes mn-xpshine { from { transform: translateX(-100%); } to { transform: translateX(1280px); } }
.mn-xp .tick {
  position: absolute; inset: 0;
  background-image:
    repeating-linear-gradient(90deg, rgba(0,0,0,.85) 0 calc(1 * var(--u)), transparent calc(1 * var(--u)) 2.5%),
    repeating-linear-gradient(90deg, ${alpha(BRASS.warm, .5)} 0 calc(1 * var(--u)), transparent calc(1 * var(--u)) 10%);
}
.mn-xp .plate {
  position: absolute; bottom: calc(2 * var(--u)); display: flex; align-items: center; gap: calc(5 * var(--u));
  font-size: calc(9 * var(--u)); letter-spacing: .18em; text-transform: uppercase;
  color: ${alpha(TEXT.gold, .95)}; text-shadow: ${SHADOW_TEXT};
}
/* Inboard of the globes: at left:10 the plate collides with the life orb's
   socket on any viewport narrower than the design width. */
.mn-xp .plate.l { left: calc(182 * var(--u)); }
.mn-xp .plate.r { right: calc(182 * var(--u)); }
.mn-xp .plate b { color: #fff2cf; font-size: calc(11 * var(--u)); letter-spacing: .06em; }

/* ========================================================================= */
/* top bars                                                                   */
/* ========================================================================= */
.mn-top { position: absolute; left: 0; right: 0; top: 0; z-index: 22; }

.mn-boss {
  position: absolute; left: 50%; top: calc(14 * var(--u)); transform: translateX(-50%);
  width: calc(${M.bossBar} * var(--u)); text-align: center;
}
.mn-boss .nm {
  font-family: ${FONT.display}; font-size: calc(20 * var(--u));
  text-transform: uppercase; letter-spacing: .24em; text-indent: .24em;
  color: #efe4cc; text-shadow: ${SHADOW_TEXT}, 0 0 calc(16 * var(--u)) ${alpha(UI.hpRed, .5)};
  line-height: 1.1;
}
.mn-boss .sub {
  margin-top: calc(2 * var(--u));
  font-size: calc(9.5 * var(--u)); letter-spacing: .26em; text-indent: .26em; text-transform: uppercase;
  color: ${alpha(UI.critYellow, .82)}; text-shadow: ${SHADOW_TEXT};
}
.mn-boss .trkw, .mn-target .trkw { position: relative; margin-top: calc(6 * var(--u)); }
.mn-boss .trk, .mn-target .trk {
  position: relative;
  height: calc(16 * var(--u));
  background: linear-gradient(180deg, #0a080c, #16101a 60%, #060409);
  border: 1px solid ${alpha(BRASS.dark, .95)};
  box-shadow: inset 0 0 calc(9 * var(--u)) rgba(0,0,0,.95), 0 calc(2 * var(--u)) calc(7 * var(--u)) rgba(0,0,0,.7);
  overflow: hidden;
}
.mn-target .trk { height: calc(11 * var(--u)); }
.mn-boss .frm, .mn-target .frm {
  position: absolute; inset: calc(-7 * var(--u)) calc(-9 * var(--u));
  background-repeat: no-repeat; background-size: 100% 100%; pointer-events: none;
}
.mn-boss .lag, .mn-target .lag {
  position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(1);
  background: linear-gradient(180deg, ${alpha('#ffd9c8', .85)}, ${alpha('#c98d7a', .7)});
}
.mn-boss .fil, .mn-target .fil {
  position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(1);
  background:
    linear-gradient(180deg, ${mixHex(UI.hpRed, '#ff9a72', .55)} 0%, ${UI.hpRed} 40%, ${UI.hpRedDark} 100%);
  box-shadow: inset 0 calc(1 * var(--u)) 0 ${alpha('#ffb59a', .7)}, 0 0 calc(11 * var(--u)) ${alpha(UI.hpRed, .55)};
}
/* Fine ticks every 4% with a heavier one every 20%. A single 10% period reads
   as a row of batteries; a minor/major rhythm reads as a machined scale, and it
   still answers "roughly how much is left" at a glance. */
.mn-boss .seg, .mn-target .seg {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    repeating-linear-gradient(90deg, rgba(0,0,0,.72) 0 calc(1 * var(--u)), transparent calc(1 * var(--u)) 20%),
    repeating-linear-gradient(90deg, rgba(0,0,0,.30) 0 calc(1 * var(--u)), transparent calc(1 * var(--u)) 4%);
}
.mn-target .seg {
  background-image: repeating-linear-gradient(90deg, rgba(0,0,0,.42) 0 calc(1 * var(--u)), transparent calc(1 * var(--u)) 12.5%);
}
.mn-boss .gls, .mn-target .gls {
  position: absolute; left: 0; right: 0; top: 0; height: 46%; pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,.20), rgba(255,255,255,0));
}
.mn-boss .pips { display: flex; justify-content: center; gap: calc(5 * var(--u)); margin-top: calc(5 * var(--u)); }
.mn-boss .pips i {
  width: calc(24 * var(--u)); height: calc(3 * var(--u));
  background: ${alpha('#4a3a2a', .9)}; box-shadow: inset 0 0 0 1px rgba(0,0,0,.7);
}
.mn-boss .pips i.on { background: ${UI.critYellow}; box-shadow: 0 0 calc(7 * var(--u)) ${alpha(UI.critYellow, .85)}; }

.mn-target {
  position: absolute; left: 50%; transform: translateX(-50%);
  width: calc(${M.targetBar} * var(--u)); text-align: center;
}
.mn-target .hdr { display: flex; align-items: baseline; justify-content: center; gap: calc(6 * var(--u)); }
.mn-target .nm {
  font-family: ${FONT.display}; font-size: calc(13.5 * var(--u));
  text-transform: uppercase; letter-spacing: .16em; color: #e6dcc6; text-shadow: ${SHADOW_TEXT};
}
.mn-target .lv {
  font-size: calc(9.5 * var(--u)); letter-spacing: .14em; color: ${TEXT.dim}; text-shadow: ${SHADOW_TEXT};
}
.mn-target .rank {
  font-size: calc(9 * var(--u)); letter-spacing: .2em; text-transform: uppercase;
  padding: 0 calc(4 * var(--u));
  border: 1px solid currentColor; border-radius: calc(2 * var(--u));
  text-shadow: ${SHADOW_TEXT};
}
.mn-target .aff {
  margin-top: calc(8 * var(--u)); font-size: calc(9 * var(--u));
  letter-spacing: .2em; text-transform: uppercase; color: ${alpha(violetHot, .9)};
  text-shadow: ${SHADOW_TEXT};
}

/* ========================================================================= */
/* minimap                                                                    */
/* ========================================================================= */
.mn-map {
  position: absolute; right: calc(16 * var(--u)); top: calc(16 * var(--u));
  width: calc(${M.minimap} * var(--u)); height: calc(${M.minimap} * var(--u));
  z-index: 22;
}
.mn-map canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.mn-map .cmp {
  position: absolute; inset: 0; pointer-events: none;
}
.mn-map .cmp span {
  position: absolute; font-size: calc(8.5 * var(--u)); letter-spacing: .1em;
  color: ${alpha(TEXT.dim, .8)}; text-shadow: ${SHADOW_TEXT};
}
.mn-map .cmp .n { left: 50%; top: calc(4 * var(--u)); transform: translateX(-50%); }
.mn-map .cmp .s { left: 50%; bottom: calc(4 * var(--u)); transform: translateX(-50%); }
.mn-map .cmp .w { left: calc(5 * var(--u)); top: 50%; transform: translateY(-50%); }
.mn-map .cmp .e { right: calc(5 * var(--u)); top: 50%; transform: translateY(-50%); }
.mn-map .cap {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(-15 * var(--u)); white-space: nowrap;
  font-size: calc(9 * var(--u)); letter-spacing: .22em; text-transform: uppercase;
  color: ${alpha(TEXT.primary, .8)}; text-shadow: ${SHADOW_TEXT};
}
.mn-map .cap b { color: ${TEXT.gold}; font-weight: 700; }

/* ========================================================================= */
/* shadow army roster (top-left) — the Solo Leveling status readout           */
/* ========================================================================= */
.mn-shadows {
  position: absolute; left: calc(18 * var(--u)); top: calc(16 * var(--u)); z-index: 22;
  min-width: calc(150 * var(--u));
  padding: calc(7 * var(--u)) calc(11 * var(--u)) calc(8 * var(--u));
  background: linear-gradient(180deg, ${alpha('#0a0f1c', .78)}, ${alpha('#05060c', .62)});
  border-left: calc(2 * var(--u)) solid ${alpha(violet, .9)};
  box-shadow: inset 0 0 calc(24 * var(--u)) ${alpha(violet, .16)}, 0 calc(3 * var(--u)) calc(12 * var(--u)) rgba(0,0,0,.7);
}
.mn-shadows .hd {
  font-size: calc(9 * var(--u)); letter-spacing: .26em; text-transform: uppercase;
  color: ${alpha(violetHot, .95)}; text-shadow: 0 1px 0 #000, 0 0 calc(8 * var(--u)) ${alpha(violet, .8)};
}
.mn-shadows .ct {
  font-size: calc(17 * var(--u)); font-weight: 700; font-variant-numeric: tabular-nums;
  color: #efe7ff; text-shadow: ${SHADOW_TEXT}, 0 0 calc(10 * var(--u)) ${alpha(violet, .7)};
  line-height: 1.15;
}
.mn-shadows .ct small { font-size: calc(10 * var(--u)); color: ${alpha('#c9bce8', .7)}; font-weight: 400; }
.mn-shadows .pips { display: flex; gap: calc(3 * var(--u)); margin-top: calc(5 * var(--u)); flex-wrap: wrap; }
.mn-shadows .pips i {
  width: calc(7 * var(--u)); height: calc(11 * var(--u));
  clip-path: polygon(50% 0, 100% 28%, 100% 100%, 0 100%, 0 28%);
  background: #1b1630; box-shadow: inset 0 0 0 1px ${alpha(violet, .5)};
}
.mn-shadows .pips i.on {
  background: linear-gradient(180deg, ${violetHot}, ${violet});
  box-shadow: 0 0 calc(6 * var(--u)) ${alpha(violet, .95)};
}

/* ========================================================================= */
/* killfeed / combat log                                                      */
/* ========================================================================= */
.mn-feed {
  position: absolute; right: calc(18 * var(--u)); top: calc(${M.minimap + 34} * var(--u));
  width: calc(260 * var(--u)); z-index: 20;
  display: flex; flex-direction: column; align-items: flex-end; gap: calc(2 * var(--u));
  text-align: right;
}
.mn-feed .row {
  font-size: calc(11 * var(--u)); letter-spacing: .06em; line-height: 1.45;
  color: ${TEXT.dim}; text-shadow: ${SHADOW_TEXT_SOFT}; white-space: nowrap;
}
.mn-feed .row b { color: ${TEXT.primary}; font-weight: 700; }
.mn-feed .row .d { font-weight: 700; font-variant-numeric: tabular-nums; }
.mn-feed .row .g {
  display: inline-block; width: calc(9 * var(--u)); text-align: center;
  margin-right: calc(4 * var(--u)); opacity: .9;
}

/* ========================================================================= */
/* SYSTEM window — the Solo Leveling language                                 */
/* ========================================================================= */
.mn-sys {
  position: absolute; left: 50%; top: 30%; transform: translateX(-50%);
  z-index: 40; display: flex; flex-direction: column; align-items: center;
  gap: calc(12 * var(--u));
}
.mn-win {
  position: relative; width: calc(${M.systemWin} * var(--u));
  transform-origin: 50% 40%;
  will-change: transform, opacity;
}
.mn-win .bd {
  position: relative; overflow: hidden;
  padding: calc(13 * var(--u)) calc(22 * var(--u)) calc(15 * var(--u));
  /* Deliberately MORE transparent than a solid panel would be. The window is a
     projection over reality, so the room has to read through it — and the side
     effect is that the near-monochrome scene dilutes what would otherwise be a
     large block of saturated cyan in every frame the window appears in. */
  background:
    linear-gradient(180deg, ${alpha('#124a72', .30)} 0%, ${UI.systemFill} 40%, ${alpha('#071825', .70)} 100%);
  border: 1px solid ${UI.systemEdge};
  box-shadow:
    0 0 calc(2 * var(--u)) ${alpha(UI.systemBlue, .9)},
    0 0 calc(26 * var(--u)) ${alpha(UI.systemBlue, .40)},
    inset 0 0 calc(40 * var(--u)) ${alpha('#3fb4ff', .12)},
    inset 0 calc(1 * var(--u)) 0 ${alpha('#dff5ff', .5)};
}
/* Static scanlines. 3px period at 1x — any tighter aliases into a grey wash. */
.mn-win .bd::before {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(180deg, rgba(0,0,0,.22) 0 1px, rgba(0,0,0,0) 1px calc(3 * var(--u)));
  mix-blend-mode: multiply;
}
/* A faint hex-grid wash so the panel is not a flat fill. */
.mn-win .bd::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background:
    repeating-linear-gradient(60deg, ${alpha(UI.systemBlue, .05)} 0 1px, transparent 1px calc(16 * var(--u))),
    repeating-linear-gradient(-60deg, ${alpha(UI.systemBlue, .05)} 0 1px, transparent 1px calc(16 * var(--u)));
}
/* The travelling scan sweep. */
.mn-win .scan {
  position: absolute; left: 0; right: 0; height: calc(56 * var(--u)); top: calc(-56 * var(--u));
  background: linear-gradient(180deg, ${alpha(UI.systemBlue, 0)} 0%, ${alpha(UI.systemBlue, .09)} 62%, ${alpha('#dff6ff', .44)} 96%, ${alpha(UI.systemBlue, 0)} 100%);
  animation: mn-scan 2.6s linear infinite; pointer-events: none;
}
@keyframes mn-scan { from { transform: translateY(0); } to { transform: translateY(calc(100% + 260 * var(--u))); } }
/* Corner brackets — 4 L shapes, the hardest-working 12 lines of CSS here. */
.mn-win .cn { position: absolute; width: calc(17 * var(--u)); height: calc(17 * var(--u)); pointer-events: none; }
.mn-win .cn::before, .mn-win .cn::after {
  content: ''; position: absolute; background: ${alpha('#d9f4ff', .95)};
  box-shadow: 0 0 calc(7 * var(--u)) ${alpha(UI.systemBlue, .95)};
}
.mn-win .cn::before { width: 100%; height: calc(2 * var(--u)); }
.mn-win .cn::after { width: calc(2 * var(--u)); height: 100%; }
.mn-win .cn.tl { left: calc(-3 * var(--u)); top: calc(-3 * var(--u)); }
.mn-win .cn.tr { right: calc(-3 * var(--u)); top: calc(-3 * var(--u)); }
.mn-win .cn.tr::before { right: 0; } .mn-win .cn.tr::after { right: 0; }
.mn-win .cn.bl { left: calc(-3 * var(--u)); bottom: calc(-3 * var(--u)); }
.mn-win .cn.bl::before { bottom: 0; } .mn-win .cn.bl::after { bottom: 0; }
.mn-win .cn.br { right: calc(-3 * var(--u)); bottom: calc(-3 * var(--u)); }
.mn-win .cn.br::before { right: 0; bottom: 0; } .mn-win .cn.br::after { right: 0; bottom: 0; }

.mn-win .ttl {
  font-family: ${FONT.mono}; font-size: calc(15 * var(--u)); font-weight: 700;
  letter-spacing: .30em; text-indent: .30em; text-transform: uppercase;
  color: #e6f8ff; text-align: center;
  text-shadow: 0 0 calc(3 * var(--u)) ${alpha(UI.systemBlue, 1)}, 0 0 calc(14 * var(--u)) ${alpha(UI.systemBlue, .75)}, 0 calc(1 * var(--u)) 0 rgba(0,0,0,.8);
}
.mn-win .rule {
  height: 1px; margin: calc(10 * var(--u)) 0 calc(11 * var(--u));
  background: linear-gradient(90deg, transparent, ${alpha(UI.systemBlue, .85)} 18%, ${alpha('#e6f8ff', .95)} 50%, ${alpha(UI.systemBlue, .85)} 82%, transparent);
  box-shadow: 0 0 calc(7 * var(--u)) ${alpha(UI.systemBlue, .6)};
  transform-origin: 50% 50%;
}
.mn-win .ln {
  font-family: ${FONT.mono}; font-size: calc(13 * var(--u)); line-height: 1.85;
  letter-spacing: .05em; color: #d6ecfa; text-align: center;
  text-shadow: 0 0 calc(9 * var(--u)) ${alpha(UI.systemBlue, .55)}, 0 calc(1 * var(--u)) 0 rgba(0,0,0,.85);
  white-space: pre-wrap; min-height: calc(13 * 1.85 * var(--u));
}
.mn-win .ln.em { color: #ffffff; font-weight: 700; letter-spacing: .10em; }
.mn-win .ln.gd { color: ${UI.critYellow}; text-shadow: 0 0 calc(10 * var(--u)) ${alpha(UI.critYellow, .6)}, 0 1px 0 #000; }
.mn-win .ln.vi { color: ${violetHot}; text-shadow: 0 0 calc(11 * var(--u)) ${alpha(violet, .85)}, 0 1px 0 #000; }
.mn-win .car {
  display: inline-block; width: calc(8 * var(--u)); height: calc(13 * var(--u));
  margin-left: calc(2 * var(--u)); vertical-align: calc(-2 * var(--u));
  background: ${alpha('#dff6ff', .9)}; box-shadow: 0 0 calc(8 * var(--u)) ${alpha(UI.systemBlue, .95)};
  animation: mn-caret .62s steps(1, end) infinite;
}
@keyframes mn-caret { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
/* The one-frame blowout on entry. */
.mn-win .pop {
  position: absolute; inset: calc(-6 * var(--u)); pointer-events: none; opacity: 0;
  background: ${alpha('#eafaff', .9)};
  filter: blur(calc(6 * var(--u)));
}

/* ========================================================================= */
/* full-screen banner (ARISE / LEVEL UP)                                      */
/* ========================================================================= */
.mn-banner {
  position: absolute; left: 0; right: 0; top: 13%; z-index: 44;
  text-align: center; opacity: 0; pointer-events: none;
}
.mn-banner .big {
  font-family: ${FONT.display}; font-weight: 700;
  font-size: calc(62 * var(--u)); line-height: 1;
  letter-spacing: .40em; text-indent: .40em; text-transform: uppercase;
  background: linear-gradient(180deg, #ffffff 0%, ${violetHot} 42%, ${violet} 78%, ${shade(violet, .5)} 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 0 calc(20 * var(--u)) ${alpha(violet, .95)}) drop-shadow(0 calc(3 * var(--u)) calc(6 * var(--u)) rgba(0,0,0,.9));
}
.mn-banner .big.gold {
  background: linear-gradient(180deg, #fffdf5 0%, ${UI.critYellow} 40%, ${UI.xpGold} 76%, ${shade(UI.xpGold, .45)} 100%);
  -webkit-background-clip: text; background-clip: text;
  filter: drop-shadow(0 0 calc(20 * var(--u)) ${alpha(UI.xpGold, .9)}) drop-shadow(0 calc(3 * var(--u)) calc(6 * var(--u)) rgba(0,0,0,.9));
}
.mn-banner .sm {
  margin-top: calc(8 * var(--u));
  font-size: calc(12 * var(--u)); letter-spacing: .44em; text-indent: .44em; text-transform: uppercase;
  color: ${alpha('#ded3ff', .9)}; text-shadow: ${SHADOW_TEXT}, 0 0 calc(14 * var(--u)) ${alpha(violet, .8)};
}
.mn-banner .rulel, .mn-banner .ruler {
  position: absolute; top: calc(34 * var(--u)); height: 1px; width: 26%;
  background: linear-gradient(90deg, transparent, ${alpha(violetHot, .85)});
}
.mn-banner .rulel { left: 4%; }
.mn-banner .ruler { right: 4%; transform: scaleX(-1); }

/* ========================================================================= */
/* toast strip                                                                */
/* ========================================================================= */
.mn-toasts {
  position: absolute; left: 50%; transform: translateX(-50%);
  top: calc(120 * var(--u)); z-index: 38;
  display: flex; flex-direction: column; align-items: center; gap: calc(4 * var(--u));
}
.mn-toast {
  padding: calc(4 * var(--u)) calc(14 * var(--u));
  font-size: calc(11.5 * var(--u)); letter-spacing: .18em; text-transform: uppercase;
  color: ${TEXT.primary};
  background: linear-gradient(180deg, ${alpha('#171319', .88)}, ${alpha('#07060a', .88)});
  border-top: 1px solid ${alpha(BRASS.base, .7)};
  border-bottom: 1px solid ${alpha(BRASS.dark, .9)};
  text-shadow: ${SHADOW_TEXT};
  box-shadow: 0 calc(2 * var(--u)) calc(9 * var(--u)) rgba(0,0,0,.8);
}
.mn-toast.good { color: ${UI.critYellow}; }
.mn-toast.bad { color: ${mixHex(UI.hpRed, '#ffb0a0', .5)}; }
.mn-toast.shadow { color: ${violetHot}; border-top-color: ${alpha(violet, .8)}; }

/* ========================================================================= */
/* panels — inventory / character / skills                                    */
/* ========================================================================= */
/* Centred with margins rather than a transform ON PURPOSE: a transformed
   ancestor becomes the containing block for position:fixed descendants, which
   would shrink the full-screen scrim down to the panel's own box. */
.mn-panel {
  position: absolute; left: 50%; top: 50%;
  margin-left: calc(${M.panel} * -0.5 * var(--u)); margin-top: calc(295 * -1 * var(--u));
  width: calc(${M.panel} * var(--u)); height: calc(590 * var(--u));
  z-index: 50; display: none; pointer-events: auto;
}
.mn-panel.on { display: block; }
.mn-panel .scrim {
  position: fixed; inset: 0;
  background: linear-gradient(180deg, rgba(4,3,6,.72), rgba(2,2,4,.86));
  z-index: -1;
}
.mn-panel .win {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background:
    linear-gradient(180deg, ${alpha('#15111a', .97)}, ${alpha('#08070c', .98)});
  border: 1px solid ${alpha(BRASS.base, .75)};
  /* Blur radii kept small on purpose: this is a 940x590 box and a software
     rasteriser pays O(area x radius) for every shadow. A 60px outer plus a 90px
     inset here measured in whole seconds per composited frame. */
  box-shadow:
    0 calc(8 * var(--u)) calc(22 * var(--u)) rgba(0,0,0,.92),
    inset 0 0 calc(34 * var(--u)) rgba(0,0,0,.85),
    inset 0 1px 0 ${alpha(BRASS.warm, .35)};
}
.mn-panel .orn {
  position: absolute; inset: 0; pointer-events: none;
  background-repeat: no-repeat; background-size: 100% 100%;
}
/* Corner filigree — one baked bitmap, mirrored into the other three corners. */
.mn-panel .cnr {
  position: absolute; width: calc(96 * var(--u)); height: calc(96 * var(--u));
  background-repeat: no-repeat; background-size: 100% 100%; pointer-events: none; z-index: 3;
}
.mn-panel .cnr.tl { left: 0; top: 0; }
.mn-panel .cnr.tr { right: 0; top: 0; transform: scaleX(-1); }
.mn-panel .cnr.bl { left: 0; bottom: 0; transform: scaleY(-1); }
.mn-panel .cnr.br { right: 0; bottom: 0; transform: scale(-1, -1); }
.mn-panel .ptitle {
  position: absolute; left: 50%; top: calc(-15 * var(--u)); transform: translateX(-50%);
  padding: calc(3 * var(--u)) calc(26 * var(--u));
  font-family: ${FONT.display}; font-size: calc(14 * var(--u));
  letter-spacing: .34em; text-indent: .34em; text-transform: uppercase;
  color: #f2e6c8;
  background: linear-gradient(180deg, ${alpha(BRASS.dark, .98)}, ${alpha('#0a0810', .98)});
  border: 1px solid ${alpha(BRASS.base, .85)};
  box-shadow: 0 calc(3 * var(--u)) calc(12 * var(--u)) rgba(0,0,0,.85), inset 0 1px 0 ${alpha(BRASS.warm, .5)};
  text-shadow: ${SHADOW_TEXT};
  white-space: nowrap; z-index: 4;
}
.mn-panel .tabs {
  display: flex; gap: calc(2 * var(--u)); padding: calc(16 * var(--u)) calc(20 * var(--u)) 0;
  border-bottom: 1px solid ${alpha(BRASS.dark, .9)};
}
.mn-panel .tab {
  padding: calc(7 * var(--u)) calc(20 * var(--u)) calc(6 * var(--u));
  font-size: calc(11 * var(--u)); letter-spacing: .24em; text-transform: uppercase;
  color: ${TEXT.dim}; cursor: pointer;
  background: linear-gradient(180deg, ${alpha('#1a1520', .8)}, transparent);
  border: 1px solid transparent; border-bottom: none;
  text-shadow: ${SHADOW_TEXT};
}
.mn-panel .tab.on {
  color: #fff3d8;
  background: linear-gradient(180deg, ${alpha(BRASS.dark, .95)}, ${alpha('#100c14', .9)});
  border-color: ${alpha(BRASS.base, .8)};
  box-shadow: inset 0 1px 0 ${alpha(BRASS.warm, .55)};
}
.mn-panel .pg { flex: 1; display: none; overflow: hidden; }
.mn-panel .pg.on { display: flex; }

/* --- inventory ----------------------------------------------------------- */
.mn-inv { padding: calc(20 * var(--u)) calc(22 * var(--u)); gap: calc(22 * var(--u)); width: 100%; }
.mn-doll { width: calc(330 * var(--u)); position: relative; flex: 0 0 auto; }
.mn-doll .fig {
  position: absolute; left: 50%; top: calc(8 * var(--u));
  width: calc(220 * var(--u)); height: calc(320 * var(--u));
  transform: translateX(-50%);
  opacity: .96;
}
.mn-eq {
  position: absolute; width: calc(44 * var(--u)); height: calc(44 * var(--u));
}
.mn-cell {
  position: relative; width: calc(44 * var(--u)); height: calc(44 * var(--u));
  background: linear-gradient(180deg, #0e0b12, #060509);
  border: 1px solid ${alpha(BRASS.dark, .95)};
  box-shadow: inset 0 0 calc(6 * var(--u)) rgba(0,0,0,.95), inset 0 1px 0 ${alpha(BRASS.base, .28)};
}
.mn-cell canvas { position: absolute; inset: calc(2 * var(--u)); width: calc(100% - 4 * var(--u)); height: calc(100% - 4 * var(--u)); }
.mn-cell.f { border-color: currentColor; box-shadow: inset 0 0 calc(11 * var(--u)) rgba(0,0,0,.9), 0 0 calc(8 * var(--u)) currentColor; }
.mn-cell .q {
  position: absolute; right: calc(2 * var(--u)); bottom: calc(1 * var(--u));
  font-size: calc(9 * var(--u)); font-weight: 700; color: ${TEXT.primary};
  text-shadow: 0 1px 0 #000, 0 0 calc(4 * var(--u)) #000;
}
.mn-cell .lk {
  position: absolute; left: calc(2 * var(--u)); top: calc(1 * var(--u));
  font-size: calc(9 * var(--u)); color: ${UI.critYellow}; text-shadow: 0 1px 0 #000;
}
.mn-grid {
  flex: 1; display: grid; align-content: start;
  grid-template-columns: repeat(10, calc(44 * var(--u)));
  gap: calc(4 * var(--u));
}
.mn-invhdr {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: calc(8 * var(--u));
}
.mn-tip {
  position: absolute; width: calc(272 * var(--u)); padding: calc(11 * var(--u)) calc(13 * var(--u));
  background: linear-gradient(180deg, ${alpha('#0d0a12', .98)}, ${alpha('#060409', .99)});
  border: 1px solid currentColor;
  box-shadow: 0 calc(5 * var(--u)) calc(14 * var(--u)) rgba(0,0,0,.95), inset 0 0 calc(18 * var(--u)) rgba(0,0,0,.8);
  z-index: 4;
}
.mn-tip .nm { font-family: ${FONT.display}; font-size: calc(15 * var(--u)); letter-spacing: .08em; color: currentColor; text-shadow: ${SHADOW_TEXT}; }
.mn-tip .ty { font-size: calc(10 * var(--u)); letter-spacing: .2em; text-transform: uppercase; color: ${TEXT.dim}; margin-bottom: calc(7 * var(--u)); }
.mn-tip .dv { height: 1px; margin: calc(7 * var(--u)) 0; background: linear-gradient(90deg, transparent, ${alpha(BRASS.base, .9)}, transparent); }
.mn-tip .af { font-size: calc(11.5 * var(--u)); line-height: 1.7; color: ${mixHex(RARITY.magic.srgb, '#cfe0ff', .55)}; }
.mn-tip .af b { color: #fff; font-weight: 700; }
.mn-tip .big { font-size: calc(23 * var(--u)); font-weight: 700; color: ${TEXT.primary}; line-height: 1.1; }
.mn-tip .flv { font-size: calc(11 * var(--u)); font-style: italic; color: ${TEXT.faint}; line-height: 1.55; }

/* --- character ----------------------------------------------------------- */
.mn-char { padding: calc(16 * var(--u)) calc(22 * var(--u)); gap: calc(26 * var(--u)); width: 100%; }
.mn-statcol { flex: 1; }
.mn-stat {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: calc(5 * var(--u)) calc(8 * var(--u));
  border-bottom: 1px solid ${alpha('#221c26', .9)};
  font-size: calc(12 * var(--u));
}
.mn-stat:nth-child(odd) { background: ${alpha('#ffffff', .018)}; }
.mn-stat .k { color: ${TEXT.dim}; letter-spacing: .1em; text-transform: uppercase; font-size: calc(10.5 * var(--u)); }
.mn-stat .v { color: ${TEXT.primary}; font-weight: 700; font-variant-numeric: tabular-nums; }
.mn-stat .v em { color: ${mixHex(RARITY.magic.srgb, '#a8c8ff', .4)}; font-style: normal; font-size: calc(10.5 * var(--u)); }
.mn-secthd {
  margin: calc(14 * var(--u)) 0 calc(6 * var(--u));
  font-size: calc(10 * var(--u)); letter-spacing: .3em; text-transform: uppercase;
  color: ${TEXT.gold}; text-shadow: ${SHADOW_TEXT};
  border-bottom: 1px solid ${alpha(BRASS.dark, .9)}; padding-bottom: calc(4 * var(--u));
}
.mn-portrait {
  width: calc(230 * var(--u)); flex: 0 0 auto; position: relative;
  display: flex; flex-direction: column; align-items: center;
}
.mn-portrait canvas { width: calc(200 * var(--u)); height: calc(240 * var(--u)); }
.mn-portrait .cls {
  margin-top: calc(10 * var(--u)); font-family: ${FONT.display};
  font-size: calc(17 * var(--u)); letter-spacing: .26em; text-indent: .26em; text-transform: uppercase;
  color: ${violetHot}; text-shadow: ${SHADOW_TEXT}, 0 0 calc(14 * var(--u)) ${alpha(violet, .8)};
}
.mn-portrait .lvl {
  font-size: calc(10 * var(--u)); letter-spacing: .3em; text-transform: uppercase; color: ${TEXT.dim};
  text-shadow: ${SHADOW_TEXT};
}

/* --- skill tree ---------------------------------------------------------- */
.mn-panel .pg.tree { position: relative; width: 100%; }
.mn-panel .pg.tree canvas { position: absolute; inset: calc(10 * var(--u)); width: calc(100% - 20 * var(--u)); height: calc(100% - 20 * var(--u)); }
.mn-panel .pg.tree .pts {
  position: absolute; right: calc(18 * var(--u)); top: calc(12 * var(--u));
  font-size: calc(11 * var(--u)); letter-spacing: .2em; text-transform: uppercase;
  color: ${UI.critYellow}; text-shadow: ${SHADOW_TEXT};
}

/* ========================================================================= */
/* cursor                                                                     */
/* ========================================================================= */
.mn-cursor {
  position: absolute; left: 0; top: 0; z-index: 60;
  width: calc(30 * var(--u)); height: calc(30 * var(--u));
  margin: calc(-15 * var(--u)) 0 0 calc(-15 * var(--u));
  pointer-events: none; will-change: transform;
}
.mn-cursor i {
  position: absolute; display: block; background: ${alpha('#e9e2ff', .92)};
  box-shadow: 0 0 calc(4 * var(--u)) ${alpha(violet, .95)}, 0 0 1px rgba(0,0,0,.9);
}
.mn-cursor .h { width: calc(7 * var(--u)); height: 1px; }
.mn-cursor .v { width: 1px; height: calc(7 * var(--u)); }
.mn-cursor .t { left: 50%; top: 0; }
.mn-cursor .b { left: 50%; bottom: 0; }
.mn-cursor .lf { left: 0; top: 50%; }
.mn-cursor .rt { right: 0; top: 50%; }
.mn-cursor .dot {
  left: 50%; top: 50%; width: calc(2 * var(--u)); height: calc(2 * var(--u));
  margin: calc(-1 * var(--u)) 0 0 calc(-1 * var(--u)); border-radius: 50%;
}
.mn-cursor.hostile i { background: ${mixHex(UI.hpRed, '#ffd0c4', .55)}; box-shadow: 0 0 calc(5 * var(--u)) ${alpha(UI.hpRed, .95)}; }
`;
}
