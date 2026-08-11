/**
 * quality.js — audio budgets, derived from `config.q`.
 *
 * ARCHITECTURE.md's rule is that every budget comes from the quality preset, not
 * from a literal buried in a subsystem. `config.q` has no audio fields (it is a
 * render preset), so rather than invent a parallel set of magic numbers this file
 * *derives* the audio budgets from the render budgets that are already there. The
 * mapping is deliberate, not arbitrary:
 *
 *   maxActors      → voice count. Every actor is a plausible sound source, so the
 *                    number of things the machine is willing to animate is a good
 *                    proxy for the number of things it should be willing to hear.
 *   particleBudget → variant richness. It is the preset's "spectacle" dial; the
 *                    same dial should decide whether a sword hit has two random
 *                    variations or four.
 *   maxLights      → HRTF voices. Both are the expensive per-source path, and
 *                    both are the thing you cut first on a weak machine.
 *   textureSize    → bake sample rate ceiling and IR length. A preset that only
 *                    wants 256 px textures does not want a 3.6 s stereo impulse
 *                    response either.
 *
 * The result is that `config.setQuality('low')` quietly makes the audio cheaper
 * too, with no extra plumbing anywhere.
 */

import { clamp } from './dsp.js';

export function audioBudget(config) {
  const q = config.q ?? {};
  const maxActors = q.maxActors ?? 60;
  const particles = q.particleBudget ?? 8000;
  const lights = q.maxLights ?? 12;
  const texture = q.textureSize ?? 512;

  /** Total simultaneously-playing pooled voices. */
  const voices = clamp(Math.round(maxActors * 0.5), 12, 48);
  /** Of those, how many get the expensive HRTF panner. The rest use equalpower,
   *  which on a distant drip is indistinguishable and roughly 20x cheaper. */
  const hrtfVoices = clamp(Math.round(lights * 0.75), 4, 16);
  /** Non-positional slots: UI, music one-shots, 2D stingers. */
  const flatVoices = clamp(Math.round(voices * 0.4), 6, 20);

  return {
    voices,
    hrtfVoices,
    flatVoices,
    /** Random variations baked per one-shot family. */
    variants: particles >= 16000 ? 4 : particles >= 8000 ? 3 : 2,
    /** Longest impulse response we are willing to convolve. */
    maxReverbSeconds: texture >= 1024 ? 4.0 : texture >= 512 ? 2.8 : 1.8,
    /** Whether the third (most expensive) music layer is allowed to exist. */
    fullMusic: particles >= 8000,
    /** Ambience scatter events per minute. */
    ambienceDensity: particles >= 16000 ? 34 : particles >= 8000 ? 26 : 18,
    /** How many occlusion raycasts we may issue per frame, round-robin over the
     *  live voices. Physics raycasts are cheap but not free and this runs every
     *  frame forever. */
    occlusionRaysPerFrame: clamp(Math.round(lights / 4), 1, 5),
    /** Milliseconds of bake work allowed per frame in the background queue. */
    bakeBudgetMs: 4,
    /** Hard ceiling on baked PCM before the bank starts evicting, in bytes.
     *  Scales with the same dial as texture memory. */
    bakeBytesMax: texture >= 1024 ? 48 << 20 : texture >= 512 ? 32 << 20 : 18 << 20,
  };
}
