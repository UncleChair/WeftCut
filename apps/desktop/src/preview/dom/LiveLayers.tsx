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
///
/// **Html-render groups** (`docs/html-render-groups.md`): when a layer
/// is a member of a group whose effect chain has any enabled
/// `HtmlTransform` (or other html-required effect), the layer is
/// **not** rendered individually. Instead, on the first active member
/// encountered, one `<HtmlGroup>` is emitted at that position in the
/// render order. Subsequent active members of the same group are
/// skipped. The composition inside the html-group renders all its
/// members as a single shadow-DOM-mounted artifact whose
/// `#composition` transform interpolates per-frame from the
/// HtmlTransform's keyframes.

import { useCallback, useEffect, useRef, useState } from "react";

import { useProjectStore } from "../../state/projectStore";
import type { GroupSummary, TrackSummary } from "../../ipc";
import type { AudioGraph } from "./audio/AudioGraph";
import { HtmlGroup } from "./HtmlGroup";
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

/// One "thing" rendered in the preview surface — either a single layer
/// or an html-render group (which collapses several layers into one
/// composition).
type RenderUnit =
  | { kind: "layer"; layerId: string }
  | { kind: "html-group"; groupId: string };

export function LiveLayers({ engine, audioGraph }: Props) {
  const tracks = useProjectStore((s) => s.summary?.tracks);
  const groups = useProjectStore((s) => s.summary?.groups);
  const layerById = useProjectStore((s) => s.layerById);
  /// Render units currently mounted. Sorted by render-order (back to
  /// front) so React reconciles a stable list when the active set
  /// changes.
  const [activeUnits, setActiveUnits] = useState<RenderUnit[]>([]);
  /// Latest masterUs from the engine. Held in a ref so recompute()
  /// can recombine with tracks-changes without ping-ponging state.
  const lastMasterUsRef = useRef<number>(0);
  const activeUnitsRef = useRef<RenderUnit[]>([]);

  const recompute = useCallback(() => {
    const t = tracks;
    if (!t) {
      if (activeUnitsRef.current.length === 0) return;
      activeUnitsRef.current = [];
      setActiveUnits([]);
      return;
    }
    const masterUs = lastMasterUsRef.current;
    const lo = masterUs - LOOKBEHIND_US;
    const hi = masterUs + LOOKAHEAD_US;
    const next = collectActive(t, groups ?? [], lo, hi);
    if (sameUnits(activeUnitsRef.current, next)) return;
    activeUnitsRef.current = next;
    setActiveUnits(next);
  }, [tracks, groups]);

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

  // When tracks/groups change (layer added / removed / moved / trimmed,
  // group created / dissolved / render-mode toggled), re-evaluate.
  useEffect(() => {
    recompute();
  }, [tracks, groups, recompute]);

  return (
    <>
      {activeUnits.map((u) => {
        if (u.kind === "html-group") {
          return <HtmlGroup key={`hg:${u.groupId}`} groupId={u.groupId} engine={engine} />;
        }
        const layer = layerById.get(u.layerId);
        if (!layer) return null;
        return (
          <Layer
            key={u.layerId}
            layer={layer}
            engine={engine}
            audioGraph={audioGraph}
          />
        );
      })}
    </>
  );
}

/// Walk all tracks → layers and collect render units whose visibility
/// window overlaps `[lo, hi]`. Render order = tracks ASC, within each
/// track layers in declaration order.
///
/// **Html-mode groups** (`docs/html-render-groups.md`): a layer that's
/// a member of an `Html`-mode group is replaced in the render order by
/// one `{ kind: "html-group", groupId }` entry at the position of the
/// group's first encountered member. Subsequent members of the same
/// group are skipped (the composition renders them collectively).
///
/// For typical projects this is O(layer_count + group_count) per call.
/// With ~30 calls/sec capped by the engine throttle and realistic
/// projects staying under a few hundred layers, the cost is negligible.
function collectActive(
  tracks: readonly TrackSummary[],
  groups: readonly GroupSummary[],
  lo: number,
  hi: number,
): RenderUnit[] {
  // Index: which html-rendered group does each layer belong to? A
  // group is html-rendered iff its own effect chain OR any of its
  // enabled member layers' effect chains has any enabled effect
  // whose kind requires html-cap (today: HtmlTransform). The member
  // case lets a per-layer HtmlTransform flip the containing group
  // into html-cap rendering without the group itself needing an
  // effect — mirrors Rust `group_requires_html` in state/group.rs.
  const layerHtml = new Map<string, boolean>();
  for (const t of tracks) {
    for (const l of t.layers) {
      if (l.effects?.some((e) => e.enabled && e.params.kind === "HtmlTransform")) {
        layerHtml.set(l.id, true);
      }
    }
  }
  const htmlGroupByLayer = new Map<string, string>();
  for (const g of groups) {
    const requiresHtml =
      g.effects.some((e) => e.enabled && e.params.kind === "HtmlTransform") ||
      g.layer_ids.some((lid) => layerHtml.get(lid) === true);
    if (!requiresHtml) continue;
    for (const lid of g.layer_ids) htmlGroupByLayer.set(lid, g.id);
  }

  const out: RenderUnit[] = [];
  const emittedHtmlGroups = new Set<string>();
  for (const t of tracks) {
    if (!t.enabled) continue;
    for (const layer of t.layers) {
      if (!layer.enabled) continue;
      // Overlap test: window [lo, hi] overlaps layer [t_start, t_end]
      // iff t_start < hi && t_end > lo.
      if (!(layer.t_start_us < hi && layer.t_end_us > lo)) continue;

      const groupId = htmlGroupByLayer.get(layer.id);
      if (groupId) {
        if (!emittedHtmlGroups.has(groupId)) {
          out.push({ kind: "html-group", groupId });
          emittedHtmlGroups.add(groupId);
        }
        // Subsequent members of the same group are part of its
        // composition — don't emit them individually.
        continue;
      }
      out.push({ kind: "layer", layerId: layer.id });
    }
  }
  return out;
}

/// Strict same-elements-same-order comparison for the render-unit list.
/// The set rarely changes; this short-circuit is the difference between
/// ~30 React re-renders/sec and 1 every few seconds.
function sameUnits(a: readonly RenderUnit[], b: readonly RenderUnit[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai.kind !== bi.kind) return false;
    if (ai.kind === "layer" && bi.kind === "layer" && ai.layerId !== bi.layerId) return false;
    if (ai.kind === "html-group" && bi.kind === "html-group" && ai.groupId !== bi.groupId) return false;
  }
  return true;
}
