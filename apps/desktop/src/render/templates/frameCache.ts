// Per-frame raster cache for animated SVG templates.
//
// A template animates over its duration: each composition frame is a
// distinct `render(t)` rasterized to an `ImageBitmap`. This cache holds a
// SEQUENCE of frames per template instance, keyed by `(cacheKey, frameIndex)`
// — distinct from a single-bitmap-per-template cache, which the old
// foreignObject path used before the SVG render redesign.
//
// Two layers:
//
//   L0 (default, must-have) — an in-RAM, bounded LRU of per-frame
//   `ImageBitmap`s. This is what preview pulls on-demand while
//   scrubbing. Evicted bitmaps are `.close()`d so their GPU-side
//   backing is freed promptly rather than waiting on GC.
//
//   L2 (opt-in, lighter) — a PNG frame sequence persisted to disk
//   under `<workspace>/Cache/raster/<hash>/<i>.png`. Manual per-layer
//   enable only in v1, so this is an interface the later sprite /
//   export code calls — NOT on the default preview path. See the
//   "L2 disk persistence" section for the fs-capability caveat.
//
// `cacheKey` is an opaque STRING the caller builds from
// `(templateId, version, canonicalPropsJSON, renderW, renderH,
// fpsNum, fpsDen, durationFrames)`. The cache never parses it; it only
// hashes it (for the L2 dir name) and uses it as the L0 key prefix.

/// Minimal contract the L0 store needs from a cached frame. The browser
/// `ImageBitmap` satisfies this; a vitest can pass `{ close: vi.fn() }`.
/// Typing the store this way is what makes the LRU / recency / eviction
/// logic unit-testable in Node, where `ImageBitmap` doesn't exist.
export interface Closeable {
  close(): void;
}

const DEFAULT_MAX_FRAMES = 240;

/// Composite L0 map key. `frameIndex` is appended after a `#`; callers'
/// cacheKeys are JSON and may themselves contain `#`, so any code that
/// splits a key back into `(cacheKey, frameIndex)` must anchor on the
/// LAST `#` and require an all-digit suffix — see `keyMatchesCacheKey`.
///
/// `frameIndex` MUST be a non-negative integer: a negative or fractional
/// index would stringify to a non-digit suffix (`#-1`, `#1.5`) that
/// `keyMatchesCacheKey` rejects, so the entry would be unreachable by
/// `hasKey`/`clearKey` — a silent leak. Reject it at the boundary instead.
function frameMapKey(cacheKey: string, frameIndex: number): string {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error(
      `TemplateFrameCache: frameIndex must be a non-negative integer, got ${frameIndex}`,
    );
  }
  return `${cacheKey}#${frameIndex}`;
}

/// True when `mapKey` is a frame of `cacheKey`. Guards against the
/// prefix-collision hazard: cacheKey "a" must NOT match "a#b"'s frame
/// "a#b#5". We require `mapKey === cacheKey + "#" + <digits>`, i.e. the
/// `#` we split on is the LAST one and everything after it is a frame
/// index. (cacheKeys can contain `#`; frame indices are always digits.)
function keyMatchesCacheKey(mapKey: string, cacheKey: string): boolean {
  const hashAt = mapKey.lastIndexOf("#");
  if (hashAt < 0) return false;
  if (mapKey.slice(0, hashAt) !== cacheKey) return false;
  const suffix = mapKey.slice(hashAt + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

export class TemplateFrameCache {
  /// Insertion-ordered store. JS `Map` preserves insertion order, which
  /// we exploit for LRU: the FIRST key is the least-recently-used, the
  /// LAST is the most-recent. `get` and `set` both move a touched entry
  /// to the tail (delete + re-insert) so recency stays accurate.
  private readonly store = new Map<string, Closeable>();
  private readonly maxFrames: number;

  constructor(maxFrames: number = DEFAULT_MAX_FRAMES) {
    // Guard against a zero/negative cap silently disabling the cache. A NaN
    // cap is especially dangerous: `store.size > NaN` is always false, so
    // eviction would never fire and the cache would grow unbounded — fall back
    // to the default in that case rather than clamping NaN (Math.max(1, NaN) is
    // NaN). Non-integer caps floor to a sane bound.
    this.maxFrames = Number.isFinite(maxFrames)
      ? Math.max(1, Math.floor(maxFrames))
      : DEFAULT_MAX_FRAMES;
  }

  // ----------------------------------------------------------------
  // L0 — in-RAM LRU of per-frame ImageBitmaps
  // ----------------------------------------------------------------

  /// Return the cached frame, or null on miss. A hit refreshes recency
  /// (the entry moves to the MRU end), so a frame the preview keeps
  /// hitting won't be evicted out from under it.
  getFrame(cacheKey: string, frameIndex: number): ImageBitmap | null {
    const k = frameMapKey(cacheKey, frameIndex);
    const bmp = this.store.get(k);
    if (bmp === undefined) return null;
    // Refresh recency: delete + re-insert moves it to the tail.
    this.store.delete(k);
    this.store.set(k, bmp);
    return bmp as ImageBitmap;
  }

  /// Insert a frame, or keep the bitmap already cached for this (key, frame).
  /// A given (cacheKey, frameIndex) is deterministic — same template, props,
  /// size, fps, content-duration and absolute content frame — so a concurrent
  /// re-raster (e.g. several same-config template layers cold-missing on
  /// project reopen) produces an IDENTICAL image. Keep the existing bitmap (a
  /// live sprite may have already bound it) and close the redundant incoming
  /// one; return the CANONICAL cache-owned bitmap the caller should bind. This
  /// makes the write idempotent so a sibling sprite never has its bound bitmap
  /// closed out from under it (which caused "External Image has been detached"
  /// on WebGPU upload). When the store exceeds `maxFrames`, the LRU frame is
  /// evicted and `.close()`d.
  ///
  /// @returns The canonical cache-owned bitmap for this (cacheKey, frameIndex):
  ///   `bmp` itself on first insert, or the EXISTING (possibly already-bound)
  ///   bitmap on a same-(key,frame) re-set (in which case `bmp` has been closed).
  setFrame(cacheKey: string, frameIndex: number, bmp: ImageBitmap): ImageBitmap {
    const k = frameMapKey(cacheKey, frameIndex);
    const prev = this.store.get(k);
    if (prev !== undefined) {
      // Keep the existing (possibly already-bound) bitmap; drop the redundant
      // incoming one. Refresh recency by re-inserting at the MRU tail.
      if (prev !== (bmp as unknown as Closeable)) bmp.close();
      this.store.delete(k);
      this.store.set(k, prev);
      return prev as unknown as ImageBitmap;
    }
    this.store.set(k, bmp as unknown as Closeable);
    this.evictToCapacity();
    return bmp;
  }

  /// Evict LRU entries until at most `maxFrames` remain, closing each.
  private evictToCapacity(): void {
    while (this.store.size > this.maxFrames) {
      // The first key in insertion order is the LRU victim.
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      const victim = this.store.get(oldest.value);
      this.store.delete(oldest.value);
      victim?.close();
    }
  }

  /// True when (cacheKey, frameIndex) is held, WITHOUT touching recency (unlike
  /// getFrame). The prewarmer uses this to skip already-cached targets so a peek
  /// can't reorder the LRU.
  hasFrame(cacheKey: string, frameIndex: number): boolean {
    return this.store.has(frameMapKey(cacheKey, frameIndex));
  }

  /// The max-frames cap (the prewarmer uses it as its warm budget).
  capacity(): number {
    return this.maxFrames;
  }

  /// True when at least one frame of `cacheKey` is currently held.
  hasKey(cacheKey: string): boolean {
    for (const k of this.store.keys()) {
      if (keyMatchesCacheKey(k, cacheKey)) return true;
    }
    return false;
  }

  /// Drop every frame of `cacheKey`, closing each bitmap. No-op when the
  /// key isn't present.
  clearKey(cacheKey: string): void {
    for (const k of Array.from(this.store.keys())) {
      if (keyMatchesCacheKey(k, cacheKey)) {
        const bmp = this.store.get(k);
        this.store.delete(k);
        bmp?.close();
      }
    }
  }

  /// Close every held bitmap and empty the store. Call on teardown.
  dispose(): void {
    for (const bmp of this.store.values()) bmp.close();
    this.store.clear();
  }

  /// Frames currently held across all keys, for diagnostics.
  size(): number {
    return this.store.size;
  }

  // ----------------------------------------------------------------
  // L2 — opt-in PNG frame sequence on disk
  //
  // Layout: `<workspace>/Cache/raster/<hash>/<i>.png`, where `<hash>` is
  // a stable hash of `cacheKey` (FNV-1a 32-bit, hex — see `hashCacheKey`).
  //
  // CAPABILITY CAVEAT: under the app's current Tauri capabilities the JS
  // fs plugin can only touch the temp dir + app-specific dirs (`fs:default`
  // = create/read-app-specific-dirs + deny-default, plus
  // `fs:allow-temp-write-recursive`). The workspace is a USER-CHOSEN
  // folder, so `mkdir`/`writeFile`/`readDir`/`remove`/`exists` against
  // `<workspace>/Cache/raster/...` are DENIED at runtime today. These
  // methods are implemented against the real fs plugin (no faking): a
  // genuine not-found yields null/no-op, but a permission denial is left
  // to surface as a thrown error rather than masked. To actually enable
  // L2, the app must grant `fs:allow-mkdir`, `fs:allow-write-file`,
  // `fs:allow-read-file`, `fs:allow-read-dir`, `fs:allow-remove`,
  // `fs:allow-exists` AND extend the runtime fs scope to cover the open
  // workspace path (e.g. Rust `app.fs_scope().allow_directory(ws, true)`
  // on project open — `default.json` alone can't express the dynamic
  // workspace path the way `allow-temp-write-recursive` ships a `$TEMP/**`
  // scope). The Tauri imports are loaded lazily so the L0 path never
  // pulls Tauri (keeps `frameCache.ts` Node-loadable for the unit test).
  // ----------------------------------------------------------------

  /// Read a persisted PNG frame, or null if it isn't on disk (or no
  /// project is open). Permission / IO errors other than not-found
  /// propagate.
  async readPng(cacheKey: string, frameIndex: number): Promise<Blob | null> {
    const dir = await rasterDirFor(cacheKey);
    if (dir === null) return null;
    const { join } = await import("@tauri-apps/api/path");
    const { readFile, exists } = await import("@tauri-apps/plugin-fs");
    const path = await join(dir, `${frameIndex}.png`);
    if (!(await exists(path))) return null;
    const bytes = await readFile(path);
    return new Blob([bytes], { type: "image/png" });
  }

  /// Persist a PNG frame, creating the `<hash>` dir as needed. No-op when
  /// no project is open (nowhere to anchor `<workspace>/Cache/`).
  async writePng(cacheKey: string, frameIndex: number, png: Blob): Promise<void> {
    const dir = await rasterDirFor(cacheKey);
    if (dir === null) return;
    const { join } = await import("@tauri-apps/api/path");
    const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
    await mkdir(dir, { recursive: true });
    const path = await join(dir, `${frameIndex}.png`);
    const bytes = new Uint8Array(await png.arrayBuffer());
    await writeFile(path, bytes);
  }

  /// Prune `Cache/raster/<hash>` dirs whose hash isn't referenced by any
  /// currently-active cacheKey. Used to reclaim disk after layers are
  /// deleted or their props/dims change (a new key → a new hash dir, the
  /// old one becomes unreferenced). A missing `Cache/raster` is treated
  /// as nothing-to-GC, not an error.
  async gcUnreferenced(activeCacheKeys: string[]): Promise<void> {
    const root = await rasterRootDir();
    if (root === null) return;
    const { readDir, remove, exists } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    if (!(await exists(root))) return;
    const live = new Set(activeCacheKeys.map(hashCacheKey));
    const entries = await readDir(root);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (live.has(entry.name)) continue;
      const dir = await join(root, entry.name);
      await remove(dir, { recursive: true });
    }
  }
}

/// `<workspace>/Cache/raster`, or null when no project is open.
async function rasterRootDir(): Promise<string | null> {
  const { workspaceDir } = await import("../../ipc");
  const ws = await workspaceDir();
  if (!ws) return null;
  const { join } = await import("@tauri-apps/api/path");
  return join(ws, "Cache", "raster");
}

/// `<workspace>/Cache/raster/<hash(cacheKey)>`, or null when no project
/// is open.
async function rasterDirFor(cacheKey: string): Promise<string | null> {
  const root = await rasterRootDir();
  if (root === null) return null;
  const { join } = await import("@tauri-apps/api/path");
  return join(root, hashCacheKey(cacheKey));
}

/// Stable hash of a cacheKey for use as an on-disk directory name.
///
/// FNV-1a-derived (32-bit), rendered as zero-padded 8-char lowercase
/// hex. Pure FNV-1a for ASCII keys; for non-ASCII code points (e.g.
/// zh-CN prop values) the UTF-16 unit's high byte is folded in too, so
/// it's a deterministic variant rather than textbook FNV-1a there.
/// Chosen for being tiny, dependency-free, and deterministic — the
/// dir name is JS-owned (`Cache/raster/` is not created by the Rust
/// `CacheLayout`), so it does NOT need to match Rust's blake3 scheme. A
/// 32-bit space is ample BECAUSE the number of live keys is tiny: only a
/// handful of distinct template-instance keys exist in one workspace, so
/// the birthday-bound collision probability against a 2^32 space is
/// negligible. (A collision would NOT be self-healing — two colliding keys
/// share the `<hash>` dir and their frame `<i>.png` files would CLOBBER each
/// other, since `0.png` means frame 0 of WHICHEVER key wrote last. The
/// safety here is the low key count, not the per-frame filenames.)
export function hashCacheKey(cacheKey: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < cacheKey.length; i++) {
    h ^= cacheKey.charCodeAt(i) & 0xff;
    // Mix high + low bytes too so non-ASCII code points still perturb the
    // hash; charCodeAt is a UTF-16 unit, so fold the upper byte in.
    h ^= (cacheKey.charCodeAt(i) >>> 8) & 0xff;
    // FNV prime multiply via shift-adds to stay in 32-bit int math.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
