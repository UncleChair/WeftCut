// Inline external font / image references into a template's HTML + CSS so
// the rasterized SVG can render without network access (or any access at
// all, since `createImageBitmap` won't fire subresource requests through
// a foreignObject). Workspace templates that ship their own woff2 files
// or <img> assets need this; the built-in catalog doesn't reference
// anything external so the pipeline is currently a no-op for them.
//
// Split into pure scan/rewrite helpers (testable in Node) and a single
// async `embedTemplateAssets` that walks the discovered URLs through an
// injected resolver. Caller owns the resolver — the rasterizer doesn't
// know how to read disk; it just asks for bytes by URL.

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g;
const HTML_IMG_SRC_RE = /(<img\b[^>]*\bsrc\s*=\s*)(['"]?)([^'"\s>]+)\2/gi;
const DATA_URL_PREFIX = "data:";

/// Extract every `url(...)` target from a CSS string. Skips data: URLs
/// (already inlined). Returns unique, insertion-ordered URLs.
export function extractCssUrls(css: string): string[] {
  return uniqueOrdered(matchAll(css, CSS_URL_RE).map((m) => m[2]!));
}

/// Extract every `<img src="...">` target from an HTML string. Skips
/// data: URLs. Returns unique, insertion-ordered URLs.
export function extractHtmlImageUrls(html: string): string[] {
  return uniqueOrdered(matchAll(html, HTML_IMG_SRC_RE).map((m) => m[3]!));
}

/// Rewrite every `url(X)` in `css` whose X is a key of `mapping` to
/// `url("Y")` (double-quoted for safety with data: URLs that contain
/// commas + parens). Unmatched url() targets pass through unchanged.
export function rewriteCssUrls(
  css: string,
  mapping: ReadonlyMap<string, string>,
): string {
  return css.replace(CSS_URL_RE, (full, _quote, target: string) => {
    const replacement = mapping.get(target);
    if (replacement === undefined) return full;
    return `url("${replacement}")`;
  });
}

/// Rewrite every `<img src="X">` whose X is a key of `mapping` to
/// `<img src="Y">`. Unmatched srcs pass through.
export function rewriteHtmlImageSrcs(
  html: string,
  mapping: ReadonlyMap<string, string>,
): string {
  return html.replace(
    HTML_IMG_SRC_RE,
    (full, prefix: string, quote: string, target: string) => {
      const replacement = mapping.get(target);
      if (replacement === undefined) return full;
      const q = quote || '"';
      return `${prefix}${q}${replacement}${q}`;
    },
  );
}

/// Derive a MIME type for a URL by extension. Returns
/// `application/octet-stream` for unknown extensions — browsers still
/// inline data: URLs with that, just without the format hint.
export function mimeFromUrl(url: string): string {
  const cleaned = url.replace(/[?#].*$/, "");
  const idx = cleaned.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = cleaned.slice(idx + 1).toLowerCase();
  switch (ext) {
    case "woff2":
      return "font/woff2";
    case "woff":
      return "font/woff";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/// Base64-encode bytes for use in a data: URL. Browser-only (uses
/// `btoa` after building a binary string). Caller is responsible for
/// chunking absurdly large payloads — most font/image assets are
/// fine inline; multi-MB videos would not be (and shouldn't be
/// embedded this way anyway).
export function bytesToBase64(bytes: Uint8Array): string {
  // Built up in chunks to avoid pushing a huge spread arg onto the
  // call stack (V8 caps arg lengths at ~125k on a normal stack).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export interface EmbedTemplateAssetsInput {
  html: string;
  css: string;
  /// Resolver invoked per discovered external URL. Return the asset's
  /// bytes to embed it, or `null` to leave the reference untouched
  /// (e.g., the URL is unknown to this template's asset namespace,
  /// or the file is missing). Caller may resolve relative paths
  /// against the template's directory however it sees fit.
  fetchAsset: (url: string) => Promise<Uint8Array | null>;
}

export interface EmbedTemplateAssetsResult {
  html: string;
  css: string;
  /// URLs the resolver returned non-null for, in discovery order.
  /// Useful for diagnostics + cache-key composition.
  embedded: string[];
  /// URLs that were skipped (resolver returned null). Caller can log
  /// these as missing-asset warnings.
  skipped: string[];
}

/// Walk every external URL in the inputs, ask the resolver for bytes,
/// and rewrite hits to inline `data:` URLs. Hits + misses are reported
/// in the return value so the caller can fold them into the raster
/// cache key (different embedded asset bytes → different rasters).
export async function embedTemplateAssets(
  input: EmbedTemplateAssetsInput,
): Promise<EmbedTemplateAssetsResult> {
  const cssUrls = extractCssUrls(input.css);
  const htmlUrls = extractHtmlImageUrls(input.html);
  // Unique union; preserve insertion order for deterministic
  // embedded/skipped reporting.
  const allUrls = uniqueOrdered([...cssUrls, ...htmlUrls]).filter(
    (u) => !u.startsWith(DATA_URL_PREFIX),
  );

  const mapping = new Map<string, string>();
  const skipped: string[] = [];
  for (const url of allUrls) {
    const bytes = await input.fetchAsset(url);
    if (!bytes) {
      skipped.push(url);
      continue;
    }
    mapping.set(url, `data:${mimeFromUrl(url)};base64,${bytesToBase64(bytes)}`);
  }

  return {
    html: rewriteHtmlImageSrcs(input.html, mapping),
    css: rewriteCssUrls(input.css, mapping),
    embedded: [...mapping.keys()],
    skipped,
  };
}

// ----- internals ----------------------------------------------------------

function matchAll(s: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) {
    out.push(m);
    // Defensively bump lastIndex on zero-width matches (shouldn't fire
    // for our patterns but guards against pathological inputs).
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function uniqueOrdered(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
