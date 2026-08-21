// THE font authority: all runtime font acquisition — bundled bytes, OS
// resolution, and the hand-out-copies transfer policy — lives in this module.
// Don't grow private font loaders at use sites. Deliberate exception: motif
// capture host pages load their own fonts via explicit document.fonts.load
// (they run in a separate CDP browser context this module can't reach, and
// their explicit-load discipline carries the deterministic-capture guarantee).
//
// Bundled fonts are loaded into BOTH the preview Compositor (main thread,
// document.fonts) and the export Worker (self.fonts) so burned-in captions
// render identically — this carries the cross-OS determinism guarantee.
// Vite `?url` resolves each asset to a same-origin URL at build time.
import notoCjkUrl from "../../../../assets/fonts/NotoSansSC-VF.ttf?url";
import liberationUrl from "../../../../assets/fonts/LiberationSans-Regular.woff2?url";

export const BUNDLED_FONT_FAMILIES = ["Liberation Sans", "Noto Sans SC"] as const;

// Re-exported, not defined here: the main process stamps this family onto every
// new Text layer and cannot import from renderer/. See src/shared/fonts.ts.
export { DEFAULT_CAPTION_FONT_FAMILY } from "../../../shared/fonts";

const FONT_URLS: Record<string, string> = {
  "Liberation Sans": liberationUrl,
  "Noto Sans SC": notoCjkUrl,
};

/// Memoized fetch cache. Bundled fonts are immutable build assets, so each
/// realm (main thread and the export Worker import separate module instances)
/// pays the fetches once instead of twice per export. Reset on rejection so a
/// transient fetch failure doesn't poison the session — the next call retries.
let bundledFontBytesCache: Promise<Record<string, ArrayBuffer>> | null = null;

/// Fetch every bundled font's bytes. Used to FontFace-register them into a
/// face set (document.fonts for preview, self.fonts for the export Worker).
/// LANDMINE: always returns fresh copies of the cached buffers — the export
/// harness posts these to the Worker as TRANSFERABLES (runExport's
/// postMessage), which DETACHES the sender's copy. Handing out the cache
/// directly would detach it on the first export and silently blank the fonts
/// of every later export.
export async function loadBundledFontBytes(): Promise<Record<string, ArrayBuffer>> {
  if (!bundledFontBytesCache) {
    const p = fetchBundledFontBytes().catch((err: unknown) => {
      // Only clear if no newer attempt has replaced the slot meanwhile.
      if (bundledFontBytesCache === p) bundledFontBytesCache = null;
      throw err;
    });
    bundledFontBytesCache = p;
  }
  const cached = await bundledFontBytesCache;
  const out: Record<string, ArrayBuffer> = {};
  for (const [family, buf] of Object.entries(cached)) {
    out[family] = buf.slice(0);
  }
  return out;
}

async function fetchBundledFontBytes(): Promise<Record<string, ArrayBuffer>> {
  const out: Record<string, ArrayBuffer> = {};
  for (const [family, url] of Object.entries(FONT_URLS)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to load bundled font ${family}: ${res.status}`);
    out[family] = await res.arrayBuffer();
  }
  return out;
}

/// Per-family OS-resolution cache (main-thread realm). A session's verdict for
/// a family is stable, so hits cache the pristine bytes and misses cache the
/// null verdict — an absent font stops re-paying the IPC round-trip on every
/// export. Rejections reset the slot (a transient IPC failure must not poison
/// the session). Same hand-out-copies LANDMINE as the bundled cache above.
const resolvedFontCache = new Map<string, Promise<ArrayBuffer | null>>();

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
      let p = resolvedFontCache.get(leaf);
      if (!p) {
        const attempt: Promise<ArrayBuffer | null> = resolveOsFontBytes(leaf).catch((err: unknown) => {
          // Only clear if no newer attempt has replaced the slot meanwhile.
          if (resolvedFontCache.get(leaf) === attempt) resolvedFontCache.delete(leaf);
          throw err;
        });
        resolvedFontCache.set(leaf, attempt);
        p = attempt;
      }
      const pristine = await p;
      if (pristine) out[leaf] = pristine.slice(0);
    }
  }
  return out;
}

async function resolveOsFontBytes(leaf: string): Promise<ArrayBuffer | null> {
  const bytes = await window.api.font.resolve(leaf);
  if (bytes && bytes.byteLength > 0) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  return null;
}
