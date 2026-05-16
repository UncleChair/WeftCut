# HTML render groups — design

**Status:** Designed in a grilling session on 2026-05-17. Not yet
implemented. Builds on top of the shipped [[preview-dom]] (loose-parity
DOM compositor) and [[group-system]] (Phases G.1–G.6, flat groups with
fan-out edits). Branch name TBD (`feat/html-render-groups` if landed as
big-bang; see Phase plan for a smaller alternative).

---

## Problem

ffmpeg expresses some video transforms badly or not at all — 3D
perspective, multi-axis transform stacks, animated clip-paths, conic
gradients sweeping over a video, compound transform-origin animation.
The maintenance cost of mapping CSS effects to ffmpeg lavfi is real,
and for the genuinely-unsupported cases there's no equivalent at all.
Authors who can express "what I want" trivially in CSS hit a wall when
the same intent has to lower to ffmpeg.

The [[preview-dom]] decision contract took the position that
preview-vs-export pixel parity is *not* this product's differentiator,
and shipped a loose-parity DOM preview with Render & Play as the
WYSIWYG escape hatch. That choice still stands for the bulk of the
timeline. **But** it leaves no answer for the case "I want this CSS
effect on the *exported* video" — Render & Play just renders through
ffmpeg, which doesn't have the CSS effect.

The proposal: extend the template raster path (HTML → offscreen
webview → `__seek(t)` → captured frames → ffmpeg ingests; already
shipped for `Template` layers) to **wrap groups of layers** in a
sub-composition that exports through CSS rather than through lavfi.
ffmpeg owns deterministic decode (its strength); HTML owns visual
composition (HTML's strength). Each does what it's strong at; neither
reaches into the other's territory.

The price is per-frame snapshot speed (30–100 ms × project frame
count) and the opt-in authoring step of grouping the affected layers
and toggling `render_mode = Html`. The benefit is **any CSS the
webview supports, applied to real video, exports correctly** without a
per-effect lavfi mapping.

---

## The decision contract

These twelve choices, settled in the grilling session, define the
architecture. Phases below assume them.

### 1. Trigger — capability gap, not maintenance gap

The motivating use-case is **CSS effects on real media that ffmpeg
expresses badly or not at all**. Maintenance burden (the
`ffmpeg(params)` ↔ `css(params, t)` catalog parity) is real but
secondary; we're not unifying on CSS to delete the ffmpeg side, we're
adding a CSS island for what the ffmpeg side can't do.

Rejected framings:

- *Walk back loose-parity preview-vs-export everywhere.* That's the
  preview-dom contract reversed; out of scope.
- *Replace the effect catalog's ffmpeg slot with CSS for everything.*
  Per-frame snapshot is far slower than lavfi for the cases lavfi
  already handles. Use lavfi where it works; use the HTML island only
  where lavfi doesn't.

### 2. Granularity — per-group sub-composition

The unit of "html-render" is a **group** of layers, not a single layer
or a single effect. The motivating case ("a video with a label
overlaid that follows the same 3D perspective transform") requires
the video and the label to **share a CSS coordinate space**, which a
per-layer island can't express — each per-layer island would mount an
isolated DOM and the label's CSS couldn't see the video's transform.

A per-group island lets the children share one DOM, one transform
stack, one z-context. Mixed-grain alternatives (per-layer with
alpha video, per-effect with parent-layer promotion, per-track
bundling) were considered and rejected on cost-vs-expressiveness
grounds; see grilling-session transcript.

### 3. Data model — `Group.render_mode: Native | Html`

The existing `Group` (`docs/group-system.md`, Phases G.1–G.6, shipped
2026-05-15) gains one field:

```rust
// state/group.rs
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub enum GroupRenderMode {
    #[default]
    Native,
    Html,
}

pub struct Group {
    pub id: GroupId,
    pub label: Option<String>,
    pub members: imbl::OrdSet<LayerId>,
    #[serde(default)]
    pub render_mode: GroupRenderMode,
}
```

- `Native` is the default; existing groups load as `Native` via
  `#[serde(default)]` (no migration writes needed).
- `Html` opts the group's visual children into the HTML island render
  path. Audio children pass through to the main ffmpeg amix unchanged
  (see decision 7).
- Schema bumps v5 → v6 (the field addition); the migration is a no-op
  on the wire, only the version is recorded.

Reuses every existing group invariant — aligned-edge coupling,
locked-member rejection, fan-out trim/split — verbatim. Confirms at
implementation: track-position constraints may need to relax under
`Html` mode because DOM stacking is paint order inside the group,
not track-index in the parent timeline; see Phase H.2 below.

### 4. Source video into HTML — ffmpeg pre-extracts source frames

The composed HTML for an html-render group **never contains a
`<video>` element during export**. Source media is materialized as a
PNG sequence by ffmpeg before raster runs; the HTML references the
frames via `<img src=...>` and the `__seek(t)` shim swaps the `src`
per frame.

```
Per html-group export, source-side:

  ffmpeg-extract  ─► tmp/<group>/source/frame_NNNNN.png  (ring buffer, ~30 frames)
                              │
                              ▼
                        webview reads frame N as <img>
                              │   raster's __seek(t)
                              │
                              ▼
                        composition captures composited frame
```

Why this and not `<video>`-element-in-HTML or WebCodecs decode:

- ffmpeg does frame-exact decode; `<video>.currentTime` does not.
  Path-iii inherits ffmpeg's precision.
- Kills the cross-platform decode axis for the export side entirely.
  The offscreen webview never decodes H.264; Linux WebKitGTK without
  `gstreamer1.0-libav` works.
- WebCodecs path (the previous B.3 engine, deleted in preview-dom
  Phase F) is exactly what we just removed — reviving it for a
  narrower purpose isn't worth the code resurrection.

**Source extraction shape.** One ffmpeg invocation per video child in
the group, bounded by `(-ss src_in, -t (src_out - src_in))`. Output
is `frame_NNNNN.png` into a per-export tmp dir. Raster reads frames
in sequence; after consuming frame N, raster `unlink()`s it. The
extraction is throttled by the ring-buffer fill (extraction sleeps
when N+30 exists; resumes when raster consumes). Peak transient disk
for source ≈ 30 × frame-size ≈ 15 MB at 1080p.

### 5. Preview parity inside an html-render group — same composed HTML, different video resolver

Inside an html-render group, preview mounts the **same composed HTML**
that export raster uses. The single difference is the resolver for
`<video data-source-layer="L-id">` slots:

- **Preview path:** resolver fills `<video src="asset://<proxy>">` and
  per-frame nudges `currentTime` to `(t - layer.t_start + layer.src_in)`
  toward target. ±1-frame precision (the same precision preview-scrub
  uses elsewhere).
- **Export path:** resolver fills `<img src="tmp/.../frame_NNNNN.png">`
  and swaps `src` per `__seek(t)`. Frame-exact.

Same composition HTML → same CSS → same per-frame styles → same
visual result inside the group, modulo the seek precision delta on
the video frame itself. CSS transforms, filters, blend modes,
animations are pixel-identical preview-to-export inside an
html-render group.

This **does not walk back the preview-dom loose-parity contract**.
Outside html-render groups, preview stays loose; Render & Play is
still the verification path for text, blur, color, drawtext. Inside
html-render groups is the **opt-in pixel-parity zone**.

Contract update: the preview-dom decision contract gains
"opt-in pixel-parity zone per Group{render_mode=Html}" as a *third*
parity tier alongside "loose" (default) and "subtitle pixel-parity
via libass-wasm".

### 6. Output to main ffmpeg — per-export tmp alpha video (β)

The raster output of an html-render group becomes a single
intermediate file: VP9-encoded with `yuva420p` alpha, written to
`tmp/<workspace>/html-group-<group-id>-<state-hash>.webm`. The main
ffmpeg export pass treats it as a normal `-i` input.

```
Three-phase export per html-render group:

  Phase 1 — source frame extraction (ring buffer, 30 frames steady state)
  Phase 2 — raster composite + capture (per-frame __seek; ~30–100 ms / frame at 1080p)
  Phase 3 — encode captured frames to VP9+yuva420p (image2pipe streaming; near real-time)

Then: main ffmpeg picks up the .webm as one input among many.
```

Peak transient disk: ~45 MB per 30 s 1080p group (vs ~450 MB if we
kept PNGs all the way through; vs ~0 MB if we did pure-pipe streaming
into the main ffmpeg, which adds concurrent-process orchestration
complexity we don't want yet).

**Lowering.** The IR's `lower.rs` pass detects `Group.render_mode ==
Html`, materializes the alpha-video for that group via
`html_group::materialize(...)`, and emits the resulting `webm` path
as a `DecodeV` input with `format=yuva420p` inserted on its output
edge so the surrounding `Overlay` chain blends with alpha. No new IR
node kind is needed; the alpha-video is just a transient input.

**No cache for v1.** Cache hit rate for html-render groups is
structurally low (source edits invalidate; html-groups are usually
edited until done, then exported once). Add a content-hashed cache
at `Cache/html-groups/<hash>.webm` as a one-evening followup when
usage warrants — the v1 transient-only path doesn't grow tech debt
that complicates that add.

### 7. Audio inside an html-render group — passthrough

Audio doesn't snapshot. Audio layers inside an html-render group
**bypass raster** and contribute to the main ffmpeg's `amix` chain
exactly as if they sat outside the group. The "html-render" mode
applies only to visual layer kinds (`VideoClip`, `ImageOverlay`,
`Color`, `Text`, `Template`, `Subtitles`).

The V.6 Separate-audio feature shipped 2026-05-16 makes this clean
for the common AV-pair case: the video child renders via raster, its
auto-paired audio child rides the regular amix. Authors don't need
manual A/V separation.

`lower.rs` detects audio children inside an `Html`-mode group and
routes them to the audio side of the lowering walk unchanged. The
group's `render_mode` is observed only on the video side.

### 8. Effects with no CSS implementation — strict refusal at edit time

The existing effect catalog (`apps/desktop/src/preview/dom/effects/`)
has `ffmpeg(params)` mandatory and `css?(params, t)` optional. Inside
an html-render group there's **no ffmpeg path**, so every effect must
have a `css` implementation.

Policy:

- The catalog gains explicit `supports_css: bool` and
  `supports_ffmpeg: bool` flags. Defaults are derived from current
  catalog entries (both true for effects that ship both functions).
- Toggling a group's `render_mode` to `Html` runs a validation pass.
  If any child layer has an effect whose `supports_css == false`, the
  toggle **rejects** with a structured error:
  ```
  GroupHtmlModeRequiresCssEffects {
    group: GroupId,
    offending: Vec<(LayerId, EffectId)>,
  }
  ```
  surfaced as `Cannot switch group "intro" to html-render: layer
  "shot.mp4" has effect "gblur" with no CSS implementation. Remove
  the effect or use a different render mode.`
- Same validation runs as a `state::validate` invariant on every
  commit, so a separately-applied effect (added after the mode
  switch) is also caught.

Why strict and not lenient: silent-drop-at-export is the
trust-eroding bug class. A user marks a group html-render and their
gblur disappears from the final video without warning. Surface the
problem at the *action that caused it* — the mode switch or the
effect-add — with a clear error and a clear remediation.

### 9. Template children — `<div>` + Shadow DOM (nested)

Template-layer children inside an html-render group continue to use
**`<div>` + Shadow DOM** for CSS isolation, the same approach
`TemplateHandle.ts` ships today (commit `71e55a0`). Shadow roots nest
fine — the outer composition's mount can be a shadow root (preview
path) containing inner shadow roots for each template child.

**Iframes are explicitly not used** for the composition or for
template children, because WebView2 paints a hardcoded white canvas
under `<iframe srcdoc>` and `URL.createObjectURL`-backed iframes that
no CSS path can reach (see commits `35875e7` → `1bf5391` →
`9378367` → `71e55a0` for the four-attempt arc that ended in
abandoning iframes for the runtime template path). The originally-
specced `<iframe srcdoc>` in [[preview-dom]] §5 is obsolete; this
doc supersedes it. The same `new Function(...)` shadowed-globals
pattern `TemplateHandle.instantiateTemplate` uses to run template
scripts with a shadowed `document` / `window` / `performance` /
`Date` / `requestAnimationFrame` is reused verbatim for template
children inside an html-render group.

The TemplatePicker UI's iframe usage for catalog thumbnails is
**unaffected and remains legitimate** — picker iframes display
templates on opaque backgrounds (not on the transparent compositor),
so the white-canvas bug doesn't apply. This doc only concerns the
runtime preview + export render paths.

### 10. Canvas — inherit main composition, in-place flatten

The html-render group's intermediate alpha video is **full-canvas**.
Children position themselves in the same coordinate system they'd
use if they sat directly in the main composition. The main ffmpeg
overlays the alpha video at `(0, 0)`.

Rejected alternatives:

- *Tight bounding box.* Shrink the alpha video to the children's
  bounding box, track an offset for the main overlay. Saves disk but
  CSS transforms can move children at runtime; static bounding-box
  computation is unreliable and the savings are marginal.
- *User-specified sub-canvas + transform (AE pre-comp).* The
  "pre-composition layer kind" model was explicitly rejected at
  decision 3 — we chose flag-on-group, not new layer-kind.

### 11. Composition mount isolation — (c.2): root in export, shadow in preview

The composed HTML is **mount-agnostic** — no `:host` selectors, uses
`#composition` id selector throughout. The same artifact serves both
paths:

- **Preview path.** Mounts the composition inside `<div>` + outer
  Shadow DOM. Inner template children attach their own inner shadow
  roots. The engine's `__setTime(t)` shim runs inside the outer
  shadow's scope, drives the master clock, walks child snapshots,
  applies per-frame CSS.
- **Export path.** The offscreen raster webview *navigates* to the
  composition as a full root document. No outer shadow — the
  document boundary is enough. Inner template children still use
  inner shadow roots (CSS isolation between sibling templates in
  the composition).

Trade-off accepted: **shadow DOM is not JS realm isolation.** Shared
`window`, `Promise`, `console`, `setTimeout`. This is the same
trade-off `TemplateHandle` already makes for the shipped Phase C —
templates are trusted (built-in catalog only). If user-supplied
templates ever land, this is when iframe sandboxing has to come
back, and the transparency bug needs solving for real.

### 12. Transparency-bug discipline — single-pixel probe on day one

Before building anything on top of the composition mount, **spike a
single-pixel transparency probe** through both the preview mount
(`<div>` + outer Shadow DOM inside the React preview surface) and
the offscreen export mount (full root document in the raster
webview). Same hard-earned diligence the template iframe work paid
for; every near-miss in the iframe-transparency arc (`color-scheme`,
`allowtransparency`, blob: URLs, transparent srcdoc) looked like a
fix before failing on another surface.

Probe shape:

1. Mount a composition containing one `<div>` with
   `background: rgba(255, 0, 0, 0.5);` on an otherwise-empty document.
2. Read the captured pixel buffer (preview: canvas snapshot of the
   surface region; export: raster's `CapturePreview`).
3. Assert the center pixel is `(255, 0, 0, 128)` ± 4. Any
   pre-multiplication, color-management, or opaque-backdrop bug
   shifts the result.

Pass the probe before the rest of this work begins. Re-run after any
WebView2 / webkitgtk / wkwebview version bump.

---

## Architecture in one paragraph

A group with `render_mode = Html` renders its visual children as a
single HTML composition: per-child `<div class="layer">` subtrees
ordered by z-stack, each receiving per-frame CSS from the effect
catalog's `css(params, t)` functions and the layer's animated
`transform` / `opacity`. Template children mount via `<div>` +
Shadow DOM with the existing `TemplateHandle` script-execution
pattern. Audio children skip the composition entirely and feed the
main `amix` chain unchanged. In **preview**, the composition mounts
in the preview surface inside `<div>` + outer Shadow DOM; video
slots resolve to live `<video src="asset://proxy">` elements driven
by the existing PlaybackEngine clock. In **export**, three phases
run per group: ffmpeg pre-extracts each source video's frames into
a 30-frame ring-buffered tmp dir; the offscreen raster webview
navigates to the same composition (as a full root document), and
its `__seek(t)` shim swaps `<img src="...frame_NNNNN.png">` for
each video slot, applies the same per-frame CSS, captures via
`CapturePreview`; the captured PNG bytes stream via `image2pipe`
into a transient ffmpeg-encode producing one
`tmp/.../group-<id>.webm` (VP9 + `yuva420p`). The main ffmpeg export
pass then consumes that `.webm` as one more `-i` input, with
`format=yuva420p` on its output edge so the surrounding `Overlay`
chain blends with alpha. Mode switching is gated by a strict
validator that refuses to set `render_mode = Html` if any child
effect lacks a CSS implementation.

---

## Phase plan

Smaller than preview-dom because the raster machinery already exists;
most of the work is composition generation + the lowering integration.

### Phase H.0 — Spike: transparency probe + composed-HTML mount (~2 days)

Goal: prove the mount works in both contexts before building on it.

**New files:**

- `apps/desktop/src/preview/dom/composition/CompositionGenerator.ts`
  — pure function: `(group: Group, project: Project) => { html: string, bindings: VideoBinding[] }`.
  Initial scope: a static composition with one `<div>` and one image
  slot. Real children come in Phase H.3.
- `apps/desktop/src-tauri/src/raster/html_group.rs` — raster job
  shape for an html-group composition (separate from the template
  `RasterJob` so the cache keys don't collide).
- `apps/desktop/src/preview/dom/composition/probe.test.ts` — vitest
  asserting the single-pixel transparency probe in preview.
- `apps/desktop/src-tauri/src/raster/html_group_probe_test.rs` —
  integration test asserting the same probe through the offscreen
  raster path.

**Verification.** Both probes pass. No production code path uses the
new files yet.

### Phase H.1 — Data model: `GroupRenderMode` (~1 day)

**Modified files:**

- `apps/desktop/src-tauri/src/state/group.rs` — add `GroupRenderMode`
  enum + `Group.render_mode` field with `#[serde(default)]`.
- `apps/desktop/src-tauri/src/state/project.rs` — bump
  `SCHEMA_VERSION` 5 → 6.
- `apps/desktop/src-tauri/src/io/migrate.rs` — no-op migration v5 →
  v6 (the `#[serde(default)]` covers the wire shape).
- `apps/desktop/src-tauri/src/state/validate.rs` — new invariant:
  every effect on every child of an `Html`-mode group has
  `supports_css == true` in the catalog. Fails with the structured
  error from decision 8.
- `apps/desktop/src-tauri/src/state/actor.rs` — new op
  `groups_set_render_mode(group_id, mode)` running the validator
  before commit.
- `apps/desktop/src-tauri/src/mcp/mod.rs` — MCP tool
  `groups_set_render_mode`.

**Verification.** Schema round-trip, validator positive + negative
tests, MCP-tool integration test, snapshot test of the migration on
a v5 fixture.

### Phase H.2 — Group invariants under `Html` mode (~1 day)

Confirm-or-adjust aligned-edge / locked-member / fan-out behaviors
for `Html`-mode groups. Open question: does aligned-edge trim still
apply when DOM stacking-paint-order is what matters? Likely yes
(temporal edges stay aligned even though spatial stacking moves to
DOM), but write the tests before deciding.

**Modified files:**

- `apps/desktop/src-tauri/src/state/actor.rs` — coverage tests for
  move / trim / split inside Html-mode groups.
- (Probably no production change; the existing fan-out rules apply
  by structure. If a test reveals a needed relaxation, document it
  here.)

**Verification.** All existing group tests pass with
`render_mode = Html` toggled; new tests cover any newly-found
edge cases.

### Phase H.3 — Composition generator (~3–5 days)

Generate the composed HTML from a group's children.

**New files:**

- `apps/desktop/src/preview/dom/composition/CompositionGenerator.ts`
  — full generator: emits one `<div class="layer">` per visual
  child, ordered by track index (z-stack), with per-kind subtree
  shape (`<video data-source-layer="L-id">` for VideoClip, `<div>`
  for Text/Color, mount-point for Template children, `<canvas>` for
  Subtitles). Embedded `<script>` is the `__setTime(t)` / `__seek(t)`
  engine that walks children and applies per-frame state.
- `apps/desktop/src/preview/dom/composition/engine.ts` — the
  `__setTime` / `__seek` engine code that ships *inside* the
  composition. Reads animated values, calls
  `effectCatalog[id].css(params, t)`, writes
  `style.transform/.opacity/.filter` per child.
- `apps/desktop/src/preview/dom/composition/videoResolver.ts` — the
  resolver-strategy interface; preview impl uses `<video>`, export
  impl uses `<img>` swap.

**Verification.** Generate a composition from a fixture group;
mount in a jsdom-based test; advance `__setTime` through several
times; assert child styles match catalog `css(t)` output.

### Phase H.4 — Preview integration (~2–3 days)

Wire the generator into the preview surface.

**Modified files:**

- `apps/desktop/src/preview/dom/LiveLayers.tsx` — detect groups in
  the window-active set with `render_mode = Html`; mount one
  `HtmlGroupHandle` for the group instead of per-layer handles for
  its members.
- `apps/desktop/src/preview/dom/handles/HtmlGroupHandle.ts` — new
  handle. Creates a `<div>` + outer shadow root, generates the
  composition, mounts it, drives `__setTime(t)` per RAF tick.
- `apps/desktop/src/preview/dom/PlaybackEngine.ts` — update the
  handle-kind list (the existing comment listing handle kinds), no
  engine-loop change.

**Verification.** A test project with a group containing a video
clip + a label, marked `Html`, renders the label inside the video's
CSS transform space in the preview surface (manual screenshot
review). Toggling `Html` ↔ `Native` cleanly re-mounts the handles.

### Phase H.5 — Export pipeline (~3–5 days)

Wire the html-render path into `export::run_render_inner`.

**New files:**

- `apps/desktop/src-tauri/src/export/html_groups.rs` — orchestrates
  per-group materialization: spawn ffmpeg-extract with ring buffer,
  navigate raster worker to composition, run `__seek` loop, stream
  captures through `image2pipe` to ffmpeg-encode producing the
  `.webm`. Returns the `.webm` path.
- `apps/desktop/src-tauri/src/ir/html_group.rs` (or in `lower.rs`) —
  materialize-html-groups pass analogous to the existing
  `materialize_templates` pass; produces a map
  `GroupId → tmp_alpha_video_path` consumed by the lowering walk.

**Modified files:**

- `apps/desktop/src-tauri/src/ir/lower.rs` — when entering a
  `Group.render_mode == Html`, emit a single `DecodeV` for the
  group's tmp `.webm`, wrapped in `SetPts(group.t_start)`, with
  `format=yuva420p` baked into the lowering helper. Skip lowering
  the group's individual visual children (they're inside the
  `.webm`). Audio children still flow through the audio side.
- `apps/desktop/src-tauri/src/export/mod.rs` — `run_render_inner`
  calls `materialize_html_groups` before `lower`; cleans up the
  `tmp/.../*.webm` files on success and failure.

**Verification.** Export a fixture project with a marked group;
inspect the final mp4; CSS transform on the video child is present;
audio is correctly aligned; surrounding `Overlay` chain blends with
alpha correctly.

### Phase H.6 — UI surface (~1–2 days)

**Modified files:**

- `apps/desktop/src/timeline/Timeline.tsx` — group inspector / context
  menu gains a render-mode toggle. Validation error from
  `groups_set_render_mode` shown as a toast naming the offending
  effects.
- `apps/desktop/src/i18n/locales/{en-US,zh-CN}.ts` — new strings
  under `group.render_mode.*`.
- `apps/desktop/src/timeline/styles.css` — optional visual
  differentiation for Html-mode groups (e.g., tinted border in a
  different shade).

**Verification.** Manual: select layers → group → toggle `Html` →
error case shows useful message; success case renders correctly in
preview and export.

### Phase H.7 — Progress + status surfacing (~1 day)

Per-group raster + encode phases emit `html_group:<group-id>:*`
events so the main export progress bar reflects real progress
instead of jumping 0% → 80% → crawl.

**Modified files:**

- `apps/desktop/src-tauri/src/export/html_groups.rs` — emit
  `html_group:source_extract_progress`, `:raster_progress`,
  `:encode_progress`, `:complete` events per group.
- `apps/desktop/src/export/ExportPanel.tsx` — render a per-group
  progress sub-bar during phases 1–3.

**Verification.** Export a multi-html-group project; progress
indicator never flatlines.

**Total scope ~2–3 weeks of single-developer time.** Smaller than
preview-dom because the raster machinery, the offscreen webview,
the time-mock shim, the group system, the IR lowering pass, and the
effect catalog all exist. New surface is composition generation +
HtmlGroupHandle + the export-driver glue.

---

## Risks & mitigations

- **Per-frame snapshot speed.** 30–100 ms / frame at 1080p (from
  `docs/rendering.md` part 2). A 30 s 1080p@30 html-group = 900
  frames = 30–90 s wall-clock for raster alone. Long groups
  multiply linearly. **Mitigation:** surface progress (Phase H.7);
  cache the `.webm` on stable content (deferred to a v2 follow-up);
  if pain becomes real, consider hardware-accelerated capture paths
  per platform.

- **Webview decoder count.** Source-video children are `<video>` in
  *preview only*; the same browser decoder ceiling that constrains
  the preview-dom engine applies (~20–30 simultaneously on Windows
  per `docs/preview-dom.md` risks). An html-render group with 10
  video children would consume 10 decoders in preview. **Mitigation:**
  the window-active 2 s lookahead in preview-dom Phase A naturally
  bounds this; if a group genuinely has more video children than
  the ceiling supports, fall back to Render & Play during authoring.
  Export path is unaffected (no decoders in raster webview).

- **Memory ceiling under the IPC frame-bytes path.** Phase H.5
  streams captured PNG bytes from the offscreen webview through the
  Tauri IPC bridge to the ffmpeg-encode subprocess. At 1080p × 30 fps
  that's ~9 MB/s of IPC throughput per concurrent html-group export.
  **Mitigation:** export queue is serial (one job at a time per
  `ExportQueue`); the throughput target is one stream's worth, well
  within Tauri's bandwidth. Re-measure if 4K profiles land.

- **Shadow-DOM script-execution edge cases.** Some CSS-in-JS
  libraries or templates that bare-reference `globalThis` /
  `document.body` instead of `document` lose context inside the
  shadowed-globals execution. `TemplateHandle.ts` already deals with
  this for the shipped Phase C; the same workarounds apply. New
  templates added to the catalog should be tested against both the
  full-page and shadow-mount paths.

- **Spike-or-spike-not on transparency.** Phase H.0 is non-optional.
  The iframe arc (35875e7 → 71e55a0) cost four commits to discover
  that "looks fine on the first surface" doesn't mean "works on the
  second surface". Land the single-pixel probes first; gate all
  subsequent phases on green probes in both contexts.

- **Cache invalidation when added.** Future cache (deferred to v2)
  key must include: group content snapshot, every source media hash,
  src_in/src_out per video child, every prop on every template
  child, effect catalog hash, rasterizer version, alpha-codec
  version. Miss any of those and stale `.webm` files end up in
  final exports. Document the key inputs as a load-bearing invariant
  when caching ships.

- **Schema bump compounding.** Schema is currently v5; this work
  bumps to v6. The v5 → v6 migration is a no-op via
  `#[serde(default)]`, but every active branch with schema work
  needs to coordinate. **Mitigation:** sequence this phase before
  any other schema-touching work.

---

## What "done" looks like

After Phase H.7 lands:

- Authors can group any subset of layers, set `render_mode = Html`,
  and CSS-author the visual composition with full DOM flexibility.
- Export of an html-render group produces a final mp4 where the CSS
  effects are present, pixel-identical to what preview showed.
- Preview shows the same composition the export produces, mounted
  via shadow DOM in the live surface (video children at ±1-frame
  precision via `<video>`, everything else pixel-identical).
- The strict-refusal validator catches CSS-missing effects at the
  mode-switch boundary, before any export.
- Outside html-render groups, preview-dom's loose-parity contract is
  unchanged; ffmpeg-side lowering is unchanged; Render & Play is
  unchanged.
- Net code change: ~1500–2500 LoC added across Rust + TS; zero LoC
  deleted (this is an additive feature on top of shipped
  infrastructure). The only old-implementation cleanup is the
  iframe-template *references* in [[preview-dom]] §5 and a handful
  of stale comments — done as part of this doc's introduction, not
  this design's implementation phases.
