# The critic protocol

This is the standard every MONARCH frame is judged against. It exists because
"make it look AAA" is not a reviewable instruction and "it looks good to me" is
not a reviewable answer.

## What a critic is for

A critic does not improve the game. A critic produces **a ranked list of specific
defects, each attached to the subsystem that owns the fix**, and **a score that is
allowed to go down**. A critic whose scores only rise is broken, and a critic that
writes "could be improved" without naming a pixel is worthless.

Critics are adversarial by construction: their job is to find the reason a viewer
would say "this is a browser demo", not to confirm that progress happened.

## The reference constraint — read this before scoring

**This container has no outbound network access.** Real Diablo IV screenshots and
Solo Leveling stills cannot be downloaded, so a literal side-by-side with a
reference PNG is not possible here. Pretending otherwise would make every A/B
result a fabrication.

What replaces it is a **discrimination test**, which is strictly harder to pass
than a comparison and does not require the reference to be on disk:

> Shown this frame with no context, would a person who plays these games classify
> it as a screenshot from a shipped AAA title, or as a hobbyist WebGL project?

Answer that first, before any rubric, in one sentence, and commit to it. Then
justify it. If the honest answer is "hobbyist", the score cannot exceed 5.0 no
matter how the rubric adds up — the rubric exists to explain the verdict, not to
overrule it.

Two rules keep this honest:

1. **Name the tell.** Whatever made you say "hobbyist" is the single most valuable
   output of the review. Name it precisely: "the floor specular is a uniform sheen
   with no breakup, which no shipped renderer produces", not "materials need work".
2. **State the counterfactual.** For each defect say what the reference does
   instead. "Diablo IV would have the brazier's light pooling on the flagstone
   within about two metres and falling to near black by five" is actionable;
   "lighting is flat" is not.

## Scoring — 0 to 10, calibrated

| score | meaning |
|---|---|
| 0–2 | Untextured primitives, uniform lighting. Reads as a WebGL tutorial. |
| 3–4 | Recognisable as a game. Amateur: flat surfaces, no depth cueing, no grade. |
| 5–6 | Competent indie. Real materials and lighting, but a player would never mistake it for a shipped AAA title. |
| 7–8 | Genuinely close. A knowledgeable viewer would have to look twice. Defects are specific and local, not systemic. |
| 9–10 | Indistinguishable in a blind test from a Diablo IV frame. Nothing in this project has earned this. |

**Do not grade on effort or on improvement since last round.** Grade the frame in
front of you as if you had never seen an earlier one. Improvement is measured by
comparing scores across rounds, which only works if each score is absolute.

## The rubric

Score each axis 0–10 and report all of them. The overall score is the **minimum of
the axis scores, not the mean** — a frame with perfect materials and no depth
separation is a bad frame, and averaging hides exactly the systemic failures that
matter most.

### 1. Material truth
Does stone read as stone at this distance? Is there albedo variation, a normal
map doing visible work, roughness variation, and a detail layer? Are the crevices
dirtier than the faces? Is any surface flat, perfectly clean, or visibly repeating?
Check the `.z2.png` centre crop before answering — half of all "untextured"
complaints are resolution complaints.

### 2. Light transport
Is there a clear key/fill/rim separation? Does the brazier behave like a real
light — a bright pool nearby falling to near black at distance — or like an
ambient multiplier? Do contact points have contact shadows? Is there bounce, or
are the shadows empty? Are the blacks deep without being information-free?
`analyze.mjs` gives you `rms`, `p1`, `crushedPct` and `litPct`; cite them.

### 3. Depth and atmosphere
Can you tell how far away the back of the room is? Is there fog doing real work,
aerial perspective, light shafts? Does the foreground separate from the
background? A flat, uniformly-readable image is a failure even if every material
in it is perfect. This is the axis amateur work fails hardest and notices least.

### 4. Composition and staging
Is the player readable against the environment? Is the frame's focal point
obvious? Is there a foreground element giving scale? Is anything important
occluded by geometry the occluder-fade should have handled? Is the silhouette
language clear at a glance?

### 5. Combat spectacle *(combat / nova / arise / ultimate shots only)*
Does the frame have energy? Is there impact — hit flashes, blood, debris,
light spill from the spell onto nearby geometry? Do damage numbers read? Would a
still from this fight make someone want to play it? A spell that does not
illuminate its surroundings is a sprite, not a spell.

### 6. Signature identity
Is the Solo Leveling read present and correct — a near-monochrome world with
violet shadow energy as the only saturated element? Is the violet *lighting the
scene*, not just glowing on its own? On non-combat shots, is the world
appropriately restrained? `analyze.mjs` reports `V/W/C` (violet/warm/cold pixel
share) and `sat` — cite them.

### 7. Technical finish
Aliasing, shimmer, banding, obvious dithering, z-fighting, light leaks, shadow
acne, popping, TAA ghosting, bloom fringing, tiling seams. These are what
separate 7 from 9 and they are individually cheap to fix once named.

## Required output format

```
VERDICT: shipped-AAA | close | indie | hobbyist        <- the discrimination test
TELL: <the one thing that gave it away, in one sentence>

SCORES  material:N  light:N  depth:N  composition:N  spectacle:N  identity:N  finish:N
OVERALL: N  (= minimum of the above)

DEFECTS (ranked, most damaging first)
1. [owner-subsystem] <what is wrong, where in frame> — <what the reference does instead> — <the fix>
2. ...

WHAT IS WORKING (be specific; the fix agents must not regress these)
- ...
```

## Loop termination

The loop runs until **every shot scores ≥ 8.0 overall and no critic returns a
VERDICT worse than `close`**, or until a round produces no new defects — whichever
comes first. A round that produces no new defects while scores are still below 8
means the critics have gone blind and need to be re-seeded with different lenses,
not that the game is finished.

Report the real numbers at the end. The sibling project in this repository shipped
with an honest "it does not match Call of Duty, here is exactly where it falls
short", and that is worth more than a claim of success nobody can reproduce.
