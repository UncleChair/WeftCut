---
status: accepted
---
# 0026 — Captions as first-class Text layers

## Context

The original subtitle implementation used libass-wasm (JASSUB) to render
ASS/SRT content into its own canvas, which the compositor copied as a texture
each frame. This design had three compounding problems:

1. **Export blind spot.** The export Worker runs in an `OffscreenCanvas`
   context — no DOM, no canvas-mode JASSUB. Every project with subtitles
   silently dropped them on export. The only exit was a separate ffmpeg
   `subtitles` burn-in stage that was never implemented.

2. **Opaque, non-editable.** A `Subtitles` layer held a reference to a
   subtitle media item or an inline SRT body. Individual cues were not
   addressable — there were no Text layers to move, trim, restyle, or keyframe.
   MCP tools (`update_layer_params`, `set_keyframe`, etc.) that work on every
   other layer kind were useless against subtitles.

3. **Second render path.** JASSUB maintained its own rendering state outside
   the PixiJS compositor. This forked the frame-compositing logic and forced a
   full texture refresh every frame (libass has internal animation state; there
   was no cheap static-vs-animated short-circuit).

The alternative — rendering subtitle cues through the existing PixiJS `Text`
path — sidesteps all three. `TextSprite` already runs identically in preview
and in the export Worker (`exportWorker.ts` imports `Compositor` against an
`OffscreenCanvas`). If every cue is a `Text` layer, the compositor needs no
subtitle-specific code and burn-in is a consequence of normal compositing, not
a new export stage.

The remaining question was font coverage. PixiJS `Text` renders via the
browser's canvas text API; the export Worker has no font-loading event. Bundling
fonts explicitly (loading them into the `FontFaceSet` inside the Worker before
the encode loop starts) solves this. CJK coverage requires at least one CJK
font family in that bundled set.

## Decision

Every imported subtitle cue becomes an independent first-class **`Text` layer**
on a dedicated `role: "caption"` track. There is no longer a `Subtitles` layer
variant. The design rests on four pillars:

### 1 — Single Rust parser chokepoint

`subtitles::parse(body, format)` in the native crate is the one place that turns
subtitle text (SRT / VTT / ASS) into `Cue { start_us, end_us, text, style }`
records. It is shared by all three entry points: file drag-drop / `import_media`,
the `apply_subtitles` MCP tool, and the `transcribe_clip` transcription workflow.
Format sniffing (`subtitles::sniff`) runs before parsing when the caller does not
supply a `SubFormat`.

`add_caption_track` is the one mutation that builds a caption track from a
`Vec<Cue>`. Overlapping cues auto-stack onto additional caption tracks (same
overlap rule as every other layer class). The entire import is atomic — one
history entry, one `ChangeEvent`.

### 2 — Track role "caption"

A track created by caption import carries `role: TrackRole::Caption`. The
captions panel uses this to find and list caption tracks without a separate
media-pool query; the `add_caption_track` mutation uses it to label new tracks
consistently.

### 3 — Bundled fonts + best-effort OS resolution

Two font families are bundled with the app and loaded into both preview
(`Compositor` on startup) and the export Worker (before the encode loop):

- **Liberation Sans Regular** — broad Latin / Cyrillic / Greek coverage, the
  default face for new caption tracks.
- **Noto Sans SC Regular** — Simplified Chinese + full CJK Extension A/B
  coverage.

The font pipeline resolves these families before compositing begins, so
burned-in captions never tofu on any supported platform regardless of the OS
font state.

For user-chosen font families not in the bundled set, `font:resolve` is a
synchronous IPC channel from the Worker back to the main process; the main
process queries `systemFonts.getAllFonts()` and returns matching font bytes.
This is best-effort — a font present on the author's machine may be absent on a
collaborator's, so it carries no determinism guarantee. The bundled chain is the
fallback and is always present.

### 4 — Tier-3 ASS support

ASS files are parsed using only the V4+ Style table and the inline override tags
most relevant to a caption import: `\an` (alignment), `\pos` (position),
`\c`/`\1c` (primary colour), `\b` (bold), `\i` (italic), `\fs` (font size),
`\fn` (font name), `\fad` (fade timing). Advanced tags — karaoke (`\k`), vector
drawings (`\p`), clip regions (`\clip`), animated transforms (`\t`/`\move`),
axis rotations (`\frx`/`\fry`/`\frz`), and Gaussian blur (`\blur`) — are
stripped and the cue text is kept. When any such tag was encountered,
`ParsedSubtitles.simplified = true` is set and surfaced to the caller so the UI
or MCP tool can warn the user.

### Migration: hard break

Project format version bumped v8 → v9. The load path is a cut-over gate
(`io/migrate.rs`): v9 loads, v8 is rejected. There is no migration for older
projects that contain `Subtitles` layers — they are unsupported. This is
consistent with the existing policy (see the Versioning section in
`data-model.md`): maintaining migration code for a layer variant that has never
shipped to end-users is pure overhead.

### What v1 defers

Export produces only burn-in (captions are ordinary `Text` layers and composite
into the video through the normal `TextSprite` path). Soft-subtitle tracks
(stream-muxed SRT/ASS into MKV/MP4) and sidecar file export remain a small
deferred follow-up — the data is already in `Text` layers and accessible to an
ffmpeg subtitle-mux stage when that work is prioritised.

## Consequences

- **+** Preview and export share one compositor and one render path for all
  layer kinds. The JASSUB second path and its "no export" gap are gone.
- **+** Every caption cue is a `Text` layer. All existing layer tools —
  `update_layer`, `update_layer_params`, `move_layer`, `trim_layer`,
  `split_layer`, `delete_layer`, keyframe tools — work on captions without any
  new code.
- **+** CJK and broad-Latin burn-in is deterministic on any platform because the
  bundled fonts load before compositing begins. User-font resolution is
  best-effort but always falls back to the bundled chain (no tofu).
- **+** The `apply_subtitles` MCP tool now returns a caption track id whose
  `Text` layers are immediately editable and keyframeable; the old JASSUB flow
  returned nothing addressable.
- **−** Hard migration break: v8 projects with `Subtitles` layers do not load in
  v9 and must be recreated. (No shipped projects carry this variant.)
- **−** Tier-3 ASS: complex ASS files lose karaoke, drawings, and animated
  transforms. The parser sets `simplified = true` to surface this.
- **−** User-font burn-in is non-deterministic across machines. Determinism
  requires choosing fonts from the bundled set or ensuring the same fonts are
  installed everywhere.
- **−** Soft-subtitle / sidecar export is deferred; v1 produces burn-in only.
