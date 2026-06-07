# Motifs editor integration & cutover — design

- **Status:** design approved 2026-06-07 (latency validated); spec under review before planning.
- **Builds on:** `2026-06-07-motifs-webcap-design.md` (the webcap capture core, Plan 1, merged) — this spec operationalizes its §6 (cache), §7 (compositor), §8 (export) against the existing codebase and adds the cutover from the SVG template system.
- **Goal:** a Motif renders live in the editor preview and exports — by **redirecting the existing template pipeline's frame source from SVG-raster to the webcap CDP capture**, renaming `Template*`→`Motif*`, and retiring the SVG machinery. Not a from-scratch build.

## 1. The constraint that shapes everything (measured 2026-06-07)

Warm, sustained CDP capture of a Motif is **~92 ms/frame (~11 fps)**, and:
- **release ≈ debug** (91.6 vs 93.0 ms) — not a compute bottleneck.
- **cold ≈ warm** — not first-load overhead.
- **round-trip-bound, not pixel-bound** — 120×120 (84.5 ms) vs 960×960 (102.7 ms): 64× pixels, ~18 ms. **Low-res preview does not pay off.**

The per-frame cost is 3 CDP round-trips (`__motifRender` eval + `setDeviceMetricsOverride` + `captureScreenshot`) plus `__motifRender`'s ~33 ms double-rAF settle. Trimming the redundant `setDeviceMetricsOverride` (fixed res across frames) and tuning the settle can lift the **fill rate** toward ~15–17 fps, but does not change the conclusion:

> **There is no taint-free path to smooth on-demand live preview for arbitrary web content.** (Canvas/shared-texture alternatives re-hit the `foreignObject` taint wall; low-res is ruled out.) Live preview must be **cache-backed (prewarm + persist)** — the After Effects "RAM-preview / green-bar" model.

This is accepted as the product model: **Motifs warm-then-play; they are not buttery-smooth on first touch.**

## 2. Approach: reuse-and-redirect, don't rebuild

The existing SVG template feature already implements the whole editor integration. The exploration (2026-06-07) confirmed these exist and are structurally reusable:

| Layer | Exists today (SVG) | This milestone |
|---|---|---|
| Data model | `LayerParams::Template(TemplateParams{ template_id, template_version, props, src_in_us, transform, opacity })` | rename → `Motif(MotifParams)` (shape/semantics unchanged; field names follow the rename, e.g. `template_id`→`motif_id`) |
| Commands + MCP | `add_template`/`list_templates` (Tauri + MCP), `update_layer_params` w/ `TemplatePatch` | rename → `add_motif`/`list_motifs`/`MotifPatch` |
| Compositor | `Compositor.compositeFrame` → `TemplateSprite.update(view, tInLayerUs, durationUs, injectedFrames?)` | rename → `MotifSprite`; **swap frame source** |
| Cache | `frameCache.ts` (L0 in-RAM LRU + L2 on-disk PNG), prewarmer, export baker | **reuse**, redirect fill to CDP capture |
| Picker UI | `TemplatePicker.tsx` | rename → `MotifPicker` |
| Frame source | iframe harness + `rasterPool`/`rasterSlot` + `svgRaster` (`render(t)→SVG→ImageBitmap`) | **delete**; replaced by `captureMotifFrame` (CDP) |

IR is audio-only; templates bypass it (no IR work). Frame-time math (`tInLayerUs = tUs − t_start_us`, `durationUs = t_end_us − t_start_us`), transform/opacity application, z-order, and the `src_in_us`/content-duration windowing all carry over unchanged.

## 3. The core change: frame-source redirect

`MotifSprite` keeps the existing two-path shape, with the source swapped:

- **Preview path (cache miss):** today `captureAndBind` calls `rasterTemplateFrame(...)` (JS iframe SVG raster). Replace with `captureMotifFrame(motifId, tSec, props, w, h)` (the Plan-1 IPC → Rust → CDP → base64 PNG → `createImageBitmap`). The cache key, frame-index math, and the async race-guard (`targetCacheKey`/`targetFrame`) are unchanged.
- **Preview path (cache hit):** unchanged — `sharedMotifFrameCache.getFrame(cacheKey, frame)` returns the bitmap synchronously and binds it.
- **Export path:** unchanged shape — the baker pre-fills frames on the main process; `MotifSprite.update(..., injectedFrames)` binds synchronously (Worker-safe).

Because capture is now a JS↔Rust↔CDP round-trip (not pure-JS), the **prewarmer and baker become the primary fill mechanism** (on-demand is the cold fallback). They call `captureMotifFrame` instead of `rasterTemplateFrame`; their scheduling (idle-sliced, playhead-first, dedup-by-cache-key) is unchanged but now fills at ~11–17 fps instead of ~hundreds.

### Throughput optimizations (fold into the capture path)
1. **Set device metrics once.** `motif_capture_frame` currently calls `setDeviceMetricsOverride` every frame. When the host's size is unchanged, skip it — saves one of three round-trips. (Track the host's current (w,h); only re-issue on change.)
2. **Tunable settle.** `__motifRender`'s double-rAF settle (~33 ms) is needed for canvas/WebGL paints; expose a single-rAF (or zero) settle mode for Motifs that don't need it, to raise fill rate. Default stays safe (double-rAF).

These are fill-rate improvements, not correctness; measure during implementation.

## 4. Cache, prewarm, persist (reuse `frameCache` + prewarmer + baker)

- **L0 on-demand** — playhead frame captured on miss, bound, cached. Cold playback/scrub is choppy (~11–17 fps) but correct.
- **L1 prewarm (always on)** — continuously fills the shared cache ahead of the playhead, paused and playing, idle-sliced. Fill is sub-realtime, so a fresh Motif's frames arrive over ~2–3× its content duration. Dedup-by-content-cache-key so N identical Motifs warm one set.
- **L2 persist (measurement-driven)** — PNG sequence under `<workspace>/Cache/raster/`, keyed by `(motifId, version, canonicalProps, renderW, renderH, fpsNum, fpsDen, durationFrames)`. Pay once; survives reload; export reads it off disk. Safe to delete; regenerates.

The cache **key and tiers are the existing ones**; only the producer changes (CDP capture). Transform/opacity/window are not in the key (sprite-applied; absolute-content-frame keyed) — unchanged.

## 5. Warming UX (the green bar)

The capture is slow enough that the user must see warming state, or live preview reads as "broken/janky."

- Each Motif layer exposes a raster state — reuse/extend the existing read-only status (`idle | rastering{progress} | ready | error`) already surfaced for templates.
- Surface it on the layer in the timeline (a small "rendering N%" indicator / tint) and optionally a thin cache-coverage bar on the layer span (the AE green-bar). Driven by the prewarmer's progress over the layer's content frames.
- On a cold frame in the preview (no cached bitmap yet), the sprite holds the **last bound bitmap** rather than flashing empty; a first-ever-cold Motif shows a neutral placeholder until frame 0 arrives.
- `prefers-reduced-motion` and the existing picker hover-preview behavior carry over.

## 6. Export

The main-process baker pre-captures every Motif layer's frames (composition fps grid, export resolution) via CDP before the encode loop and hands bitmaps to the Worker — the existing "preparing" wait covers it. At ~11–17 fps bake, a 10 s Motif takes ~15–25 s to bake; acceptable and surfaced. When a Motif is already L2-persisted at export resolution, the Worker reads its PNGs directly (no re-capture).

## 7. Cutover & deletion

Rename in place (`Template*`→`Motif*`) across the cutover surface (Rust: `state/layer.rs`, `state/actor.rs`, `commands.rs`, `mcp/mod.rs`, `templates/`→`motifs/`; TS: `render/sprite`, `render/templates/`→`render/motifs/`, `ipc/`, `Compositor.ts`, the picker). **Delete** the SVG-only machinery (`harness.ts`, `harnessFrame.ts`, `svgRaster.ts`, `rasterPool.ts`, `rasterSlot.ts`, `fontFace.ts`, `Rasterizer.ts`, and the `templates/` Rust catalog once `motifs/` owns the catalog). **Keep & redirect** `frameCache.ts`, the prewarmer, the baker, `templateFrames.ts` (frame-grid math), `templateFrameDescriptor.ts` (cache key) — moved under `motifs/` and pointed at CDP capture.

The single built-in `countdown` is already reauthored (Plan 1). No other built-ins to port.

## 8. Compatibility: none (clean break)

Pre-release — **no backward compatibility is preserved.** The rename is a hard break: no serde aliases, no migration pass. Saved projects containing `LayerParams::Template` are simply unsupported and may fail to load; that is acceptable. This keeps the cutover purely a rename + redirect with zero migration machinery.

## 9. Boundaries / staging / risks

- **In scope:** the rename/cutover, frame-source redirect, cache/prewarm/persist redirect + throughput opts, warming UX, export baker redirect, SVG deletion.
- **Out of scope:** user-uploaded Motifs and the untrusted-content security hardening (separate plan — built-ins only here); multi-Motif host navigation (the Plan-1 host errors on a 2nd id — this milestone wires the host to navigate/reuse across motif ids, OR keeps one host per id; decide in planning); a faster capture primitive (e.g. `Page.startScreencast`) — deferred, the RAM-preview model stands without it.
- **Staging (for the plan):** (1) data-model + command/MCP rename (mechanical, green build); (2) thin vertical slice — `MotifSprite` + on-demand CDP capture + cache hit/miss, so `countdown` renders live in preview (choppy, no prewarm yet) and proves the integration + the JS round-trip cost; (3) prewarm/persist redirect + throughput opts + warming UX (smooth-after-warm); (4) export baker redirect; (5) delete SVG machinery + picker rename.
- **Risks:** the prewarmer was tuned for ~hundreds-fps SVG raster; at ~11–17 fps its idle-slicing/budget assumptions need re-tuning (it must not block the UI while filling slowly). The host-navigation/lifecycle for multiple distinct Motifs on one timeline is unproven (Plan-1 host is single-Motif). Both surface in stage 3.
