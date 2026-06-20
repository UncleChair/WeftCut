# Motifs

A Motif is a parameterized, time-varying overlay — a lower-third, a countdown, an
animated title card, a callout. The user picks one from the catalog, fills in its
props, and drops it on the timeline as a `Motif` layer; from then on it must
produce correct pixels at every composition frame, in both the live preview and
the export.

A Motif is **a real web page** — arbitrary HTML/CSS/SVG/canvas/WebGL and animation
libraries. There is exactly one rendering path, internally called **webcap**: the
page is driven to a precise time `t` and captured to a bitmap via the Chromium
DevTools Protocol (CDP), driven over `webContents.debugger` against an offscreen
Electron window. No per-engine backends, no engine-selection field.

This doc covers how a Motif instance becomes pixels. For the data model
(`MotifParams`, validation, the `add_motif` surface) see
[`data-model.md`](data-model.md); for the generic compositor see
[`render.md`](render.md).

## The principle, and the obstacle

The renderer's load-bearing principle is *preview pixels equal export pixels by
construction* — a single capture path feeds both surfaces. The hard platform wall
that shapes the design:

- **The export Worker has no DOM.** Preview runs in the renderer; export runs in a
  Web Worker against an `OffscreenCanvas` with no `document`/`<iframe>`/`Image`. It
  cannot run a Motif. So whatever produces preview pixels must produce export
  pixels through a path the Worker can consume — the **main process rasterizes,
  the Worker receives bitmaps**.

webcap clears it: capture happens on the main process, handing bitmaps to the
Worker for export. CDP `Page.captureScreenshot` is a real browser raster (not a
canvas read-back), so it sidesteps DOM-rasterization read-back hazards entirely —
the obvious "rasterize the DOM via an SVG `<foreignObject>`" route. (On Chromium an
inline `<foreignObject>` raster does not taint — measured, though external-resource
cases are unverified — so taint is not the binding reason. The Motif path uses CDP
capture regardless.)

The price of full web freedom is that a web page has its own clock and animates on
its own — nondeterministic, incompatible with a frame-exact editor (scrubbing,
re-export, preview==export all require that the same `t` always yields the same
pixels). The resolution is the **determinism contract**, the spine of the system:

> **A Motif renders as a pure function of time.** It never advances itself; the
> harness owns the clock and drives the page to each composition frame.

This is what makes Motifs a *video template system* rather than a screen recorder.
Everything else (capture, cache, export) is mechanism around this contract.

## Boundaries

- **In scope:** the authoring contract a Motif must satisfy, the capture harness
  that turns it into bitmaps, the raster cache and its escalation levers, and how
  the compositor and export read Motif frames.
- **Out of scope:** adding/validating Motif layers ([`data-model.md`](data-model.md)),
  the generic per-frame composite ([`render.md`](render.md)), and audio/mux. A
  Motif carries no audio.

## Authoring contract

A Motif is a directory of `manifest.json` + `index.html` (plus an optional
`assets/` for fonts and images), embedded in the binary via `include_bytes!` and
served to the offscreen capture host over a `motif:` URI scheme. `index.html` is a
normal web document.

### The lifecycle: `motif.define`

The harness injects two things before any author code runs: the clock takeover
(see [Determinism](#determinism-owning-the-clock)) and a global `motif`. The author
declares a lifecycle with one call:

```js
motif.define({
  // Runs once per distinct props value. Build the scene, declare animations,
  // load and await assets.
  async setup(props, ctx) {
    bar.animate([{ opacity: 0 }, { opacity: 1 }],
                { duration: 700, easing: "ease-out", fill: "both" });
    await document.fonts.load('700 56px "Inter"');   // see Fonts, below
  },
  // OPTIONAL: only when content must read the clock (e.g. a countdown number).
  frame(t, ctx) { label.textContent = Math.ceil(ctx.duration - t); },
});
```

- **`setup(props, ctx)`** — async, runs once per distinct props value. Builds the
  DOM, declares WAAPI/CSS/GSAP animations, loads and `await`s assets. Re-runs when
  a prop changes, so it must be self-contained (no residual cross-instance state).
- **`frame(t, ctx)`** — optional, called at each seeked time for imperative
  time-reading content. Pure-declarative Motifs omit it.
- **`ctx`** = `{ duration, width, height, fps, frame, random() }`. `t` is content
  time in seconds; `ctx.frame` the integer frame index. Both are provided so the
  CSS/WAAPI (time-based) and frame-based idioms each work.

### The one law: state is a function of `t`, not an accumulation

> Any visible state must be computable **from `t` alone** — via declared animations
> or `frame(t)` — never via mutation that **accumulates over time**.

```js
setInterval(() => { n++; label.textContent = n; }, 1000);   // ✗ stubbed, not seekable
frame(t) { label.textContent = Math.floor(t); }             // ✓ closed-form in t
```

Authors may use any normal animation tool (CSS animations/transitions, WAAPI,
GSAP, Lottie, canvas/WebGL): the harness owns the clock and seeks them. The single
learnable rule is *don't accumulate state via timers; express it as `f(t)`*.

| Anti-pattern | Why | Use instead |
|---|---|---|
| `setInterval` / self-advancing rAF accumulating state | stubbed / not seekable | closed-form in `frame(t)` |
| `fetch()` for data/fonts/images | sandbox-blocked, nondeterministic | bundle in `assets/` |
| reading real `Date.now()` for motion | returns virtual time | use `t` |
| unseeded physics/particle integration | depends on the prior frame | closed-form `f(t)` or seeded `ctx.random()` |
| global state accreted across instances | leaks after a prop-change rebuild | keep `setup` self-contained |

### The manifest

```json
{
  "id": "lower-third",
  "name": "Lower Third",
  "version": 1,
  "size": [1280, 320],
  "default_duration_s": 5.0,
  "content_duration_s": 0.8,
  "settle_rafs": 1,
  "fonts": [{ "family": "Inter", "file": "Inter.woff2", "weight": 700 }],
  "props_schema": {
    "title":    { "type": "string", "default": "Jane Doe", "max_length": 40 },
    "subtitle": { "type": "string", "default": "Director of Photography" },
    "accent":   { "type": "color",  "default": "#ff4d4d" }
  }
}
```

- **`size`** — the natural authoring size (CSS px, top-left origin). The author lays
  out within it; capture resolution is the harness's job (`setDeviceMetricsOverride`),
  so there is no resolution code in the Motif and no blur on scale-up.
- **`default_duration_s`** — the initial placed-layer length.
- **`props_schema`** — typed props (`string` with optional `max_length`, `color` as
  `#rrggbb[aa]`, `number` with optional `min`/`max`), each with a `default`. Props
  are validated (unknown keys reject, missing keys fall back to defaults) and
  canonicalized into a stable key order, so identical inputs produce identical bytes
  and identical cache keys.
- **`settle_rafs`** — how many real browser frames the harness waits after a seek
  before capturing (clamped to `{0,1,2}`, default `2`). CSS/DOM-only Motifs can set
  `1` to shave a frame; canvas/WebGL Motifs want `2`.
- **`fonts`** — declares bundled faces (see [Fonts](#fonts-assets-size)).
- The duration fields (`max_duration_s` / `max_duration_prop` / `content_duration_s`)
  are explained next.

### Content duration and the timeline window

A Motif's **content** has an intrinsic length; the **layer** on the timeline is a
*window* into that content, exactly as a video clip windows its media.
`MotifParams.src_in_us` is the window offset; the window width is the layer width;
the window end is derived, never stored. There are three duration shapes:

| Manifest | Content duration | Layer | Use |
|---|---|---|---|
| **`max_duration_prop`** (names a NUMBER prop) and/or **`max_duration_s`** | the prop value (live-editable), else the static `max_duration_s` | **capped** to that length; windowable (`src_in`) | bounded clips — a countdown |
| **`content_duration_s`** | this fixed value | **freely extendable**; frames past it clamp to the last content frame (a held, deduped tail), and it never windows | holdable overlays that animate in then hold — a lower-third |
| none of the above | the layer width | extendable; animates over the placed duration | unbounded holdable overlays |

The distinction between `max_duration_s` and `content_duration_s` is the load-bearing
one: both fix the seekable content length, but `max_duration_s` *also caps the layer*
while `content_duration_s` *does not*. A holdable lower-third sets `content_duration_s`
(its ~0.8 s in-animation) so the user can drag the layer arbitrarily long: every frame
beyond the in-animation maps to the same last content frame, which the cache collapses
to a single capture, and because the content-frame count is fixed, trimming the layer
never invalidates cached frames.

### Fonts, assets, size

- **Fonts:** declared in `manifest.fonts`, bytes in `assets/`; the page writes a
  normal `@font-face` referencing the bundled file, served same-origin over `motif:`.
  **Determinism caveat:** `await document.fonts.ready` alone can resolve *before* the
  `@font-face` fetch even starts (faces load lazily on first layout use), which would
  let the first capture paint a fallback and a later capture paint the real font. A
  font-using Motif MUST force the load explicitly — `await document.fonts.load('700 56px "Inter"')`
  for each weight/size it renders — before resolving `setup`.
- **Assets (images, JS libs):** bundled in `assets/`, referenced by relative URL,
  served from the `motif:` scheme — never the network.
- **Size & resolution:** lay out within `manifest.size`; the harness chooses the
  capture resolution. Layer transform and opacity are applied by the Pixi sprite at
  composite time, never captured.

## Determinism: owning the clock

Before any Motif code runs, the harness installs a clock takeover and seeks declared
animations to `t`:

| Animation source | How it is pinned to `t` |
|---|---|
| CSS animations/transitions, WAAPI | `document.getAnimations()` → `pause()` + `currentTime = tMs` |
| GSAP and other eased tweens | run on `requestAnimationFrame` + `performance.now` → both owned; the controlled rAF queue is flushed |
| canvas / WebGL render loops | bottom out on `requestAnimationFrame` → owned |
| `setTimeout` / `setInterval` / `Date.now` | stubbed to the virtual clock |

`seekTo(t)`: set the virtual clock; `getAnimations()` pause + `currentTime`; flush
the controlled rAF queue a bounded number of times (idempotent at a fixed clock);
force a layout flush; wait `settle_rafs` real browser frames so the paint commits;
then capture. The takeover is installed *before* any Motif code runs; an animation
that caches a `Date`/`performance` reference before that, or uses a time source the
harness does not hijack, is out of contract.

**The seek must stay re-seekable.** `seek()` only pauses and sets `currentTime` — it
never cancels or commits animations. Removing a completed animation would break
seeking *back* to an earlier time (the animation would be gone from
`getAnimations()`), violating the pure-function-of-`t` contract.

**Byte-identical determinism.** On Electron the offscreen-CDP capture is
**byte-identical across runs and across operating systems** at a fixed `t` — the
clock takeover freezes the frame, so two captures of the same Motif at the same `t`
produce the same bytes (verified across Windows, Linux, and macOS). Conformance
checks therefore assert exact-byte equality, not just a perceptual tolerance. The
cache captures each frame index once and reuses it.

## Capture harness

- **One reused offscreen Electron BrowserWindow host.** A single offscreen
  `BrowserWindow` (driven over `webContents.debugger` / CDP) is created lazily on first
  capture and reused across Motifs, frames, and layers. The footprint is one extra
  browser process tree, not one per layer.
- **Window-as-isolation.** The Motif is loaded as the host window's **top-level
  document**, served by the `motif:` scheme. Isolation comes from: a dedicated
  offscreen BrowserWindow (separate from the editor shell), no preload / disabled
  Node integration on the `motif:` origin, and a strict CSP (`default-src 'none'` plus
  only what capture needs) so the page is **fully offline** and can make no network
  request. The clock-takeover runtime is injected at document-start (before the
  Motif's `motif.define(...)`).
- **Multi-Motif navigation.** When a capture requests a different Motif than the one the
  host currently holds, the host **navigates** to the new `motif:` URL (reusing the
  window and CDP session; the init runtime is re-injected on the new document), and the
  capture state is reset so the readiness probe re-confirms the new page and the render
  metrics re-apply.
- **Capture via CDP, over `webContents.debugger`.** The host drives
  `Emulation.setDeviceMetricsOverride` (arbitrary resolution, independent of the physical
  screen), `Emulation.setDefaultBackgroundColorOverride` (alpha 0, so a Motif's
  `background: transparent` is preserved as real alpha instead of being flattened onto
  CDP's default opaque white), and `Page.captureScreenshot` (lossless **PNG** — the
  Canvas/CDP WebP path is lossy and crisp text edges matter). A `Runtime.evaluate`
  awaiting `window.__motifRender(t, props, meta)` runs `setup`/`frame`/seek/settle and
  resolves when the frame is visually ready; the screenshot follows. The whole
  render+capture is **serialized** under a lock so the several fill loops (on-demand
  sprite, prewarmer, baker) cannot interleave on the one host and screenshot a stale
  frame.

## Raster cache and escalation

A capture costs tens to ~100 ms — far more than a cheap vector raster — so the cost is
managed by **cache dedup, not a second renderer**: a static overlay produces identical
pixels every content frame, so the cache collapses it to one capture; only Motifs with
many *distinct* frames pay the per-frame cost repeatedly. Three escalation levers sit
over the one capture function:

- **L0 — on demand (default).** The playhead frame is captured when needed and bound as
  a texture, at the resolution the composite needs. An in-RAM LRU of per-frame bitmaps;
  evicted bitmaps are closed promptly.
- **L1 — in-RAM lookahead (always on).** A budget-paced background prewarmer fills the
  shared L0 cache ahead of the playhead, off the play loop, during playback and while
  paused. Active layers dedupe by content cache key (N identical Motifs warm one content
  set); a pure planner orders playhead-first, then forward, then earlier frames for small
  backward scrubs; the per-content budget keeps the warm set within the cache cap so the
  LRU can't evict a still-targeted frame.
- **L2 — persisted PNG.** One PNG per frame under `<workspace>/Cache/raster/`, keyed by a
  hash of `(motifId, version, contentHash, canonicalProps, renderW, renderH, fps, contentDurationFrames)`.
  Survives reload, caps the in-RAM working set, and lets export read frames off disk;
  safe to delete (regenerates). Driven by a global **Pre-bake** setting (off by default)
  and a per-layer **Pre-bake now** action; reads are disk-first, gated by an in-RAM
  baked-key index so un-baked Motifs pay no fs cost.

The key is **source-derived**: `contentHash` is a hash of the Motif's manifest + HTML, so
editing a Motif's source (or updating an installed one) yields a fresh key and re-captures —
the cache tracks *current* content rather than relying on a layer's stored version. A Motif
with no `contentHash` (a built-in seeded from the build-time bundle, whose content is fixed)
keys stably without it.

**Not in the cache key:** the layer transform and opacity (applied by the Pixi sprite at
composite time — moving/scaling/fading never re-captures) and the window position
(`src_in_us`; frames are keyed by absolute content-frame index, so trimming reuses cached
frames). Changing props, the content duration, or the composition fps does change the key.

### Editing an installed Motif

Editing an installed (or built-in) Motif opens a **working draft** seeded from its source —
a built-in is a forced **fork** (built-ins live in the bundle and can't be overwritten). The
selected layer swaps in place onto the draft so the source panel previews it. From there:

- **Update** republishes the draft over the original id and **bumps its version**. Because the
  cache key is source-derived, every placed layer — this project and others — re-renders with the
  new look. Current-project layers that referenced the working draft are **rebound** to the
  original id and their stored props are **lenient-migrated** to the new schema (unknown keys
  dropped, new keys filled from defaults) in one undo step; the source panel's render path already
  tolerates a mid-flight schema mismatch, so a placed layer never blanks. Other projects pick up
  the change the next time they open.
- **Save as new** publishes the draft under its own fresh id; the original is untouched.
- **Discard** swaps the layer back to the original and deletes the draft.

A Motif can also be **imported** from an external single-file `.html` (its manifest island is
parsed + validated at import; any id it claims is ignored and a fresh one minted). It lands as a
draft to preview and install — the same path an agent-authored Motif would take.

### Status display

Each Motif layer reports a bake phase — `idle | warming{progress} | rastering{progress} | ready | error`.
A **status dot** on the timeline layer block and a line in the **property panel** reflect
it: warming shows L0 coverage filling ahead of the playhead, a persisted (L2) sequence
reads as ready immediately, error is surfaced, idle shows nothing.

## Compositor integration

`compositeFrame(tUs)` passes each Motif sprite its layer-relative time
`tInLayerUs = tUsSnapped − layer.t_start_us`. The sprite resolves the content time, maps
it to a frame index on the exact-rational frame grid (shared `frames.ts` helpers — never
`round(µs·fps)`), clamps to `[0, contentDurationFrames − 1]`, obtains the frame (L0 / L1 /
L2), and binds the bitmap as its texture. Transform and opacity from the layer summary
apply to the sprite.

## Export

The export Worker has no DOM and cannot drive a renderer, so before the encode loop the
**main process** captures every Motif layer's frames — through the same host, at export
resolution, on the composition fps grid — and hands the bitmaps to the Worker
(transferred). This is surfaced through the export "preparing" wait. When a Motif is
already persisted at L2, the Worker reads its PNG files directly. Either way the bytes
come from the same capture path the preview used, so the exported Motif matches the
preview.

## User Motifs

Beyond the built-ins, users (and agents — see below) author their own Motifs. They're the
same single self-contained `.html` + manifest-island documents, stored globally under
`<app_config_dir>/motifs/` (so they're reusable across projects, like built-ins), and they
render through the exact same capture path — once installed, a user Motif behaves
indistinguishably from a built-in.

The lifecycle is **draft → preview → install**:

- **Create** — three entry points: the picker's **New** (a starter draft), **Import** of an
  external single-file `.html`, or an agent over MCP (`write_motif_draft`). A draft gets a
  unique, final-ready id at birth, so installing it needs no layer rebind.
- **Preview** — a draft is a placeable layer; the compositor renders it **into the real
  project canvas** so the author sees it in context. A draft's frames are keyed by
  `content_hash`, so every source edit re-captures (see [Raster cache](#raster-cache-and-escalation)).
- **Edit** — a placed draft layer gets an in-app **source panel** (edit the HTML + island,
  Apply → re-render). The on-disk store is also **watched**: saving a Motif's file from any
  external editor hot-reloads the same way — disk changes coalesce (debounced) into the same
  catalog resync the panel uses, and the content-hash cache key plus the capture-host
  cache-buster force a fresh capture. This covers installed Motifs too: any disk edit
  re-renders every placement. Editing an *installed* Motif opens a working draft (see
  [Editing an installed Motif](#editing-an-installed-motif)).
- **Install** — **publish-new** (under the draft's own id) or **update-in-place** (republish
  over the target, bump its version). Updates are **live/mutable**: every placement — this
  project and others — re-renders with the new look (the cache key is source-derived, never
  the layer's stored `motif_version`). **Save-as-new** is the "keep my old look" escape hatch.

Because updates are live/mutable, the `motif_version` stored on a placed layer is only a
**seen-at marker** — it never pins rendering. When a project opens, each Motif layer's marker
is compared against the catalog's current version; any mismatch surfaces a one-time
**"Motifs changed since you placed them"** notice (v1 → v3, with the affected layer count)
plus a status-log entry — the cross-project signal for updates made while this project was
closed. Dismissing it acknowledges: the markers bump to current in one undo step, so the
notice doesn't repeat on the next open. There is deliberately no global reverse index of
which projects use a Motif; each project self-reports when it opens.

A project referencing a since-deleted Motif degrades to an error placeholder, not a crash.
The lifecycle is driven from the property panel (Install / Edit / Update / Save-as-new /
Discard / Delete) with inline confirms, and equivalently over the MCP tools below. Security
of the untrusted-document case is covered in [Security](#security).

## Agent surface

An MCP agent can both *place* and *author* Motifs, mirroring the human lifecycle through the
same backend cores (so the two surfaces can't drift):

- **Place / inspect.** `add_motif` is props-only — agents reason about *what* a Motif says,
  never about capture or timing — and resolves built-ins **and** user Motifs (drafts +
  installed). `list_motifs` enumerates the full catalog (each entry carries `status` =
  `builtin | installed | draft`, plus `content_hash`/`target_id`), and `motifs://current`
  mirrors it. Raster state is read-only (`idle | warming | rastering | ready | error`); the
  export "preparing" wait blocks on pending bakes. (The MCP list is manifest-only — `html` is
  stripped so it doesn't bloat agent context; agents fetch source on demand.)
- **Author.** `get_motif_source {id}` reads a Motif's `{ manifest, html }`; `write_motif_draft
  { manifest, html, from? }` writes a draft (`from` records an existing Motif as the Update
  target); `preview_motif_draft { id, t_sec, width?, height?, props? }` returns a base64 PNG of
  one frame so the agent can **see its output and self-correct**; `install_motif { draft_id, mode:
  new | update }` publishes (update bumps the version + rebinds + migrates placed layers);
  `delete_motif { id }` removes a user Motif (built-ins rejected).

Agents observe and author; they never drive the renderer directly.

## Security

User Motifs are untrusted web documents (an agent or a human authored them), so the
capture host is the trust boundary. A **single reused offscreen Electron
BrowserWindow** (driven over `webContents.debugger` / CDP) navigates between Motif
ids/content hashes; isolation comes from a dedicated window (separate from the
editor), no preload / disabled Node integration on the `motif:` origin, and CSP
`default-src 'none'` — fully offline (no `connect-src` → no fetch/XHR/WebSocket).
That window-as-sandbox carries both trusted built-ins and untrusted user Motifs. On
top of it:

- **Import-time validation** — the manifest island is parsed + validated against the
  `Manifest`/`PropSpec` schema (sane `size` bounds, well-formed `props_schema`,
  `default_duration_s`/`content_duration_s` finite-and-positive) and rejected at write/import,
  not as a runtime crash.
- **Per-frame wall-clock timeout** — `motif_capture_frame` caps the render so an
  infinite-loop Motif fails the frame (and tears down the wedged host) instead of hanging.
- **Path-safe disk serving** — the `motif:` scheme resolver rejects `..`/absolute/separator
  escapes and confirms the resolved path stays under the Motif's own directory.
- **Id-namespace isolation** — minted ids can never shadow a built-in (`countdown`,
  `lower-third`) or the reserved `drafts/` segment; the manifest's own `id`/`version` are
  ignored (app-assigned).

Residual accepted risk: a renderer-level Chromium exploit is out of our control (mitigated by
the isolated, offline host with no preload / Node integration); a determinism-violating Motif
renders wrong but harmlessly (surfaced by the determinism story).
