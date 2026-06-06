# Templates

A template is a parameterized, time-varying SVG overlay — a lower-third, a
countdown, an animated title card. The user picks one from the catalog, fills in
its props, and drops it on the timeline as a `Template` layer; from then on it
must produce correct pixels at every composition frame, in both the live preview
and the export.

This doc covers how a template instance becomes pixels. For the data model
(`TemplateParams`, validation, the `add_template` surface) see
[`data-model.md`](data-model.md); for the catalog embedding and the generic
compositor see [`render.md`](render.md). The decision to author templates as SVG
rather than HTML/CSS — and why — is [ADR 0015](adr/0015-templates-rasterize-from-svg-not-foreignobject.md).

## The principle, and the obstacle

The renderer's load-bearing principle is *preview pixels equal export pixels by
construction* — one compositor feeds both. Templates have to honor it across two
surfaces with different capabilities, and under one hard platform limit:

- The **preview** runs in the webview and has a DOM.
- The **export** runs in a Web Worker against an `OffscreenCanvas`, with **no
  DOM** — no `document`, no `<iframe>`, no `Image`. It cannot run a template.
- The only DOM-to-bitmap path the web platform offers that yields a *usable*
  bitmap is **plain SVG**. An HTML/CSS overlay rasterized through an SVG
  `<foreignObject>` is cross-origin-tainted in WebView2 — unreadable and
  un-uploadable to the GPU compositor (ADR 0015). So templates are SVG.

Two facts about SVG settle the architecture:

- A template's pixels can only be *produced* where there is a DOM — the main
  thread runs `render(t)` and rasterizes via `<img>` → `createImageBitmap`.
- A Web Worker cannot even *decode* SVG (`createImageBitmap` on an SVG blob fails
  off the main thread). So the export Worker can't rasterize a template either.

The resolution: **`render(t)` and rasterization both happen on the main thread**,
for preview and for export. The export Worker receives already-rasterized
bitmaps from the main thread rather than producing them. Because a single
main-thread rasterizer feeds both surfaces, preview equals export by
construction — faithfully, at each surface's resolution.

## Boundaries

- **In scope:** the authoring contract a template must satisfy, the capture
  harness that turns it into bitmaps, the raster cache and its escalation levers,
  and how the compositor and export read template frames.
- **Out of scope:** adding/validating template layers (data-model.md), the
  generic per-frame composite (render.md), and audio/mux (rendering.md). A
  template carries no audio.

## Authoring contract

A template is a directory of `manifest.json` + `index.html` (plus an optional
`assets/` for fonts and images), embedded in the binary via `include_str!`
(`src-tauri/src/templates/`) and mirrored to the webview catalog. `index.html` is
a normal HTML document — the markup plus an inline `<script>` that defines
`render`. The filename encodes no rendering tier: `manifest.engine` declares how
the document is captured, so a future HTML+JS template is the **same shape** with
no SVG file.

The manifest declares identity, natural size, default duration, an optional
content-duration cap, a typed `props_schema` (string / color / number, each with
a default), an optional `fonts` list, and an `engine`:

```json
{
  "id": "countdown",
  "name": "Countdown",
  "version": 1,
  "size": [480, 480],
  "default_duration_s": 5.0,
  "max_duration_s": 5.0,
  "max_duration_prop": "seconds",
  "engine": "svg",
  "props_schema": { "seconds": { "type": "number", "default": 5 }, … }
}
```

`max_duration_s` is the template's **intrinsic content duration** — the full
length of the animation it knows how to render (a 5-count). `max_duration_prop`
names a NUMBER prop that drives that length *live*: when present, the current
value of that prop (here `seconds`, in seconds) is the content duration, so
editing the prop relengthens the content. A template with neither is unbounded
(a holdable overlay — see "Content duration and the timeline window" below).

`engine` selects the capture pipeline: **`"svg"`** (today) serializes the `<svg>`
and rasters it via `<img>`; **`"webview"`** (reserved) renders `index.html` in a
hidden webview and screenshots it (full HTML/CSS/JS — the Tier-3 path);
**`"satori"`** (reserved) lays out an HTML/CSS subtree to SVG. v1 ships `"svg"`.

### Content duration and the timeline window

A template's **content** has its own intrinsic length (the resolved cap above);
the **layer** on the timeline is a *window* into that content — the same
source/window relationship a video clip has with its media. `TemplateParams`
stores `src_in_us`, the window's offset into the content; the window's width is
the layer width (`t_end_us − t_start_us`), and the window end is derived, never
stored. The invariant is `0 ≤ src_in_us` and `src_in_us + width ≤ content_dur`.

This decouples two edits that used to be the same thing:

- **Editing the cap-driving prop** (`seconds`) relengthens the *content* and
  re-renders, but does **not** move or resize the layer — content frame 0 stays
  pinned at the layer's start. (The one exception: shrinking the content below
  the current window clamps `src_in_us` and `t_end_us` into the new content, so
  the layer shrinks — the longer content no longer exists.)
- **Trimming the layer** windows the content without changing its length: the IN
  edge moves `t_start_us` *and* `src_in_us` together (scrubbing into the content,
  floored so it can't go before content frame 0); the OUT edge moves `t_end_us`
  only, capped so the derived window end can't pass the content's end.

A template with no cap (no `max_duration_prop` and no `max_duration_s`) keeps the
holdable-overlay behavior: it animates over the layer width itself, `src_in_us`
is inert, and both edges trim freely.

The SVG obeys one rule that makes a template *capturable*:

> **A template renders as a pure function of time.** It exposes a synchronous
> `render(tSec, durationSec, props)` that fully produces the SVG DOM state for
> time `t` in a single call, and nothing else drives it.

Concretely:

- **`render` is synchronous and total.** Calling it with a timestamp leaves the
  SVG in exactly the state that timestamp should display. There is no
  `requestAnimationFrame`, no `setTimeout`, no SMIL or CSS animation, no
  self-advancing clock. A template animates by *mutating its own SVG* —
  `element.textContent`, `setAttribute("transform", …)`, `stroke-dashoffset`,
  attribute and class toggles — in response to `tSec`.
- **Absolute vs normalized pacing is the template's choice.** `render` receives
  `tSec` as the **content** time (the window offset plus the in-layer time) and
  `durationSec` as the **content** duration (the resolved cap, not the layer
  width). A countdown reads `tSec` against `durationSec` (`ceil(durationSec −
  tSec)`), so the same 6-count shows "6" at content 0 regardless of how much of
  it the window exposes. A progress bar reads `tSec / durationSec`. Passing both
  leaves the decision with the author.
- **SVG only.** Shapes, paths, `<text>`, gradients, masks, clips, transforms,
  opacity — anything SVG renders. **No `<foreignObject>`** (it taints the raster;
  ADR 0015), no HTML/CSS layout, no `<canvas>`. SVG has no automatic text
  wrapping, so multi-line text is explicit `<tspan>` line-breaking; the harness
  can measure runs via `getComputedTextLength` to compute where to break.
- **Fonts are embedded and injected at raster time.** An SVG rasterized through
  `<img>` is an isolated document — it cannot see the host's installed or app
  fonts. A non-system font must appear as a data-URL `@font-face` inside the SVG.
  Templates are authored and stored *font-free* (referencing the family by name);
  the harness concatenates the `@font-face` block in just before rasterizing, so
  the font is carried once per template rather than duplicated into every stored
  frame.
- **Readiness handshake.** Before any frame is captured the template resolves a
  one-time readiness promise once its assets are present — fonts
  (`document.fonts.ready`, after the `@font-face` is applied) and any embedded
  images. Per-frame `render` stays synchronous; readiness is awaited once, up
  front.

The harness defensively stubs `performance.now`, `Date.now`, and
`requestAnimationFrame` inside the template's context, so a stray wall-clock read
can't introduce nondeterminism between two captures of the same `t`.

Props are validated against `props_schema` before they reach the template
(unknown keys reject, missing keys fall back to defaults) and canonicalized into
a stable key order, so two instances with the same inputs produce the same bytes.

## Capture harness

Turning a running template into a bitmap is a two-step path the harness owns:

1. The template is hosted in a **sandboxed iframe** — `allow-scripts`,
   deliberately **without** `allow-same-origin`, so template code runs in an
   opaque origin that cannot reach the app's DOM or Tauri APIs. This isolation is
   uniform for built-in and (eventually) community templates.
2. The iframe loads the template's `index.html` (markup + its inline `render`
   script); the harness injects its own message loop and clock stubs alongside.
   On `{ t, props }` it calls `render(tSec, durationSec, props)`, forces a
   synchronous reflow, and **serializes the post-render `<svg>` element to a
   string** — with any `<script>` descendants stripped, so the output stays
   well-formed XML, and the `@font-face` injected, images embedded as `data:`
   URLs. It `postMessage`s that string to the host.
3. The host (the rasterizer) wraps the string in a `Blob`, loads it through an
   `<img>` element, and calls `createImageBitmap(img)`. (`createImageBitmap`
   applied directly to an SVG `Blob` fails — the `<img>` indirection is required.)
   No scripts run during rasterization; the SVG is already in its final state.

A single harness iframe is reused across templates via a job queue rather than
mounting one per layer. The picker, the preview, and the export's raster pass are
all thin drivers of this one harness.

## Raster cache and escalation

`render(t)` is a pure function, and a single SVG frame rasterizes in low
single-digit milliseconds — comfortably within a frame budget for typical
playback. So the default is to **rasterize on demand**, with no persisted
artifact at all: the source of truth is the template plus its props, which the
project already holds. Three escalation levers — measured on the user's own
hardware — handle progressively heavier cases. They are one mechanism over one
shared raster function, so a heavier lever is a small add, not a separate path:

- **L0 — on demand (default).** The playhead's frame is rasterized when needed
  and bound as a texture. Zero disk, zero pre-work, instant after an edit.
  Resolution-independent: the frame is rastered at the resolution the composite
  needs, so a template scaled up never blurs.
- **L1 — in-RAM lookahead (prewarm).** A budget-paced background prewarmer fills
  the **same shared L0 cache** ahead of the playhead, off the play loop, so
  playback and scrubbing hit the cache instead of racing on-demand rasters. It
  runs continuously — during playback **and** while paused or on project load.
  Each composite frame, the active template layers map to their content identities
  (deduped by cache key, so N identical templates warm **one** content set); a
  pure planner picks which `(cacheKey, content frame)` to ensure cached and in
  what order: the playhead frame first, then forward, then earlier frames for
  small backward scrubs. It warms the **whole content when it fits** the budget,
  otherwise a forward **sliding window**; the per-content budget is `cap ÷
  distinct-content-count` so the union of warm targets never exceeds the cache cap
  and the LRU can't evict a still-targeted frame. Rastering is time-sliced into
  small batches scheduled on idle callbacks, so it never blocks the UI or the play
  tick. Rasterization itself runs **off the main thread**: a small pool of
  sandboxed rasterizer iframes turns each frame's SVG into a transferred bitmap
  in parallel (the per-`templateId` render harness stays serial, but it is only
  the cheap render stage), with an automatic fall-back to a main-thread raster if
  the pool is unavailable. This keeps the cache filling ahead even under many
  simultaneous templates. The L0 on-demand path remains the fall-back for any
  not-yet-warmed frame (e.g. immediately after a seek). Buys smooth playback;
  costs bounded RAM; no disk.
- **L2 — persisted PNG (opt-in / auto-escalated).** The frame sequence is written
  to disk under the workspace `Cache/raster/`, one **PNG** per frame (PNG because
  the Canvas API's WebP encode is lossy and crisp text edges matter; ADR 0015),
  keyed by a hash of `(templateId, version, canonicalProps, renderWidth,
  renderHeight, fps, durationFrames)`. Buys **persistence** — the sequence
  survives reload, caps the in-RAM working set, and lets the export read frames
  straight off disk — rather than additional smoothness (L1 already gives that).
  The on-disk sequence is safe to delete; it regenerates.

L1 is **always on** — the prewarmer runs continuously and costs nothing but
bounded RAM, so there is no threshold to cross and nothing for the user to
predict. Escalation to **L2** is **measurement-driven**: on add or edit the
harness times one raster on the actual hardware, and heavy or persistence-worthy
cases auto-escalate to the persisted sequence (a manual per-layer override is the
escape hatch, not the primary control). Render and bake resolution follow the
composition (display) size — never below it — so persisted frames don't blur on
scale-up.

### What is and isn't part of the cache key

The layer's **transform and opacity are not** rastered or keyed — they're applied
by the Pixi sprite at composite time, so moving, scaling, or fading a template
never re-rasterizes it.

| Change | Effect |
|---|---|
| props | re-raster (new key) |
| content duration (the cap / `seconds`) | re-raster (the frame count changed) |
| composition fps | re-raster (the frame grid changed) |
| window (`src_in_us` / layer width) | no re-raster — frames are keyed by **absolute content frame**, so two windows into the same content share cached frames |
| layer transform / opacity | no re-raster (sprite-applied) |
| composition width / height | no persisted-key change (L0/L1 raster at composite res) |

The key carries the **content** frame count (from the resolved cap), and each
frame is the absolute content-frame index — so trimming the window never
re-rasters and overlapping windows reuse the same bitmaps. Identical inputs hash
to the same L2 key and share one sequence. Patch
`TemplateParams.props` field-wise rather than replacing the whole `params`, or
the cache thrashes on every prop tweak (data-model.md pitfall).

Persisted (L2) baking never runs as one synchronous burst: a single reused
harness drains a job queue **time-sliced** — a frame budget per idle tick,
yielding between — in **playhead-first** order (the visible frame first, then
fanning outward). Rapid edits **debounce** and **cancel the in-flight bake**.
Orphaned sequences (superseded prop values) are swept when the project loads.

## Compositor integration

`compositeFrame(tUs)` passes each template sprite its layer-relative time
`tInLayerUs = tUsSnapped − layer.t_start_us` (the same relative convention
`SubtitlesSprite` uses). The sprite resolves the **content** time `src_in_us +
tInLayerUs` and maps it to a frame index on the **exact-rational frame grid** (the
shared `frames.ts` helpers — never a lossy `round(µs · fps)`, which drifts into
off-by-one frame duplication), clamps it to `[0, contentDurationFrames − 1]`,
obtains the frame (L0 raster, L1 ring, or L2 file), and binds the bitmap as its
texture. (An uncapped template has `src_in_us = 0` and uses the layer width as its
content duration — the original "animate over the placed duration" behavior.)
Transform and opacity from the layer summary apply to the sprite itself.

## Export

The export Worker has no DOM and cannot decode SVG, so it cannot rasterize a
template. Before the encode loop, the **main thread** rasterizes every template
layer's frames — through the same harness, at export resolution — and hands the
bitmaps to the Worker (transferred); this is surfaced through the export
"preparing" wait. When a template is already persisted at L2, the Worker reads
its PNG files directly (`createImageBitmap` on a `Blob` works in Worker scope for
raster formats), skipping the round-trip. Either way the bytes come from the same
rasterizer the preview used, so the exported template matches the preview.

## Picker

The catalog picker drives `render(t)` through the same harness the timeline and
export use, rather than mounting a free-running iframe — so what the picker shows
is the same SVG at the same timestamps those paths rasterize. The **selected
template's large preview animates on hover**: while the pointer is over the
preview, a `requestAnimationFrame` loop advances `t` over `[0, duration)` in real
time (sampled at a user-adjustable preview frame rate — a number input under the
preview, defaulting to the composition frame rate), re-rendering each frame
through the
harness and binding it as an object URL (the previous URL is revoked on each
swap, so the working set stays bounded); moving the pointer away reverts to the
static first frame (`t=0`). Hovering plays from the start. The loop reads the
current props, so prop edits reflect live; `prefers-reduced-motion` skips the
loop and keeps the static frame. Card thumbnails stay static single frames (one
representative still). Both the large preview and the card thumbnails are
**fixed 16:9 boxes** of a set width; the template (whatever its intrinsic
aspect) is scaled to *contain* and centered, with the checkerboard showing
through the letterbox margins — so an oversized or oddly-shaped template can't
blow up the display area. Until the harness has mounted and rastered the first
frame, the box shows a loading spinner (not a blank or a transient error — the
harness-teardown race that rejects an in-flight `load()` with "harness: disposed"
is swallowed rather than surfaced). Prop edits are debounced so editing stays
responsive.

## Agent surface

`add_template` stays props-only — agents reason about *what* a template says,
never about rasterization or frame timing. Raster state is exposed read-only for
automation that needs to sequence around it: each template layer reports
`idle | rastering{progress} | ready | error`, both as a query and on the
`/events` change feed, and the export "preparing" wait blocks until pending L2
bakes finish. Agents observe; they do not drive.
