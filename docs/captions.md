# Captions

Imported subtitles are not a special layer kind. Every cue from an SRT, VTT,
or ASS file becomes an independent, first-class **`Text` layer** on a dedicated
caption-role track. The same PixiJS `Text` path that renders any other text
renders captions — in preview and in the export Worker — so captions burn into
exported video as a consequence of normal compositing, with no subtitle-specific
render code and no separate export stage.

The rationale (why this replaced the previous libass/JASSUB design) lives in
[ADR 0026](adr/0026-captions-as-text-layers.md). This document describes how the
feature works.

## The model, in one paragraph

A subtitle import produces one or more tracks with `role: "caption"`, each
holding one `Text` layer per cue, positioned in composition time from the cue's
own timestamps. Because every cue is an ordinary `Text` layer, all existing
layer operations — move, trim, split, delete, restyle, keyframe, and the MCP
tools behind them — work on captions with no new code. Captions have no special
status at render time: they composite through `TextSprite` like any text.

## Ingestion — one parser, one mutation

Three entry points feed captions, and all of them converge on a single Rust
chokepoint so there is exactly one parsing path and one mutation:

- **File import.** Dropping or importing a `.srt` / `.vtt` / `.ass` file is
  intercepted in `import_media` by extension. Subtitle files are **consumed at
  import** — parsed straight into a caption track. They are never added to the
  media pool and produce no proxy or derivative jobs.
- **MCP `apply_subtitles`.** An agent passes a subtitle body inline. Cue timings
  come from the body; the tool builds its own caption track and returns the new
  track id.
- **Transcription.** `transcribe_clip` returns an SRT body with timestamps
  already shifted to timeline-absolute microseconds; piping it into
  `apply_subtitles` lands the cues on a caption track at the right offset.

All three call `subtitles::parse(body, format)` → `Cue { start_us, end_us, text,
style }`, then the atomic `add_caption_track` mutation. Format is sniffed
(`subtitles::sniff`) when the caller does not supply one. The whole import is a
single history entry (one undo removes the whole import, however many cues).

**Overlapping cues auto-stack.** When cues overlap in time, they fan greedily
onto additional caption tracks so each track stays non-overlapping — the same
linear-timeline invariant every other layer class obeys. A transcription, whose
cues never overlap, produces a single track.

## Cue layout and ASS support

`cue_to_text_params` turns a cue into a `Text` layer's parameters. A styleless
cue (plain SRT/VTT) gets the default caption look: white fill, a thin outline and
soft shadow, font size proportional to composition height, bottom-centre anchored
with a safe-area margin.

ASS is supported at "Tier 3": the V4+ Style table plus the inline override tags
that matter for captions — `\an` (alignment, mapped to anchor + position), `\pos`,
`\c`/`\1c` (colour), `\b`, `\i`, `\fs`, `\fn`, `\fad`. Advanced tags (karaoke
`\k`, drawings `\p`, clips, animated transforms `\t`/`\move`, rotations, blur) are
stripped while the cue text is preserved; the parser sets a `simplified` flag the
UI and MCP tool surface so the user knows styling was dropped.

VTT is parsed at SRT level — text and timing only; region and cue-setting
directives are ignored.

## Fonts and burn-in determinism

Burned-in text must render identically in preview and export and must not fall
back to tofu (missing-glyph boxes). Two font families are bundled with the app
and loaded into **both** surfaces before any compositing begins — the preview
`Compositor` on startup (`document.fonts`) and the export Worker before its encode
loop (`self.fonts`):

- **Liberation Sans** — broad Latin/Cyrillic/Greek; the default caption face.
- **Noto Sans SC** — Simplified Chinese and full CJK coverage.

These bundled fonts carry the cross-OS export-determinism guarantee. The default
caption font is the fallback chain `"Liberation Sans, Noto Sans SC"`, so any glyph
Liberation lacks falls through to Noto.

A user may set a caption (or any `Text` layer) to a font outside the bundled set.
The main-thread renderer resolves it best-effort via `window.api.font.resolve`
(`resolveFontsForFamilies`) **before the export Worker starts**, and merges the
resolved bytes into the export request; the Worker only consumes pre-resolved
fonts and never calls the resolver itself — that separation is the determinism
boundary. On the main process, `resolveSystemFont` matches a family name by a
hand-rolled scan of the platform font directories' sfnt `name` tables (no external
font-enumeration dependency). User-font resolution is explicitly **outside** the
determinism contract — a font on the author's machine may be absent on a
collaborator's — and when a family does not resolve it is omitted, so rendering
falls back to the bundled chain. Captions never tofu.

## Editing — the captions panel

The captions panel (in the right panel) reads the caption-role tracks and lists
their cues in time order. Each row seeks the playhead to the cue and offers inline
text editing (committed on blur through `update_layer_params`). A track-level
restyle control batch-applies font family, size, colour, and outline across every
`Text` layer on the caption track in a single undo step (`restyle_caption_track`);
the colour commit is debounced because it fans out to every layer on the track.

Because cues are plain `Text` layers, they are also editable directly on the
timeline and in the inspector like any other layer — the panel is a convenience
for navigating and bulk-styling a caption set, not the only way to edit it.

## Scope

v1 export is **burn-in only**: captions composite into the video frame like any
text. Soft-subtitle tracks (stream-muxed SRT/ASS into MKV/MP4) and sidecar
subtitle-file export are deferred — the data already lives in `Text` layers and is
available to a future ffmpeg subtitle-mux stage. Word-level/karaoke highlight,
automatic safe-area word-wrap, and per-project user-supplied font files are out of
scope.

## Pointers

- Decision record and trade-offs: [ADR 0026](adr/0026-captions-as-text-layers.md).
- Layer/track data model and the `apply_subtitles` tool contract: [data-model.md](data-model.md).
- How `Text` layers render (and how bundled fonts load into the export Worker):
  [render.md](render.md).
- MCP surface: [mcp.md](mcp.md).
