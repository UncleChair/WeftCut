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
variance between Chromium/Electron and ffmpeg is out of the picture entirely.

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
  `weftcut-media://` HTTP Range requests — one window, one contiguous
  byte range.

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

The heart of the design. For each audio layer, the shared keyframe engine
(now the single `weftcut-eval` leaf — compiled natively for Rust and to
wasm for the renderer, see [`render.md`](render.md) and
[ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md)) resolves two
envelopes over the layer's local time span:

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
  array — and the pan coefficient curves via `setValueCurveAtTime` on
  the matrix `GainNode`s.
- The Rust mixer lerps per sample between the same points.

Identical points, identical interpolation: parity holds by
construction, not by tolerance. Properties that are fully static (no
keyframes, no fades) skip sampling and travel as a scalar.

Known quantization: a `Hold` keyframe's instant step becomes a ≤10 ms
ramp between the two grid points that straddle it. Accepted; 10 ms is
well under a frame.

The envelope sampler's drift-prone math is single-sourced in the
`weftcut-eval` leaf (native for Rust, wasm for the renderer): `db_to_linear`
(`10^(dB/20)`), the keyframe interpolation it samples, the **fade ramp**
(`fade_multiplier`), and the **equal-power pan law** (`pan_coeffs`). The
sampler STRUCTURE around them — the 10 ms grid loop and the per-sample lerp —
is still parallel Rust/TS code, guarded by `audioEnvelopeGolden.fixture.json`.

Pan law: the equal-power law is a time-varying 2×2 mix matrix
`[a,b,c,d]` (`out_l = a·l + b·r`, `out_r = c·l + d·r`), computed by
`weftcut-eval::pan_coeffs`. The canonical pan control points are the
COEFFICIENTS, sampled on the 10 ms grid; both consumers lerp coefficients
(export per-sample, preview via `setValueCurveAtTime`) — the same grid →
lerp discipline as gain, so parity holds by construction. The
`panLawGolden.fixture.json` covers mono + stereo branches; the pan
coefficient envelope is additionally covered in the envelope golden.

## Preview mixer

`render/audio/` replaces element-based playback with a
buffer-scheduled graph on one shared `AudioContext`:

```
per layer:  AudioBufferSourceNode (chunk)
              → GainNode        (gain envelope via setValueCurveAtTime)
              → ChannelSplitter → 4×GainNode → ChannelMerger
                                (pan matrix; coefficient curves from the
                                 weftcut-eval pan law — mono uses 2 gains)
              → trim GainNode   (micro-fades, re-anchor masking)
              → master.input
master:     input → analyser (meter) → DynamicsCompressor
              (−1 dB, 20:1, 1 ms attack — soft overload protection)
              → destination
```

**Feeding:** chunks are read straight from the conform file over
`weftcut-media://` HTTP Range requests (loop-read until the exact byte
count, the established Range discipline) and de-interleaved into
`AudioBuffer`s — **no decode in the renderer, ever**. Chunk length 1 s, lookahead 3 s,
at most 8 live chunks per layer (~3 MB). Mono conform produces mono
buffers; the pan matrix routes the single channel to both outputs via
the mono pan law (2 gains).

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
scheduled sources; resume re-anchors. Mute, track-silenced, and
out-of-window layers simply don't schedule.

**Layer skip rules (preview and export share rules 1–6):**

1. `Track.enabled == false` — the whole track is off; skip all its audio layers.
   This is the one whole-track gate left: track `muted`/`solo` no longer gate
   audio (audio mute/solo moved to roles — see Roles below).
2. The layer's role is muted (`RoleMixSettings.muted == true`) — every layer
   tagged with that role is silenced.
3. A role-solo set is non-empty — any role with `solo == true` exists; skip
   layers whose role is not soloed. (An empty solo set → normal path.)
4. `mute wins over solo` — a role that is both muted and soloed is silent, and a
   muted role inside a solo set never reopens.
5. `Layer.enabled == false` — the individual layer is off; skip it regardless of
   role flags.
6. `AudioParams.mute == true` — the layer's own clip mute; skip it.
7. `Layer.locked == true` — **export-side only**: the export planner drops locked
   layers' audio; the preview mixer does not apply this rule, so a locked layer
   still plays back. The divergence is inherited, not designed — locking is an
   edit guard, and silencing on lock is arguably wrong on both sides.

The mute/solo half of these rules is evaluated against the project's `audio_roles`
table, so it is consistent whatever track a layer lives on. The mute/solo
DECISION itself now runs the shared `weftcut-eval` leaf (`role_audible` — native
in the export planner `audible_audio_layers`, wasm in the preview gate
`roleGate.ts`; [ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md)) and is guarded
by the `roleGateGolden.fixture.json` cross-language golden. The layer-selection
loop around it (track + window gating) stays parallel on the two sides.

The master meter (RMS + peak per channel) is surfaced to the dev
PerfHUD and over MCP for level checks.

## Roles

Audio mixing groups by **role**, not by track. A role is a per-layer
tag on `AudioParams` — Dialogue (the default), Music, SFX, or
Voiceover — and each role is a mix bus. The buses live project-level in
`Project.audio_roles`, one `RoleMixSettings { gain_db, muted, solo }`
per role; an absent entry resolves to defaults (0 dB, unmuted,
unsoloed) via `role_mix`, so a project that never touched the mixer
plays every role at unity. Decision record: [ADR 0023](adr/0023-audio-mixes-by-role-not-track.md).

v1 realizes the bus by **folding**: the role's `gain_db` is converted
to linear and multiplied into every member layer's gain envelope before
the block loop, and role mute/solo simply filter which layers enter the
plan. There is no separate summing stage per role — the per-block
accumulator loop is unchanged from a track-less mix. A future per-role
effect insert (`RoleMixSettings.effects`) is the deferred extension
point that would turn the fold into a real bus with its own DSP; it is
named in the data model and does nothing yet.

Three control levels stack, each owning a different scope:

- **Clip mute** (`AudioParams.mute`, per layer) — silence one layer.
- **Role mute / solo / gain** (`audio_roles`, the mix) — silence,
  isolate, or trim a whole category of sound at once ("all dialogue",
  "just the music").
- **Track `enabled`** (the eye toggle, whole track) — turn an entire
  track's picture *and* audio off together.

Role gain is a **recorded** edit — `set_role_gain` lands on the undo
stack like any parameter change. Role mute and solo (`update_role_flags`)
are **unrecorded** preferences applied to every history snapshot, so
Ctrl-Z never flips a mixer toggle — the same convention as the track
eye/lock flags. The Mixer panel is the surface that drives these.

## Export mixer

`lower(project, target, window)` no longer produces an ffmpeg filter
graph; it produces a **MixPlan**: per audible layer, the conform path
+ channel count, source span, timeline placement, and the two
envelopes (or scalars). The plan applies the same layer skip rules as
the preview (see above) — the `Track.enabled` whole-track gate, the
role mute/solo gates, and `Layer.enabled`/`AudioParams.mute` all take
effect in export, and each role's gain is folded into its layers'
envelopes. Layers whose conform is missing fail readiness before any
work starts.

The mixer (`export::mix`) is a block-pull loop, deterministic and
allocation-flat:

```
for each output block (65 536 frames, 48 kHz f32 stereo):
    zero the accumulator
    for each layer overlapping the block:
        map block window → source frames (t_start, src_in, clamped to src span)
        read frames from the conform file (seek = header + frame × ch × 4)
        gain = lerp(envelope) per sample
        pan  = lerp(pan_coeffs) per sample → 2×2 matrix (the shared leaf law)
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
- Everything downstream — temp-file naming, `mux_to_file`, the
  no-audio-layers short-circuit, the `include=false` skip — is
  unchanged from [`rendering.md`](rendering.md).

The audio IR (`DecodeA/Adelay/Amix/OutA` and the lavfi emitter) is
retired by this design; the mixer plan is its replacement.

## Readiness and errors

- **Export:** conform readiness joins the existing media-readiness
  gate; the export auto-wait ("preparing") panel covers conform jobs
  exactly as it covers proxies. The wait set comes from Rust
  (`ensure_export_audio_conform`, sharing the mix plan's audible-layer
  walk and validating the cache file itself), and completion is tracked
  by `media:job_complete kind=conform` events — the store's
  `conform_path` can't carry this wait because a stale path reads
  identically before and after a re-conform. A conform job that
  *failed* (unreadable audio) fails the export loudly with the media
  named — never a silent layer drop.
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

- **Cross-language goldens:** the envelope sampler fixture (gain control
  points + pan values + pan coefficient envelope) and the pan-law fixture
  (`pan_coeffs` mono + stereo branches + apply rows), each asserted by both
  the Rust and TS suites against one checked-in fixture — also the
  native↔wasm `libm` trig determinism proof.
- **Preview pan graph:** an `OfflineAudioContext` render test
  (`e2e/electron/audio-pan-preview.spec.ts`) drives the real
  `buildPanGraph` + `panCurves` and checks output L/R against the
  equal-power law — covering the matrix-mixer wiring the math goldens
  cannot reach.
- **Mixer unit tests:** pure f32-in/f32-out — placement, trim
  clamping, overlap summing, envelope application, block-boundary
  continuity.
- **Conformance E2E** (extends [`conformance.md`](conformance.md)):
  the deterministic mixer upgrades audio assertions from perceptual
  to analytic. New fixtures: a keyframed gain ramp (per-window RMS
  against the analytic envelope), fade-in/out, two-layer overlap
  (summing + limiter engagement), and pan (L/R energy ratio). The
  existing Goertzel tone/alignment suite continues to pass unchanged.

## Out of scope here, designed elsewhere or later

- **Denoise** — offline job producing a processed sibling of the
  conform artifact (DeepFilterNet-class), never a realtime insert.
- **Retime / speed** — needs A/V group-coupling semantics first;
  component direction is signalsmith-stretch (same MIT algorithm
  available as Rust crate and AudioWorklet).
- **Per-role DSP effects** — the `RoleMixSettings.effects` insert that
  would make each role a true processing bus; v1 folds role gain only.
- **True-peak (oversampled) limiting**, loudness-normalize export
  option, >stereo output, scrub audio.
