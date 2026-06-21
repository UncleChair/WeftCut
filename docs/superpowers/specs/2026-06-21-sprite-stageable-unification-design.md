# Sprite staging unification — `StageableSprite`

**Date:** 2026-06-21
**Scope:** Refactor-only, zero behavior change. Groundwork for a later
"Motif effects" feature; that feature is explicitly **out of scope** here.

## Problem

The Compositor's per-frame composite loop (`Compositor.ts`, the
`for (const track ...)` body) reaches into each layer kind's sprite wrapper
through a different, hard-coded member to apply effect filters and add the
node to the stage:

| Active record | filterable / stageable node | accessor in loop | stage guard |
| --- | --- | --- | --- |
| `ActiveClip` | `Sprite` | `clip.sprite.sprite` | `texture !== Texture.EMPTY` |
| `ActiveImage` | `Sprite` | `image.sprite.sprite` | `texture !== Texture.EMPTY` |
| `ActiveColor` | `Graphics` | `color.sprite.graphics` | none (always added) |
| `ActiveText` | `Text` | `text.sprite.text` | none (always added) |
| `ActiveMotif` | `Sprite` | `tmpl.sprite.sprite` | `texture !== Texture.EMPTY` |

`Sprite`, `Graphics`, and `Text` all extend Pixi's `Container`, which owns
`.filters` — so the five nodes are uniformly filterable and stageable. The
only real heterogeneity is **which member holds the node** and **whether
staging gates on a non-empty texture**. That knowledge belongs to each sprite
(it knows what Pixi node it wraps), but today it is duplicated across five
branches of the loop.

A second consequence: the Motif branch is the only one that omits the
`.filters = effectsFor(...)` line, and `ActiveMotif` is the only Active record
without an `effects: EffectChain` field. "Effects don't apply to Motif" is
therefore an accident of the loop's shape, not a compositing limitation —
once a Motif's node is a `Sprite` with a bound texture, a filter would apply
to it identically to any other layer.

## Goal

Move "which node is filterable/stageable, and is it ready" onto each sprite
wrapper behind a common interface, and centralize the per-frame
"apply filters + add to stage" tail into one Compositor helper. Leave a
single, obvious seam where a future change wires Motif effects.

Non-goals (hard boundary): wiring Motif effects, touching the content-
production paths (decode / CDP capture), `dispose`, the filter catalog, or any
export gate. The content-production paths (decode-from-media vs CDP-raster-
from-web) are an essential difference and stay separate; the correct
convergence point is exactly "a `Container` with its content already bound,"
which is where this refactor operates.

## Design

### 1. `StageableSprite` interface

New file `apps/desktop/src/renderer/render/sprite/StageableSprite.ts`:

```ts
import type { Container } from "pixi.js";

/** The contract the composite loop needs from every visual layer's sprite:
 *  the filterable/stageable Pixi node, and whether it's ready to stage this
 *  frame. Each sprite wrapper knows which of its members is the Container
 *  (Sprite | Graphics | Text) — that knowledge lives here, not in the loop. */
export interface StageableSprite {
  readonly displayObject: Container;
  /** Sprite-backed kinds gate on a real (non-EMPTY) texture; Graphics/Text
   *  are always ready. */
  readonly stageReady: boolean;
}
```

Each of the five wrappers gains `implements StageableSprite` and two getters.
Existing members (`.sprite` / `.graphics` / `.text`) are **kept unchanged** —
`displayObject` / `stageReady` are additive, so ensure/update internals and
existing tests are untouched.

- `VideoClipSprite`, `ImageOverlaySprite`, `MotifSprite`:
  - `get displayObject(): Container { return this.sprite; }`
  - `get stageReady(): boolean { return this.sprite.texture !== Texture.EMPTY; }`
- `ColorSprite`:
  - `get displayObject(): Container { return this.graphics; }`
  - `get stageReady(): boolean { return true; }`
- `TextSprite`:
  - `get displayObject(): Container { return this.text; }`
  - `get stageReady(): boolean { return true; }`

The `implements` clause is a compile-time guard: a wrapper missing a getter
fails `tsc`.

### 2. `Compositor.stageVisual` helper

```ts
/** Per-frame "filter + addChild" tail for every visual layer kind. Applies
 *  the layer's resolved filters when it carries an effect chain, then stages
 *  the node once it's ready. `effects` is omitted for kinds without a chain
 *  (Motif today) → they stage unfiltered. That omission is the single seam a
 *  future "Motif effects" change plugs into: give ActiveMotif an EffectChain
 *  and pass it here. */
private stageVisual(
  sprite: StageableSprite,
  effects: EffectChain | undefined,
  layer: LayerSummary,
  tInLayerUs: number,
  effectOpts: { previewEffectsEnabled: boolean },
): void {
  if (effects) {
    sprite.displayObject.filters = effectsFor(effects, layer, tInLayerUs, effectOpts);
  }
  if (sprite.stageReady) {
    this.stage.addChild(sprite.displayObject);
  }
}
```

Semantics map one-to-one to today: set `filters` first (`effectsFor` returns
`Filter[]`; an empty array means no filters), then `addChild` gated by
readiness. Order and calls are unchanged from the current per-branch code.

### 3. Composite-loop rewrite

Each branch's 2–3 staging lines collapse to one `stageVisual` call. The
`ensure*` / `update*` calls stay per-kind (their signatures genuinely differ).
This is the only site in the loop that applies filters or adds to the stage.

VideoClip (representative of the four effect-bearing kinds):

```ts
const clip = this.ensureClip(layer);
if (!clip) continue;
this.updateClip(clip, layer, tUsSnapped, z++);
this.stageVisual(clip.sprite, clip.effects, layer, tUsSnapped - layer.t_start_us, effectOpts);
```

Motif — `effects` passed as `undefined`, exactly reproducing today's behavior
(no filter line at all, texture-gated staging):

```ts
const tmpl = this.ensureMotif(layer);
if (!tmpl) continue;
this.updateMotif(tmpl, layer, z++, tUsSnapped);
this.stageVisual(tmpl.sprite, undefined, layer, tUsSnapped - layer.t_start_us, effectOpts);
```

## Testing & verification

Zero behavior change → **no new e2e gate**. Existing gates prove the four
effect-bearing kinds still render unchanged, and the shared composite loop
means the export Worker is covered by the same proof.

- **Type check** — `tsc -b`: the `implements StageableSprite` clauses are the
  primary correctness guard.
- **Unit** — one small assertion per wrapper for `displayObject` / `stageReady`
  (Sprite-backed kinds tested in both EMPTY and bound-texture states; Color/Text
  trivially `true`). Existing `effectsFor.test.ts`, `EffectChain.test.ts`,
  `MotifSprite.test.ts`, `TextSprite.test.ts` stay green.
- **e2e regression (core evidence)** —
  `apps/desktop/e2e/electron/effects-smoke.spec.ts` (add blur → preview pixel
  change → 8-bit export blurred → undo restores) drives the rewritten composite
  loop end-to-end through preview and 8-bit export. The f16 GL-parity gate
  (`apps/desktop/e2e/effects-f16-parity/`) guards filter precision on the 10-bit
  pool and must stay green. Both run local-only.
- **Real-app smoke (optional)** — add a blur to a clip in the built app and
  confirm no regression.

## Future seam (not built here)

Wiring Motif effects later is: add `effects: EffectChain` to `ActiveMotif`
(constructed in `ensureMotif`), and pass it into the existing `stageVisual`
call instead of `undefined`. Plus the export-path verification noted in the
roadmap (filtered Motif frames via `injectedFrames` + the f16 pool). No loop
or interface change required — that is the payoff of this refactor.
