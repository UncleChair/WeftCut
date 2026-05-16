/// Phase A.4 — window-active layer selector for the DOM preview.
///
/// Walks the project's tracks, returns layer IDs whose
/// `[t_start_us, t_end_us]` overlaps `[clock - LOOKBEHIND, clock + LOOKAHEAD]`,
/// and renders one `<Layer>` per active id. Driven by the engine's
/// `onTimeUpdate` (throttled to ~30 Hz inside PlaybackEngine).
///
/// Why a window rather than mount-on-enter (`docs/preview-dom.md` Q6.1):
/// `<video>` elements take 100–500 ms to initialize a decoder + seek.
/// Pre-mounting the next clip while the current one is still playing
/// hides the cold-start; mount-on-enter would flash black at every cut.
///
/// Set-equality short-circuit: the engine fires `onTimeUpdate` ~30×/s,
/// but the active set only changes when a layer's window edge crosses
/// the playhead boundary. Comparing the new id list against the prior
/// one and short-circuiting on equality keeps React re-renders to that
/// rate.

import { useCallback, useEffect, useRef, useState } from "react";

import { useProjectStore } from "../../state/projectStore";
import type { TrackSummary } from "../../ipc";
import type { AudioGraph } from "./audio/AudioGraph";
import { Layer } from "./Layer";
import type { PlaybackEngine } from "./PlaybackEngine";

/// How far behind the playhead we keep a layer mounted after its
/// `t_end_us` passes. Allows immediate reverse-scrubs across a cut
/// without re-mounting.
const LOOKBEHIND_US = 500_000;

/// How far ahead of the playhead we pre-mount upcoming layers so
/// their decoders are warm by the time the cut arrives.
const LOOKAHEAD_US = 2_000_000;

interface Props {
  engine: PlaybackEngine;
  audioGraph: AudioGraph | null;
}

export function LiveLayers({ engine, audioGraph }: Props) {
  const tracks = useProjectStore((s) => s.summary?.tracks);
  const layerById = useProjectStore((s) => s.layerById);
  /// IDs of layers currently mounted. Sorted by render-order (back to
  /// front) so React reconciles a stable list when the active set
  /// changes.
  const [activeIds, setActiveIds] = useState<string[]>([]);
  /// Latest masterUs from the engine. Held in a ref so recompute()
  /// can recombine with tracks-changes without ping-ponging state.
  const lastMasterUsRef = useRef<number>(0);
  const activeIdsRef = useRef<string[]>([]);

  const recompute = useCallback(() => {
    const t = tracks;
    if (!t) {
      if (activeIdsRef.current.length === 0) return;
      activeIdsRef.current = [];
      setActiveIds([]);
      return;
    }
    const masterUs = lastMasterUsRef.current;
    const lo = masterUs - LOOKBEHIND_US;
    const hi = masterUs + LOOKAHEAD_US;
    const next = collectActive(t, lo, hi);
    if (sameIdList(activeIdsRef.current, next)) return;
    activeIdsRef.current = next;
    setActiveIds(next);
  }, [tracks]);

  // Subscribe to engine ticks. Throttled by PlaybackEngine to ~30 Hz,
  // which is fine for window membership changes (they're driven by
  // playhead crossings, not frame-by-frame).
  useEffect(() => {
    const unsub = engine.onTimeUpdate((masterUs) => {
      lastMasterUsRef.current = masterUs;
      recompute();
    });
    return unsub;
  }, [engine, recompute]);

  // When tracks change (layer added / removed / moved / trimmed),
  // re-evaluate the window using the last-known master time.
  useEffect(() => {
    recompute();
  }, [tracks, recompute]);

  return (
    <>
      {activeIds.map((id) => {
        const layer = layerById.get(id);
        if (!layer) return null;
        return (
          <Layer
            key={id}
            layer={layer}
            engine={engine}
            audioGraph={audioGraph}
          />
        );
      })}
    </>
  );
}

/// Walk all tracks → layers and collect IDs whose visibility window
/// overlaps `[lo, hi]`. Render order = tracks ASC, within each
/// track layers in declaration order. In DOM stacking that means
/// `tracks[0].layers[0]` renders deepest (behind everything); the
/// last layer of the last track renders on top.
///
/// For typical projects this is O(layer_count) per call. With ~30
/// calls/sec capped by the engine throttle and realistic projects
/// staying under a few hundred layers, the cost is negligible.
function collectActive(
  tracks: readonly TrackSummary[],
  lo: number,
  hi: number,
): string[] {
  const out: string[] = [];
  for (const t of tracks) {
    if (!t.enabled) continue;
    for (const layer of t.layers) {
      if (!layer.enabled) continue;
      // Overlap test: window [lo, hi] overlaps layer [t_start, t_end]
      // iff t_start < hi && t_end > lo.
      if (layer.t_start_us < hi && layer.t_end_us > lo) {
        out.push(layer.id);
      }
    }
  }
  return out;
}

/// Strict same-elements-same-order comparison. The set-of-IDs change
/// is rare; this short-circuit is the difference between 30 React
/// re-renders/sec and 1 every few seconds.
function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
