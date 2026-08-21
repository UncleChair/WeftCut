// The bundled font family string, in one place. Lives in src/shared/ because
// both processes mint it: the Electron main process stamps it onto new Text and
// caption layers (state/mutations/add.ts, state/mutations/captions.ts) and the
// renderer registers the matching bytes and renders with it
// (render/fonts/registry.ts, which re-exports this). Main must not import from
// renderer/, so a shared home is the only way the two agree — same reason
// DecodeRoute and textSnippet live here.
//
// The Rust twin is `DEFAULT_CAPTION_FONT` in native/src/subtitles/layout.rs:
// the other language, so it holds its own copy of the literal.

/// Default text/caption family: Latin glyphs from Liberation Sans, CJK from
/// Noto. A comma list, not a single family — PixiJS passes it straight to the
/// canvas font shorthand, so the browser falls through to Noto for any glyph
/// Liberation lacks. Both faces ship with the app, which is what makes the
/// cross-OS determinism guarantee true on the DEFAULT authoring path and not
/// only on imported captions (ADR 0049).
export const DEFAULT_CAPTION_FONT_FAMILY = "Liberation Sans, Noto Sans SC";
