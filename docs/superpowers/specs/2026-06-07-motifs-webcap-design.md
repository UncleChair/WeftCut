# Motifs — single web-capture design

- **Status:** design approved 2026-06-07; spec under review before implementation planning.
- **Supersedes:** the SVG `render(t)` template engine described in `docs/templates.md`
  and the reserved `engine: "svg" | "satori" | "webview"` tiering.
- **Feasibility:** both load-bearing risks validated 2026-06-07 (see §10).

## 1. Summary

Rebuild the `template` module as **Motifs**: parameterized, time-varying overlays
(lower-thirds, countdowns, title cards, callouts, motion graphics). A Motif is
**a real web page** — arbitrary HTML/CSS/canvas/WebGL and animation libraries
(GSAP, Lottie, etc.). There is exactly **one** rendering path, internally called
**webcap**: the page is driven to a precise time `t`, then captured to a bitmap
via the WebView2 DevTools Protocol (CDP). No engine-selection field, no
per-engine backends.

The renderer's load-bearing principle is preserved: **preview pixels equal
export pixels by construction**, because a single capture path feeds both
surfaces.

## 2. Why one web-capture path (and why determinism is the spine)

Two hard platform walls shaped every prior template design:

1. **The export Worker has no DOM.** Preview runs in the webview; export runs in
   a Web Worker against an `OffscreenCanvas` with no `document`/`iframe`/`Image`.
   It cannot run a template. So whatever produces preview pixels must produce
   export pixels through a path the Worker can consume — i.e. the **main thread /
   main process rasterizes, the Worker receives bitmaps**.
2. **HTML→SVG `<foreignObject>` raster is cross-origin tainted in WebView2**
   (ADR 0015 / `reference_foreignobject_taint`): unreadable, un-encodable,
   un-uploadable to the GPU. That killed earlier "HTML template" attempts and
   forced templates to be plain SVG.

webcap clears both walls: a **CDP `Page.captureScreenshot` is a real browser
raster, not a canvas read-back**, so it is *not* tainted; and capture happens on
the main process, handing bitmaps to the Worker for export.

The price of full web freedom is that a web page has its own clock and will
animate on its own — which is nondeterministic and incompatible with a
frame-exact editor (scrubbing, re-export, preview==export all require that the
same `t` always yields the same pixels). The resolution is the **determinism
contract**, and it is the spine of the whole system, not an implementation
detail:

> **A Motif renders as a pure function of time.** It never advances itself; the
> harness owns the clock and drives the page to each composition frame.

This is what makes Motifs a *video template system* rather than a screen
recorder. Everything else (capture, cache, export) is mechanism around this
contract.

### Considered and rejected (2026-06-07)

- **Real-time capture (screen-recording model).** Let the page free-run on its
  real clock and capture frames as they paint (MediaRecorder / CDP screencast /
  window capture). Zero authoring contract — but **no scrubbing** (the page only
  knows "now"; seeking an arbitrary frame is impossible without replay), **export
  bound to real time** (a 60 s Motif takes ≥ 60 s), and **preview ≠ export**
  (capture jitters with machine load). Rejected: a timeline editor needs
  frame-exact seek, faster-than-real-time export, and preview==export.
- **Record-once-then-replay (real-time bake).** Play the page `0→duration` once,
  record to a frame sequence, serve `frame[t]` from storage. Removes the contract,
  but every Motif bakes in real time, any prop edit forces a full re-bake, bakes
  vary run-to-run, resolution is fixed at bake time, and holdable/unbounded Motifs
  don't fit. It also taxes the *common* declarative Motif (which seeks for free)
  with a universal real-time bake. Rejected as default; not adopted as an escape
  hatch either, to keep the single-path simplicity.

Both confirm the conclusion the established tools reached — **Remotion** and
**timesnap/timecut** all override time and seek, because frame-exact web→video has
no other path. Decision: time-function (seek), burden minimized per §3.

## 3. The authoring contract

A Motif is a directory of `manifest.json` + `index.html` (+ optional `assets/`
for fonts/images). `index.html` is a normal web document. Built-in Motifs are
embedded in the binary; user-uploaded Motifs load from disk (§9).

### The lifecycle: `motif.define`

The harness injects two things before any author code runs: the clock takeover
(§4) and a global `motif`. The author declares a lifecycle with one call:

```js
motif.define({
  // once per props value (re-runs on prop change); build scene + declare animations
  async setup(props, ctx) {
    ring.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: ctx.circumference }],
                 { duration: ctx.duration * 1000, easing: 'linear', fill: 'both' });
    await document.fonts.ready;          // readiness: awaited once, here
  },
  // OPTIONAL: only when content must read the clock (e.g. a countdown number)
  frame(t, ctx) { label.textContent = Math.ceil(ctx.duration - t); },
});
```

- **`setup(props, ctx)`** — async, runs once per distinct props value. Builds the
  DOM, declares WAAPI/CSS/GSAP animations, loads and `await`s assets.
- **`frame(t, ctx)`** — optional, called at each seeked time for imperative
  time-reading content. Pure-declarative Motifs omit it.
- **`ctx`** = `{ duration, width, height, fps, frame, random() }`. `t` is content
  time in seconds; `ctx.frame` the integer frame index. Both are provided so the
  CSS/WAAPI (time-based) and Remotion-style (frame-based) idioms each work.

Each capture: ensure `setup` done (once) → call optional `frame(t)` → seek all
`document.getAnimations()` to `t` → flush controlled rAF → await frame-settled →
capture.

### The one law: state is a function of `t`, not an accumulation

> Any visible state must be computable **from `t` alone** — via declared
> animations or `frame(t)` — never via mutation that **accumulates over time**.

```js
setInterval(() => { n++; label.textContent = n; }, 1000);   // ✗ stubbed / not seekable
frame(t) { label.textContent = Math.floor(t); }             // ✓ closed-form in t
```

The author may use any normal animation tool (CSS animations/transitions, WAAPI,
GSAP, Lottie, canvas/WebGL) because the harness owns the clock and seeks them. The
single learnable rule: don't accumulate state via timers; express it as `f(t)`.

### Minimizing the authoring burden

The contract is real but its cost is held low by three levers, so "just write a
web page" holds for the common case:

1. **Auto-seek declarative animations.** CSS/WAAPI/GSAP/Lottie are seeked by the
   harness with **no special API** — authors use the animation tools they know.
2. **A small time primitive** (`interpolate(t, [inRange], [outRange], opts)` plus
   `ctx.frame`/`ctx.random()`) for the imperative time-reading case, so `frame(t)`
   stays terse.
3. **Import-time lint.** Static scan flags accumulation anti-patterns
   (`setInterval`/`setTimeout`-driven state, self-advancing rAF that mutates) and
   warns the author up front — critical for untrusted uploads (§9), so the footgun
   surfaces at import, not as a silently wrong frame.

#### Anti-patterns (will not work)

| Pattern | Why | Use instead |
|---|---|---|
| `setInterval`/self-advancing rAF accumulating state | stubbed / not seekable | closed-form in `frame(t)` |
| `fetch()` for data/fonts/images | sandbox-blocked, nondeterministic | bundle in `assets/` |
| reading real `Date.now()` for motion | returns virtual time, not wall-clock | use `t` |
| unseeded physics/particle integration | depends on prior frame, not reproducible | closed-form `f(t)` or seeded `ctx.random()` |
| global state accreted across instances | leaks after a prop-change rebuild | keep `setup` self-contained |

The manifest declares identity, natural size, durations, a typed `props_schema`,
fonts, and a **format version** (no `engine` field):

```json
{
  "id": "countdown",
  "name": "Countdown",
  "formatVersion": 1,
  "size": [480, 480],
  "default_duration_s": 5.0,
  "max_duration_s": 5.0,
  "max_duration_prop": "seconds",
  "props_schema": { "seconds": { "type": "number", "default": 5 } },
  "fonts": [{ "family": "Inter", "file": "Inter.woff2", "weight": 700 }]
}
```

`formatVersion` replaces `engine`: it carries no rendering-tier meaning, only a
migration hook for future contract changes.

Props are validated against `props_schema` (unknown keys reject; missing keys
fall back to defaults) and canonicalized into a stable key order, so identical
inputs produce identical bytes and identical cache keys.

### Fonts, assets, size

- **Fonts:** declared in `manifest.fonts`, bytes in `assets/`; the page writes a
  normal `@font-face` referencing the bundled file. Simpler than the old SVG path
  (no data-URL injection). Readiness `await document.fonts.ready` in `setup`.
- **Assets (images, JS libs):** bundled in `assets/`, referenced by relative URL,
  served from a local scheme inside the sandbox — never the network (§9).
- **Size & resolution:** author lays out within `manifest.size` (CSS px, top-left
  origin) as if rendering at that size. Capture resolution is the harness's job
  (`setDeviceMetricsOverride`/`deviceScaleFactor`) — no resolution code in the
  Motif, no blur on scale-up. Layer transform/opacity are applied by the Pixi
  sprite at composite time, never captured (§7).
- **Prop change = rebuild:** editing a prop re-runs `setup` with the new value and
  invalidates that content's cache; `setup` must be self-contained (no residual
  cross-instance state).

### Content duration and the timeline window (carried over)

A Motif's **content** has an intrinsic length; the **layer** on the timeline is a
**window** into that content, exactly as a video clip windows its media.
`MotifParams.src_in_us` is the window offset; the window width is the layer width;
the window end is derived, never stored. Invariant: `0 ≤ src_in_us` and
`src_in_us + width ≤ content_dur`. `max_duration_s` is the intrinsic content
duration; `max_duration_prop` names a NUMBER prop that drives that length live; a
Motif with neither is an unbounded holdable overlay that animates over the layer
width. (This is unchanged from the prior template model and is well understood;
it is not re-litigated here.)

## 4. Determinism: owning the clock (VALIDATED)

The harness drives the page to time `t` before each capture by **taking over
every low-level time source** and seeking declarative animations:

| Animation source | How it is pinned to `t` |
|---|---|
| CSS animations/transitions, WAAPI | `document.getAnimations()` → `pause()` + `currentTime = tMs` |
| GSAP and other eased tweens | run on `requestAnimationFrame` + `performance.now` → both owned; flush controlled rAF |
| three.js / canvas render loops | bottom out on `requestAnimationFrame` → owned |
| `setTimeout` / `setInterval` / `Date.now` | stubbed to the virtual clock |
| `<video>` / media | `currentTime = t`, paused; gated by the frame-settled handshake |

The `seekTo(t)` step: set the virtual clock to `t`; `getAnimations()` pause +
`currentTime`; flush the controlled rAF queue a bounded number of times (idempotent
at a fixed clock); force a style/layout flush; await the **frame-settled** signal
(fonts ready, images decoded, current WebGL/canvas frame drawn) before capture.

**Validated 2026-06-07** (Playwright spike): a page mixing a CSS `@keyframes`
animation, a WAAPI animation, and a canvas+rAF loop was seeked to `t=500ms`,
`t=1000ms`, then back to `t=500ms`. All three sources produced mathematically
exact positions and the re-seek to `t=500ms` reproduced a **byte-identical**
canvas hash. Determinism and correct advance both held.

**Residual unsupported case (must be documented):** an animation that bypasses
our clock — e.g. caches a `Date`/`performance` reference before our wrapper
installs, or uses a time source we do not hijack — is undefined behavior. The
wrapper installs the clock takeover **before** any Motif code runs to minimize
this; anything that still escapes is explicitly out of contract.

## 5. The capture harness (VALIDATED)

- **One reused hidden WebView2 host.** A single offscreen WebView2 is created
  lazily and reused across Motifs, frames, and layers via a **job queue** (the
  pool/queue/reuse pattern from `feat/template-raster-pool`, with CDP-on-a-hidden-
  webview slots replacing `<img>`-on-iframe slots). Footprint is bounded to one
  extra browser process tree, not one per layer.
- **Isolation = the hidden window itself (v1 decision, 2026-06-07).** The Motif is
  loaded as the hidden window's **top-level document**, served by a `motif:` URI
  scheme (`motif://<id>/index.html` + `motif://<id>/<asset>`). Isolation comes from:
  the window is a separate WebView2 with **no Tauri API injected**, a CSP
  `default-src 'none'` (plus only what capture needs) so it is **fully offline**, and
  it only ever loads `motif:` content. The **clock-takeover runtime** is injected by
  the scheme handler as a served `<script src="motif://_rt/runtime.js">` (built from
  `runtime.ts` — single source, no Rust duplication), so it installs before any Motif
  code runs. `seek` is driven by `postMessage` to the window. Same-origin within the
  `motif:` scheme means the Motif's relative `assets/` URLs resolve naturally.
  > Rejected for v1: an inner opaque-origin `sandbox="allow-scripts"` iframe (stronger
  > isolation for untrusted uploads, but awkward asset resolution + runtime injection).
  > The stronger isolation for untrusted/uploaded Motifs — opaque-origin iframe and/or
  > a low-privilege process, network deny-listing, resource quotas — is **deferred to
  > the security-hardening plan (§9)**, where it belongs. v1 ships built-in Motifs only.
- **Capture via CDP.** The host drives `Emulation.setDeviceMetricsOverride` to
  render at an arbitrary resolution (independent of the physical screen), then
  `Page.captureScreenshot` (PNG) for the seeked frame. Reached from Rust via
  `WebviewWindow::with_webview(|pw| pw.controller().CoreWebView2()
  .CallDevToolsProtocolMethod(...))` (see `reference_tauri_webview2_cdp`).
- **Capture is orchestrated Rust-side.** Because CDP control is host-side, every
  capture crosses the process boundary: a preview frame round-trips JS compositor
  → Rust → CDP → PNG bytes → back to the app webview (decode to `ImageBitmap`,
  upload to Pixi); export hands the PNG straight to the Worker. This
  JS↔Rust↔CDP round-trip is **new** relative to the old pure-JS SVG raster and is
  a cost input for §6 and §13.

**Validated 2026-06-07** (throwaway in-app spike, reverted): controller reachable
from Rust; `setDeviceMetricsOverride` ≈ 27 ms; `Page.captureScreenshot` returned a
real PNG (~47 KB base64) in ≈ 98 ms (debug build, cold, 1080p).

**Capture format is PNG** (lossless; the Canvas/CDP WebP path is lossy and crisp
text edges matter — ADR 0015 rationale still applies).

## 6. Raster cache and escalation

webcap costs ~50–100 ms per **distinct** frame (vs single-digit ms for the old
SVG path). The escalation model is the same shared mechanism over one capture
function, tuned so the cost lands only where it must:

- **L0 — on demand.** The playhead frame is captured when needed and bound as a
  texture. Resolution-independent (capture at the resolution the composite needs).
- **L1 — in-RAM lookahead (always on).** A budget-paced background prewarmer fills
  the shared L0 cache ahead of the playhead, off the play loop, during playback
  and while paused. Active Motif layers dedupe by content cache key (N identical
  Motifs warm one content set); a pure planner orders playhead-first then forward.
- **L2 — persisted PNG (measurement-driven).** Heavy/persistence-worthy Motifs
  auto-escalate to one PNG per frame under `<workspace>/Cache/raster/`, keyed by a
  hash of `(motifId, formatVersion, canonicalProps, renderW, renderH, fps,
  contentDurationFrames)`. Survives reload; lets export read frames off disk;
  safe to delete (regenerates).

**The key cost insight:** what makes simple Motifs cheap is **cache dedup, not a
second renderer.** A static overlay produces identical pixels every content
frame → the cache collapses it to **one** capture, then it is free. Only Motifs
with many *distinct* frames (a long continuous animation) pay the per-frame tax
repeatedly. That cost is accepted: on desktop it is absorbed by always-on L1
prewarm, L2 persistence (pay once), and the existing export "preparing" wait.

**Not in the cache key:** the layer transform and opacity (applied by the Pixi
sprite at composite time — moving/scaling/fading never re-captures) and the window
position (`src_in_us`; frames are keyed by absolute content-frame index, so
trimming the window reuses cached frames).

## 7. Compositor integration

`compositeFrame(tUs)` passes each Motif sprite its layer-relative time
`tInLayerUs = tUsSnapped − layer.t_start_us`. The sprite resolves the content time
`src_in_us + tInLayerUs`, maps it to a frame index on the exact-rational frame
grid (shared `frames.ts` helpers — never `round(µs·fps)`), clamps to
`[0, contentDurationFrames − 1]`, obtains the frame (L0 capture / L1 ring / L2
file), and binds the bitmap as its texture. Transform and opacity from the layer
summary apply to the sprite. (Structurally identical to the prior `TemplateSprite`;
only the frame source changes from SVG raster to webcap.)

## 8. Export

The export Worker has no DOM and cannot drive a webview, so before the encode loop
the **main process** captures every Motif layer's frames — through the same host,
at export resolution, on the composition fps grid — and hands the bitmaps to the
Worker (transferred). This is surfaced through the existing export "preparing"
wait. When a Motif is already persisted at L2, the Worker reads its PNG files
directly (`createImageBitmap` on a `Blob` works in Worker scope for raster
formats). Either way the bytes come from the same capture path the preview used.

## 9. Security sandbox (load-bearing for user uploads)

Because **every** Motif now runs arbitrary JS, and uploaded Motifs are untrusted,
the sandbox is on the hot path for all Motifs (not a special heavy tier). This is
not new cost — supporting uploads requires it regardless; webcap just applies it
uniformly. Requirements:

- **No network egress.** A strict CSP (`default-src 'none'` plus only what the
  capture needs) and/or a WebView2 `WebResourceRequested` filter denying any
  request not served from the Motif's own bundle. A Motif renders fully offline
  and deterministically; outbound requests (fingerprinting, exfiltration) are
  blocked.
- **No app/Tauri reach.** The opaque-origin sandboxed iframe already denies the
  app DOM and Tauri IPC; the host injects no privileged bridge into it.
- **Isolated profile** for the hidden WebView2 host (its own user-data folder),
  no top-level navigation away from the Motif.
- **Per-frame wall-clock limit** (the analog of today's 5 s render timeout): a
  capture that does not settle within budget fails that frame rather than hanging
  the bake.
- **Strict manifest/props validation** on import: malformed manifest, out-of-range
  props, a `max_duration_prop` naming a non-existent prop → reject the import, not
  a runtime crash.

## 10. Validation status

| Risk gate | Method | Result (2026-06-07) |
|---|---|---|
| Determinism of arbitrary web animation under clock-takeover + seek | Playwright: CSS+WAAPI+canvas-rAF, seek 500→1000→500ms | Green — byte-identical re-seek, exact advance |
| Native Tauri→WebView2 CDP capture from Rust, arbitrary resolution, taint-free | Throwaway in-app spike (reverted) | Green — controller reachable; setDeviceMetricsOverride ~27ms; captureScreenshot ~98ms PNG |

## 11. Module rename

- Product noun: **Motifs** (weaving-metaphor on-brand for WeftCut; means "a
  recurring design element"). Internal capture engine: **webcap**.
- Renames (non-exhaustive; finalized in the implementation plan): `templates/` →
  `motifs/`; `TemplateSprite` → `MotifSprite`; `TemplateParams` → `MotifParams`;
  MCP/agent tool `add_template` → `add_motif`, `list_templates` → `list_motifs`;
  `docs/templates.md` → `docs/motifs.md` (evergreen rewrite, separate step).
- The agent surface stays props-only (`add_motif` reasons about *what* a Motif
  says, never about capture/timing); raster state stays read-only
  (`idle | rastering{progress} | ready | error`), export "preparing" blocks on
  pending L2 bakes.

## 12. Boundaries / out of scope

- In scope: the Motif authoring contract, the webcap harness, the raster cache and
  escalation, compositor/export integration, the upload security sandbox, the
  module rename.
- Out of scope: adding/validating Motif layers in the data model
  (`docs/data-model.md`), the generic per-frame composite (`docs/render.md`),
  audio/mux. A Motif carries no audio.

## 13. Risks and open questions

- **Latency in release/warm conditions.** The 98 ms figure is debug, cold, 1080p,
  uninstrumented. Add a release-mode warm microbench during implementation; it
  informs L1/L2 defaults but does not change feasibility.
- **W2 fallback.** If a future WebView2/Tauri update breaks CDP reachability,
  the fallback is native window screenshot of the hidden host (bounded by physical
  DPI/resolution). Keep the capture seam abstracted so the backend can swap.
- **Long continuous animations bake slowly** (hundreds of distinct frames ×
  ~tens of ms). Accepted; mitigated by prewarm/persist. Surface a clear "preparing"
  progress; never silently truncate frames.
- **Cross-origin seek handshake.** Seeking inside the sandboxed iframe via
  `postMessage` must round-trip before each capture; verify the handshake +
  frame-settled cost stays within the per-frame budget for WebGL/Lottie Motifs.
- **Hidden host lifecycle.** When to spin up (first Motif use), when to tear down
  (idle timeout), and how to recover if the host process dies mid-bake.
- **Capture round-trip cost.** Unlike the old pure-JS SVG raster, webcap capture
  crosses JS↔Rust↔CDP and transfers a PNG per frame. Measure the *full* round-trip
  (not just the CDP call) plus the JS-side PNG decode; it compounds the per-frame
  budget and caps L1 prewarm throughput. If it dominates, consider transferring raw
  bitmap bytes rather than PNG, or batching captures.

## 14. Migration

The in-progress `feat/template-raster-pool` SVG rasterizer is **repurposed, not
discarded**: the pool/queue/reuse scheduler, the sandbox-iframe harness, the
cache tiers, and the content-window math all carry over. What is replaced is the
SVG-specific path: `render(t)`-mutates-SVG, SVG-string serialization, and
`<img>`→`createImageBitmap` rasterization give way to the webcap host + CDP
capture. The single built-in `countdown` template is reauthored as a Motif (real
HTML/CSS, declarative animation) as the first migration and conformance case.
