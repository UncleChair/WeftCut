---
status: accepted
---

# Audio mixes in Rust over a 48 kHz float conform cache

## Context

The audio data model was ahead of the renderers: `AudioParams` carries
`gain_db: Animated<f64>`, `pan: Animated<f64>`, `fade_in_us`,
`fade_out_us` — and none of them did anything. The lavfi export path
(`DecodeA → Adelay → Amix → OutA`) read only trim, placement, and
mute; the preview played per-layer `<audio>` elements with OS mixing
and a 100 ms drift-snap. Three structural problems followed: the
model fields were a silent no-op trap (worst for MCP agents, which get
no signal that a accepted parameter is dead); preview and export were
two unrelated audio engines fed by two independent decoders (WebView2
vs ffmpeg) with no shared evaluation of anything; and
`amix=normalize=0` hard-clips at encode when overlapping layers sum
past full scale.

A cross-industry survey (clipcombo, Remotion, OpenCut, MLT, GES,
AVFoundation, Ardour, Olive, Premiere, After Effects, Final Cut)
established: the desktop-NLE canon is **one declarative model, two
thin renderers** — not one shared engine; `OfflineAudioContext` is
unsuitable for timeline-length renders (the spec allocates the full
result buffer up front, `suspend()` does not bound memory); Remotion's
volume-expression translation into ffmpeg works but is stepped,
quantized, and parser-stack-bounded; Premiere's CFA conform (decode
once at import into the engine's working format) is the proven move
for killing per-use decode and resample costs; and the float-mix /
single-quantization / explicit-limiter discipline is the consensus
clipping answer.

## Decision

- **Conform cache.** Every audio-bearing source is conformed at import
  to canonical PCM — 48 kHz, f32, interleaved, source channels capped
  at 2 (mono stays mono) — under `Cache/audio/{blake3}.conform` with a
  VPEAKS-style header. Both preview and export read conform and only
  conform: the preview over `asset://` Range windows with zero decode
  in the webview, the export mixer by direct frame-offset reads.
  48 kHz makes the dominant source class (video audio) a
  decode-without-resample; f32 makes the cache format identical to
  both consumers' working format; resampling is paid once at import
  rather than on every playback and export.
- **Envelope contract.** The shared golden-vector animation engine
  samples `gain_db` (composed with the fade ramps, converted to
  linear) and `pan` onto a 10 ms grid. Both renderers linearly
  interpolate the same control points — Web Audio via
  `setValueCurveAtTime`, the Rust mixer per sample. Parity is by
  construction, not by tolerance. The sampler is a Rust/TS twin pair
  with its own cross-language golden fixture, same discipline as the
  animation twins.
- **Preview** is a buffer-scheduled Web Audio graph (source → gain →
  stereo panner → master with meter + soft compressor), chunks
  scheduled sample-accurately against an anchor pair. The Pixi ticker
  stays master in this slice; cross-clock drift is re-anchored past
  40 ms. The audio-master clock upgrade is specified as future work in
  [`audio.md`](../audio.md).
- **Export** mixes in Rust: `lower` produces a MixPlan (layers +
  envelopes + placement), a block-pull loop sums f32 stereo blocks
  from conform reads, and ffmpeg's role shrinks to the encode tail —
  `-f f32le -i - -af aresample,alimiter=limit=0.891:level=false -c:a …`.
  The limiter (−1 dB sample-peak ceiling, auto-normalize explicitly
  off) is always on in this slice — it answers the overlap-clipping
  defect; a user toggle can land with export settings later. The
  audio IR and the lavfi emitter are retired.

## Alternatives considered and rejected

- **Enhanced lavfi graph** (keep the IR; add
  `volume='if(between(t,…))':eval=frame`, `afade`, `pan` filters —
  the Remotion-classic pattern): translates the model into a third
  language with per-audio-frame stepped gain, expression-size limits
  requiring value quantization, and a preview side whose
  interpolation semantics (linear ramps) never match the export side
  (steps). Parity becomes a tolerance negotiation across three
  implementations.
- **OfflineAudioContext export** (one Web Audio graph, two contexts —
  the clipcombo model): killed by the full-length upfront buffer
  allocation (~1.4 GB/h, unbounded by `suspend()`); segmented
  multi-context rendering loses stateful-node state at seams. The
  only surveyed project doing this is pure-web and caps renders at
  500 MiB with a skip fallback — a constraint WeftCut, with Rust at
  hand, has no reason to inherit.
- **All-TS export audio** (ADR 0001 redux — offline mix in the export
  Worker): already superseded once; the Worker has no Web Audio
  graph, and eager `decodeAudioData` RAM residency scales with source
  size. The conform cache + Rust mixer keeps memory flat regardless
  of timeline length.
- **Per-source native-rate conform** (no resample at import): pushes
  resampling into the mixer and the preview scheduler — paid on every
  use instead of once, the exact cost Blender's VSE profiling showed
  dominating its render-time mixing.

## Consequences

- `gain_db`, `pan`, and the fades become live in both paths; the MCP
  tool descriptions change in the same breath (the silent-no-op trap
  closes). `ir/` audio nodes, `emit_ffmpeg`, and the element-based
  `AudioMixer` are deleted; preview audio gains a master meter
  (PerfHUD + MCP only — mixer UI belongs to the UX redesign).
- Disk: ~1.4 GB per stereo source-hour (half for mono) of conform
  data, on top of proxies. Accepted deliberately — it buys the
  zero-decode read path on both sides; eviction policy remains part
  of the general cache story.
- Export audio becomes deterministic f32 math over deterministic
  bytes, so conformance upgrades from perceptual (Goertzel) to
  analytic assertions (envelope RMS, channel ratios, summing).
- Two new cross-language twin obligations (envelope sampler, pan law)
  join the engine-source drift discipline.
- The conform job joins proxy/waveform in the import path and the
  export readiness gate; first export after this change waits on
  conform for existing projects (`ensure_conform` backfill).
