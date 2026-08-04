// Timeline in/out points — the range the user marks on the timeline and the
// export then runs over.
//
// Session state, deliberately NOT persisted, for the same reason the playhead
// isn't: a range is where you are in a work session, not a property of the
// project. Persisting it would cost a schema version, a `parseProject`
// backfill, and a Rust wire-contract field to record something the user
// re-marks in two keystrokes.
//
// A module-level store rather than App state because both readers sit off
// App's props chain — the Quick Actions strip is a Dock Panel, and the ruler
// marks must not re-render the timeline tree. Same shape as `toolStore.ts`.
//
// React subscribers must use the ATOMIC selector hooks below (per
// `feedback_zustand_composite_selector` — never select a composite object).

import { useEffect, useState } from "react";
import { create } from "zustand";

interface State {
  /// First INCLUDED microsecond, or null when unmarked. On the composition
  /// frame grid: callers translate a playhead anchor through
  /// `displayedFrameStartUs` before storing.
  inUs: number | null;
  /// EXCLUSIVE end microsecond, or null when unmarked. Callers bridge the
  /// frame-anchor/exclusive gap with `inclusiveOutBoundaryUs` — never a bare
  /// `+1` (see `frames.ts`).
  outUs: number | null;
}

export const useRangeStore = create<State>(() => ({ inUs: null, outUs: null }));

/**
 * Mark the in point.
 *
 * Marking past the current out point CLEARS the out point rather than clamping
 * it. Clamping would invent a boundary the user never chose and then export it
 * silently; dropping the end that no longer makes sense states plainly that
 * there is one point marked, not a reversed range. Same rule mirrored in
 * `setRangeOut`.
 */
export function setRangeIn(inUs: number): void {
  const { outUs } = useRangeStore.getState();
  useRangeStore.setState({
    inUs,
    outUs: outUs !== null && outUs <= inUs ? null : outUs,
  });
}

/// Mark the out point (exclusive). Marking before the current in point clears
/// the in point — see `setRangeIn`.
export function setRangeOut(outUs: number): void {
  const { inUs } = useRangeStore.getState();
  useRangeStore.setState({
    outUs,
    inUs: inUs !== null && inUs >= outUs ? null : inUs,
  });
}

export function clearRange(): void {
  useRangeStore.setState({ inUs: null, outUs: null });
}

/// Imperative reads for event-time callers (shortcut handlers, the export
/// dialog's range resolver) that must not subscribe.
export function rangeInUs(): number | null {
  return useRangeStore.getState().inUs;
}

export function rangeOutUs(): number | null {
  return useRangeStore.getState().outUs;
}

export function hasMarkedRange(): boolean {
  const { inUs, outUs } = useRangeStore.getState();
  return inUs !== null || outUs !== null;
}

export const useRangeInUs = (): number | null => useRangeStore((s) => s.inUs);
export const useRangeOutUs = (): number | null => useRangeStore((s) => s.outUs);
/// Derived but still atomic — the selector returns a boolean, so a subscriber
/// that only cares WHETHER a range exists doesn't re-render when it moves.
export const useHasMarkedRange = (): boolean =>
  useRangeStore((s) => s.inUs !== null || s.outUs !== null);

/// How long the out-of-range treatment stays up after a mark changes.
export const RANGE_REVEAL_MS = 900;

/**
 * True for a moment after the range last changed.
 *
 * Drives the out-of-range dimming, which is deliberately NOT permanent: it is
 * a full-width wash over the user's clips serving a feature used twice a
 * session, so it reads as operation FEEDBACK ("the span I just changed is
 * this one") rather than as standing chrome. What survives between marks is
 * the ruler's end caps, which cost no lane pixels.
 *
 * Re-marking the same point still re-triggers, because the mutators always
 * write — a second `I` at one playhead is a deliberate re-confirmation, and
 * flashing the span back is the right answer to it.
 */
export function useRangeReveal(durationMs: number = RANGE_REVEAL_MS): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useRangeStore.subscribe(() => {
      setRevealed(true);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setRevealed(false);
      }, durationMs);
    });
    return () => {
      unsub();
      if (timer !== null) clearTimeout(timer);
    };
  }, [durationMs]);
  return revealed;
}

/**
 * The concrete span a half-marked range means, or null when nothing is marked.
 *
 * One end alone is a complete instruction in every NLE — an in point with no
 * out means "from here to the end" — so the missing side resolves against the
 * composition rather than being treated as an incomplete range. Kept a pure
 * function of (range, duration) because the store has no business knowing the
 * project's length.
 *
 * Returns null for a degenerate result instead of falling back to the whole
 * composition: a caller that silently widens a range the user narrowed is the
 * exact failure this feature exists to prevent.
 */
export function resolveMarkedRange(
  inUs: number | null,
  outUs: number | null,
  durationUs: number,
): { startUs: number; endUs: number } | null {
  if (inUs === null && outUs === null) return null;
  if (!Number.isFinite(durationUs) || durationUs <= 0) return null;
  const startUs = Math.max(0, Math.min(inUs ?? 0, durationUs));
  const endUs = Math.max(0, Math.min(outUs ?? durationUs, durationUs));
  if (endUs <= startUs) return null;
  return { startUs, endUs };
}
