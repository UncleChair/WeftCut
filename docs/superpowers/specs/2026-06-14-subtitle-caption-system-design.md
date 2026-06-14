# Subtitle / Caption System: Cue-as-Clip Editing, Text-Backed Render, Independent Export

**Date:** 2026-06-14
**Status:** Approved design, pending implementation plan

## Goal

Make subtitles first-class citizens of the timeline. Today a subtitle is a
single opaque `Subtitles` layer (`state/layer.rs:208`) that holds an entire
ASS/SRT *document*: it renders in preview via JASSUB (`render/sprite/SubtitlesSprite.ts`,
`render/subtitles/Jassub.ts`) but is **silently dropped from export**
(`Compositor.ensureSubtitles` returns `null` with no DOM host; `exportWorker.ts:25`)
and cannot be edited cue-by-cue on the timeline.

Both gaps share one root cause: subtitles live *outside* the normal layer
pipeline. The ordinary `Text` layer, by contrast, is per-instance editable and
already composites into export. This design dissolves both gaps by making **each
subtitle cue a first-class `Caption` layer that delegates rendering to the Text
rasterizer**, grouped under a **`CaptionSet`** that owns the shared style and the
re-aggregation needed for sidecar export. The old `Subtitles`/JASSUB path is
retained only as a read-only fallback for documents whose typesetting we cannot
represent.

Fidelity target is **"practical ASS minus per-character effects"** (Tier 2): named
shared style, per-cue position/colour override, outline, shadow, background box,
fades — but no karaoke, no `{\...}` mid-cue animation, no vector drawing. That
ceiling is set by the Text rasterizer, deliberately.

## Decisions (settled during brainstorming)

- **Paradigm = cue-as-clip.** Each cue is a first-class `Layer`; it moves, trims,
  splits, duplicates, and multi-selects with the *existing* layer machinery. NOT a
  document-as-layer model with a separate caption-list panel (weakest timeline
  integration), NOT a hybrid single-document-with-sublayer-edits (needs new
  sub-layer edit primitives).
- **Render = delegate to the Text rasterizer.** A cue resolves `CaptionSet.style +
  per-cue override` into an equivalent `TextParams` and draws through the same code
  as a `Text` layer. This is *why* export works for free (no DOM, no JASSUB) and
  why the fidelity ceiling is Tier 2.
- **New `CaptionSet` object, NOT a reuse of `Group`.** `Group`'s defining semantic
  is "edit one member → all fan out" (`state/group.rs`, coupled move/trim/split),
  which is exactly wrong for cues (each cue must move independently). `CaptionSet`
  borrows only Group's derived-index pattern (`LayerId → CaptionSetId`).
- **Keep `Subtitles`/JASSUB as a read-only fallback** for documents containing
  effects we cannot represent. The graceful-degradation home, not dead code.
- **Background box (+ line spacing + wrap width) is added to `Text` proper**, not a
  caption-only hack; captions inherit it via delegation. Scope is these three
  caption-driven gaps only — a broader Text capability overhaul, if wanted, is a
  separate spec. v1 box is **Block** (one box around the whole cue); per-line box
  is a fast-follow.
- **Export = burn-in (A) + sidecar file (B) this round; embedded soft-sub track
  (C, container mux) deferred to v2.**
- **No schema migration.** Pre-release; old project folders are recreated. Add the
  new types/fields directly, bump `schema_version` as a marker, write no migration
  or backward-compat code.

## 1. Data model

### 1.1 `Caption` layer kind (thin; delegates render to Text)

Add a variant to `LayerParams` (`state/layer.rs:55`, currently `VideoClip /
ImageOverlay / Text / Motif / Audio / Subtitles / Color`):

```rust
pub struct CaptionParams {
    pub set_id: CaptionSetId,                       // which set this cue belongs to
    pub text: String,                               // this cue's text
    pub style_override: Option<CaptionStyleOverride>, // sparse per-cue exceptions
    // timing is NOT here — reuse Layer.t_start_us / t_end_us like every other kind
}
```

Why a new kind rather than reusing `Text` directly: caption cues need timeline
behaviour and a set association that a plain `Text` layer cannot carry (a caption
cue and a title card would otherwise be indistinguishable). The cost is only IPC
view + inspector wiring — **not a new renderer**, because rendering delegates to
the Text rasterizer (§4.5).

### 1.2 `CaptionSet` object (shared style + members + re-aggregation home)

```rust
pub struct CaptionSet {
    pub id: CaptionSetId,
    pub label: Option<String>,
    pub language: Option<String>,       // "zh-CN" / "en" — drives sidecar filename suffix
    pub style: CaptionStyle,            // the shared style (≈ ASS [V4+ Styles])
    pub source_format: SubtitleFormat,  // Srt | Vtt | Ass — preferred lossless export target
    // members = every Caption layer whose set_id points here; the actor maintains
    // a derived LayerId → CaptionSetId index (the state/group.rs index pattern)
}
```

Add `caption_sets: imbl::Vector<CaptionSet>` to `Project` (`state/project.rs`),
alongside `groups`. `CaptionSet` and `CaptionStyle` are the in-model mirror of
ASS's `[V4+ Styles] + [Events]` split — which is precisely what makes lossless
`.ass` sidecar export (§5.2) almost a 1:1 serialization.

### 1.3 `Subtitles` / JASSUB → read-only fallback

`Subtitles` (`SubtitlesParams`, JASSUB) is **not deleted**. It becomes the landing
zone for documents the ingest cannot represent as editable cues (§3.3): preview
renders correctly via JASSUB; the layer is marked read-only (no cue editing); it
does **not burn into export** (no DOM), but it **can** sidecar-export by
passthrough (§5.3).

## 2. Timeline interaction

Because a cue is a `Layer`, most interaction is reused, not built.

### 2.1 Caption track — content-derived, auto-created, top of z-stack

- **Auto-created on first ingest** (preserves today's `apply_subtitles`
  auto-create-"Captions"-track behaviour); does not consume the reserved A/B-roll
  tracks.
- **Inserted at the top of the z-stack** (data index high → renders above
  video/B-roll; subtitles sit on top of the picture).
- **No hard `TrackRole`** — stays kind-agnostic per V.5. The track's caption-ness
  is *derived from content* (it holds `Caption` layers), like the existing derived
  `TrackSummary.kind` field. The track header surfaces a "caption set style /
  export" affordance only when it detects a caption track.

### 2.2 Sequential (non-overlapping) for free

Cues are inherently sequential. `Caption` joins the existing `"visual"` overlap
class (`timeline/geometry.ts` `layerOverlapClass`), and the existing invariant
"same-class layers cannot overlap on one track" then enforces sequencing with **no
new logic**. (ASS technically permits simultaneous dialogue via its Layer field;
that is out of Tier 2 — simultaneous cues are a v2 concern.)

### 2.3 Cue block visual

Reuse `LayerBlock` (`timeline/LayerBlock.tsx`); change only:
- **Label = the cue text** (truncated), so the timeline reads as captions.
- **Per-set hue** so cues of one `CaptionSet` share a colour (reuse the
  `geometry.ts` `groupHue()` approach); multiple sets (zh / en) are visually
  distinct.

### 2.4 Editing — almost entirely reused

| Action | Source |
| --- | --- |
| Drag to retime / cross-track move | `move_layer` (existing) |
| Trim edges | `trim_layer` (existing) |
| Blade split | `split_layer` (existing) |
| Duplicate | `duplicate_layer` (existing) |
| Multi-select → batch shift/delete | existing multi-select |

Only two caption-specific operations are new:
- **New empty cue:** double-click empty caption-track space → create a default-
  duration (e.g. 2s, frame-aligned) empty cue and enter text edit.
- **Merge adjacent cues:** select two adjacent cues → merge into one (text
  concatenated, time = union).

Splitting a cue uses `split_layer`'s generic behaviour (bisect time, copy text to
both halves; the user then trims the text) — no automatic word-boundary splitting.

### 2.5 No auto-ripple in v1

Editing or deleting one cue does **not** shift later cues. Cues are independent,
like clips. Ripple is a common-but-optional subtitle mode → v2.

## 3. Import & auto-caption

### 3.1 One ingest path

All entry points converge on a single Rust-side function (it mutates project state
→ must go through the actor):

```
drag .srt/.vtt/.ass ┐
file picker          ├──→ ingest_subtitles(body, format, target_track, t_offset)
Whisper auto-caption │        ├─ parse → structured cue list + style table
MCP apply_subtitles  ┘        ├─ capability detection
                              ├─ representable → CaptionSet + N Caption layers
                              └─ not representable → read-only Subtitles (JASSUB) layer
```

Capability detection / frame-snapping / degradation are then written once.

### 3.2 Parsers (Rust) + capability detection

| Format | Today | This round |
| --- | --- | --- |
| SRT | parsed + time-shifted in `cloud/srt.rs` | extend to "parse to cue list"; inline `<i>/<b>` → per-cue formatting or drop |
| VTT | **unsupported** (`assBody.ts` `subtitleBodyFromFile` returns null) | **new parser**; `position/line/align` → style/override, `<v speaker>` → speaker |
| ASS | passed through to JASSUB only | **new parser**: `[V4+ Styles]` → `CaptionStyle`, `[Events]` → cues; scan override tags for capability |

Capability detection = scanning ASS `{\...}` tags:
- **Mappable (pass):** none, `\pos` → transform, `\an` → alignment, `\i \b` → format.
- **Unsupported (warn):** `\k \kf` (karaoke), `\t \move` (animation), `\p` (vector),
  `\clip`, `\frx/\fry` (3D rotation), etc.

### 3.3 "Limited support" handling — default does not block, but is explicit

Default behaviour: **import as editable cues, flattening unsupported effects (keep
text + timing + mappable style), and show a dialog listing what was dropped, with a
one-click escape to "keep as read-only effect subtitle".**

> Dialog (mirrors the existing codec "needs optimizing" popup pattern):
> *"Imported as editable subtitles. 5 unsupported advanced effects (karaoke ×3,
> path animation ×2) were ignored."* `[OK]` `[Keep as read-only effect subtitle]`

The common case (a user who just wants editable captions) is frictionless; the
notice is explicit and reversible — "Keep as read-only effect subtitle" switches
the document back to a JASSUB `Subtitles` layer (§1.3): full fidelity, no editing,
no burn-in. **SRT/VTT/Whisper output never triggers this dialog** (plain text +
timing is always fully representable); only ASS can.

### 3.4 Auto-caption / Whisper

- `transcribe_clip` (Whisper, `mcp/mod.rs`): output is always clean text → straight
  into ingest as a `CaptionSet` + cues. The `cloud/srt.rs` `shift_srt` timeline
  alignment (relative → absolute timestamps) is retained.
- `/auto-caption` prompt: unchanged externally; new pipeline underneath.
- `apply_subtitles` MCP: same name/signature, routed through ingest, now producing
  editable cues.

### 3.5 Drag-drop

Dropping `.srt/.vtt/.ass` on the timeline sets the set's `t_offset` and target
track, then runs the same ingest. Reuse the existing HTML5 drag-drop (mind the
Windows-only `dragDropEnabled:false` constraint).

## 4. Style & inspector

Fields are chosen to stay within what the Text rasterizer can draw, so delegation
(and therefore export) holds.

### 4.1 `CaptionStyle` (set-level shared style)

Lives on `CaptionSet.style`; every cue inherits it. All fields map to current (or
newly-added, §4.2) Text capabilities:

| Field | Maps to Text | Note |
| --- | --- | --- |
| font (family/size/weight/italic) | `FontSpec` (`layer.rs:124` — has weight + italic) | existing |
| fill colour | `color` | existing |
| outline (colour/width) | `Outline` (`layer.rs:150`) | existing |
| shadow (colour/offset/blur) | `Shadow` (`layer.rs:142`) | existing |
| horizontal align | `TextAlign` (`layer.rs:134`) | existing |
| screen anchor + margin | `transform` position | 9-grid anchor (`\an1–9` model), default bottom-centre; resolved into `transform.position`, no Text change needed |
| **background box** | **new `TextParams.background`** (§4.2) | Block mode v1 |
| **line spacing** | **new Text field** (§4.2) | — |
| **wrap width** | **new Text field** (§4.2) | constrain to e.g. 80% frame width |

`CaptionStyle` holds **static values, no `Animated<T>` / keyframes** — captions do
not keyframe (that is the Tier 3 we cut). This also keeps captions off the
cross-language animation engine (§7).

### 4.2 Text capability additions (caption-driven, land on `Text`)

Add to `TextParams` (`layer.rs:109`):

```rust
pub background: Option<TextBackground>,
// + line_spacing, + wrap_width_px (exact field shapes finalized in the plan)

pub struct TextBackground {
    pub color: Rgba,         // alpha for translucency
    pub padding: f32,
    pub corner_radius: f32,
    pub mode: BoxMode,       // Block (v1) | PerLine (fast-follow)
}
```

Scope is exactly these three gaps. v1 box = **Block** (one box around the whole
cue); **PerLine** (per-line tight boxes, YouTube/CapCut style) is a fast-follow
(needs per-line width measurement + gap handling). A box likely forces the
`TextBackend::Rasterized` path (`layer.rs:165`) — acceptable.

### 4.3 `CaptionStyleOverride` (sparse per-cue exception)

`style_override` defaults to `None` (full inheritance). When set, it stores **only
the differing fields** — typically position nudge (a cue colliding with on-screen
content) or colour (speaker distinction).

**v1 = one shared style per set + sparse per-cue override.** ASS-style *multiple
named presets within a set* (Default / Emphasis / Speaker-A, switched per cue) is
deferred to v1.5/v2 — per-cue colour/position override already covers most speaker
cases. YAGNI.

### 4.4 Inspector — two levels

- **Set-level style editor**: opened from the caption track header (§2.1) or when
  the set is selected; editing re-renders all cues live. Where you set
  font/size/position/box once.
- **Cue-level inspector**: selecting a cue shows **text editor (multi-line)** +
  **timing (start/end/duration, frame-aligned)** + a collapsed **"override style"**
  section (empty = inherit). Preview updates at the playhead as you type.

### 4.5 Render resolution

Per frame: `CaptionStyle + cue.style_override → an equivalent TextParams →` Text
rasterizer. This reuses the per-frame `resolveView` pattern (preview and export
Worker share one resolution point), so `preview == export` by construction.

## 5. Export (burn-in + sidecar)

### 5.1 Burn-in — does not touch JASSUB

Export drops subtitles today only because JASSUB needs a DOM canvas the export
Worker lacks. `Caption` cues never use JASSUB — they use the Text rasterizer, which
**already runs in the export Worker**. Burn-in is therefore inherently possible,
no DOM. Wiring:
- **Compositor**: add a `Caption` dispatch branch (calls the same code as `Text`).
- **`activeVideoLayers.ts`**: add `Caption` to the `hasVisibleContent()` visible set
  (currently Video/Image/Text/Color/Motif) — otherwise the no-material export guard
  misfires and cues are skipped.
- **UI**: a "Subtitles" section in the existing Export Settings dialog with a
  **"Burn in subtitles" toggle (default on)**.

### 5.2 Sidecar (independent subtitle file)

Serialize `CaptionSet` → file:

| Format | Fidelity | Use |
| --- | --- | --- |
| **ASS** | **highest (lossless)** | our model is the ASS structure — style table → `[V4+ Styles]`, cues → `[Events]`, override → cue tags; ~1:1 |
| VTT | mid | web / positioning / speaker |
| SRT | lowest (drops style) | universal; upload to YouTube/Bilibili |

- **Multi-language**: each `CaptionSet` exports its own file, named by language
  suffix (`name.zh.srt`, `name.en.srt`).
- **Two triggers**: (1) emitted alongside the video on export (same dir, same
  basename); (2) a standalone **"Export subtitles…"** command that writes only the
  subtitle file(s), no video render.

### 5.3 Read-only fallback layers sidecar by passthrough

A read-only `Subtitles` fallback layer (§1.3) **is** a complete ASS/SRT document,
so sidecar export passes it through directly (applying the layer's timeline offset
via the `shift_srt` machinery) — lossless. So the fallback layer **does not burn
in** (no DOM) but **does sidecar-export**: a user who relied on effects we cannot
burn still keeps them as a soft subtitle file.

### 5.4 Export matrix (two independent axes)

| | Burn-in on | Burn-in off |
| --- | --- | --- |
| No sidecar | hard-subbed video | clean video |
| + sidecar | hard-subbed video + soft file | clean video + soft file |

Burn-in toggle and sidecar-format selection are independent; all four combinations
are valid.

## 6. MCP surface

The payoff: because cues are ordinary `Layer`s, the **generic layer tools work on
captions for free** — `move_layer` / `split_layer` / `trim_layer` /
`duplicate_layer` / multi-select all operate per-cue with no caption-specific code.
"Subtitles integrated into timeline editing" therefore holds for external agents
too.

| Action | Tool | Status |
| --- | --- | --- |
| move/trim/split/duplicate a cue | `move/trim/split/duplicate_layer` | **existing, free** |
| edit cue text / per-cue override | `update_layer` (+ Caption fields in `LayerUpdatePatch`) | extend |
| apply / import subtitles | `apply_subtitles` | keep, route via ingest |
| Whisper auto-caption | `transcribe_clip` | keep, route via ingest |

Three genuinely new tools (set-level, beyond what generic layer ops reach):
- **`update_caption_style(set_id, style_patch)`** — edit the set's shared style; one
  call restyles the whole set. The batch-restyle entry point.
- **`add_caption_cue(set_id, text, t_start_us, t_end_us)`** — add a cue to a set.
- **`export_subtitles(set_id?, format, path?)`** — sidecar export (srt/vtt/ass).

Landing constraints (known pitfalls): every new mutation must emit `project:changed`
(UI-actor bridge rule) or the UI freezes; rmcp 0.1.x `#[tool]` methods return
`Result<CallToolResult, McpError>` via the `ok_text/ok_json` helpers in
`mcp/mod.rs`. `/auto-caption` prompt unchanged.

## 7. Schema & cross-language notes

**`schema_version` 8 → 9, no migration.** Pre-release: add the new types/fields
directly, bump the version as a marker, recreate old project folders. No
backward-compat / `serde(default)` migration code is required.

New Rust types: `LayerParams::Caption(CaptionParams)`, `CaptionSet`,
`CaptionStyle`, `CaptionStyleOverride`, `TextBackground`; new `TextParams` fields
(`background`, line spacing, wrap width); `Project.caption_sets`. TS mirrors in
`ipc/index.ts`: `CaptionView` / `CaptionSetView`, a `Caption` arm in the
`LayerParamsView` union.

Consistency notes (recorded pitfalls):
- **Sidecar serialization (CaptionSet → ASS/SRT/VTT) lives Rust-side**, next to
  `cloud/srt.rs`.
- `CaptionStyle` is static (§4.1), so it does **not** touch the byte-identical
  Rust/TS animation `ENGINE_SOURCE` — that parity risk is structurally avoided.
- `CaptionStyle + override → equivalent TextParams` resolution runs in **one** place
  (the TS Compositor's `resolveView`, shared by preview and export) — no second
  implementation.

## Out of scope / future

- **v2: embedded soft-sub track** (container mux — mov_text in MP4, ASS in MKV;
  needs an ffmpeg mux step in `export/mod.rs`).
- **PerLine background box** (per-line tight boxes); the broader **Text capability
  overhaul** beyond box/line-spacing/wrap (its own spec).
- **Multiple named style presets per set** (Default / Emphasis / Speaker-A).
- **Auto-ripple** editing mode; **simultaneous (overlapping) cues** (ASS Layer
  field); **auto word-boundary cue split**.
- **Tier 3 typesetting** (karaoke, mid-cue animation, vector, 3D rotation) — only
  ever available through the read-only JASSUB fallback, never editable.

## Related

- `state/layer.rs` — `LayerParams`, `TextParams`, `FontSpec`, `Outline`, `Shadow`,
  `SubtitlesParams`.
- `state/group.rs` — the derived-index pattern `CaptionSet` borrows (but not the
  coupling semantics).
- `render/subtitles/` (`Jassub.ts`, `assBody.ts`) + `cloud/srt.rs` — the JASSUB
  fallback render and SRT parse/shift reused by ingest §3 and passthrough §5.3.
- `timeline/geometry.ts` — overlap class, `groupHue`, visual track ordering.
- `docs/render.md` — the single per-frame resolution point shared by preview and
  export (§4.5).
- `docs/data-model.md` — layer/track/group model; subtitle row to be updated from
  "Preview-only" to the cue/CaptionSet model.
