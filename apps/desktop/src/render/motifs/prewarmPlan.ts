export interface PrewarmContent {
  cacheKey: string;
  /// Content frame at the current playhead (0-based; clamped to the content).
  contentFrame: number;
  contentDurationFrames: number;
}

export interface PrewarmTarget {
  cacheKey: string;
  frame: number;
}

/// Plan which (cacheKey, frame) to ensure cached, in priority order. Dedups
/// contents by cacheKey; each unique content gets a per-content budget =
/// floor(cap / uniqueContentCount) (>= 1), or the WHOLE content when it fits.
/// Per content the order is playhead-first: contentFrame, then forward to the
/// budget edge, then the earlier frames (backfill for small backward scrubs).
/// Contents are ROUND-ROBINED so one long content can't starve others. The
/// union never exceeds `cap`, so the cache LRU can't evict a still-targeted
/// frame.
export function planPrewarmTargets(
  contents: PrewarmContent[],
  cap: number,
): PrewarmTarget[] {
  const seen = new Set<string>();
  const uniq: PrewarmContent[] = [];
  for (const c of contents) {
    if (seen.has(c.cacheKey)) continue;
    seen.add(c.cacheKey);
    uniq.push(c);
  }
  if (uniq.length === 0) return [];
  const budget = Math.max(1, Math.floor(cap / uniq.length));

  const perContent: number[][] = uniq.map((c) => {
    const n = c.contentDurationFrames;
    const want = Math.min(budget, n);
    const start = Math.max(0, Math.min(c.contentFrame, n - 1));
    const order: number[] = [];
    for (let f = start; f < n && order.length < want; f++) order.push(f);   // current → forward
    for (let f = 0; f < start && order.length < want; f++) order.push(f);   // backfill earlier
    return order;
  });

  const out: PrewarmTarget[] = [];
  const maxLen = perContent.reduce((m, a) => Math.max(m, a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (let c = 0; c < uniq.length; c++) {
      const frames = perContent[c]!;
      if (i < frames.length) out.push({ cacheKey: uniq[c]!.cacheKey, frame: frames[i]! });
    }
  }
  return out;
}
