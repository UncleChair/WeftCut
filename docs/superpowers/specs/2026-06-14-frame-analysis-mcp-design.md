# Frame analysis for agents — `analyze_clip` / `compare_frames`

**Status: design parked — NOT scheduled.** Captured as a future TODO in
[`roadmap.md`](../../roadmap.md) ("Frame analysis for agents"). No
implementation plan written; revisit when agent-driven editing needs
structural picture signals.

## Problem

The MCP surface already lets an agent **see** a frame —
`media://{id}/frame/{t_us}` (on-demand, lazy-cached, multimodal-friendly),
`media://{id}/thumbnail`, `preview_motif_draft`. What it cannot do is
**reason about how the picture changes over a clip**: where the cuts are,
how much motion a span has, whether a stretch is black / frozen / fading,
whether two frames (or two clips) are near-duplicates.

A multimodal agent can already describe *what is in* a single frame it
fetches. The signals worth WeftCut computing are the ones an agent
**cannot cheaply derive by looking at one image**: temporal / structural
signals across a whole clip, and a quick navigable overview of its shots.

## Scope (decisions)

Resolved during brainstorming:

1. **Purpose** — temporal / structural signals + quick overview / navigation.
   Semantic "what's in the frame" stays the agent's job (it sees the frame).
2. **When / on what** — lazy (first tool call computes), on the **720p preview
   proxy** (fall back to the original when a clip is proxy-bypassed), result
   content-addressed and cached on disk.
3. **Tool surface** — one core `analyze_clip` returning structured JSON +
   `compare_frames` for pairwise similarity. Viewing a representative frame
   **reuses the existing `media://{id}/frame/{t_us}` resource** — no new
   image-serving path. No composite contact-sheet image (multimodal token
   cost; the agent fetches the frames it cares about individually).
4. **Compute method** — pure heuristic in Rust over downscaled frames
   (histogram-difference scene scoring — the PySceneDetect approach — plus
   luma-mean, inter-frame diff, and a difference-hash). Validated against the
   open-source canon (see "Prior art").
5. **Where it runs** — a Rust pass driven by the **ffmpeg CLI child** (same
   `ffmpeg_sidecar` + `ffmpeg_sem` path as proxy/thumbnail/waveform/frame
   jobs), **not** the webview. Keeps analysis off the GPU/compositor the user
   is actively driving while editing.
6. **Detector** — heuristic behind a `SceneDetector` trait so a learned model
   (TransNetV2 via ONNX) can drop in later as an opt-in high-accuracy mode
   without re-architecting. Footprint relaxed (the user waits in agent mode),
   so analysis runs at a sane downscale + full frame rate by default for
   signal quality; `max_fps` subsampling is an opt-in knob for very long clips.

## Prior art (why heuristic-first)

- **PySceneDetect** — the open-source standard for shot detection; CPU-only,
  thresholds the frame-to-frame change of an HSV colour histogram. This *is*
  the route-B algorithm; the design reimplements it in Rust on small frames.
- **TransNetV2** — a lightweight 3D-CNN; markedly better on **gradual
  transitions** (dissolves), near real-time. Cost is ONNX runtime + native
  lib bundling on Windows + a determinism caveat — that is *distribution*
  complexity, which "the user can wait longer" does not pay for. The common
  production pipeline is "PySceneDetect first, TransNetV2 to recover misses";
  v1 takes only the first half.
- Rejected for footprint / redundancy: **OpenCV** (heavy binary), **CLIP /
  transformers.js / MobileCLIP embeddings** (model download; and semantic
  similarity is the agent's job, not ours).
- Imported footage (what an agent analyzes) is **dominated by hard cuts** —
  dissolves are an editing-time addition, rare in raw sources — so the
  heuristic covers the dominant case. Hence: ship heuristic, leave the trait
  seam for the model.

## Architecture

New `src-tauri/src/analysis/` module. Structurally a sibling of the existing
derivative jobs (`jobs/{proxy,thumbnails,waveform,frame}.rs`), reusing
`CacheLayout`, the `ffmpeg_sidecar` path, and the global `ffmpeg_sem`.

### Decode loop (ffmpeg CLI raw-video pipe)

Spawn one ffmpeg child that downscales + (optionally) temporally subsamples,
emitting fixed-size raw frames to stdout:

```
ffmpeg -hide_banner -loglevel error -i <source>
       -vf "fps=<max_fps?>,scale=<W>:<H>:flags=area,format=rgb24"
       -f rawvideo -
```

Default `W×H = 320×180` (footprint relaxed; PySceneDetect-grade fidelity).
Read `W*H*3` bytes per frame from stdout, hold only `prev` + `cur`. Per frame
compute, all from the raw bytes:

- **brightness** — luma mean (0..1).
- **scene score** — frame-to-frame difference of a small RGB/HSV histogram
  (PySceneDetect-style). Bins tunable; default ~16/channel.
- **motion** — mean absolute luma difference vs `prev` (0..1).
- **dHash (64-bit)** — from a 9×8 greyscale reduction of the same frame; used
  by `compare_frames` and near-duplicate flagging.

This is the `SceneDetector` trait's input contract — a stream of
`(t_us, brightness, scene_score, motion, dhash)`. The heuristic detector
consumes it; a future ONNX detector would consume the same stream (or a
parallel tap of larger frames).

### Aggregation

- **Scenes** — a boundary where `scene_score` crosses `scene_threshold`; merge
  spans shorter than `min_scene_us`. Per scene: `t_start_us`, `t_end_us`,
  `keyframe_us` (frame nearest the scene midpoint that is not black), mean
  `brightness`, mean `motion`, optional `flags`.
- **Events** — `black` (brightness below a floor over a span), `freeze`
  (motion ≈ 0 over a span), `fade_in` / `fade_out` (monotonic brightness ramp
  at a scene edge).

### Timebase

`fps`-filtered output is constant-rate, so `t_us = round(index / rate * 1e6)`;
when running full-rate, read the proxy's `avg_frame_rate` once via ffprobe and
use the same formula (proxies are CFR). Timestamps are returned in **source
microseconds** — proxies preserve source timing 1:1, and the values feed
straight back into `media://{id}/frame/{t_us}`, so **analysis runs on the
cheap proxy while the agent views the keyframe from the full-quality
original**. Snap `keyframe_us` to the source frame grid (frame-aligned-timeline
invariant).

## Tool surface (MCP)

Listed under docs/mcp.md "Analysis tools", beside `detect_silences`.

### `analyze_clip`

```
analyze_clip { media_id | layer_id, t_start_us?, t_end_us?,
               scene_threshold?, min_scene_us?, max_fps? }
```

- `layer_id` analyzes only that layer's used `src_in_us..src_out_us` window by
  default (consistent with `transcribe_clip`); `media_id` analyzes the whole
  source.
- Returns the structured shot list:

```json
{
  "media_id": "...",
  "analyzed_source": "proxy",
  "duration_us": 312000000,
  "fps_analyzed": 30.0,
  "scenes": [
    { "index": 0, "t_start_us": 0, "t_end_us": 3200000,
      "keyframe_us": 1500000, "mean_brightness": 0.42,
      "motion": 0.08, "flags": ["fade_in"] }
  ],
  "events": [
    { "kind": "black",  "t_start_us": 0,        "t_end_us": 480000 },
    { "kind": "freeze", "t_start_us": 90000000, "t_end_us": 92000000 }
  ]
}
```

The agent fetches any scene's `keyframe_us` via the existing
`media://{id}/frame/{t_us}` resource — no new image tool.

### `compare_frames`

```
compare_frames { a: { media_id, t_us }, b: { media_id, t_us } }
  → { hamming, similarity, verdict }
```

`verdict`: `near_duplicate` (hamming ≤ 6) / `similar` (≤ 16) / `different`.
`similarity = 1 - hamming/64`. Reuses a cached per-frame dHash when an
`analyze_clip` run covered that timestamp; otherwise decodes the one frame
each side via a one-frame raw-video pipe (9×8 grey) and hashes it. This is the
cross-clip / pairwise primitive the single-clip scan can't cover. dHash is
pixel-similarity only — semantic "looks like the same thing" is out of scope.

## Caching

Content-addressed by `blake3(file_hash_blake3 || detector_version || scale ||
max_fps || scene_threshold || min_scene_us || source_kind)`, stored as
`<Cache>/analysis/<key>.json`. `analyze_clip` checks the cache → returns; on
miss it acquires an `ffmpeg_sem` permit, runs the decode, writes the JSON
atomically (`temp_path` + `promote_temp`), returns. First call costs a few
seconds; every later call is an instant cache hit that survives restarts.

`CacheLayout` additions: `analysis_dir()` + `analysis(key)`, registered in
`ensure_dirs()`. **No** `migrate_hash_artifacts` entry needed — analysis is
lazy and always runs *after* import has finalized the blake3, so it never keys
off a `pending-*` hash.

## Execution & concurrency

`analyze_clip` blocks inline on a cache miss (the MCP SSE handler is
concurrent, so one slow analyze doesn't stall other tools) and bounds itself
with the shared `ffmpeg_sem` so multiple agent calls don't saturate the host.
Unlike the derivative jobs it does **not** patch a `MediaItem` derivative path
or emit `media:job_*` events — the result is agent-facing data served by the
tool, not a UI-consumed artifact.

## Footprint / speed

Working set is `prev` + `cur` at 320×180×3 ≈ 170 KB each plus histogram bins —
trivial. One ffmpeg child under the existing 2-permit semaphore; the decode is
CPU only and never touches the GPU/compositor. `max_fps` lets very long clips
trade temporal resolution (and a risk of missing very fast cuts — documented)
for speed. A few-minute proxy is a few seconds cold, then cached.

## Error model & threading

Structured errors consistent with the existing surface: `MediaNotFound`,
`SourceNotReady` (no usable proxy yet *and* original unavailable — rare, since
the original is the always-present fallback; hints to wait for
`media:job_complete`), `FrameOutOfRange` (compare_frames `t_us` past media
duration). The ffmpeg child is awaited on a tokio task; raw frames stream
through `tokio` IO. No ffmpeg-next `!Send` handles cross an await (the CLI-pipe
approach sidesteps that class of bug entirely).

## Testing

- **Unit (synthetic fixtures via lavfi / concat):** a clip concatenating
  solid-colour segments → known cut boundaries (assert ±1 frame); a black
  span; a frozen span (repeated frame); a brightness ramp (fade). dHash:
  identical frame → hamming 0, perturbed → small, unrelated → large; assert
  `compare_frames` verdict thresholds.
- **Determinism:** same input + params → byte-identical cache JSON (matches
  the conformance discipline; relies on a fixed ffmpeg build).
- **Integration:** invoke `analyze_clip` end-to-end on a `WEFTCUT_TEST_MEDIA`
  fixture and assert the scene count — a real tool invocation, not a
  string-match on the schema (per the emit-smoke-tests lesson). Consider a
  fixture with known cuts added to the media-conformance suite.

## Non-goals (v1 / YAGNI)

TransNetV2 / any learned model (trait seam only); webview / WebGPU analysis
path (deferred optimisation — see below); semantic content understanding
(agent's own vision); contact-sheet composite image; codec motion vectors
(mean-abs-diff is the motion proxy); semantic similarity in `compare_frames`.

## Future extensions (seams left open)

- **TransNetV2 (ONNX) high-accuracy mode** — a second `SceneDetector` impl for
  gradual-transition recovery; gated on bundling onnxruntime on Windows + a
  CPU-EP determinism lock. Add only if dissolve misses prove painful in use.
- **Webview WebCodecs/WebGPU opportunistic signals** — the preview already
  decodes frames to GPU textures; a compute-shader histogram/hash on frames
  the user has *already* scrubbed could backfill a sparse signal map for free.
  Complex (couples into the hot preview path); revisit only if the cold
  first-call latency becomes a real complaint.
- **Embedding-based `compare_frames`** — MobileCLIP via transformers.js for
  semantic similarity / "find a shot like this", if a use case appears.

## Documentation deliverables (when built — evergreen, no dates/phase numbers)

- docs/mcp.md "Analysis tools": add `analyze_clip` + `compare_frames` with
  API-doc-quality descriptions.
- A short **ADR**: "frame analysis = a heuristic Rust pass over the proxy, not
  a learned model, not the webview", nailing down the rejected alternatives
  (TransNetV2, OpenCV, transformers.js/WebGPU) and the trait seam.
