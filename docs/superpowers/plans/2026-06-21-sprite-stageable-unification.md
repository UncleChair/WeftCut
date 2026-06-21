# Sprite Staging Unification (`StageableSprite`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the five sprite wrappers a common `StageableSprite` interface (`displayObject` + `stageReady`) and collapse the Compositor's per-kind "apply filters + addChild" tail into one `stageVisual` helper, with zero behavior change.

**Architecture:** Each sprite wrapper exposes which Pixi `Container` it wraps and whether it's ready to stage; the Compositor calls one helper that applies a layer's effect filters (when it has an effect chain) and stages the node. Motif passes `undefined` for effects, exactly reproducing today's "Motif has no filters" behavior and leaving a one-argument seam for a future Motif-effects feature.

**Tech Stack:** TypeScript, PixiJS v8 (`pixi.js@^8.18.1`), Vitest (jsdom env), electron-vite. Commands run from `apps/desktop/`.

## Global Constraints

- **Zero behavior change.** This is a pure refactor. Existing rendering — preview and export, all five layer kinds — must be byte-for-byte identical.
- **Do not touch** content-production paths (decode / CDP capture), `dispose`, the filter catalog (`effectRegistry.ts`), or `ActiveMotif`'s shape. Motif gets NO effects in this work.
- **Keep existing members.** `.sprite` / `.graphics` / `.text` on the wrappers stay; the new getters are additive (ensure/update internals and existing tests must not change).
- **Preserve the empty-texture landmine comment.** The "PixiJS v8 batched renderer crashes on the EMPTY-texture placeholder" rationale currently sits at the VideoClip branch; it must survive the refactor (moved into `stageVisual`). It is on the protected never-cut comment list.
- All file paths below are relative to the repo root (`C:/Users/jonny/Desktop/learning/videtor`).
- Branch already created and checked out: `feat/sprite-stageable-unification` (the design spec is committed there).

---

### Task 1: `StageableSprite` interface + getters on all five wrappers

**Files:**
- Create: `apps/desktop/src/renderer/render/sprite/StageableSprite.ts`
- Create: `apps/desktop/src/renderer/render/sprite/StageableSprite.test.ts`
- Modify: `apps/desktop/src/renderer/render/sprite/VideoClipSprite.ts` (import + `implements` + getters)
- Modify: `apps/desktop/src/renderer/render/sprite/ImageOverlaySprite.ts` (same)
- Modify: `apps/desktop/src/renderer/render/sprite/MotifSprite.ts` (same)
- Modify: `apps/desktop/src/renderer/render/sprite/ColorSprite.ts` (same)
- Modify: `apps/desktop/src/renderer/render/sprite/TextSprite.ts` (same)

**Interfaces:**
- Produces:
  - `interface StageableSprite { readonly displayObject: Container; readonly stageReady: boolean }` (from `./StageableSprite`)
  - On each wrapper: `get displayObject(): Container` and `get stageReady(): boolean`.
  - `displayObject` returns: `VideoClipSprite`/`ImageOverlaySprite`/`MotifSprite` → `this.sprite`; `ColorSprite` → `this.graphics`; `TextSprite` → `this.text`.
  - `stageReady` returns: Sprite-backed kinds → `this.sprite.texture !== Texture.EMPTY`; `ColorSprite`/`TextSprite` → `true`.

- [ ] **Step 1: Create the interface file**

Create `apps/desktop/src/renderer/render/sprite/StageableSprite.ts`:

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

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/renderer/render/sprite/StageableSprite.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Texture } from "pixi.js";
import { VideoClipSprite } from "./VideoClipSprite";
import { ImageOverlaySprite } from "./ImageOverlaySprite";
import { ColorSprite } from "./ColorSprite";
import { TextSprite } from "./TextSprite";
import { MotifSprite } from "./MotifSprite";

describe("StageableSprite contract", () => {
  it("VideoClipSprite: displayObject is the sprite; stageReady tracks a non-EMPTY texture", () => {
    const s = new VideoClipSprite({ layerId: "L", mediaId: "m" });
    expect(s.displayObject).toBe(s.sprite);
    expect(s.stageReady).toBe(false); // EMPTY at construction
    s.sprite.texture = Texture.WHITE;
    expect(s.stageReady).toBe(true);
  });

  it("ImageOverlaySprite: displayObject is the sprite; stageReady tracks a non-EMPTY texture", () => {
    const s = new ImageOverlaySprite({ layerId: "L", mediaId: "m", maxWidth: 1920, maxHeight: 1080 });
    expect(s.displayObject).toBe(s.sprite);
    expect(s.stageReady).toBe(false);
    s.sprite.texture = Texture.WHITE;
    expect(s.stageReady).toBe(true);
  });

  it("MotifSprite: displayObject is the sprite; stageReady tracks a non-EMPTY texture", () => {
    const s = new MotifSprite({ layerId: "L", motifId: "x", fpsNum: 30, fpsDen: 1 });
    expect(s.displayObject).toBe(s.sprite);
    expect(s.stageReady).toBe(false);
    s.sprite.texture = Texture.WHITE;
    expect(s.stageReady).toBe(true);
  });

  it("ColorSprite: displayObject is the graphics; always stageReady", () => {
    const s = new ColorSprite({ layerId: "L" });
    expect(s.displayObject).toBe(s.graphics);
    expect(s.stageReady).toBe(true);
  });

  it("TextSprite: displayObject is the text; always stageReady", () => {
    const s = new TextSprite({ layerId: "L" });
    expect(s.displayObject).toBe(s.text);
    expect(s.stageReady).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/render/sprite/StageableSprite.test.ts`
Expected: FAIL — `s.displayObject` is `undefined` (getters not yet added), so `expect(undefined).toBe(s.sprite)` fails on the first case.

- [ ] **Step 4: Add the getters to `VideoClipSprite`**

In `apps/desktop/src/renderer/render/sprite/VideoClipSprite.ts`:

Change the pixi import (line ~60) to add the `Container` type, and import the interface:

```ts
import { type Container, ImageSource, Sprite, Texture } from "pixi.js";
import type { StageableSprite } from "./StageableSprite";
```

Add `implements StageableSprite` to the class declaration:

```ts
export class VideoClipSprite implements StageableSprite {
```

Add these two getters immediately after the constructor (after the `}` closing `constructor(...)`):

```ts
  get displayObject(): Container {
    return this.sprite;
  }

  /// EMPTY-texture sprites are not staged: PixiJS v8's batched renderer
  /// crashes on the EMPTY placeholder in some Chromium configs. Once the
  /// first decoded frame lands, the texture swaps and stageReady flips true.
  get stageReady(): boolean {
    return this.sprite.texture !== Texture.EMPTY;
  }
```

- [ ] **Step 5: Add the getters to `ImageOverlaySprite`**

In `apps/desktop/src/renderer/render/sprite/ImageOverlaySprite.ts`:

Change the pixi import (line 9) and add the interface import:

```ts
import { type Container, ImageSource, Sprite, Texture } from "pixi.js";
import type { StageableSprite } from "./StageableSprite";
```

(Keep the other existing imports below unchanged.)

Add `implements StageableSprite`:

```ts
export class ImageOverlaySprite implements StageableSprite {
```

Add these getters immediately after the constructor (after the `this.sprite = new Sprite(Texture.EMPTY);` constructor's closing `}`):

```ts
  get displayObject(): Container {
    return this.sprite;
  }

  /// EMPTY until the first frame is decoded/bound; not staged before then
  /// (PixiJS v8 batched renderer crashes on the EMPTY placeholder).
  get stageReady(): boolean {
    return this.sprite.texture !== Texture.EMPTY;
  }
```

- [ ] **Step 6: Add the getters to `MotifSprite`**

In `apps/desktop/src/renderer/render/sprite/MotifSprite.ts`:

Change the pixi import (line 18) and add the interface import:

```ts
import { type Container, ImageSource, Sprite, Texture } from "pixi.js";
import type { StageableSprite } from "./StageableSprite";
```

Add `implements StageableSprite`:

```ts
export class MotifSprite implements StageableSprite {
```

Add these getters immediately after the constructor (after the constructor's closing `}`, before `update(...)`):

```ts
  get displayObject(): Container {
    return this.sprite;
  }

  /// EMPTY until the first raster (cache hit / capture) binds; not staged
  /// before then (PixiJS v8 batched renderer crashes on the EMPTY placeholder).
  get stageReady(): boolean {
    return this.sprite.texture !== Texture.EMPTY;
  }
```

- [ ] **Step 7: Add the getters to `ColorSprite`**

In `apps/desktop/src/renderer/render/sprite/ColorSprite.ts`:

Change the pixi import (line 9) and add the interface import:

```ts
import { Graphics, type Container } from "pixi.js";
import type { StageableSprite } from "./StageableSprite";
```

(Keep the existing `import type { ResolvedColorView } ...` line.)

Add `implements StageableSprite`:

```ts
export class ColorSprite implements StageableSprite {
```

Add these getters immediately after the constructor (after the constructor's closing `}`, before `update(view)`):

```ts
  get displayObject(): Container {
    return this.graphics;
  }

  /// A Graphics fill has no EMPTY-placeholder phase — always ready.
  get stageReady(): boolean {
    return true;
  }
```

- [ ] **Step 8: Add the getters to `TextSprite`**

In `apps/desktop/src/renderer/render/sprite/TextSprite.ts`:

Change the pixi import (line 14) and add the interface import:

```ts
import { Text, TextStyle, type Container, type TextStyleFontWeight } from "pixi.js";
import type { StageableSprite } from "./StageableSprite";
```

(Keep the existing `import type { ResolvedTextView } ...` line.)

Add `implements StageableSprite`:

```ts
export class TextSprite implements StageableSprite {
```

Add these getters immediately after the constructor (after the constructor's closing `}`, before `update(view)`):

```ts
  get displayObject(): Container {
    return this.text;
  }

  /// A Text node has no EMPTY-placeholder phase — always ready.
  get stageReady(): boolean {
    return true;
  }
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/render/sprite/StageableSprite.test.ts`
Expected: PASS — all 5 cases green.

- [ ] **Step 10: Run the typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: PASS (exit 0). The `implements StageableSprite` clauses compile on every wrapper.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/renderer/render/sprite/StageableSprite.ts \
        apps/desktop/src/renderer/render/sprite/StageableSprite.test.ts \
        apps/desktop/src/renderer/render/sprite/VideoClipSprite.ts \
        apps/desktop/src/renderer/render/sprite/ImageOverlaySprite.ts \
        apps/desktop/src/renderer/render/sprite/MotifSprite.ts \
        apps/desktop/src/renderer/render/sprite/ColorSprite.ts \
        apps/desktop/src/renderer/render/sprite/TextSprite.ts
git commit -m "refactor(render): StageableSprite contract on the five sprite wrappers

Adds a common StageableSprite interface (displayObject + stageReady) and
implements it on VideoClip/ImageOverlay/Motif/Color/Text sprites. Additive
getters only; existing members and behavior unchanged. Unit-tested across
all five wrappers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `Compositor.stageVisual` helper + composite-loop rewrite

**Files:**
- Modify: `apps/desktop/src/renderer/render/Compositor.ts` (add import, add `stageVisual` method, rewrite the five branches at lines ~764–803)

**Interfaces:**
- Consumes (from Task 1): `StageableSprite` (`displayObject: Container`, `stageReady: boolean`) from `./sprite/StageableSprite`; the `.sprite` member on each Active record's wrapper already satisfies it.
- Consumes (existing in Compositor): `effectsFor(chain, layer, tInLayerUs, opts?)` (`./effects/effectsFor`), `EffectChain` type, `LayerSummary` type, `this.stage`.
- Produces: `private stageVisual(sprite: StageableSprite, effects: EffectChain | undefined, layer: LayerSummary, tInLayerUs: number, effectOpts: { previewEffectsEnabled: boolean }): void`.

This is a pure refactor: there is **no new behavior to test**, so there is no new failing test. Verification is the existing unit suite + typecheck + the effects e2e gate. Do NOT fabricate a test for `stageVisual`; its logic is proven by Task 1's getter tests (the `stageReady` semantics) plus the e2e regression below.

- [ ] **Step 1: Add the `StageableSprite` import to Compositor**

In `apps/desktop/src/renderer/render/Compositor.ts`, next to the existing effects import (`import { EffectChain } from "./effects/EffectChain";`, ~line 60), add:

```ts
import type { StageableSprite } from "./sprite/StageableSprite";
```

- [ ] **Step 2: Add the `stageVisual` private method**

Add this method to the `Compositor` class, immediately before the method that contains the composite loop (the one holding the `for (const track of this.projectSummary.tracks)` body — search for that loop and insert `stageVisual` just above its enclosing method, or anywhere among the private methods):

```ts
  /// Per-frame "filter + addChild" tail for every visual layer kind. Applies
  /// the layer's resolved filters when it carries an effect chain, then stages
  /// the node once it's ready. `effects` is omitted for kinds without a chain
  /// (Motif today) → they stage unfiltered. That omission is the single seam a
  /// future "Motif effects" change plugs into: give ActiveMotif an EffectChain
  /// and pass it here.
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
    // Skip not-yet-ready sprites. Sprite-backed kinds report stageReady false
    // while their texture is still the EMPTY placeholder — PixiJS v8's batched
    // renderer crashes on that placeholder in some Chromium configs. Once the
    // first frame lands, the texture swaps and the sprite stages.
    if (sprite.stageReady) {
      this.stage.addChild(sprite.displayObject);
    }
  }
```

- [ ] **Step 3: Rewrite the five composite-loop branches**

Replace the block at `Compositor.ts` lines ~764–803 (from `const kind = layer.params.kind;` through the closing `}` of the `else if (kind === "Motif")` branch) with:

```ts
        const kind = layer.params.kind;
        const tInLayerUs = tUsSnapped - layer.t_start_us;
        if (kind === "VideoClip") {
          const clip = this.ensureClip(layer);
          if (!clip) continue;
          this.updateClip(clip, layer, tUsSnapped, z++);
          this.stageVisual(clip.sprite, clip.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "ImageOverlay") {
          const image = this.ensureImage(layer);
          if (!image) continue;
          this.updateImage(image, layer, tUsSnapped, z++);
          this.stageVisual(image.sprite, image.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Color") {
          const color = this.ensureColor(layer);
          if (!color) continue;
          this.updateColor(color, layer, z++);
          this.stageVisual(color.sprite, color.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Text") {
          const text = this.ensureText(layer);
          if (!text) continue;
          this.updateText(text, layer, z++, tUsSnapped);
          this.stageVisual(text.sprite, text.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Motif") {
          const tmpl = this.ensureMotif(layer);
          if (!tmpl) continue;
          this.updateMotif(tmpl, layer, z++, tUsSnapped);
          this.stageVisual(tmpl.sprite, undefined, layer, tInLayerUs, effectOpts);
        }
```

Note: the per-branch `effectsFor(...)` calls, the EMPTY-texture guards, and the VideoClip landmine comment are all subsumed by `stageVisual`. The Motif branch passes `undefined` for `effects` (no filters), exactly matching its current behavior.

- [ ] **Step 4: Run the typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: PASS (exit 0). `stageVisual`'s signature, the `StageableSprite` parameter, and `effectOpts` shape all resolve.

- [ ] **Step 5: Run the full unit suite**

Run: `cd apps/desktop && npm test`
Expected: PASS. In particular `effectsFor.test.ts`, `EffectChain.test.ts`, `StageableSprite.test.ts`, `MotifSprite.test.ts`, `TextSprite.test.ts` all green. No test changes were needed (behavior unchanged).

- [ ] **Step 6: Behavioral regression — effects e2e (local-only, built app)**

This is the core zero-behavior-change evidence. It needs a built app with `VITE_WEFTCUT_E2E=1` (see the media-conformance / e2e notes). Run:

Run: `cd apps/desktop && npm run e2e:electron -- effects-smoke`
Expected: PASS — add blur → preview non-transparent pixel count rises → 8-bit export renders blurred → undo restores. This drives the rewritten composite loop end-to-end in preview and 8-bit export.

If the e2e harness/build isn't available in this environment, hand back to the user to run it before merge — do NOT mark the task complete on typecheck + unit suite alone, since the e2e is the behavioral proof for the loop rewrite.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/render/Compositor.ts
git commit -m "refactor(render): collapse composite-loop staging into stageVisual

The per-kind 'apply filters + addChild' tail now routes through one
Compositor.stageVisual(sprite, effects, ...) helper over the StageableSprite
contract. Motif passes effects=undefined (unchanged: no filters), leaving the
single seam a future Motif-effects change plugs into. Zero behavior change;
verified by typecheck, the unit suite, and the effects-smoke e2e.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `StageableSprite` interface → Task 1 Step 1. ✓
- Getters on all five wrappers → Task 1 Steps 4–8. ✓
- `stageVisual` helper with exact semantics → Task 2 Step 2. ✓
- Loop rewrite incl. Motif `undefined` pass-through → Task 2 Step 3. ✓
- Testing: tsc, unit getters, effects-smoke e2e, parity gate stays green → Task 1 Steps 9–10, Task 2 Steps 4–6. ✓
- Non-goals (no Motif effects, no content-production/dispose/catalog changes) → Global Constraints + Task 2 note. ✓
- Empty-texture landmine preserved → moved into `stageVisual` + the Sprite-backed `stageReady` getters. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command shows expected output. ✓

**Type consistency:** `displayObject: Container` / `stageReady: boolean` identical across interface, getters, and `stageVisual`'s `StageableSprite` param. `stageVisual(sprite, effects, layer, tInLayerUs, effectOpts)` arg order matches its definition and every call site. `effectOpts: { previewEffectsEnabled: boolean }` matches the loop's `const effectOpts = { previewEffectsEnabled }` and is assignable to `effectsFor`'s `opts?: { previewEffectsEnabled?: boolean }`. ✓
