# Audio conformance axis — design

## Goal

Extend the media-conformance harness with an audio axis that verifies the
exported audio against its source the way the video axis verifies frames:
**temporal alignment** (which segment, catching drop / reorder / duplication /
sync drift) plus **fidelity** (the audio content matches the source). The axis
exists to exercise the seam the video axis can't: video is rendered through
WebCodecs (Pixi) while audio is exported through the Rust ffmpeg path
(`export_audio_only` → AAC, then `mux_to_file` / `transcode_and_mux`). A/V sync
bugs live at that two-pipeline mux boundary.

No product code changes are expected — the audio export path already exists;
this axis *verifies* it.

## Data flow

```
test_1080p_30fps_audio.mp4  (burned-in counter video, true BT.709, + marked audio track)
  → e2e: import → 1:1 place → export (video=WebCodecs, audio=Rust ffmpeg→AAC, then mux)
  → media_conformance --audio --output <mp4> --source <mp4>
       (ffmpeg → PCM, Goertzel per window at the known candidate frequencies)
  → JSON report (per-second + overall) + exit code (0 pass / 1 regression / 2,3 error)
  → audio_conformance.e2e.js asserts alignment + drift + fidelity
```

The audio axis is parallel to the video axis (same Rust analyzer binary, same
report/exit-code shape) but uses an **independent fixture and an independent
spec**, so the video axis is unaffected.

## Fixture (`generate.go --audio`)

A new `--audio` flag adds a marked audio track and names the output
`test_<height>p_<fps>fps_audio.<ext>`. The video is identical to the standard
fixture (testsrc2 + burned-in counter, converted to true BT.709), so the same
clip can serve future cross-axis work.

The audio track is a sequence of **per-second pure-tone segments**, concatenated:

- Second `k` (k = 0 … duration−1) is a sustained sine at `F_k = 400 + 120·k Hz`
  (seconds 0–9 → 400 … 1480 Hz). The frequencies are well separated and kept in
  a clean low band to avoid harmonic confusion.
- 48 kHz, mono.
- The phase discontinuity at each second boundary produces a brief broadband
  click — used as the per-second onset marker for sync.

One signal yields all three measurements: the **frequency** identifies the
second (alignment), the **frequency step / click time** marks the second
boundary (sync), and the **tone purity** gives fidelity.

## Analyzer (`media_conformance --audio` mode)

A new `--audio` flag switches the existing binary to audio analysis (the video
frame-extraction path is untouched).

1. Shell ffmpeg to decode the output (and source) audio to PCM (mono, 48 kHz,
   to a temp WAV). ffmpeg's default decode applies the container edit list, so
   AAC priming is compensated at the decoder; any residual constant offset is
   handled by the drift-based sync criterion below.
2. Window the PCM (~100 ms window, ~25 ms hop). For each window run **Goertzel**
   (hand-written, ~15 lines, no new dependency) at each candidate frequency in
   the known set `{F_k}`, producing a magnitude per candidate.
3. Per window: the dominant candidate frequency → which second; the window where
   the dominant frequency changes → the second-boundary onset time; the dominant
   magnitude relative to off-frequency energy → SNR.
4. Aggregate into:
   - **Alignment**: the per-second dominant frequency must equal `F_k`, and the
     detected frequency *sequence* must equal the expected sequence (catches
     drop / reorder / duplication).
   - **Sync / drift**: fit detected second-boundary times against expected
     (`k` seconds) → `drift_slope` and `offset_ms`.
   - **Fidelity**: per-second SNR in dB.

Report (JSON, mirroring the video report shape):

- per-second: `{ second, expected_freq, detected_freq, aligned, onset_ms,
  expected_onset_ms, sync_offset_ms, snr_db, pass }`
- overall: `{ drift_slope, offset_ms, duration_ok, pass }`

Exit codes match the video mode (0 pass, 1 regression, 2 bad-args, 3 hard error).

## Pass / fail criteria

- **Alignment** — STRICT: every second's dominant frequency equals the expected
  `F_k`, and the sequence matches exactly.
- **Drift** — STRICT: `|drift_slope − 1|` corresponds to ≤ ~1 frame (33 ms) over
  the whole clip. This is the real A/V-sync bug.
- **Absolute offset** — LOOSE: `|offset_ms| ≤ ~2 frames (66 ms)`, tolerating AAC
  encoder priming (a constant lag, not a drift).
- **Fidelity** — per-second `snr_db ≥` a floor, initially ~20 dB, re-calibrated
  after the first real run (as the video axis's 0.80 SSIM floor was).
- **Presence / duration** — audio exists and its duration matches the video
  within tolerance.

**Why this validates A/V sync without an explicit cross-check:** the audio drift
criterion measures audio markers against the absolute time grid (`k` seconds);
the video axis independently validates frames against the same absolute grid
(`N / fps`). Both aligning to the absolute grid implies they align to each other,
so no explicit audio-vs-video correlation is needed in v1.

## E2E spec

A new `audio_conformance.e2e.js` (separate from the video spec): wait for the
hooks, create a project, import `test_1080p_30fps_audio.mp4`, 1:1-place it,
export, then run `analyze({ audio: true, … })` and assert alignment + drift +
fidelity. The export is driven fire-and-forget with the same node-side phase
poll as the video spec. Ships `describe.skip` until the first run validates it,
then un-skipped (the established flow).

`analyze.mjs` gains an `audio` passthrough (adds `--audio` to the argv).

## Testing

Rust unit tests for the pure analysis pieces:

- Goertzel: given synthetic PCM of a known tone, it reports the correct
  candidate frequency as dominant with the expected magnitude, and rejects
  off-frequency tones.
- Alignment / drift logic: given a synthetic detected-frequency sequence and
  synthetic boundary times, it flags reorder / drop and computes the right
  drift slope and offset.

## Out of scope (follow-ups)

- Audio on the full fixture matrix (other fps / containers / prores) — only the
  30 fps mp4 audio fixture is generated for the first slice.
- Multi-track / mixed-audio projects, gain / fades, channel layouts beyond mono.
- Explicit audio-vs-video correlation (the transitive absolute-grid argument
  covers v1).
