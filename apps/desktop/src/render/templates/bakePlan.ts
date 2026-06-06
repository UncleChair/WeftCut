export interface BakeContent {
  cacheKey: string;
  /// Content frame at the current playhead (0-based; clamped to the content).
  contentFrame: number;
  contentDurationFrames: number;
}

export interface BakeTarget {
  cacheKey: string;
  frame: number;
}

/// Plan every (cacheKey, frame) to persist to disk, in priority order. Unlike
/// `planPrewarmTargets` this is NOT capped — disk holds the whole content. Per
/// content the order is playhead-first: contentFrame → forward → backfill
/// earlier. Contents dedup by cacheKey and round-robin so one long content
/// can't starve others. `isOnDisk(cacheKey, frame)` drops already-baked frames
/// so a resumed/partial bake doesn't redo work.
export function planBakeTargets(
  contents: BakeContent[],
  isOnDisk: (cacheKey: string, frame: number) => boolean,
): BakeTarget[] {
  const seen = new Set<string>();
  const uniq: BakeContent[] = [];
  for (const c of contents) {
    if (seen.has(c.cacheKey)) continue;
    seen.add(c.cacheKey);
    uniq.push(c);
  }
  if (uniq.length === 0) return [];

  const perContent: number[][] = uniq.map((c) => {
    const n = c.contentDurationFrames;
    const start = Math.max(0, Math.min(c.contentFrame, n - 1));
    const order: number[] = [];
    for (let f = start; f < n; f++) {
      if (!isOnDisk(c.cacheKey, f)) order.push(f); // current → forward
    }
    for (let f = 0; f < start; f++) {
      if (!isOnDisk(c.cacheKey, f)) order.push(f); // backfill earlier
    }
    return order;
  });

  const out: BakeTarget[] = [];
  const maxLen = perContent.reduce((m, a) => Math.max(m, a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (let c = 0; c < uniq.length; c++) {
      const frames = perContent[c]!;
      if (i < frames.length) out.push({ cacheKey: uniq[c]!.cacheKey, frame: frames[i]! });
    }
  }
  return out;
}
