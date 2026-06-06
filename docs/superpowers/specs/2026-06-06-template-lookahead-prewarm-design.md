# Template Lookahead Prewarm (L1) Design

## Problem

Template preview rasterization is **pull-based and on-demand**. In
`TemplateSprite.update`, a cache hit binds synchronously; a **miss fires an async
`captureAndBind` and returns**, leaving the sprite showing its last-bound frame.
The playhead advances every rAF tick (`PlaybackEngine.tick` → `compositeFrame`
returns immediately, not awaiting the raster). Each template content rasterizes
through **one shared per-`templateId` harness iframe**, serialized (~7–15 ms per
frame including reflow + postMessage + `rasterizeSvg`). With a few template
layers, demand (N × playback fps) exceeds the per-frame budget (33 ms @30fps),
so misses pile up: the templates **freeze** (hold the last frame) while the
playhead keeps moving; superseded async results are cached-but-not-bound. Moving
the playhead back replays smoothly because those frames are now cached.

The documented L0/L1/L2 escalation (`docs/templates.md`) is **design-only** — only
L0 (the on-demand `sharedTemplateFrameCache`) exists. There is no lookahead /
prewarm for preview.

## Goal

Land an **L1 lookahead prewarmer**: fill the existing `sharedTemplateFrameCache`
**ahead of the playhead**, off the play loop, so playback (and scrubbing) hits
the cache instead of racing async rasters. In-RAM only (no disk).

- **Scope:** warm **whole content when it fits** the budget; otherwise a forward
  **sliding window** from the current content frame.
- **When:** **continuous** — during playback AND while paused / on project load.
- The on-demand `captureAndBind` path **stays as a fallback** (frames not yet
  warmed, e.g. immediately after a seek). The prewarmer drives steady-state
  misses toward zero; nothing about the existing path is removed.

## Approach

A budget-paced background filler warms the **same L0 cache** the sprites read —
no new tier or ring data structure. It reuses the existing per-`templateId`
harness, `rasterizeSvg`, and the idempotent `setFrame`, but runs **off the rAF
play tick**, time-sliced and yielding, so it never blocks the UI or the play
loop. Dedup is by `cacheKey`, so N identical template layers warm **one** content
set (the windowing feature's content-addressed key makes this free).

## Components

### 1. Shared frame-descriptor helper (refactor — prevents drift)
Extract, from `TemplateSprite.update`, the pure computation that maps a template
layer + in-layer time + comp fps + resolved `Template` to the frame identity:

```
templateFrameDescriptor(view, tInLayerUs, fpsNum, fpsDen, template) → {
  cacheKey, contentDurationFrames, contentFrame, renderW, renderH,
  canonicalProps, tSec, durationSec, srcInUs
}
```
(`view` = `TemplateView`; mirrors the current `templateContentFrame` +
`templateFrameCacheKey` + `canonicalizeProps` + `resolveTemplateContentDurationUs`
logic.) **Both** `TemplateSprite` (on-demand) and the prewarmer call it, so the
two paths can never disagree on `(cacheKey, contentFrame)`. New module
`src/render/templates/templateFrameDescriptor.ts`; `TemplateSprite.update` is
refactored to use it (no behavior change).

### 2. Target planning (pure)
`planPrewarmTargets(contents, cap)` where `contents` is the deduped-by-`cacheKey`
set of active template contents, each `{ cacheKey, contentFrame (at playhead),
contentDurationFrames }`. Returns an **ordered** list of `(cacheKey, frameIndex)`
to ensure cached:
- **Per-content budget** = `cap / contents.length` (floored), or the whole
  content when `contentDurationFrames ≤ budget`. This guarantees the union of all
  targets ≤ `cap`, so the LRU never evicts a still-targeted frame (no thrash).
- **Order:** playhead-first — for each content, `contentFrame` first, then forward
  (`contentFrame+1 … min(contentFrame+budget, contentDurationFrames-1)`), then the
  earlier frames `0 … contentFrame-1` (lower priority, for backward scrub) up to
  budget. **Round-robin across contents** so a long template can't starve others.
- Pure + unit-tested. The prewarmer skips any target already in the cache.

### 3. `TemplatePrewarmer` (scheduler)
New `src/render/templates/TemplatePrewarmer.ts`:
- `setTargets(contents)` — recompute the plan when the playhead or active layers
  change; (re)arm the loop.
- A self-paced loop: each tick, drain the plan in priority order, rendering each
  missing frame via `harnessFor(template)` → `renderFrameSvg(tSec, durationSec,
  canonicalProps)` → `rasterizeSvg` → `setFrame`, until a small **per-tick budget**
  is spent (a frame count or wall-ms cap), then **yield** and re-schedule via
  `requestIdleCallback` (with a `setTimeout` fallback for engines lacking it).
  Stops when the plan is fully cached.
- `dispose()` — cancel the scheduled tick; abort in-flight (it's just cache fill,
  safe to drop). Does **not** own bitmaps (the cache does).
- Holds the resolved `Template` objects (via `getTemplate`) needed to render.

### 4. Compositor integration
`Compositor` owns one `TemplatePrewarmer`:
- On `setProject`: collect the project's template layers (id, params, t_start/t_end)
  and pass them (with the current playhead) to the prewarmer.
- On `compositeFrame(tUs)` (throttled — e.g. only when the snapped comp frame
  changed): map the playhead to each layer's in-layer time → descriptor →
  `{cacheKey, contentFrame, contentDurationFrames}`, dedup by `cacheKey`, and call
  `prewarmer.setTargets(...)`. Runs whether playing or paused (compositeFrame is
  called on seek/scrub too).
- On dispose: `prewarmer.dispose()`.

## Cap / memory
The frame cap (`DEFAULT_MAX_FRAMES`, 240) is the warm budget; the plan sizes
targets so their union ≤ cap (whole content when it fits, else windowed). 480²
RGBA bitmaps → bounded RAM. Default cap unchanged. (Adaptive cap / disk L2 are
out of scope.)

## Out of Scope
- L2 persisted-PNG cache, `gcUnreferenced`, `rastering{progress}` state machine.
- Measurement-driven escalation (timing a raster to decide tiers).
- Adaptive/larger cache cap, or a separate ring data structure.
- Parallelizing the harness (multiple iframes per templateId) — the prewarmer
  sidesteps the bottleneck by filling ahead of time, not by speeding the harness.
- Behind-the-playhead warming beyond the plan's lower-priority backfill (LRU
  covers small backward scrubs).

## Testing / Verification
- **Unit (vitest):**
  - `templateFrameDescriptor` — `(cacheKey, contentFrame, contentDurationFrames)`
    match what `TemplateSprite` computes for the same inputs (incl. `src_in`,
    uncapped fallback).
  - `planPrewarmTargets` — whole-content-when-it-fits; windowed when over budget;
    union ≤ cap; playhead-first + forward order; round-robin across contents;
    skips none / dedup by cacheKey.
- **Real-WebView2 (the stress repro):** a project with several template tracks —
  play through: templates no longer freeze (no held-frame while playhead
  advances); perf HUD stable; pause → the cache warms; hitting play is smooth;
  seek then play is smooth. Confirm via the shared frame cache filling ahead of
  the playhead (no on-demand miss storm during steady play).
