# Motif #2 — Lower Third, content-duration decoupling, and multi-host navigation

- **Status:** design approved 2026-06-08; spec under review before implementation planning.
- **Builds on:** `2026-06-07-motifs-webcap-design.md` (the webcap engine) and
  `2026-06-07-motifs-editor-integration-design.md`. The Motifs migration is complete
  (single `countdown` built-in on the live `motif.define` contract).
- **Goal:** ship a second built-in Motif that is the most common video-editing
  overlay (a lower third) and that deliberately exercises the implementation
  surfaces `countdown` never touched — so the engine's feasibility is tested
  broadly, not just re-confirmed.

## 1. Why this shape

`countdown` exercises exactly one slice of the engine: DOM+SVG + a WAAPI
`.animate()` + an imperative `frame(t)`, a hard-capped duration
(`max_duration_prop: "seconds"`), a 480×480 square, a transparent backdrop, a
system font, and no bundled assets. A second Motif that merely re-walks those
paths proves nothing new.

A **lower third** is both the single most common overlay in real editing and the
Motif that lights up the largest set of untested paths in one artifact:

| Untested dimension | How the lower third exercises it |
|---|---|
| **Holdable / unbounded duration** | animate-in over a fixed ~0.8 s, then hold indefinitely on a freely-extendable layer |
| **Bundled `assets/` (font)** | a real `@font-face` over the `motif:` scheme + `manifest.fonts` + `font-src` CSP + `await document.fonts.ready` |
| **Pure-declarative (no `frame()`)** | state is a function of `t` entirely via auto-seeked WAAPI animations |
| **Non-square / wide geometry** | ~1280×320, exercising `setDeviceMetricsOverride` off-square |
| **Multi-Motif host navigation** | a second id forces the hidden host to navigate (today it errors) |

Designing it honestly surfaced a real gap (§2) the engine must close to support
*any* holdable overlay correctly. Closing that gap is in scope.

## 2. The duration gap and its fix (`content_duration_s`)

### What the spec claimed vs. what the code does

`webcap-design §6` claims a static overlay's identical frames "collapse to one
capture." They do not. `MotifFrameCache` (`frameCache.ts`) keys entries by
`(cacheKey, frameIndex)` with **no pixel-level dedup** — two distinct frame
indices with byte-identical pixels are two separate cache entries and two
separate CDP captures. `cacheKey` itself embeds `durationFrames`.

Tracing `motifFrameDescriptor.ts` → `motifFrames.ts` (`motifContentFrame`), today
there are only two duration models, and **neither** expresses "animate in, then
hold, deduped, on an extendable layer":

| Model | Resolution | Why it fails a holdable lower third |
|---|---|---|
| **Capped** (`max_duration_s`/`max_duration_prop`) | `contentDurationUs = cap`; layer also capped to `cap` | layer can't extend past the cap → can't hold; and within `[0, cap)` every frame is a distinct index → the held region is *not* deduped either |
| **Uncapped** (neither set) | `contentDurationUs = layerWidth`; `srcInUs = 0` | held region = N distinct indices → re-captured per frame; worse, `durationFrames` ∈ `cacheKey`, so **every trim changes the key and busts the entire cache** |

The frame clamp (`frame = min(contentDurationFrames-1, frameIndex(contentTime))`)
only dedups the region **beyond** the content duration. So dedup of a held tail
requires `contentDuration < layerWidth` with the layer allowed to exceed it —
which neither model permits.

### The fix: split "content duration" from "layer cap"

Introduce a third, additive manifest field. The two concepts become independent:

- **`max_duration_s` / `max_duration_prop`** (existing) — fixed content duration
  **that also caps the layer length** (e.g. `countdown`).
- **`content_duration_s`** (new) — fixed content duration that **does not cap the
  layer**. The layer stays freely extendable; frames past it clamp to the last
  content frame.

Resolution rule (applied in `motifFrameDescriptor`; Rust mirrored):

```
fixedContentUs    = content_duration_s_us ?? maxCapUs ?? null
contentDurationUs = fixedContentUs ?? layerWidthUs          // null only when wholly uncapped
srcInUs           = (maxCapUs != null && content_duration_s == null)
                       ? view.src_in_us : 0                 // windowing stays a capped-only feature
layerCapUs        = maxCapUs                                // content_duration_s NEVER caps the layer
```

Both fields may coexist (short animation, capped layer); precedence above is
explicit. Validation: `content_duration_s` must be a finite value `> 0` when
present (reject on import otherwise), consistent with the existing
`max_duration_s > 0` guard.

### What the fix buys

1. **Trims stop busting the cache.** With a fixed `content_duration_s`,
   `durationFrames` in `cacheKey` is constant regardless of layer width.
2. **The held tail dedups to one capture.** Every `tInLayer > content_duration`
   maps to the same last content frame → one cache entry, one CDP capture.

This makes `webcap-design §6`'s claim true for the holdable case via the cheaper
mechanism (clamp + stable key), without adding a pixel-hash dedup layer. A
general pixel-hash dedup remains a possible future generalization but is **out of
scope** here.

### Touch points (small, located)

- `catalog.ts` `MotifManifest` — add `content_duration_s?: number`.
- `catalog.ts` `resolveMotifContentDurationUs` — return `content_duration_s` (µs)
  when present; else existing cap-or-null. (Rename/clarify its doc to "content
  *seek* duration," distinct from the layer cap.)
- `motifFrameDescriptor.ts` — apply the `srcInUs` rule above so holdable Motifs
  always start at content frame 0.
- Rust `motifs/catalog.rs` — add `content_duration_s: Option<f64>` to `Manifest`;
  **leave `resolve_motif_max_dur_us` reading only the cap** (so the timeline keeps
  the layer extendable). Mirror the validation.
- Unit tests: `motifContentFrame` clamp/dedup with a fixed content duration shorter
  than the layer; `resolveMotifContentDurationUs` precedence (content vs cap vs null).

## 3. The Lower Third Motif

### Authoring contract (the live one)

A self-contained `index.html` using `motif.define({ setup, frame })`. The injected
runtime owns the clock and auto-seeks `document.getAnimations()`; capture is CDP
`Page.captureScreenshot` (taint-free PNG, transparent backdrop via the existing
`setDefaultBackgroundColorOverride` α0 path).

### Geometry

- **Natural size ~1280×320, just the bar** — renders only the name strip + text,
  transparent around it. The user positions it via the layer transform (the same
  way `countdown` is placed). Cheaper capture, reusable, and tests non-square
  `setDeviceMetricsOverride`. (Full-frame 1920×1080-with-baked-safe-area was
  considered and rejected: heavier capture, position baked in, no real gain.)

### Animation — pure declarative, no `frame()`

In `setup(props, ctx)`:
- a WAAPI slide-up + fade-in on the bar (~0.8 s, `easing` ease-out, `fill: "both"`),
- a slightly delayed (~0.15 s) fade/slide on the subtitle line,
- `await document.fonts.ready`.

No `frame(t)` — the runtime auto-seeks the WAAPI animations, and `fill: "both"`
pins the end state for all `t > 0.8 s` → a static, deduped held tail. `settle_rafs: 1`
(CSS/DOM/SVG only; no canvas/WebGL). **No slide-out** in v1: a holdable overlay
cannot see its own end; the user ends it by trimming the layer (or fades it later
via layer opacity, which is outside Motif scope).

### Props

| Prop | Type | Notes |
|---|---|---|
| `title` | string (max ~40) | primary name line |
| `subtitle` | string (max ~60) | role / secondary line |
| `accent` | color | bar fill / underline tint |
| `align` | string `"left"`/`"right"` | text + bar alignment; exercises a constrained-string prop |

`align` is a plain `string` prop validated by the author's own switch (the schema
has no enum type yet; an out-of-set value falls back to `"left"`). Adding a real
enum `PropSpec` is a possible future, not required here.

### Manifest (illustrative)

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
    "subtitle": { "type": "string", "default": "Director of Photography", "max_length": 60 },
    "accent":   { "type": "color",  "default": "#ff4d4d" },
    "align":    { "type": "string", "default": "left", "max_length": 5 }
  }
}
```

No `max_duration_s`/`max_duration_prop` → the layer is freely extendable;
`content_duration_s` bounds only the animation/seek range. `default_duration_s`
(5 s) is just the initial placed length.

### Bundled font — Inter (woff2 subset, SIL OFL)

This is what exercises the entire untested asset path:
- a second `BuiltinFile` (`assets/Inter.woff2`) embedded in `builtin.rs` via
  `include_bytes!`,
- a `manifest.fonts` entry,
- an `@font-face` in `index.html` referencing `assets/Inter.woff2` (relative,
  served same-origin over `motif:`),
- the `font-src data: <origin>` CSP allowance (already present in `builtin.rs csp()`),
- `await document.fonts.ready` in `setup`.

We vendor a **subset** woff2 (Latin + common punctuation, weight 700) to keep
binary growth small. License: SIL OFL — record attribution alongside the asset.

## 4. Multi-Motif host navigation (`host.rs`)

Today `ensure_host` errors when asked for an id different from the one the hidden
host is bound to. Replace that with **navigate-or-rebuild**:

1. If a host exists and is bound to a **different** id, **navigate** it to the new
   `motif://<id>/index.html` URL (reusing the window + CDP session). WebView2 re-runs
   the `initialization_script` on navigation, so the clock-takeover runtime
   re-injects automatically.
2. **Reset `CaptureState`** after navigation: `ready_for = None` (force the
   ready-probe to re-confirm `__motifRender` on the new page) and `last_size = None`
   (force `setDeviceMetricsOverride` on the next capture — the new Motif's size
   differs).
3. **Rebuild** the window as a fallback if navigation is unavailable/fails.

The whole-render mutex in `motif_capture_frame` already serializes captures, so a
navigation can't interleave with a screenshot. **Verify during implementation**
which navigation primitive the pinned Tauri exposes (`WebviewWindow::navigate`
vs. CDP `Page.navigate`); keep the call behind the existing host seam so the
backend can swap. Extend `motif_id_from_url` coverage to the lower-third id.

## 5. Catalog / picker / MCP wiring + drift cleanup

- Add `lower-third` as the second entry in Rust `builtins()` and in
  `builtin.rs`'s served `BUILTINS` (with its `index.html` + `assets/Inter.woff2`).
- **Fix the `catalog/` vs `builtin/` drift discovered during design.** Today
  `catalog.rs` `include_str!`s `catalog/countdown/index.html` (the stale legacy
  `render()`/`ready()` HTML, used for the manifest + `content_hash`) while
  `builtin.rs` serves `builtin/countdown/index.html` (the live `motif.define`
  HTML). They have diverged. For the lower third, point **both** `catalog.rs` and
  `builtin.rs` at a **single per-Motif source dir** so the manifest/hash and the
  served bytes can never drift. Re-point `countdown` to the same unified layout as
  cleanup so the drift class can't recur.
- The picker already iterates the catalog → the lower third surfaces
  automatically. MCP `list_motifs` / the `motifs://current` resource likewise pick
  it up via `catalog()`. No per-surface plumbing.
- `commands.rs` derives `meta.duration` from a hardcoded `seconds` prop
  (`TODO(motifs-plan-2)`). The lower third has no `seconds` prop and ignores
  `ctx.duration` (its animation length is hardcoded in `setup`), so the existing
  fallback is harmless here. Optionally address the TODO (derive duration from the
  manifest) as part of this work; not required for correctness of either Motif.

## 6. Testing

- **Rust:** `builtins_cover_starter_set` updates to two ids; an assets-lookup test
  asserting `assets/Inter.woff2` is embedded and served with `font/woff2`; a
  `Manifest` round-trip test for `content_duration_s`; a `motif_id_from_url` /
  navigate-path unit test.
- **TS:** `motifContentFrame` clamp/dedup tests (fixed `content_duration_s` shorter
  than the layer → all tail frames resolve to the last content frame, identical
  `cacheKey`); `resolveMotifContentDurationUs` precedence tests.
- **E2E (`motif_capture.e2e.js`):** capture the lower third (font glyphs rendered,
  transparent backdrop, non-square dims) and exercise **host navigation** by
  capturing `countdown` then `lower-third` in the same session.

## 7. Boundaries / out of scope

- **In scope:** the `content_duration_s` decoupling (+ tests), the lower-third
  Motif (HTML/CSS, WAAPI, bundled Inter subset), multi-host navigation, the
  catalog/builtin drift cleanup, picker/MCP wiring, tests.
- **Out of scope:** a general pixel-hash dedup layer; a real enum `PropSpec` type;
  slide-out / end-aware animation for holdable Motifs; the untrusted-upload security
  hardening (`webcap-design §9`); audio (a Motif carries none); the evergreen
  `docs/motifs.md` rewrite (separate doc step).

## 8. Risks / open questions

- **Tauri navigation primitive.** Confirm `WebviewWindow::navigate` exists in the
  pinned version; otherwise drive `Page.navigate` over CDP, or fall back to
  rebuild. Low risk — rebuild always works.
- **Font subset fidelity.** A too-aggressive subset could drop glyphs used in
  non-Latin titles (e.g. zh-CN props are allowed elsewhere in the app). v1 ships a
  Latin subset; document that non-Latin lower-third text falls back to system
  fonts until a fuller subset/secondary face is bundled.
- **Held-tail correctness under L0 eviction.** With the dedup fix the held tail is
  a single cache entry, so the 240-frame L0 cap is no longer a thrash risk for a
  long holdable layer — confirm in the E2E by scrubbing a long lower-third layer.
