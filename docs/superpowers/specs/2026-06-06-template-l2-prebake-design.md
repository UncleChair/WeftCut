# Template Persisted Pre-bake (L2) Design

## Problem

The L1 lookahead prewarmer (`TemplatePrewarmer`) fills the in-RAM
`sharedTemplateFrameCache` ahead of the playhead by **rastering** each frame
(`render(t)` → serialize `<svg>` → `<img>` → `createImageBitmap`, ~7–15 ms each,
parallelized across the raster pool). Under real load — several template layers
stacked, 4K, or a weaker GPU — **raster throughput is the bottleneck**: the pool
can't produce frames faster than the playhead consumes them, so L1 falls behind
and the on-demand fallback drops frames. Two symptoms result, both observed:

- **Playback / scrub stutter.** L1 + the on-demand fallback can't stay ahead;
  frames arrive late.
- **Slow cold-start on reload.** Reopening a project re-rasters every template
  frame from scratch — there is no persisted artifact, so nothing survives a
  session.

Both share one root cause: **per-play rastering**. The fix is to make the frames
*already exist* as cheap-to-decode PNGs, so the cache fills by **decoding**
(fast, even off-thread) instead of **rastering**, and the bake survives reload.

The L2 disk layer in `frameCache.ts` (`readPng` / `writePng` / `gcUnreferenced`
/ `hashCacheKey`) is **implemented but unwired and runtime-blocked**:

- **Dead at runtime.** The fs capabilities only grant temp + app-specific dirs.
  The workspace is a user-chosen folder, so `mkdir` / `writeFile` / `readFile`
  against `<workspace>/Cache/raster/` are **denied today**.
- **Nothing calls it.** The sprite (L0), the prewarmer (L1), and export don't
  read or write PNGs. There is no bake driver, no trigger, no GC-on-load.

## Goal

Wire up **L2 persisted pre-bake**: a PNG-per-frame sequence on disk that the
preview read path prefers over live rastering, removing per-play rastering and
surviving reload. User-facing name is **"Pre-bake"** — never "cache to disk".

- **Read-through is the smoothness/cold-start win.** When a frame's PNG exists,
  the cache fills by decoding it, not rastering.
- **Two explicit triggers** (no measurement heuristic):
  - a **global "Pre-bake" setting** (default **off**) that eagerly bakes every
    active template content in the background;
  - a per-layer **right-click → "Pre-bake now"** that bakes one layer on demand,
    regardless of the global setting.
- **In scope:** the fs prerequisite, a shared disk-first frame resolver, a
  full-content bake driver, the two triggers, PNG encode, GC-on-load, and the UI.
- **Out of scope (v1):** export reading PNGs directly (export-prep isn't a
  reported pain — the resolver makes it a near-free follow-up); a Rust/resvg
  baker; measurement-driven auto-escalation.

## Approach

Make L2 a **read-through + write-through layer on the path that already exists**,
not a parallel subsystem. Today the Compositor builds, per active template
content, a `render(frame)` closure (`rasterTemplateFrame`) that the prewarmer
drives and that the sprite mirrors in `captureAndBind`. Replace that single
closure with one shared **`resolveTemplateFrame`**:

1. **Read-through.** If `(cacheKey, frame)` is on disk (and the content's key is
   in the baked-key index, below) → `readPng` → `createImageBitmap` → return.
   Read/permission errors are **swallowed** and fall through to raster, so the
   preview never breaks on an fs hiccup.
2. **Miss → raster.** `rasterTemplateFrame` as today → **if pre-bake is active
   for this content**, encode PNG and `writePng` fire-and-forget → return the
   bitmap.

Because the sprite's on-demand miss and the prewarmer's lookahead both go through
this one function, disk-first behavior is uniform. That is what fixes stutter
(decode beats raster under load) **and** cold-start (load reads disk). It honors
the documented principle: *one mechanism over one shared raster function, so a
heavier lever is a small add.*

**Rejected alternatives.** (B) A standalone `BakeManager` parallel to the
prewarmer — duplicates scheduling and yields two read paths that can drift. (C) A
Rust/resvg baker off the main thread — a new heavy dependency that risks pixel
divergence from the JS rasterizer, breaking *preview == export by construction*;
a possible future lever, not v1.

## Components

### 1. fs prerequisite (Rust — mandatory; nothing works without it)

Grant the fs operations and extend the runtime scope to the open workspace:

- Capabilities: `fs:allow-mkdir`, `fs:allow-write-file`, `fs:allow-read-file`,
  `fs:allow-read-dir`, `fs:allow-remove`, `fs:allow-exists`.
- Dynamic scope: on project open, `app.fs_scope().allow_directory(ws, true)`.
  `default.json` cannot express the user-chosen workspace path the way
  `$TEMP/**` ships, so the scope must be granted imperatively at open time
  (and the prior workspace's allowance dropped on project switch).

This widens the app's fs surface to exactly the open workspace directory the
user already chose. After this lands, `frameCache.ts`'s L2 methods work
unchanged (they were written against the real plugin, no faking).

### 2. Baked-key index (avoids per-frame `exists` IPC)

On project load, one `readDir(<workspace>/Cache/raster)` builds an in-memory
`Set<string>` of baked `hash(cacheKey)` directory names; `writePng` adds to it.
`resolveTemplateFrame` only attempts a disk read when the content's
`hash(cacheKey)` is in the set — so an un-baked template never pays a per-frame
`exists`/`readFile` round-trip. The same load pass calls
`gcUnreferenced(activeCacheKeys)` to sweep orphan dirs left by stale props/dims.

Lives alongside `sharedTemplateFrameCache` in `templateRaster.ts` (the shared
module both the sprite and prewarmer import), so there is one index per process.

### 3. `resolveTemplateFrame` (the shared read-through/write-through fn)

New function in `templateRaster.ts`, the single entry point replacing
`rasterTemplateFrame` for the sprite and prewarmer:

```
resolveTemplateFrame(template, cacheKey, frame, tSec, durationSec,
                     canonicalProps, { persist }) → Promise<ImageBitmap>
```

- Read-through (gated by the baked-key index; errors swallowed → raster).
- Miss → `rasterTemplateFrame`; if `persist` → encode PNG + `writePng`
  (fire-and-forget; failures logged, never thrown).
- Never touches the cache itself — callers `setFrame` the result, as today.

`persist` is true when the global setting is on **or** this content has been
manually pre-baked this session. The Compositor passes the current `cacheKey`
(it already has the descriptor) so the resolver needn't recompute it.

### 4. `TemplateBaker` (the writer / full-content driver)

A small idle-paced driver, sibling to `TemplatePrewarmer`, reusing the same
per-content `render(frame)` closures and the raster pool. It differs from the
prewarmer in plan and persistence:

- **Plan:** the **full `[0, contentDurationFrames)`** per content (disk isn't
  bounded by the in-RAM `cap`), **playhead-first** (visible frame, then forward,
  then backfill), **skipping frames already on disk**.
- **Pacing:** time-sliced on `requestIdleCallback` (the prewarmer's
  `scheduleIdle`/`cancelIdle`), a small frame budget per tick, yielding between.
- **Debounce + cancel-in-flight** on edits (a prop change supersedes the bake).
- **Persists** each rastered frame via the resolver's `persist` path; updates the
  baked-key index.

Pure planner extracted as `bakePlan.ts` (full-content, playhead-first,
disk-skip), unit-tested in Node like `prewarmPlan.ts`.

### 5. Triggers

- **Global setting (default off).** Rust `AppSettings.prebake_templates: bool`
  (+ patch + default `false`); TS `AppSettings`/`AppSettingsPatch` in `ipc`; an
  atomic selector `usePrebakeTemplatesEnabled()` in `appSettingsStore.ts`; a
  "Pre-bake templates" toggle in `SettingsPanel.tsx`. When on, the Compositor
  feeds **every** active template content to the baker.
- **Per-layer "Pre-bake now".** A new `LayerContextMenu` item (Timeline),
  shown only for `layerKind === "Template"`, that enqueues a prioritized
  full-content bake of that one layer's content regardless of the global
  setting. The PNGs it writes are the persisted state — honored on reload via
  the read-through path even with the global toggle off (no model field needed).

### 6. PNG encode, key, resolution

- **Encode:** `OffscreenCanvas.convertToBlob({ type: "image/png" })` (PNG, not
  WebP — Canvas WebP is lossy and crisp text edges matter; ADR 0015). The SVG
  raster path is untainted, so encode succeeds.
- **Key:** reuse `templateFrameCacheKey` + `hashCacheKey` unchanged.
- **Resolution:** bake at **composition (display) resolution, never below**, so
  a scaled-up template never blurs. The key already carries `renderW/renderH`, so
  a composition resize re-keys → re-bake, and GC reclaims the orphan. (This
  contradicts the `templates.md` cache-key table line that says comp width/height
  is *not* a key change — reconcile that line to: bake res tracks display res, so
  comp resize re-keys.)

### 7. Per-layer status (reuse the designed surface)

Surface the existing `idle | rastering{progress} | ready | error` per-layer
state for bake feedback (context-menu disabled/labelled while baking, optional
small indicator). Read-only; agents observe, never drive (`docs/templates.md`
agent-surface section).

## Compositor wiring

- `updatePrewarmTargets` already maps active template layers → specs with a
  `render(frame)` closure. Point that closure at `resolveTemplateFrame` (with
  `persist` from the setting/manual state), so the prewarmer becomes disk-first
  for free.
- `TemplateSprite.captureAndBind` calls `resolveTemplateFrame` instead of
  `rasterTemplateFrame` (passing the descriptor's `cacheKey`), so on-demand
  misses are disk-first too.
- The Compositor owns the `TemplateBaker` (DOM-gated, like the prewarmer — never
  constructed in the export Worker), feeds it the same specs, and toggles its
  active set from the global setting + manual triggers.

## Testing

- **Node units:** `bakePlan` (full-content, playhead-first, disk-skip ordering);
  the baked-key index add/lookup/GC-set logic. Follows `prewarmPlan.test.ts`.
- **Real-WebView2 e2e:** the disk path can't be faked. Verify (a) a bake writes
  `<workspace>/Cache/raster/<hash>/<i>.png` for a template layer; (b) after a
  simulated reload the read-through binds frames from disk without rastering
  (assert no harness render for baked frames); (c) "Pre-bake now" writes a full
  content sequence; (d) GC removes an orphan dir after a prop change. Matches how
  the L1 pool/prewarm work was validated.
- **No regression:** existing template e2e (`templates.e2e.js`,
  `template_export.e2e.js`) stays green; export path unchanged in v1.

## Decisions (resolved)

- Global toggle **default off** — disk use is opt-in; manual pre-bake +
  disk-first read cover the rest.
- **Drop** the old measurement-driven auto-escalation — explicit triggers are
  simpler and predictable (YAGNI).
- **Export deferred** — `exportBake` reading disk-first is a near-free follow-up,
  not v1.
- Disk-first read is **unconditional once a key is in the baked index**, so a
  manual pre-bake persists and is honored on reload with the global toggle off.

## Docs to reconcile after build

- `docs/templates.md`: rewrite the L2 section (triggers = global toggle + manual
  "Pre-bake now", not measurement-driven), and fix the cache-key table line about
  composition width/height vs. bake resolution.
- ADR: a short ADR recording the L2-wiring decision (fs scope grant, disk-first
  shared resolver, "Pre-bake" naming, dropped measurement heuristic).
