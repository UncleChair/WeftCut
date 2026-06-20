// Bundled fonts are loaded into BOTH the preview Compositor (main thread,
// document.fonts) and the export Worker (self.fonts) so burned-in captions
// render identically — this carries the cross-OS determinism guarantee.
// Vite `?url` resolves each asset to a same-origin URL at build time.
import notoCjkUrl from "../../../../assets/fonts/NotoSansSC-VF.ttf?url";
import liberationUrl from "../../../../assets/fonts/LiberationSans-Regular.woff2?url";

export const BUNDLED_FONT_FAMILIES = ["Liberation Sans", "Noto Sans SC"] as const;

/// Default caption font: Latin glyphs from Liberation Sans, CJK from Noto.
/// PixiJS passes this comma list straight to the canvas font shorthand, so
/// the browser falls through to Noto for any glyph Liberation lacks.
export const DEFAULT_CAPTION_FONT_FAMILY = "Liberation Sans, Noto Sans SC";

const FONT_URLS: Record<string, string> = {
  "Liberation Sans": liberationUrl,
  "Noto Sans SC": notoCjkUrl,
};

/// Fetch every bundled font's bytes. Used to FontFace-register them into a
/// face set (document.fonts for preview, self.fonts for the export Worker).
export async function loadBundledFontBytes(): Promise<Record<string, ArrayBuffer>> {
  const out: Record<string, ArrayBuffer> = {};
  for (const family of BUNDLED_FONT_FAMILIES) {
    const res = await fetch(FONT_URLS[family]);
    out[family] = await res.arrayBuffer();
  }
  return out;
}
