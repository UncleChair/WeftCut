---
status: accepted
---

# Motifs render as web pages captured via CDP, deterministic by clock takeover

## Context

ADR 0015's SVG `render(t)` engine bounded authoring to what SVG expresses, and
the in-webview HTML alternative is structurally dead: every `<foreignObject>`
raster is cross-origin-tainted in WebView2 (unreadable, un-encodable,
un-uploadable). Templates were rebuilt as **Motifs** around the one
DOM-to-bitmap path that grants full web fidelity *and* clean pixels.

## Decision

- **One capture path for every Motif.** A Motif is a normal HTML/CSS/JS page,
  loaded as the **top-level document of a single reused hidden WebView2
  window** and captured from Rust over the DevTools Protocol
  (`Page.captureScreenshot` — a real browser raster, not a canvas read-back,
  so taint never applies). There is no per-Motif engine field and no tiering.
- **Determinism by clock takeover, not cooperation.** The harness stubs
  `performance.now`/`Date.now`/timers/`requestAnimationFrame`, seeks
  CSS/WAAPI animations via `getAnimations()` + `currentTime`, and drives the
  page to each composition frame: a Motif renders as a **pure function of
  `t`** and never advances itself. The seek stays re-seekable (pause + set,
  never cancel/commit), and the gate is **perceptual** — live GPU-compositor
  layers jitter antialiased edges sub-unit between captures of the same
  frozen frame, so byte-identical is unachievable by construction.
- **Window-as-isolation.** Isolation comes from the dedicated hidden WebView2,
  capability denial on the `motif:` origin, and a `default-src 'none'` CSP
  (fully offline) — not from an inner sandboxed iframe.

## Alternatives considered and rejected

- **Engine tiering** (a per-Motif `"svg" | "satori" | "webview"` field):
  three renderers to keep pixel-consistent, and authors must learn which tier
  allows what. The untrusted-upload sandbox is needed anyway, so uniform JS
  adds no new security cost.
- **Real-time capture** (screen-record the live page): no scrubbing, export
  bound to wall-clock, preview ≠ export.
- **Record-once-then-replay**: bake is realtime-bound, every prop edit is a
  full re-bake, and runs jitter against each other. (Remotion and
  timesnap/timecut reached the same conclusion: own the clock.)
- **Inner opaque-origin sandboxed iframe** for stronger upload isolation:
  awkward asset/runtime delivery; deferred in favor of the offline
  window-as-isolation model.

## Consequences

- **Capture is round-trip-bound, not pixel-bound.** Warm sustained capture
  measured ~92 ms/frame (~11 fps) regardless of resolution — 120² costs about
  what 960² does, so a low-res preview tier buys nothing. No taint-free
  smooth on-demand live preview exists on this platform.
- Live preview is therefore the **RAM-preview model**: choppy-cold on-demand
  capture (L0), a playhead-lookahead prewarmer (L1), and a persisted PNG bake
  (L2), surfaced by a warming/ready status. Cost is managed by **cache dedup,
  not a second renderer** — a static overlay collapses to one capture.
- Export reuses the same captures (main process captures, the DOM-less Worker
  receives bitmaps) — preview pixels equal export pixels by construction.
- Capture output is lossless PNG with a forced-transparent CDP backdrop, so
  overlays keep real alpha.

The living design is [`docs/motifs.md`](../motifs.md).
