# DOM preview — design

**Status:** Phases A–F **shipped 2026-05-16** on branch `feat/preview-dom`.
Designed in a grilling session on 2026-05-16; six implementation commits
landed the same day. The Rust-side `PreviewRenderer`, segmented cache,
WebCodecs + WebGL2 engine, and the cached/realtime/auto mode toggle UI
are all deleted. **One** preview engine exists; ffmpeg runs only at
import (proxy job) and export — never in the preview hot path.

**Decision 5 revised 2026-05-16/17:** the originally-specced
`<iframe srcdoc>` per-template mount hit a WebView2 white-canvas bug
(four commits — `35875e7`, `1bf5391`, `9378367`, `71e55a0` — attempted
fixes; only the last succeeded). Templates **ship as `<div>` + Shadow
DOM** with `new Function`-shadowed globals (see `TemplateHandle.ts`).
The §5 below describes the *originally-specced* approach; the actual
shipped contract is the shadow-DOM one. Any forward design that wraps
templates (notably [[html-render-groups]]) uses the shipped shadow-DOM
contract, not the originally-specced iframe contract.

---

## Problem

The cached preview pipeline pre-renders the whole timeline through ffmpeg
on every edit. Phase A (segmented cache) and Phase B.3 (WebCodecs + WebGL2
compositor) shipped 2026-05-15 to mitigate this, but they are heavy
infrastructure for a goal — pixel-identical preview-vs-export — that
isn't this product's actual differentiator. The MCP-as-product framing
benefits more from edit-time latency and architectural simplicity than
from WYSIWYG-exact previews.

A pure-DOM preview composition (Remotion-style: `<video>` for clips,
`<div>` for color/text, `<div>` + Shadow DOM for templates (originally
specced as `<iframe srcdoc>`; see Status note above), `<canvas>` for
ASS via libass-wasm, Web Audio for mixing) gives:

- Edit-time latency ≈ next animation frame, no debounce + encode + swap.
- ~2000 lines of Rust + ~3000 lines of TS deleted at cutover.
- `Cache/preview/` directory gone; only proxies survive.
- Cross-platform story sidestepped (DOM works on every webview the
  product might eventually target).

The price is loose visual parity between preview and export for text,
subtitles, blurs, and color grades. The Render & Play button (one click
→ ffmpeg-rendered MP4 of the current state, autoplayed) is the escape
hatch for WYSIWYG verification when it matters.

---

## The decision contract

These eight choices, settled in the grilling session, define the
architecture. Phases below assume them.

### 1. Visual fidelity contract — loose parity + escape hatch

Preview pixels do *not* equal export pixels. CSS text rendering, blur,
color math, blend modes diverge subtly from ffmpeg. The Render & Play
button (Phase E) calls the existing export pipeline into a temp MP4 and
autoplays it — the answer when a user needs verification.

**Exception: ASS/SRT subtitles via libass-wasm (JASSUB).** libass compiled
to WASM is the same renderer ffmpeg's `subtitles` filter uses. Two days
of integration buys pixel-parity on the one layer kind where parity is
genuinely high-value (subtitles are content the audience reads).

Other engineering-parity work was rejected: matching drawtext kerning
would require a freetype-WASM text renderer; matching `gblur` requires a
per-effect WebGL shader. Months of work duplicating ffmpeg in JS for
limited payback.

### 2. Scope — clean deletion at cutover

The cached + segmented + B.3 paths are deleted in Phase F, not feature-flagged.
Soft deletion produces dead code; coexistence doubles maintenance.

The 540p (now configurable) proxy job from `docs/preview-scrub.md` survives
unchanged — it remains load-bearing because `<video>` seeks slowly on
long-GOP sources regardless of the compositor on top.

### 3. Source media — always-transcode-on-import

Every imported media file passes through the existing proxy job and
produces `<workspace>/Cache/proxies/<media_id>.mp4` (H.264 main profile,
AAC, MP4, 1 s GOP). Preview *only* ever plays proxies. Originals are
preserved untouched for export.

The trade-offs are uniform behavior (no `canPlayType` edge cases, no
"some sources play, others fail") in exchange for visible import-time
work the user must wait through, and ~10–30 % storage overhead at proxy
resolution.

### 3.5. Proxy resolution — workspace-tunable, default capped-match

Workspace settings expose a Performance / Balanced / Match-canvas picker.
Default is **Balanced** = `min(canvas, 1080p)`. Changing this bumps
`PROXY_FORMAT_VERSION` per-workspace, invalidating existing proxies which
the background job re-encodes. Aspect ratio is preserved at any
resolution (existing `scale=-2:H` filter shape).

Reason for the picker: a 4K source proxied to 540p shows visible softness
in the preview pane that confuses users about whether export will look
the same. Matching the canvas resolution (capped at 1080p to bound
decode bandwidth across N stacked layers) resolves this for the common
720p–1080p case.

### 4. Master clock + audio mixing — synthetic + Web Audio mixer (γ)

Master clock is `performance.now() - playStartedAt`, ticked by a RAF
loop. Web Audio API is the **mixer**, not the **clock**:

```
Per-layer:  <video> or <audio>  ─┐
                                 │ createMediaElementSource()
                            [layer GainNode]      ← per-layer volume + fade ramps
                                 │ (optional StereoPannerNode)
                            [master GainNode]     ← project volume
                                 │
                       audioCtx.destination
```

Each RAF tick the engine nudges every active media element's
`currentTime` toward `(master - layer.t_start) + layer.in_us`. If drift
exceeds 100 ms, hard-set; otherwise let the browser absorb micro-drift.

This is the same lesson commit `f355e3e` (B.3 B6b-fix) learned the hard
way: tying the master clock to a stallable source (AudioContext) freezes
the engine when any source buffers. A clock independent of every
decoder/buffer is the only architecture that doesn't stall on hiccups.

Audio scrub: pointermove mutes the master GainNode and advances the
master clock + nudges `<video>.currentTime` only. Pointerup unmutes.
Audio-scrub-on-drag (Premiere-style) deferred to a follow-up setting.

### 5. Templates — `<div>` + Shadow DOM per instance + `setTime` (revised post-shipped)

**Originally specced:** `<iframe srcdoc>` per `Template` layer, with
prop / time updates via direct `iframe.contentWindow` access. This
collided with a WebView2 white-canvas-under-srcdoc bug that no CSS
path could reach. Four attempted fixes (commits `35875e7` →
`1bf5391` → `9378367`) failed; commit `71e55a0` abandoned the iframe
approach and shipped what we have today.

**Actually shipped:** each `Template` layer mounts a `<div>` host
with `attachShadow({ mode: 'open' })`. The template's `<style>`
content goes into the shadow root for CSS isolation; the template's
`<script>` body is extracted and executed via `new Function(...)`
with per-instance shadowed globals — `document` → `shadowRoot`,
`window` → proxy carrying `__props__`, `performance.now` /
`Date.now` → synthetic clock, `requestAnimationFrame` → per-instance
queue. See `apps/desktop/src/preview/dom/handles/TemplateHandle.ts`
for the full pattern.

Per-frame drive:

```ts
templateRuntime.setTime(localSec);   // advance closure clock, drain rAF queue
```

The export-side `__seek_dispatch(t)` shim (with its
`document.fonts.ready` + rAF flush + compositor wait, in
`apps/desktop/src-tauri/src/raster/time_mock.js`) is unchanged — the
offscreen raster webview still loads templates as full HTML pages
and uses the time-mock shim. The two paths share the template
artifact but diverge on rendering host.

**Trade-off accepted vs the originally-specced iframe.** Shadow DOM
provides CSS + DOM-query isolation, **not** JS realm isolation —
shared `window`, `Promise`, `console`, `setTimeout`. Acceptable
because templates are trusted (built-in catalog only). If
user-supplied templates ever land, this is when iframe sandboxing
has to come back and the white-canvas bug needs solving for real.

### 6. Source of truth — Project state via Zustand; no `emit_dom` IR target

React consumes Project state directly through Zustand, same source as
the timeline UI. The IR (`apps/desktop/src-tauri/src/ir/`) lives only
for export lowering. Adding an `emit_dom` IR target was considered and
rejected — JSX is the DOM's natural representation, and forcing a flat
IR between Project and DOM fights the medium.

### 6 (lifecycle). Window-active 2 s lookahead + hybrid React/refs (b + γ)

**Lifecycle.** Only layers whose `[t_start, t_end]` overlaps
`[clock - 0.5 s, clock + 2 s]` are mounted. Pre-mount + pre-seek the
next clip's decoder before its cut arrives — this is the only way to
get smooth cuts without flashing the cold-start. Outgoing layer stays
mounted for an additional 500 ms `idle_grace` after `t_end` so
quick reverse-scrubs back across a cut don't need to re-mount.

Soft ceiling: ~20–30 simultaneously-mounted `<video>` elements
(browser decoder limit). Window-active naturally bounds this; if a
project genuinely exceeds the ceiling, dispose furthest-from-playhead
handles first; if that's still not enough, the user falls back to
Render & Play.

**React vs imperative.** Hybrid: React owns *which layers exist* via a
`LiveLayers` selector + `<Layer key={layer.id} />` list; the layer's
DOM element is created inside `useEffect([layer.id])` (once, ever) and
stored on a ref. Per-frame mutations (`currentTime`, `__setTime`,
`style.transform`, GainNode `gain.value`) go through the ref in the
RAF loop — never through React re-render. React state changes do not
re-mount the media element; decoder state survives.

This rules out the failure mode where a React prop change cascades into
a `<video>` re-mount, dropping decoder state and flashing the preview.

### 7. Effects + keyframes + transitions — RAF interpolation + catalog + transitions-as-opacity (b + α + II)

**Interpolation.** JS RAF interpolation, writing to `element.style`.
Web Animations API was considered for GPU off-thread efficiency but
rejected: integration with the synthetic master clock is awkward, and
the per-layer JS math (~50 μs × small N) is dominated by browser
layout/paint anyway. CSS still GPU-composites the resulting transform/
opacity/filter.

**Effect catalog.** A registry at `apps/desktop/src/preview/dom/effects/`,
one file per effect, each exporting:

```ts
{
  id: 'blur',
  ffmpeg: (params) => lavfiSnippet,
  css?:   (params, t) => styleObject,
  supported: 'preview-ok' | 'export-only',
}
```

Export build fails if `ffmpeg` is missing. Preview renders an "⚠ preview
unavailable" badge if `css` is missing and `supported === 'export-only'`.
Catches divergence at the registry boundary rather than at runtime.

**Transitions.** Crossfade and friends are resolved into per-layer
opacity keyframes by a `resolveTransitions(project)` pass before the
engine sees them. The engine has no concept of transitions — only
animated opacity. Audio crossfades follow the same pattern with
GainNode ramps. Export lowering (`ir/lower.rs`) is unaffected; it
already produces `Fade`/`xfade` nodes from Project state directly.

A shared `Keyframes<T>` data structure and `resolveAt(kfs, t): T`
function live in `apps/desktop/src/preview/dom/keyframes/`. The deferred
Phase 4 keyframe MCP work will share these primitives.

### 8. Phasing — big-bang branch (a)

All work on `feat/preview-dom`. No env flag, no user-visible toggle, no
two-engine production state. Main stays on cached/B.3 preview until the
single merge PR.

Trade-off accepted: longer-lived branch with merge-conflict risk and
no in-band dogfooding by users (only by the developer). Mitigation:
weekly rebase against main; if parallel work touches preview-adjacent
code (e.g. Phase 4 keyframe MCP), it joins the branch rather than
landing on main.

---

## Architecture in one paragraph

`PreviewSurface` mounts a `<div>` sized to the project canvas. A
`LiveLayers` React component subscribes to Project state via Zustand and
computes the set of layers within `[clock - 0.5 s, clock + 2 s]`; each
becomes a `<Layer>` keyed by `layer.id`. Inside each `<Layer>`, a
`useEffect([layer.id])` creates the appropriate DOM element (`<video>`,
`<audio>`, `<img>`, `<canvas>`, or `<div>` — the last serving both
generic color/text layers *and* template hosts via Shadow DOM) and
stores it on a ref; the element survives every parent re-render. A
singleton
`PlaybackEngine` owns the master clock (synthetic, RAF-driven), the Web
Audio context with master + per-layer GainNodes wired through
`createMediaElementSource()`, and a `Map<LayerId, LayerHandle>` of refs.
Each RAF tick the engine: advances the clock, computes keyframe
snapshots for each active layer, writes
`style.transform / style.opacity / style.filter`, calls per-template
`setTime(localSec)` (TemplateHandle drains its per-instance rAF queue
to advance the shadowed clock), calls JASSUB
`setCurrentTime` on subtitle canvases, and nudges each media element's
`currentTime` toward its target if drift exceeds 100 ms. No React
re-render happens inside the inner loop. Scrub paths share the engine —
pointermove mutes the master GainNode, advances the master clock,
runs one RAF write; pointerup unmutes.

---

## Phase plan (branch `feat/preview-dom`)

### Phase A — Engine skeleton (~1 week)

**New files:**

- `apps/desktop/src/preview/dom/PlaybackEngine.ts` — synthetic clock, RAF
  loop, play/pause/seek/scrub, coalesced `<video>.currentTime` nudging,
  layer-handle registry.
- `apps/desktop/src/preview/dom/LiveLayers.tsx` — Zustand selector for
  window-active layers.
- `apps/desktop/src/preview/dom/Layer.tsx` — React wrapper that creates
  a handle in `useEffect` and disposes on unmount.
- `apps/desktop/src/preview/dom/handles/{VideoClip,AudioClip,Color,Image}Handle.ts`
  — handle implementations.
- `apps/desktop/src/preview/dom/audio/AudioGraph.ts` — `AudioContext`
  singleton, master GainNode, per-layer wiring helper.
- `apps/desktop/src/preview/dom/PreviewSurface.tsx` — replaces existing
  `<PreviewSurface>` on the branch.

**Verification.** Play/pause/seek work; multi-track video composites
correctly (z-order from track index); per-layer volume changes via Web
Audio are click-free; nudging keeps two `<video>`s in sync within
1 frame; window-active LRU caps simultaneous decoders.

### Phase B — Effects, keyframes, transitions (~1 week)

**New files:**

- `apps/desktop/src/preview/dom/keyframes/Keyframes.ts` —
  `Keyframes<T>` + `resolveAt(kfs, t)`. Shared with future Phase 4 MCP.
- `apps/desktop/src/preview/dom/keyframes/transitions.ts` — rewrite
  Project transitions into per-layer opacity keyframes.
- `apps/desktop/src/preview/dom/effects/registry.ts` — catalog with
  `{ ffmpeg, css?, supported }` per effect.
- `apps/desktop/src/preview/dom/effects/{scale,opacity,fade,blur}.ts` —
  initial catalog entries.

**Modified:** `PlaybackEngine` RAF tick calls keyframe resolver + effect
catalog `css` functions, writes to handle refs.

**Verification.** Crossfade renders as overlapping opacity ramps in DOM;
`Fade` (single-layer in/out) animates correctly during scrub; an effect
with missing `css` renders a warning badge on its layer.

### Phase C — Templates (~3–5 days)

**New files:**

- `apps/desktop/src/preview/dom/handles/TemplateHandle.ts` —
  `<div>` + Shadow DOM mount + RAF-driven per-instance
  `setTime(localSec)` that advances a shadowed clock and drains the
  per-instance rAF queue. **Note:** originally specced as iframe
  srcdoc; revised to shadow DOM at the end of Phase F (see Status
  note at top of doc and commits `35875e7` → `71e55a0`).
- Tests verifying `setTime` (preview path) and `__seek_dispatch`
  (raster path) produce identical visual state at the same `t`.

**Modified.** Each template in `apps/desktop/src-tauri/src/raster/templates/*`
gets refactored to extract its render-at-time logic into a shared
`renderAtTime(t, props)` function. Two entry points are exposed:
`__setTime(t)` (preview, no awaits) and `__seek_dispatch(t)` (raster,
with fonts.ready + rAF flush + compositor wait).

**Verification.** Existing template set renders live in preview; offscreen
raster output is byte-identical to before the refactor (regression test
against pre-Phase-C cache hashes).

### Phase D — Subtitles via libass-wasm (~3–5 days)

**New files:**

- `apps/desktop/src/preview/dom/handles/SubtitleHandle.ts` — canvas
  overlay + JASSUB instance per Subtitles layer.
- Bundle `jassub` (or `libass-wasm` equivalent) into the renderer build;
  ship `libass.wasm` as an asset.

**Modified.** Workspace fonts loading — preview side reads
`<workspace>/fonts/*` and registers via `FontFace`; export side already
uses ffmpeg fontconfig. Both paths must see the same font set.

**Verification.** An ASS file with animation, karaoke, and positioning
renders the same in DOM preview as in Render & Play output (modulo
subpixel kerning — libass renders both, should be identical).

### Phase E — Render & Play button (~2 days)

**New files:**

- `apps/desktop/src/preview/dom/RenderAndPlay.tsx` — toolbar button,
  render-state machine, `<video>` swap, dismissal flow.

**Modified.** Add a Tauri command `export_to_temp_for_preview` if the
existing IPC doesn't already cover writing into a temp path with no
queue event surfacing.

**Verification.** Click renders + plays in ≈ `project_duration` +
overhead; "Return to live preview" disposes the temp file and restores
DOM compositor.

### Phase F — Cutover + deletion (~1–2 days)

**Delete (Rust):**

- `apps/desktop/src-tauri/src/preview/{segmented,queue,encoder,manifest,codec,failure}.rs`
- `apps/desktop/src-tauri/src/preview/mod.rs` (reduce to nothing or
  remove)
- `apps/desktop/src-tauri/src/ir/emit_webcodecs.rs`
- `apps/desktop/src-tauri/src/ir/emit_mpv.rs`
- `apps/desktop/src-tauri/src/ir/segments.rs`
- `WEFTCUT_PREVIEW_SEGMENTED` env handling.

**Delete (TS):**

- `apps/desktop/src/preview/playback/*` (B.3 `PlaybackEngine`,
  `DecoderPool`, `RasterCache`, RAF loop).
- `apps/desktop/src/preview/compositor/*` (WebGL2 compositor + shaders).
- `apps/desktop/src/preview/mse/*` (MSE driver for segmented mode).
- Auto / Real-time / Cached preference UI + the Zustand state behind it.

**Update:** `apps/desktop/src-tauri/src/cache/mod.rs` — drop the
`preview/` directory from `CacheLayout`. Existing workspaces will have
an orphaned `Cache/preview/<hash>.mp4` tree; one-shot cleanup on first
open, or leave for the user's eventual workspace reinit.

**Update memories.** Mark `[[project_preview_segmented_cache]]`
superseded and link to this doc. Add `[[project_preview_dom]]` index
entry.

---

## Risks & mitigations

- **Decoder count ceiling.** Browsers cap `<video>` decoders at
  ~20–30 simultaneously on Windows. Window-active + 2 s lookahead
  bounds active count, but a project with 30 stacked clips will hit
  it. Mitigation: if `active_count > N`, eagerly dispose furthest-from-
  playhead handles; if a project genuinely needs that many, fall back
  to Render & Play.

- **Web Audio `MediaElementSource` ceiling.** Some browsers cap
  `MediaElementSource` nodes per `AudioContext` (~6 on Chromium
  historically). Verify on a 5+ audio-track timeline early in Phase A.

- **`<video>.currentTime` precision after seek.** Some MP4s land 1–2
  frames off the requested timestamp. `docs/preview-scrub.md` solved
  this with 1 s GOP proxies; the same proxies serve DOM preview here.
  If seek precision regresses, GOP shortening (already in
  `PROXY_FORMAT_VERSION`'s scope) is the lever.

- **Shadow-DOM script-execution edge cases.** Templates that bare-
  reference `globalThis` or `document.body` (instead of `document`)
  lose context inside the shadowed-globals execution.
  `TemplateHandle.instantiateTemplate` handles the common cases via
  its `winProxy`, but new templates added to the catalog should be
  tested. The previously-noted "iframe-per-template soft ceiling of
  ~10–15" is obsolete — Shadow DOM doesn't have an equivalent cap.

- **Long-lived branch merge conflicts.** Q8.a's main downside.
  Mitigation: rebase weekly; if Phase 4 keyframe MCP work starts in
  parallel, it joins this branch.

- **`createMediaElementSource()` is one-way.** Once a `<video>` is
  routed through Web Audio, its audio no longer plays through the
  element's own output. Forget to connect the GainNode to destination
  and you get silent video. Phase A unit test covers this.

- **Font parity preview vs export.** Preview uses CSS font resolution;
  export uses ffmpeg fontconfig. ASS files reference fonts by name;
  Phase D wires workspace fonts into both paths but a missing-font in
  one and not the other is a real failure mode. Workspace-fonts
  directory loading is the single point that prevents this; document
  it as a load-bearing constraint in the workspace structure.

---

## What "done" looks like

After Phase F merges to main:

- Single preview engine. No mode toggle, no env flag.
- Editing latency ≈ next RAF tick. No debounce, no encode, no swap.
- `Cache/preview/` removed; `Cache/proxies/` remains and is load-bearing.
- ASS subtitles pixel-identical to export.
- Templates render live during preview; offscreen rasterizer is used
  only at export.
- Text, blur, color-grade visibly approximate; Render & Play is the
  WYSIWYG verification path.
- Net code change: ~2000 lines Rust deleted, ~3000 lines TS deleted,
  ~1500 lines TS added.

Cross-platform parity (`macOS`/`WebKitGTK`) is sidestepped, not solved
— a DOM-shaped preview composition will work on WKWebView and most of
WebKitGTK without WebCodecs. The Linux H.264-in-`<video>` codec issue
(`gstreamer1.0-libav` not present on default Fedora) remains, but is
narrower than the previous WebCodecs gap.
