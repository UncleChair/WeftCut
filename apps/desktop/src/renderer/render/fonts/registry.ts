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
  for (const [family, url] of Object.entries(FONT_URLS)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to load bundled font ${family}: ${res.status}`);
    out[family] = await res.arrayBuffer();
  }
  return out;
}

/// Resolve OS fonts for non-bundled families used in a project (best-effort).
/// Bundled families are skipped (already loaded). Unresolved families are
/// omitted so the renderer falls back to the bundled default chain (no tofu).
/// MAIN-THREAD ONLY: touches window.api — never call from the export Worker
/// (which has no window; the Worker only consumes the already-resolved bytes).
export async function resolveFontsForFamilies(families: string[]): Promise<Record<string, ArrayBuffer>> {
  const bundled = new Set(BUNDLED_FONT_FAMILIES as readonly string[]);
  const out: Record<string, ArrayBuffer> = {};
  const seen = new Set<string>();
  for (const family of families) {
    // A family field may be a comma fallback chain; resolve each leaf.
    for (const leaf of family.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (bundled.has(leaf) || seen.has(leaf)) continue;
      seen.add(leaf);
      const bytes = await window.api.font.resolve(leaf);
      if (bytes && bytes.byteLength > 0) {
        out[leaf] = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
    }
  }
  return out;
}
