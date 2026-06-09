# Rendering

The render pipeline has three concerns:

1. **Visual preview + export** — both run through the PixiJS + WebCodecs
   compositor described in [`render.md`](render.md). One renderer
   module, mounted against a `<canvas>` on the main thread for
   preview and against an `OffscreenCanvas` in a Worker for export.
2. **Audio export** — an audio-only IR compiles to an ffmpeg lavfi
   graph; ffmpeg produces a temporary audio file when the user includes
   audio.
3. **Final mux / transcode** — Rust either stream-copy muxes the
   WebCodecs video with optional audio, or transcodes the H.264
   mezzanine before muxing for codecs not handled directly by WebCodecs.

This doc covers (2) and (3). For (1) see [`render.md`](render.md) and
[`preview.md`](preview.md).

## Export settings and range

The webview owns the `ExportSettings` schema in
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
Opus-in-MP4/MOV playback is unreliable in WebView2. `mergeSettings` backfills
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
- ffmpeg transcode progress uses `endUs - startUs` as its denominator.

## Audio IR

```rust
enum IRNode {
    DecodeA  { input: InputIdx, src_in_us: i64, src_out_us: i64 },
    Adelay   { in_: NodeId, offset_us: i64 },
    Amix     { inputs: Vec<NodeId> },
    OutA     { in_: NodeId, label: String, sample_rate: u32 },
}
```

That's the entire surface. The visual half of the IR was deleted with
the PixiJS migration; the compositor lives entirely on the webview
side now.

### Lowering

`lower(project, target) → IRGraph` walks every enabled, non-locked
layer with `LayerParams::Audio(_)`:

```text
DecodeA(media, src_in, src_out)
  → Adelay(layer.t_start_us)
```

Resulting nodes are collected into `audio_streams`. If non-empty,
they're combined via `Amix { inputs: audio_streams }` (or passed
through directly when there's a single source) and terminate in
`OutA { label: "aout", sample_rate: target.sample_rate }`.

Layers with `mute: true`, disabled layers, layers on disabled tracks,
and any non-audio layer kinds are skipped silently. The result is a
single audio terminal (`graph.audio_out = Some(out_a)`) or an empty
graph when no audio layers exist.

### Emit

`emit_ffmpeg(&graph, window_us) → FfmpegPlan` walks the graph depth-first from
`audio_out` and produces:

- A list of `-i <path>` arguments in declaration order
  (`graph.inputs` deduped by exact path).
- A `-filter_complex_script`-friendly multi-line filter body.
- The final `-map [aout]` argument, or `-map [awin]` when a final export
  window is applied.

The emitter is reachability-driven from the terminal: nodes the
terminal doesn't reach aren't emitted. When there are no audio
layers, `graph.audio_out` is `None` and `emit_ffmpeg` returns an
empty plan — `export_audio_only` then short-circuits without
invoking ffmpeg.

Each source decode is trimmed to the layer's source span and shifted by the
layer start. When `window_us` is present, the emitter appends a final
`atrim=start=...:end=...,asetpts=PTS-STARTPTS` after the mixed output. That
keeps a partial video export and its audio sample-accurate and aligned at
timestamp 0.

## Audio-only export

`export::export_audio_only(app, &project, &output_path, &audio, window_us)` is
the single entry point:

1. Build a `RenderTarget` from the composition, overriding sample rate and
   channel count when the webview supplied explicit audio settings.
2. `lower(project, target) → graph`.
3. `emit_ffmpeg(&graph, window_us) → plan`.
4. If `plan.maps.is_empty()` (no audio layers): log a warning and return
   `Ok(())`. The mux step downstream tolerates a missing audio file.
5. Otherwise: write the filter graph to a temp `.txt`, spawn ffmpeg with the
   plan's inputs/maps and audio encode args:

   ```text
   -filter_complex_script <file> -map <label> -c:a <aac|libopus> -b:a <bps> <output_path>
   ```

6. On non-zero exit, return an error with the last ~8 lines of stderr.

The JS orchestrator chooses the temp audio extension from the selected codec:
AAC writes `.m4a`; Opus writes `.mka`. No `export:*` events are emitted from
this path; the webview owns ExportPanel state.

When `settings.audio.include` is false, `App.tsx` skips
`exportProjectAudioOnly` entirely.

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

For codec/container combinations that cannot be emitted directly by the
WebCodecs path, the Worker first writes a high-quality H.264 mezzanine. Rust
then calls `transcode_and_mux`, selects a hardware or software ffmpeg encoder,
pins the requested GOP, copies the optional audio stream, and writes the
user-chosen container. HEVC in MP4/MOV is tagged as `hvc1` for downstream
compatibility.

## Coverage

The root behavior above is guarded by focused tests and diagnostics; see
[`conformance.md`](conformance.md) for the media fixtures and E2E gates:

- `exportSettings.test.ts`: default merge/backfill, audio codec/container
  validity, estimate size, and range clamping.
- `frameGrid.test.ts`: half-open export frame counts and timestamp grid.
- Rust unit tests in `export/mod.rs`: AAC/Opus encode args and missing-audio
  mux arguments.
- Rust IR tests: final `atrim`/`asetpts` appears only when an export window is
  present.
- `media_conformance --audio`: frequency-based audio export diagnostics.

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
| `frame.rs` | single PNG at a t_us | On-demand via `media://{id}/frame/{t}` |
| `import.rs` | source bytes copied into `<workspace>/Media/` | User import action |

Each job runs in a single-worker FIFO so disk I/O doesn't thrash.
Progress is surfaced over Tauri events (`media:job_started`,
`media:job_complete`, `media:job_error`).
