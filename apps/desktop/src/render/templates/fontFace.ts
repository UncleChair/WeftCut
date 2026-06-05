// Pure helpers to build a data-URL @font-face <style> block and inject it
// into an SVG string. No DOM or browser APIs used — safe to run in Node
// (vitest) and in the capture harness's iframe context alike.
//
// `buildFontFaceStyle` is the canonical path for embedding bundled template
// fonts. The data-URL MIME and CSS `format(...)` token are derived from each
// font's file extension (woff2/woff/ttf/otf — the formats the catalog glob
// loads). `injectFontFace` places the resulting <style> block inside a <defs>
// element immediately after the opening <svg> tag so SVG renderers find it
// before referencing the font-family.

/// A single font entry to encode as a @font-face rule. `file` is the font's
/// filename (or any path ending in it); its extension picks the data-URL MIME
/// and the CSS `format(...)` token.
export interface FontFaceInput {
  family: string;
  weight?: number;
  style?: string;
  bytes: Uint8Array;
  file: string;
}

/// Build a concatenated CSS string of @font-face rules for the given fonts.
/// Each font's bytes are base64-encoded in 0x8000-byte chunks to avoid
/// spreading a huge Uint8Array onto the call stack (V8 caps arg count at
/// ~125 k; `String.fromCharCode(...bigArray)` throws for larger fonts).
/// Returns `""` for an empty input array.
export function buildFontFaceStyle(fonts: FontFaceInput[]): string {
  if (fonts.length === 0) return "";
  return fonts.map((font) => {
    const b64 = bytesToBase64(font.bytes);
    // Derive MIME + `format(...)` from the file extension — the catalog glob
    // loads woff2/woff/ttf/otf, and a non-woff2 font tagged as woff2 won't
    // render. Unknown/missing extensions fall back to woff2.
    const { mime, format } = fontType(font.file);
    const src = `url(data:${mime};base64,${b64}) format('${format}')`;
    const weightPart = font.weight !== undefined ? `font-weight:${font.weight};` : "";
    const stylePart = font.style !== undefined ? `font-style:${font.style};` : "";
    return `@font-face{font-family:'${font.family}';src:${src};${weightPart}${stylePart}}`;
  }).join("");
}

/// Insert `<defs><style>${style}</style></defs>` immediately after the opening
/// `<svg …>` tag in `svg`. If `style` is empty, returns `svg` unchanged.
/// Matching is done on the literal `<svg` opening tag — anything before the
/// first `>` is the attribute set; the insertion point is immediately after
/// that `>`. Existing <defs> blocks are left intact; the new block is simply
/// prepended.
export function injectFontFace(svg: string, style: string): string {
  if (!style) return svg;
  return svg.replace(/<svg\b[^>]*>/, (openTag) => {
    return `${openTag}<defs><style>${style}</style></defs>`;
  });
}

// ----- internals ------------------------------------------------------------

/// Map a font filename's extension to its data-URL MIME and CSS `format(...)`
/// token. Case-insensitive on the extension; unknown or extension-less names
/// fall back to woff2 (the most common bundled format).
function fontType(file: string): { mime: string; format: string } {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "woff":
      return { mime: "font/woff", format: "woff" };
    case "ttf":
      return { mime: "font/ttf", format: "truetype" };
    case "otf":
      return { mime: "font/otf", format: "opentype" };
    case "woff2":
    default:
      return { mime: "font/woff2", format: "woff2" };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
