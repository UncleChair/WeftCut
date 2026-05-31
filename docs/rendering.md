# Rendering

The render pipeline has three concerns:

1. **Visual preview + export** — both run through the PixiJS + WebCodecs
   compositor described in [`render.md`](render.md). One renderer
   module, mounted against a `<canvas>` on the main thread for
   preview and against an `OffscreenCanvas` in a Worker for export.
2. **Audio export** — an audio-only IR compiles to an ffmpeg lavfi
   graph; ffmpeg produces `audio.m4a`.
3. **Final mux** — `ffmpeg -c copy` stitches the WebCodecs video.mp4
   with the audio.m4a into the user's output path.

This doc covers (2) and (3). For (1) see [`render.md`](render.md) and
[`preview.md`](preview.md).

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

`emit_ffmpeg(&graph) → FfmpegPlan` walks the graph depth-first from
`audio_out` and produces:

- A list of `-i <path>` arguments in declaration order
  (`graph.inputs` deduped by exact path).
- A `-filter_complex_script`-friendly multi-line filter body.
- The final `-map [aout]` argument.

The emitter is reachability-driven from the terminal: nodes the
terminal doesn't reach aren't emitted. When there are no audio
layers, `graph.audio_out` is `None` and `emit_ffmpeg` returns an
empty plan — `export_audio_only` then short-circuits without
invoking ffmpeg.

## Audio-only export

`export::export_audio_only(app, &project, &output_path)` is the
single entry point:

1. `lower(project, target) → graph`.
2. `emit_ffmpeg(&graph) → plan`.
3. If `plan.maps.is_empty()` (no audio layers): log a warning and
   return `Ok(())`. The mux step downstream tolerates a missing
   audio file.
4. Otherwise: write the filter graph to a temp `.txt`, spawn ffmpeg
   with `-y -hide_banner -nostats -filter_complex_script <file>
   -map [aout] -c:a aac -b:a 192k <output_path>`.
5. On non-zero exit, return an error with the last ~8 lines of
   stderr.

No `export:*` events are emitted from this path — the orchestrator
on the webview side drives ExportPanel state.

## Final mux

`export::mux_to_file(video_path, audio_path, output)` runs:

```
ffmpeg -y -hide_banner -nostats \
       -i <video.mp4> \
       -i <audio.m4a> \
       -c copy \
       <output_path>
```

Stream-copy only — no re-encode, ~100 ms for typical inputs. The
WebCodecs Worker produces `video.mp4` with the project framerate
baked in; the audio export produces `audio.m4a` at the project sample
rate; `-c copy` muxes them into a single playable MP4.

If `audio_path` doesn't exist (audio-only export was skipped for a
project with no audio layers), the mux invocation fails — the
orchestrator on the webview side checks for the audio file before
calling `mux_to_file` and falls back to copying the video-only file
to the output path.

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
