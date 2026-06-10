import { hashCacheKey } from "./frameCache";

/// Tracks which motif cacheKeys have at least one frame baked on disk, so
/// the read path can skip a per-frame `exists` IPC for never-baked content.
/// Membership is by RAW cacheKey; on-disk dirs are named by `hashCacheKey`,
/// so `hydrateFromHashes` maps a set of live cacheKeys onto the dir names a
/// `readDir(Cache/raster)` returned.
export class BakedKeyIndex {
  private keys = new Set<string>();
  /// The set of cacheKeys the caller considers "live" this project (active
  /// motif layers). Set by the Compositor before `hydrateFromHashes`.
  private liveCandidates: string[] = [];

  has(cacheKey: string): boolean {
    return this.keys.has(cacheKey);
  }

  /// Mark a cacheKey baked (called after a successful `writePng`).
  add(cacheKey: string): void {
    this.keys.add(cacheKey);
  }

  clear(): void {
    this.keys.clear();
  }

  /// Tell the index which cacheKeys are live this project (you can't reverse a
  /// hash, so hydration recomputes membership against these).
  setLiveCandidates(keys: string[]): void {
    this.liveCandidates = keys;
  }

  /// Replace the set: of the live candidates, keep those whose `hashCacheKey`
  /// is among the dir names found on disk. `hashOf` is injected for
  /// testability (defaults to the real `hashCacheKey`). A baked dir with no
  /// live key is an orphan GC reclaims; it never needs to be in this index.
  hydrateFromHashes(
    diskHashes: Set<string>,
    hashOf: (cacheKey: string) => string = hashCacheKey,
  ): void {
    this.keys.clear();
    for (const k of this.liveCandidates) {
      if (diskHashes.has(hashOf(k))) this.keys.add(k);
    }
  }
}
