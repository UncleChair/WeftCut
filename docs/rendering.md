# Rendering

Two cooperating subsystems:

1. **Render graph compiler** — turns project state into an executable filter graph.
2. **Offscreen rasterizer** — turns HTML templates into PNG sequences that the compiler treats like any other input.

Both serve the architectural commitment: **preview = export pipeline at lower resolution.**

---

# Part 1 — Render Graph Compiler

## Pipeline

```
Project state
   │
   ▼
[1] Resolve         — verify media paths, populate metadata cache
[2] Pre-rasterize   — schedule template jobs, await or use cache; replace
                       Template layers with PngSeq inputs
[3] Lower           — Project layers → IR nodes
[4] Optimize        — input dedup, dead-code, scale fusion, hwaccel rewrite
[5] Validate        — type-check streams, framerates, channel counts
[6] Emit            — target-specific string (ffmpeg / libmpv / ...)
```

Stages 1–5 are pure functions over data. Stage 6 is the only one that knows about the target.

## Why an IR (and not direct string formatting)

- **Multi-target emit** — libmpv + ffmpeg today; WebGPU compositor tomorrow.
- **Validation before launch** — bad graphs fail in our code with a useful error, not in ffmpeg with `Invalid argument`.
- **Optimization passes** — dedup inputs, drop dead layers, fuse scales, hardware-aware lowering.
- **Determinism** — same project → byte-identical filter string. Critical for caching and agent reproducibility.

## IR (sketch)

```rust
enum IRNode {
    // Sources
    Color    { rgba: u32, size: (u32,u32), fps: u32, duration: f64 },
    DecodeV  { input_idx: usize, src_in: f64, src_out: f64 },
    DecodeA  { input_idx: usize, src_in: f64, src_out: f64 },
    Image    { input_idx: usize },
    PngSeq   { dir: PathBuf, fps: u32 },                 // rasterized template output

    // Transforms (1→1)
    Scale    { in_: NodeId, w: u32, h: u32 },
    Fps      { in_: NodeId, fps: u32 },
    SetPts   { in_: NodeId, offset: f64 },               // place on timeline
    Adelay   { in_: NodeId, ms: u64 },
    Opacity  { in_: NodeId, alpha: f64 },
    Fade     { in_: NodeId, kind: FadeKind, t: f64, dur: f64 },
    Volume   { in_: NodeId, db: f64 },

    // Composites (n→1)
    Overlay  { base: NodeId, top: NodeId, x: Expr, y: Expr, gate: (f64,f64) },
    DrawText { in_: NodeId, spec: TextSpec, gate: (f64,f64) },
    Subs     { in_: NodeId, ass_path: PathBuf },
    Amix     { ins: Vec<NodeId> },

    // Outputs
    OutV     { in_: NodeId, label: String, pix_fmt: PixFmt },
    OutA     { in_: NodeId, label: String, sample_rate: u32 },
}
```

Two principles to lock in early:

- **Time placement is structural.** `DecodeV` produces a stream starting at PTS=0; `SetPts` shifts it onto the timeline; `Overlay.gate` controls when it's visible. Don't rely on `enable=` alone.
- **Audio uses `Adelay`, video uses `SetPts`.** Same meaning, different units (ms vs seconds). Hide the asymmetry inside the IR.

## Lowering examples

`VideoClip { media, src_in, src_out, t_start, transform, opacity }`:
```
DecodeV(media, src_in, src_out)
  → Scale(canvas_w, canvas_h)
  → Fps(canvas_fps)
  → SetPts(t_start)
  → Opacity(opacity)
  ⇒ feeds enclosing Overlay
```

`Template { template_id, props, t_range }`:
```
PngSeq(rasterizer.materialize(template_id, props, duration, fps))
  → SetPts(t_range.start)
  ⇒ feeds enclosing Overlay
```

The lowering pass walks tracks bottom-to-top, building an `Overlay` chain on the video side and an `Amix` set on the audio side, both seeded with a base `Color` canvas / silence.

## Optimization passes

| Pass | Action | Why |
|---|---|---|
| Input dedup | One `-i` per unique source path | Avoids re-opening files |
| Dead-layer elimination | Drop fully-offscreen / α=0 / 0-duration layers | Common after agent edits |
| Scale fusion | `Scale → Scale` → single `Scale` | Avoids double resampling |
| Const-fold templates | Time-invariant template → render once as `Image` | Massively cheaper |
| Hwaccel rewrite | `DecodeV` → `DecodeV_cuda`, `Scale` → `scale_cuda`, `Overlay` → `overlay_cuda` when available | 4K real-time preview |

For MVP: only **input dedup** and **dead-layer elimination**. Defer the rest.

## Validation pass

Cheap checks that turn ffmpeg-side disasters into compile-time errors:

- All outputs reachable from at least one input.
- No cycles.
- Stream-type matches at every edge (no audio fed into `DrawText`).
- Total `-i` count under platform FD budget.
- All `Overlay` bases match canvas dims (or insert auto-scale).
- Sample rates / channel layouts converge before `Amix`.
- Every clip's source range fits inside the source's actual duration.

A good error: `Layer "title-3" references media "intro.mov" with src_out=12.5s, but media duration is 11.8s.`

## Emit: ffmpeg vs libmpv

**Same syntax.** libmpv accepts ffmpeg `lavfi` strings via `--lavfi-complex`. Difference is invocation, not graph:

- **ffmpeg export**:
  ```
  ffmpeg -i a.mp4 -i b.mp4 -i logo.png \
         -filter_complex_script graph.txt \
         -map "[vfinal]" -map "[aout]" \
         -c:v libx264 -preset slow -crf 18 \
         -c:a aac -b:a 192k \
         out.mp4
  ```
  (`-filter_complex_script` reads from a file — necessary because complex graphs blow past argv length limits.)

- **libmpv preview**:
  ```rust
  mpv.set_option("external-files", &input_paths.join(":"))?;
  mpv.set_option("lavfi-complex", &emitted_graph)?;
  ```

The compiler parameterizes on `RenderTarget { resolution, fps, hwaccel, quality }`. Preview = (1280×720, 30, hwaccel-on, draft); export = (project resolution, project fps, hwaccel-on, quality).

## Worked example

Project:
- Track 1 (video): clip A from `a.mp4` source 0–10 placed at timeline 0–10
- Track 1 (video): clip B from `b.mp4` source 5–10 placed at 10–15
- Overlay: `logo.png` at `(1700, 50)` from 0–15
- Title: drawtext "Welcome" centered, 2–5
- Audio: from clips A and B

Emitted graph:
```
color=black:s=1920x1080:r=30:d=15 [base]

[0:v] trim=0:10, setpts=PTS-STARTPTS, scale=1920:1080, fps=30 [vA]
[1:v] trim=5:10, setpts=PTS-STARTPTS+10/TB, scale=1920:1080, fps=30 [vB]
[2:v] scale=200:60 [logo]

[base][vA] overlay=enable='between(t,0,10)':eof_action=pass [s1]
[s1][vB]   overlay=enable='between(t,10,15)':eof_action=pass [s2]
[s2][logo] overlay=x=1700:y=50:enable='between(t,0,15)' [s3]
[s3] drawtext=text='Welcome':fontfile=/f/Inter.ttf:x=(w-tw)/2:y=(h-th)/2:enable='between(t,2,5)' [vout]

[0:a] atrim=0:10, asetpts=PTS-STARTPTS, adelay=0|0 [aA]
[1:a] atrim=5:10, asetpts=PTS-STARTPTS, adelay=10000|10000 [aB]
[aA][aB] amix=inputs=2:duration=longest:normalize=0 [aout]

[vout] format=yuv420p [vfinal]
```

Mappings: `-map "[vfinal]" -map "[aout]"`.

## Caching

The compiler is millisecond-fast — don't cache its output. Cache the **expensive byproducts**:

- **Rasterization output** — key: `hash(template_id, props_canonical_json, duration, fps, size)`.
- **Source metadata** — key: `path + mtime`.
- **Waveforms / scene markers** — key: `path + mtime + analysis_kind`.

If you ever cache compiled graphs, key on the **structural hash of the IR after normalization**, not the raw string.

## Pitfalls

1. **`trim` alone shifts start to 0; you need `setpts`.** Pair them. Encapsulate in a single lowering helper so callers can't forget.
2. **Audio in ms, video in seconds.** Wrap unit conversions; never let raw `f64` cross IR boundaries unlabeled.
3. **`eof_action=pass`** on overlays so a clip ending at t=10 doesn't end the whole composition.
4. **`format=yuv420p`** before encode. Many H.264 profiles require it. Bake into the export emitter.
5. **`amix` sample-rate mismatch.** Always insert `aresample=<canvas_rate>` before mixing.
6. **fps lock.** Insert `fps=<canvas_fps>` per video clip. Mixed framerates compose into glitches.
7. **Color space drift.** Pin `colorspace=bt709:iall=bt601-6-625:fast=1` for SDR HD; document the assumption.
8. **`enable=` doesn't free decode work.** Always pair with `trim`+`setpts` upstream.
9. **Filter-graph string length.** Use `-filter_complex_script` reading from a temp file.
10. **Live edits.** When the user nudges a clip, recompile + reload-graph. Debounce ~80 ms.

## Implementation footprint

| Component | LoC est. |
|---|---|
| IR types + builder | ~600 |
| Lowering | ~800 |
| Passes (dedup, DCE) | ~300 |
| Validation | ~300 |
| ffmpeg emitter | ~500 |
| libmpv emitter | ~100 |
| Cache layer | ~400 |
| Tests (snapshot per layer type, integration) | ~1000 |

**MVP: ~3K LoC.**

---

# Part 2 — Offscreen Rasterizer

Bridges "easy HTML/CSS authoring" and "ffmpeg-native overlay layer." Without it, fancy graphics force a choice between reimplementing CSS as ffmpeg filters (infeasible) or accepting the preview/export parity bug.

## The hard part: deterministic time

Naïvely "screenshot every 33 ms" doesn't work. Real time fluctuates — GC, layout pauses, font loading, raster jitter. Render twice, get two videos. Cache breaks.

**Fix: never let the page run on real time. Step it.**

Three layers, applied together:

1. **Mock the clock.** Inject before any template script runs:
   ```js
   let __t = 0;
   const _origRAF = window.requestAnimationFrame;
   window.performance.now = () => __t * 1000;
   window.Date.now        = () => __t * 1000;
   const rafCallbacks = new Set();
   window.requestAnimationFrame = (cb) => { rafCallbacks.add(cb); return 0; };
   window.__seek = async (seconds) => {
     __t = seconds;
     const cbs = [...rafCallbacks]; rafCallbacks.clear();
     cbs.forEach(cb => cb(__t * 1000));
     await document.fonts.ready;
     await new Promise(r => _origRAF(r));   // flush layout/compositor
   };
   ```
2. **Pause CSS/Web Animations.** After load, walk `document.getAnimations()`, set `pauseTime` per `__seek`. Catches declarative animations that don't use rAF.
3. **Optional template hook.** If the template exports `window.__onSeek = (t) => …`, call it inside `__seek`. Lets imperatively-driven canvas/WebGL templates respond.

Frame capture happens **after `await __seek(t)` resolves.** Promise resolution = "everything for time t is on screen."

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Rasterizer (Rust)                                           │
│                                                              │
│  ┌─────────────┐    ┌────────────────────────────────────┐   │
│  │ Job queue   │───►│ Worker pool (default: 2 webviews)  │   │
│  └─────────────┘    │  ┌──────────────────────────────┐  │   │
│        ▲            │  │ wry webview (offscreen)      │  │   │
│        │            │  │  • loads template            │  │   │
│        │ submit     │  │  • injects time-mock shim    │  │   │
│        │            │  │  • __seek(t) → snapshot      │  │   │
│  ┌─────┴────────┐   │  └──────────────────────────────┘  │   │
│  │ Cache        │   └────────────────────────────────────┘   │
│  │ (sled + FS)  │             │                              │
│  └──────────────┘             ▼                              │
│                        PNG sequence + manifest               │
└──────────────────────────────────────────────────────────────┘
```

A small pool of long-lived webview workers, each renders one job at a time. Cross-job parallelism only — never split a single template render across workers.

## Driving the webview headlessly

`wry` directly. Each platform exposes a snapshot API:

| Platform | Capture API | Transparent BG |
|---|---|---|
| Windows / WebView2 | `CapturePreview` | `DefaultBackgroundColor = Transparent` |
| macOS / WKWebView | `takeSnapshotWithConfiguration:` | `setOpaque:false` |
| Linux / WebKitGTK | `webkit_web_view_get_snapshot` (async) | `set_background_color` |

Spawn the worker window with `visible=false` plus tiny size, off-screen — most platforms still tick the compositor in this state. Linux is the soft spot; if WebKitGTK falls over, fallback is bundled headless Chromium via `chromiumoxide` (Linux-only, opt-in — accept the bundle hit there).

## Render loop

```rust
async fn render_one(worker: &mut Worker, job: &Job) -> Result<RasterOutput> {
    worker.load_template(&job.template_path).await?;       // file:// URL
    worker.inject_props(&job.props).await?;                // window.__props__ = {...}
    worker.wait_ready().await?;                            // template's __ready__ promise

    let frames = (job.duration * job.fps as f64).ceil() as usize;
    let mut output = RasterOutput::new(&job.cache_dir, job.size, job.fps);

    for i in 0..frames {
        let t = i as f64 / job.fps as f64;
        worker.eval(&format!("await window.__seek({t});")).await?;
        let png = worker.capture_png().await?;
        output.write_frame(i, &png)?;
    }
    output.finalize()
}
```

Per-frame overhead: 30–100 ms at 1080p. A 5 s 1080p@30 lower-third = 5–15 s wall-clock. **Once.** Then cached.

## Output format

| Format | When | Why |
|---|---|---|
| **PNG sequence in temp dir** | MVP, default | Simple, lossless, debuggable, ffmpeg ingests via `-framerate N -i frame_%05d.png` |
| **Transparent WebM (VP9 + alpha)** | v2 | 10–50× smaller; pipe directly through ffmpeg |
| **Direct named pipe to main ffmpeg** | v3 | Zero intermediate files; complex error handling — defer until pain is real |

## Cache design

Key:
```
blake3(
  template_id || template_content_hash || canonical_json(props)
  || duration_ms || fps || width || height || rasterizer_version
)
```

On-disk:
```
~/.app/raster-cache/<key>/
  manifest.json     { fps, frames, size, created, last_used }
  frame_00000.png
  frame_00001.png
  ...
```

- **Eviction:** LRU by total size, default 5 GB cap.
- **Negative cache:** failed renders cached for ~1 minute with the error so retries are fast.
- **Hot reload during authoring:** watch template directory; on change, bump `template_content_hash` automatically — entries invalidate, next render is fresh.

## Template format

```
templates/lower-third-glow/
  manifest.json
  index.html
  style.css
  preview.png        ← thumbnail for UI/agent picker
  fonts/
  assets/
```

`manifest.json`:
```json
{
  "id": "lower-third-glow",
  "name": "Glowing Lower Third",
  "version": 1,
  "size": [800, 200],
  "default_duration": 5.0,
  "props_schema": {
    "title":    { "type": "string", "default": "Hello", "max_length": 80 },
    "subtitle": { "type": "string", "default": "" },
    "color":    { "type": "color",  "default": "#00aaff" }
  }
}
```

Template contract (kept minimal):
- Reads props from `window.__props__` (rasterizer injects before any script runs).
- Sets transparent background (`html, body { background: transparent; }`).
- Optionally exposes `window.__ready__` — Promise awaited before first capture; default `document.fonts.ready`.
- Optionally exposes `window.__onSeek` — `(t) => Promise<void>` for imperative timing.

## Built-in template starter set

Ship 8–12 templates so the system is immediately useful:

- Lower thirds (3 styles)
- Intro / outro title cards
- Captions strip
- Callout arrow + label
- Progress bar
- Countdown timer
- Logo bug
- Slate

These are also what `list_templates()` exposes to agents on day one.

## Failure modes

| Failure | Detection | Action |
|---|---|---|
| Template JS error | console listener / unhandled rejection | Fail with the error text |
| Asset 404 | network listener | Fail with the URL |
| Font not loaded | `document.fonts.ready` timeout (5 s) | Fail with font name |
| Frame capture timeout | per-frame timeout (2 s) | Retry once, then fail |
| `__seek` hung | overall job timeout (60 s default) | Kill worker, restart, fail job |
| Worker crash | process death watcher | Restart, requeue if first attempt |
| Disk full | pre-flight free-space check | Refuse new jobs, surface to UI |

Production failures produce a **placeholder frame** (red banner with error text) so the export still completes — the user sees the failure rather than getting silently broken pixels.

## Performance budget

| Scenario | Wall-clock |
|---|---|
| 1080p, 30 fps, 5 s, cold | 5–15 s |
| 1080p, 30 fps, 5 s, **cached** | ~10 ms (folder lookup) |
| 4K, 30 fps, 5 s, cold | 25–60 s |
| Preview proxy (720p, 30 fps, 5 s) | 2–5 s |

Preview path uses **proxy resolution**; full-res is rasterized only on export or explicit "render at full quality" action. Proxy and full-res are different cache keys.

## Security

User-supplied templates run arbitrary JS. Sandbox:
- Strict CSP: `default-src 'self' file:; img-src 'self' file: data:; connect-src 'none'; script-src 'self' file: 'unsafe-inline'`. No outbound network.
- Per-template directory only; no traversal.
- Clear `localStorage`, `sessionStorage`, `IndexedDB`, `Cache API` between jobs.
- Overall job timeout caps runaway templates.
- For community/marketplace templates: review or signature verification before install.

## Pitfalls

1. **Webview determinism on Linux.** WebKitGTK snapshot is the least mature; spike on day one. Headless-Chromium fallback if it falls over.
2. **AA/font drift across OSes.** Same template → slightly different pixels on Win vs Mac. Acceptable visually; don't share cache across OSes.
3. **WebGL/WebGPU templates** add nondeterminism via driver differences. Document; recommend SVG/CSS/Canvas2D for portable templates.
4. **Long × high-res templates** can take minutes. Surface progress; allow cancel; never block the agent's MCP call on a cold render — return "rasterizing" state immediately.

## Implementation footprint

| Component | LoC est. |
|---|---|
| Worker (`wry` + platform capture shim) | ~700 |
| Time-mock JS shim (tested in isolation) | ~150 |
| Job queue + pool (`tokio` channels) | ~250 |
| Cache (sled index + filesystem) | ~400 |
| Template loader + manifest validator (`serde` + `jsonschema`) | ~300 |
| Tests (golden PNGs via perceptual diff) | ~600 |

**MVP: ~2K LoC of Rust** + the JS shim + ~10 starter templates (HTML/CSS, not Rust).
