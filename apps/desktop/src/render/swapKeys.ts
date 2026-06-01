/// Synthetic decoder-pool keys for an in-flight no-flash source-swap.
///
/// The preview pool keys handles by `layerId` and shares a `SourceMedia`
/// (with an immutable URL) by `mediaId`. To spin up a SECOND handle on a new
/// URL for the same source — without disturbing the original that's still on
/// screen — we acquire under derived keys: a fresh `layerId` so the pool
/// builds a new handle, and a fresh `mediaId` so it builds a new `SourceMedia`
/// on the new URL rather than reusing the original's.
///
/// A source swaps original→proxy at most once (the proxy is terminal), so a
/// stable `#swap` suffix is collision-free: distinct sources keep distinct
/// keys, and two clips of the same source correctly share one swap
/// `SourceMedia` (refcounted by the pool).
export function swapKeys(
  layerId: string,
  mediaId: string,
): { swapLayerId: string; swapMediaId: string } {
  return { swapLayerId: `${layerId}#swap`, swapMediaId: `${mediaId}#swap` };
}
