// Pending (uncommitted) Motif props, per layer — the preview lane for a Motif's
// own params page. A page previewing a drag writes here instead of the state
// actor: no command, no history entry, no project mutation. The render path
// reads it at `motifFrameDescriptor`'s canonicalization choke point, so the
// overlay reaches BOTH the rasterized frame and the frame cache key, and the
// preview cannot be mistaken for a committed value anywhere downstream.
//
// The overlay is a PATCH, not a replacement: only the keys the page is actively
// dragging live here, layered over the layer's committed props. A commit clears
// the keys it landed, so the moment the actor's value arrives the overlay is
// already out of the way.

/// layerId → pending prop patch. Empty patches are removed, so `size === 0`
/// means "nothing is previewing" and the render path costs one Map lookup.
const pending = new Map<string, Record<string, unknown>>();

const subscribers = new Set<() => void>();

/// Subscribe to overlay changes. The preview host rides this to re-arm the
/// Motif sprites and recomposite — the same signal path a catalog change uses,
/// because a preview mutates no project state and so moves no `summary`.
export function subscribeMotifPreview(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function notify(): void {
  for (const cb of subscribers) cb();
}

/// Merge a patch into the layer's pending props. Keys not in `patch` keep their
/// current pending value — a page may drag one control while another stays
/// parked mid-gesture. A no-op patch (same keys, same values) does NOT notify,
/// so a page re-sending an unchanged value costs no recapture.
export function setMotifPreviewProps(layerId: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const current = pending.get(layerId);
  if (current && keys.every((k) => k in current && Object.is(current[k], patch[k]))) return;
  pending.set(layerId, { ...current, ...patch });
  notify();
}

/// Drop pending props for a layer. `keys` omitted clears the whole layer
/// (panel teardown); given, clears just those keys (a commit landing them).
export function clearMotifPreviewProps(layerId: string, keys?: readonly string[]): void {
  const current = pending.get(layerId);
  if (!current) return;
  if (!keys) {
    pending.delete(layerId);
    notify();
    return;
  }
  const present = keys.filter((k) => k in current);
  if (present.length === 0) return;
  const next = { ...current };
  for (const k of present) delete next[k];
  if (Object.keys(next).length === 0) pending.delete(layerId);
  else pending.set(layerId, next);
  notify();
}

/// The layer's pending patch, or null. Read-only view — callers must not mutate.
export function motifPreviewProps(layerId: string): Record<string, unknown> | null {
  return pending.get(layerId) ?? null;
}

/// Layer a pending patch over committed props. Returns `props` UNCHANGED (same
/// object identity) when nothing is pending, which is the steady state — the
/// render path allocates only while a gesture is live.
export function overlayMotifProps(
  layerId: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  if (pending.size === 0) return props;
  const patch = pending.get(layerId);
  return patch ? { ...props, ...patch } : props;
}

/// Drop every layer's pending props. Test teardown, and any host-level reset.
export function resetMotifPreview(): void {
  if (pending.size === 0) return;
  pending.clear();
  notify();
}
