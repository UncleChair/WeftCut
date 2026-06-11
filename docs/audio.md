# Audio

One model, two paths. The project's audio model — per-layer trim,
placement, `gain_db`, `pan`, fades, mute — is evaluated **once** into
sampled envelopes, and two thin renderers consume the same control
points: a Web Audio graph plays them in the preview, a Rust mixer
writes them at export. Neither path re-derives the model, so preview
and export cannot disagree about what a curve means; the only thing
either path owns is playback (or encoding) mechanics.

Decision record: [ADR 0019](adr/0019-audio-mixes-in-rust-over-conform-pcm.md).

Both paths read the same bytes: a **conform cache** holds every
audio-bearing source as canonical PCM, produced once at import. The
preview never decodes audio; the export never decodes audio; decode
variance between WebView2 and ffmpeg is out of the picture entirely.

## The conform cache

Every imported media with an audio stream gets a conform file —
WeftCut's equivalent of Premiere's CFA conform, and chosen for the
same reason Premiere states for theirs: the cache format **is** the
engine working format, so the hot path never converts.

**Canonical format: 48 000 Hz, 32-bit float, source channel count
capped at 2, interleaved.**

- **48 kHz** because video-world sources are overwhelmingly 48 kHz
  already — for them conform is a decode, not a resample — and it
  matches the typical device `AudioContext` rate. Resampling (44.1 kHz
  music, exotic rates) is paid once at import, never per
  playback/export. There is deliberately no per-project audio sample
  rate setting; the export target rate is a one-time `aresample` at
  encode.
- **f32** because `AudioBuffer` channel data is f32, the mixer
  accumulates in f32, and float headroom means gain staging cannot
  clip until the single quantization at encode.
- **Mono stays mono** (half the disk for the voice-recording class);
  >2-channel sources downmix to stereo at conform. Consumers up-mix
  mono via the pan law (below).
- **Interleaved** because the preview reads time-windows over
  `asset://` Range requests — one window, one contiguous byte range.

File layout (little-endian, sibling of the `.peaks` format):

```
magic        "VCONF\0\0\0"  (8 bytes)
version      u32            (CONFORM_FORMAT_VERSION)
sample_rate  u32            (48000)
channels     u32            (1 | 2)
frame_count  u64
data         interleaved f32 samples
```

Frame addressing is arithmetic: `offset = 28 + frame * channels * 4`.

**Producer:** `jobs/conform.rs`, one ffmpeg invocation
(`-i src -vn -ac {1|2} -ar 48000 -f f32le -`) streamed to
`Cache/audio/{blake3}.conform` through the standard job FIFO, with the
same pending-hash migration and skip-if-cached behavior as the
waveform job. Triggered at import for audio-bearing media; an
`ensure_conform` path covers media imported before the format existed
(and `CONFORM_FORMAT_VERSION` bumps). Job completion logs the file
size — conform costs ~1.4 GB per stereo source-hour (half for mono),
and that cost is deliberate; see the trade-off in ADR 0019.

The waveform job stays independent (22 050 Hz mono peaks); collapsing
it onto conform output is a possible later simplification, not a goal.

## The envelope contract

The heart of the design. For each audio layer, the shared animation
engine (the Rust/TS twin pair locked by golden vectors, see
[`render.md`](render.md)) resolves two envelopes over the layer's
local time span:

```
gain envelope  = lerp-sample(Animated gain_db, Δ = 10 ms)
                 → linear (10^(dB/20))
                 → × fade-in ramp × fade-out ramp     (linear ramps)
pan envelope   = lerp-sample(Animated pan, Δ = 10 ms), clamped [-1, 1]
```

The output is a list of `(t_ms, value)` control points. **Both
consumers linearly interpolate between the same points**:

- Web Audio applies the gain envelope with `setValueCurveAtTime` —
  whose semantics are exactly linear interpolation across the sampled
  array — and the pan envelope on `StereoPannerNode.pan`.
- The Rust mixer lerps per sample between the same points.

Identical points, identical interpolation: parity holds by
construction, not by tolerance. Properties that are fully static (no
keyframes, no fades) skip sampling and travel as a scalar.

Known quantization: a `Hold` keyframe's instant step becomes a ≤10 ms
ramp between the two grid points that straddle it. Accepted; 10 ms is
well under a frame.

The envelope sampler is itself a twin pair
(`audio envelope` in Rust and TS) with its own cross-language golden
fixture: same control points in, same per-sample gains out, asserted
in both unit suites. The engine-source drift discipline that applies
to the animation twins applies here identically.

Pan law: the Web Audio `StereoPannerNode` equal-power law (mono and
stereo input variants, per spec). The Rust mixer implements the same
formulas; the golden fixture covers both input layouts.

## Preview mixer

`render/audio/` replaces element-based playback with a
buffer-scheduled graph on one shared `AudioContext`:

```
per layer:  AudioBufferSourceNode (chunk)
              → GainNode        (gain envelope via setValueCurveAtTime)
              → StereoPannerNode (pan envelope)
              → master.input
master:     input → analyser (meter) → DynamicsCompressor
              (−1 dB, 20:1, 1 ms attack — soft overload protection)
              → destination
```

**Feeding:** chunks are read straight from the conform file over
`asset://` Range requests (loop-read until the exact byte count, the
established Range discipline) and de-interleaved into `AudioBuffer`s —
**no decode in the webview, ever**. Chunk length 1 s, lookahead 3 s,
at most 8 live chunks per layer (~3 MB). Mono conform produces mono
buffers; the panner up-mixes.

**Scheduling:** sample-accurate inside the audio clock domain —
`when = ctxTimeAtCompUs(anchor, chunkCompUs)` against the engine's
clock anchor. Chunks that would start in the past start now with a
compensating buffer offset.

**Clock:** the audio hardware clock is the master. One `ClockAnchor`
(a composition-µs ↔ `AudioContext.currentTime` pair, defined in
`chunkSchedule.ts` and nowhere else) is owned by the `PlaybackEngine`:
while the context is running, the playing position is DERIVED from
`ctx.currentTime` against it — pure mapping, no accumulation — and the
engine forwards the same anchor to every `AudioMixer`, which schedules
chunks against it. Playhead and audio share one clock by construction;
there is no second clock to reconcile, so there is no reconciler.
While the context is suspended (autoplay policy, before the first
gesture) the clock falls back to `performance.now()` deltas; the flip
back to audio-derived re-anchors from the current position, so
switching sources never jumps the playhead. The anchor is re-taken on
play and on seek-during-play; mixers detect the identity change and
reschedule behind a ~5 ms micro-fade.

**Edits during playback:** a parameter change re-derives the layer's
envelopes and reschedules that layer (`cancelAndHoldAtTime`, then
fresh curves — `setValueCurveAtTime` forbids overlapping automation,
so rescheduling is the only correct move). Seek/pause cancel all
scheduled sources; resume re-anchors. Mute and out-of-window layers
simply don't schedule.

The master meter (RMS + peak per channel) is engine plumbing in this
slice: surfaced to the dev PerfHUD and over MCP, with no product UI.
Mixer UI belongs to the UX redesign.

## Export mixer

`lower(project, target, window)` no longer produces an ffmpeg filter
graph; it produces a **MixPlan**: per audible layer, the conform path
+ channel count, source span, timeline placement, and the two
envelopes (or scalars). Layers whose conform is missing fail
readiness before any work starts.

The mixer (`export::mix`) is a block-pull loop, deterministic and
allocation-flat:

```
for each output block (65 536 frames, 48 kHz f32 stereo):
    zero the accumulator
    for each layer overlapping the block:
        map block window → source frames (t_start, src_in, clamped to src span)
        read frames from the conform file (seek = header + frame × ch × 4)
        gain = lerp(envelope) per sample;  pan via the shared law
        sum into the accumulator
    write the block, interleaved, to ffmpeg stdin
```

The frame grid derives from the export window with exact rational
math (the same discipline as the video `frameGrid`), so audio length
matches the video range to the sample.

ffmpeg's remaining role is the encode tail:

```
ffmpeg -f f32le -ar 48000 -ac 2 -i - \
       -af aresample={target_sr},alimiter=limit=0.891:level=false \
       -c:a {aac|libopus} -b:a {bps}  <temp audio file>
```

- `alimiter` (−1 dB ceiling) is **always on in this slice** (no user
  toggle yet; an export-settings switch can come later) — it is the
  answer to "two 0 dB layers sum past full scale". `level=false` is
  explicit because alimiter's auto-normalize default is a known trap.
  This is a sample-peak ceiling; true-peak oversampling is future
  work.
- The limiter only acts above its ceiling; material below −1 dB
  passes unchanged, and the existing Goertzel conformance gates
  (dominant frequency, SNR, alignment) are level-shift-insensitive
  either way.
- Everything downstream — temp-file naming, `mux_to_file`,
  transcode-and-mux, the no-audio-layers short-circuit, the
  `include=false` skip — is unchanged from
  [`rendering.md`](rendering.md).

The audio IR (`DecodeA/Adelay/Amix/OutA` and the lavfi emitter) is
retired by this design; the mixer plan is its replacement.

## Readiness and errors

- **Export:** conform readiness joins the existing media-readiness
  gate; the export auto-wait ("preparing") panel covers conform jobs
  exactly as it covers proxies, kicking `ensure_conform` for anything
  missing. A conform job that *failed* (unreadable audio) fails the
  export loudly with the media named — never a silent layer drop.
- **Preview:** a layer without conform (job still running, or failed)
  is silent and logs once to the status log. Range-read failures
  retry; a chunk that misses its deadline mutes briefly rather than
  glitching (underrun behavior).

## MCP surface

With this design, `gain_db`, `pan`, `fade_in_us`, and `fade_out_us`
take real effect in both preview and export. The MCP tool
descriptions must say so — the previous state (accepted but ignored)
was a silent-no-op trap for agents, and updating the contract text is
part of the same change that makes the fields live. The master meter
is additionally exposed as an MCP resource for agent-side level
checks.

## Testing

- **Cross-language goldens:** the envelope sampler fixture (control
  points → per-sample gains) asserted by both the Rust and TS unit
  suites; the pan-law fixture (mono + stereo).
- **Mixer unit tests:** pure f32-in/f32-out — placement, trim
  clamping, overlap summing, envelope application, block-boundary
  continuity.
- **Conformance E2E** (extends [`conformance.md`](conformance.md)):
  the deterministic mixer upgrades audio assertions from perceptual
  to analytic. New fixtures: a keyframed gain ramp (per-window RMS
  against the analytic envelope), fade-in/out, two-layer overlap
  (summing + limiter engagement), and pan (L/R energy ratio). The
  existing Goertzel tone/alignment suite continues to pass unchanged.
- Preview-side audio capture assertions (via
  `MediaStreamAudioDestinationNode` recording) are future work; in
  this slice preview correctness rides the shared-contract unit
  gates plus manual smoke.

## Out of scope here, designed elsewhere or later

- **Denoise** — offline job producing a processed sibling of the
  conform artifact (DeepFilterNet-class), never a realtime insert.
- **Retime / speed** — needs A/V group-coupling semantics first;
  component direction is signalsmith-stretch (same MIT algorithm
  available as Rust crate and AudioWorklet).
- **True-peak (oversampled) limiting**, loudness-normalize export
  option, track-level gain / buses / mixer UI, >stereo output,
  scrub audio.
