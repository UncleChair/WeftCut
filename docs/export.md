# Export

The export pipeline has three concerns:

1. **Visual preview + export** — both run through the PixiJS + WebCodecs
   compositor described in [`render.md`](render.md). One renderer
   module, mounted against a `<canvas>` on the main thread for
   preview and against an `OffscreenCanvas` in a Worker for export.
2. **Audio export** — the Rust block mixer sums conform PCM
   sample-accurately and pipes the mix to ffmpeg's encode tail
   (limiter + AAC/Opus), producing a temporary audio file when the
   user includes audio. The full audio architecture (conform cache,
   envelope contract, preview mixer) lives in [`audio.md`](audio.md).
3. **Final mux** — Rust stream-copy muxes the already-encoded video —
   written either by the WebCodecs path or by the native `ffmpeg` encode
   sink ([`render.md`](render.md)'s "Encode exits") — with the optional
   audio track into the user's chosen container.

This doc covers (2)'s export entry point and (3). For (1) see
[`render.md`](render.md) and [`preview.md`](preview.md); for the audio
engine itself see [`audio.md`](audio.md).

## Export settings and range

The renderer owns the `ExportSettings` schema in
`apps/desktop/src/render/exportSettings.ts`; Rust persists the saved blob as
opaque JSON. Audio settings are persisted:

- `include`: when false, JS skips audio export and produces video-only output.
- `codec`: `aac` or `opus`.
- `bitrate`: bits per second.
- `sampleRate`: `null` to follow the composition, otherwise a concrete output
  sample rate.
- `channels`: `null` to follow the composition, otherwise mono or stereo.

H.264 and HEVC can target `mp4`, `mov`, and `mkv`. AV1 can target `mp4` and
`mkv`; `mov` is rejected because ffmpeg's MOV muxer does not accept AV1. AAC is
valid in every supported container. Opus is restricted to `mkv` because
Opus-in-MP4/MOV playback is unreliable in Chromium/Electron. `mergeSettings` backfills
missing audio fields from `DEFAULT_AUDIO_SETTINGS` and snaps stale saved blobs
back to AAC if the selected container cannot hold the saved audio codec.

The export range is not persisted. `ExportSettingsDialog` keeps it as
dialog-local state: full project, or a custom `[startUs, endUs)` selected with
In/Out SMPTE timecode fields and "set to playhead" buttons. `clampExportRange`
keeps the span ordered and inside `[0, durationUs]`.

`App.tsx` threads the resolved range through all export stages:

- The readiness gate checks only video sources referenced by the export range.
- Motif layer frames are baked only for the export range before the Worker
  starts.
- `runPixiExport` receives `startUs` and `endUs`; the Worker renders that
  half-open range and resets output video timestamps to start at 0.
- `exportProjectAudioOnly` receives the same range so Rust trims the final
  audio mix to match.

## Audio-only export

`export::export_audio_only(app, &project, &output_path, &audio, window_us)` is
the single entry point. It delegates to the audio engine
([`audio.md`](audio.md)):

1. `audio::mix::plan_for_project(project, window_us) → MixPlan` — every
   audible Audio layer resolved to conform-file placement + sampled
   gain/pan envelopes. "Audible" applies the full skip-rule set from
   [`audio.md`](audio.md): track `enabled`/`muted`/`solo` gates,
   `Layer.enabled`/`locked`/`AudioParams.mute`, and overlap with the
   half-open export window — a layer entirely outside `[start, end)` is
   neither planned nor required to have a conform cache. An audible
   in-window layer whose conform cache is missing fails the plan loudly
   with the media named (the renderer's readiness gate normally prevents
   reaching that state).
2. If the plan has no layers (or the window is empty): log a warning and
   return `Ok(())`. The mux step downstream tolerates a missing audio file.
3. Otherwise: spawn ffmpeg reading raw f32 from stdin —

   ```text
   -f f32le -ar 48000 -ac 2 -i - \
     -af alimiter=limit=0.891:level=0 \
     -ar <target_sr> -ac <target_ch> -c:a <aac|libopus> -b:a <bps> <output>
   ```

   — and run the block mixer on a blocking thread, summing 65 536-frame
   stereo blocks from conform reads and piping them in. The `alimiter`
   ceiling (−1 dB sample-peak, auto-normalize explicitly off) is what
   keeps overlapping layers from clipping at encode.
4. On non-zero exit, return an error with the last ~8 lines of stderr.

The JS orchestrator chooses the temp audio extension from the selected codec:
AAC writes `.m4a`; Opus writes `.mka`. No `export:*` events are emitted from
this path; the renderer owns ExportPanel state.

When `settings.audio.include` is false, `App.tsx` skips
`exportProjectAudioOnly` entirely. When it's true, the export readiness
gate first asks Rust `ensure_export_audio_conform(start_us, end_us)` for
the media whose conform cache is absent or invalid — the command shares
`plan_for_project`'s layer walk (`conform_waiting_media`), so the gate
and the plan can never disagree on selection, and it validates the cache
file itself (`cached_ok`), not the store's `conform_path` (which goes
stale if the cache dir is cleared). The command kicks a conform job per
missing media; the gate holds in "preparing" until a
`media:job_complete kind=conform` event lands for every returned id
(`createConformTracker` in `exportReadiness.ts` — listeners register
before the command so a fast job can't complete unseen).

## Final mux

`export::mux_to_file(video_path, audio_path, output)` runs a stream-copy mux:

```text
ffmpeg -y -hide_banner -nostats \
       -i <video.mp4> \
       [-i <audio.m4a|audio.mka>] \
       -c copy \
       <output_path>
```

The audio input is optional. If the user excluded audio, or the project has no
audio layers and `export_audio_only` produced no temp file, `mux_args` omits the
audio `-i` and writes a video-only file.

Every export has already written its final codec before this step runs —
either the WebCodecs path's direct encode, or the native `ffmpeg` sink
described in [`render.md`](render.md)'s "Encode exits", which also applies the
`hvc1` tag HEVC needs in MP4/MOV. `mux_to_file` never re-encodes; it only
copies streams into the user-chosen container.

## Coverage

The root behavior above is guarded by focused tests and diagnostics; see
[`conformance.md`](conformance.md) for the media fixtures and E2E gates:

- `exportSettings.test.ts`: default merge/backfill, audio codec/container
  validity, estimate size, and range clamping.
- `frameGrid.test.ts`: half-open export frame counts and timestamp grid.
- Rust unit tests in `export/mod.rs`: AAC/Opus encode args, missing-audio
  mux arguments, and a real-ffmpeg mixer round-trip (two overlapping
  layers → AAC → decode → analytic peak).
- Rust unit tests in `audio/`: envelope sampling (cross-language goldens),
  pan law, block-mixer placement/summing.
- `media_conformance --audio`: frequency-based audio export diagnostics;
  `--audio-envelope` / `--audio-pan`: analytic RMS-envelope, limiter-ceiling,
  and pan-law gates (`audio/audio.e2e.js`).

## Proxies

Import generates the H.264 proxies the WebCodecs renderer decodes,
cached under `<cache>/proxies/<file_hash>.mp4` (skip-if-cached). There
are two, for two roles (full detail in [`preview.md`](preview.md) and
[`data-model.md`](data-model.md); ADRs 0009–0011):

- **Quick proxy** (`jobs/quick_proxy.rs`) — 720p, short fixed GOP
  (`PROXY_GOP_FRAMES`), `libx264 -preset ultrafast`, yuv420p. The
  **preview** scrub source. The short GOP bounds the
  seek-to-key-then-decode-forward tail to a few frames — frame-accurate
  live scrubbing (ADR 0008; ADR 0003's no-reset-on-forward-GOP-crossing
  still holds).
- **Export master** (`jobs/proxy.rs`) — source-resolution (≤4K) H.264,
  `-preset fast -crf 18 -profile:v high` (auto level), short GOP,
  `-bf 0`, yuv420p, `+faststart`. Generated only for sources WebCodecs
  can't decode directly; export decodes it (never the quick proxy). A
  `PROXY_FORMAT_VERSION` bump or `proxy_path = Some(None)` invalidates
  it for re-encode on next open.

Both recipes assert the source's ffprobe color tags on the encode and
write the mp4 `colr` atom (`source_color_args` + `+write_colr`; the
quick proxy's remux path derives colr from the input VUI), keeping
proxies color-readable to mediabunny, which never parses the SPS VUI
(ADR 0014).

Sources WebCodecs *can* decode are bypassed (no proxy) or DirectExport
(export reads the original); see the decode-routing summary in
[`data-model.md`](data-model.md).

## Background jobs

All ffmpeg-driven derivatives live under `jobs/`:

| Job | Output | Trigger |
|---|---|---|
| `proxy.rs` / `quick_proxy.rs` | source-res (≤4K) export master + 720p scrub proxy | Auto on import |
| `thumbnails.rs` | per-source thumb strip | Auto on import |
| `waveform.rs` | `.peaks` binary file | Auto on import (audio-bearing sources) |
| `conform.rs` | `.conform` canonical PCM (48 kHz f32, [`audio.md`](audio.md)) | Auto on import (audio-bearing sources); `ensure_conform` backfill |
| `frame.rs` | single PNG at a t_us | On-demand via `media://{id}/frame/{t}` |
| `import.rs` | source bytes copied into `<workspace>/Media/` | User import action |

Each job runs in a single-worker FIFO so disk I/O doesn't thrash.
Progress is surfaced over backend events (`media:job_started`,
`media:job_complete`, `media:job_error`).
