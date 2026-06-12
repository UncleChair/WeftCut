---
status: accepted
---

# Color converges once at ingest; the working space is the output space (sRGB/709)

## Context

Sources arrive with diverse colorimetry — 601/709 matrices, limited/full
range, 8/10-bit depth, and increasingly HLG/PQ HDR from phones. Three
places in the stack have already faced the same question independently
(how does a frame's declared color become correct pixels?) and arrived
at the same shape of answer:

- preview converts at decode output (`createImageBitmap`, ADR 0004's
  ring as a side effect),
- export converts in the `VideoClipSprite` snapshot (`drawImage`,
  ADR 0014),
- proxies assert source tags at transcode (`source_color_args` + colr).

Video platforms solve the industrial version of the problem the same
way: normalize every upload into a small set of canonical delivery
forms at ingest, rather than teaching every downstream component to
handle diversity. This ADR names the principle so future pixel paths
follow it instead of rediscovering (or violating) it.

## Decision

**All color conversion happens at explicit, gated chokepoints, placed
as early as the conversion is well-defined; everything downstream is
color-naive by design.** The working space is the delivery space —
sRGB for compositing, BT.709/limited 8-bit for encoded output. There
is no wide working space and no output transform stage.

A chokepoint is legitimate in exactly two forms:

- **Verified delegation.** The conversion math belongs to a platform
  component, but the routing is ours and the tag-honoring is proven.
  The browser 2D-canvas paths (`drawImage`, `createImageBitmap`) are
  the verified converters for YUV matrix/range (the snapshot rule in
  [`render.md`](../render.md); evidence in ADR 0014).
- **Owned parameters.** The conversion runs in territory we pin and
  version, with every knob explicit: the ffmpeg proxy recipes
  (`source_color_args`, `+write_colr`), and any future ingest tone map
  (curve choice, dither — explicit flags, never defaults).

Either way, **the conformance analyzer is the arbiter**: a chokepoint
is trusted only while a gate asserts its output. "Controlled" means
deterministic and assertable, not necessarily code we wrote.

What is *never* a chokepoint: a convenient default that does silent
color math. Two known offenders are fenced off:

- Pixi's raw-`VideoFrame` upload (`copyExternalImageToTexture`)
  converts everything as BT.709/limited regardless of tags —
  a destructive pixel mis-convert for 601/full-range sources.
- Chromium's implicit HDR→SDR tone map (an HLG/PQ frame drawn into an
  sRGB canvas). This is currently the only path HDR sources take — a
  tolerated gap, not an endorsement: it is unconfigurable, its look is
  nobody's creative decision, and it can drift across WebView2
  auto-updates with no gate to catch it. The candidate fix is a
  controlled proxy-time tone map (`zscale` linear → `tonemap`
  (bt2390/hable) → 709 + dither), which would also collect the
  10→8-bit banding (today a pure truncation, measured ~4× step loss
  on the Axis-B gradient).

### Placement rule

A conversion sits at the earliest point where it is well-defined and
cache-friendly:

- **Matrix/range** — cheap, deterministic, fully specified by the
  frame's tags: per frame, at decode output / sprite snapshot.
- **Tone map / gamut reduction** — expensive, lossy, and a creative
  choice: once per asset, at proxy generation, cached forever.

## Why a collapsed working space is correct (today)

- The output end is hard-capped: WebView2's WebCodecs encoder emits
  8-bit only and tags by resolution (ADR 0014). A wide working space
  would be quantized down to 8-bit 709 at the exit anyway.
- preview-equals-export: both surfaces share one Compositor. A single
  SDR composite is what makes the invariant cheap to keep.
- Every non-video layer (text, Motif CDP captures, color fills, image
  overlays) is authored in sRGB; one sRGB composite means no per-layer
  conversion design and Pixi stays entirely color-unaware.

## Consequences

- New pixel paths must either prove tag-honoring against the analyzer
  (verified delegation) or convert at an owned chokepoint *before* the
  color-naive zone. Binding any raw `VideoFrame` to Pixi is forbidden
  (the snapshot rule).
- The 601→709 normalization on export and the browser-tone-mapped HDR
  preview are both consequences of "working space = output space",
  not bugs.
- **Revisit trigger:** if 10-bit / HDR output becomes a deliverable
  (the native Rust export backend, roadmap post-v1), the model evolves
  from one chokepoint to two — ingest converges into a wide working
  space (linear / extended gamut) and an explicit per-target output
  transform (709 SDR, 2020 PQ) becomes the second chokepoint: the
  ACES / Resolve-style fully color-managed shape. The discipline
  carries over unchanged — conversions only at explicit chokepoints,
  every chokepoint behind a gate.
