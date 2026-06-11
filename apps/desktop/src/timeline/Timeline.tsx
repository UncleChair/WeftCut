import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  addMediaLayer,
  groupsCreate,
  groupsDissolve,
  moveLayer,
  separateAudioToNewTrack,
  splitLayerGrouped,
  trimLayer,
  viewStateGet,
  viewStateSet,
  type GroupSummary,
  type KeybindingsMap,
  type LayerSummary,
  type MediaSummary,
  type TrackSummary,
} from "../ipc";
import { mediaReadiness, type ProxyState } from "../panels/mediaReadiness";
import { snapFrameRound } from "../frames";
import {
  toggleDisplayMode,
  useDisplayMode,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "../settings/appSettingsStore";
import { useShortcuts, type OverrideMap } from "../shortcuts";
import { requestPrebake } from "../render/motifs/prebakeBus";
import {
  DEFAULT_PX_PER_SEC,
  DEFAULT_TRACK_HEIGHT,
  MAX_PX_PER_SEC,
  MAX_TRACK_HEIGHT,
  MIN_LAYER_DURATION_US,
  MIN_PX_PER_SEC_FLOOR,
  MIN_TRACK_HEIGHT,
  VIEW_SAVE_DEBOUNCE_MS,
  clamp,
  computeLayerSlices,
  indexGroups,
  visualOrderedTracks,
} from "./geometry";
import { TimelineRuler } from "./TimelineRuler";
import { LayerBlock, type DragState, type PendingLayerPlacement } from "./LayerBlock";

const MEDIA_DRAG_TYPE = "application/x-weftcut-media";

interface MediaDragPayload {
  mediaId: string;
  kind: string;
}

function parseMediaDrag(e: React.DragEvent): MediaDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (!raw) return null;
    return JSON.parse(raw) as MediaDragPayload;
  } catch {
    return null;
  }
}

// V.10 (A/B-roll v2): any media drops on any track. The function is
// kept as a stub returning true to minimise churn at call-sites; future
// cleanup can inline it away. Kind-based rejection logic is gone — the
// backend's V.2 overlap rule + V.5 kind-agnostic tracks accept any
// layer kind on any track.
function trackAcceptsMedia(_trackKind: string, _mediaKind: string): boolean {
  return true;
}


// Some media kinds (audio, subtitle) must live on a matching track kind for
// V.10: under v2 every drop lands on its target track directly (no
// auto-routing). The function was kept around for the few call-sites
// that compose `trackAcceptsMedia || trackAcceptsMediaForAutoRoute`;
// returning false here is a no-op since `trackAcceptsMedia` now
// returns true unconditionally.
function trackAcceptsMediaForAutoRoute(_trackKind: string, _mediaKind: string): boolean {
  return false;
}

interface HeightDragState {
  trackId: string;
  startY: number;
  startHeight: number;
}

interface TimelineProps {
  tracks: TrackSummary[];
  /// `docs/groups.md`. Empty array when no groups exist.
  groups: GroupSummary[];
  durationUs: number;
  currentTimeUs: number;
  selectedLayerId: string | null;
  /// R.7 (`docs/data-model.md`): when set, this hidden track is
  /// included in the AB-mode ordered list at its natural accretion
  /// slot. Cleared by the App when the user selects a layer on a
  /// different track, presses Esc, or the peek list dispatches a new
  /// reveal.
  revealedTrackId?: string | null;
  /// User-overridden keybindings, threaded through from App for the
  /// timeline-scoped `groupSelected` + `dissolveSelectedGroup`
  /// actions. Missing entries fall back to `ACTION_DEFS` defaults.
  keybindings: KeybindingsMap;
  /// Composition fps for frame-grid snapping of seek / drag / scrub
  /// targets. UI snaps eagerly so the ghost matches the actor's
  /// commit-side snap; actor remains the authoritative enforcement.
  fpsNum: number;
  fpsDen: number;
  /// Blade-tool mode (toggled at App level via the `C` shortcut). When
  /// true, layer clicks split at the click point instead of selecting,
  /// and the cursor turns into a razor. Stays on until the user toggles
  /// back off or presses Esc (handled here).
  bladeMode: boolean;
  /// Snapshot of the current media pool — used by `onMediaDrop` to
  /// validate readiness before lowering the drop to `addMediaLayer`.
  media: MediaSummary[];
  /// Media that are still copying into the workspace. Cards in this set
  /// are not interactive in the pool; the drop handler rejects them as
  /// defence in depth (e.g. status flipping mid-drag, future non-drag
  /// drop pathways).
  importing: ReadonlySet<string>;
  /// Per-video proxy lifecycle from `media:job_*`. Same defence-in-depth
  /// role at the drop site as `importing`.
  proxyState: ReadonlyMap<string, ProxyState>;
  onExitBlade: () => void;
  onSelect: (id: string | null) => void;
  onSeek: (tUs: number) => void;
  onMutated: () => Promise<void>;
}


export function Timeline({
  tracks,
  groups,
  durationUs,
  currentTimeUs,
  selectedLayerId,
  revealedTrackId,
  keybindings,
  fpsNum,
  fpsDen,
  bladeMode,
  media,
  importing,
  proxyState,
  onExitBlade,
  onSelect,
  onSeek,
  onMutated,
}: TimelineProps) {
  const [pxPerSec, setPxPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>({});
  // Suppress the initial post-load save: we don't want the first
  // load-then-set-state pair to immediately echo the same values back to
  // disk. Flipped to true only after the in-flight load completes.
  const viewLoadedRef = useRef<boolean>(false);

  const totalSec = Math.max(durationUs / 1_000_000, 5);
  const widthPx = totalSec * pxPerSec;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pendingPlacement, setPendingPlacement] =
    useState<PendingLayerPlacement | null>(null);
  const [heightDrag, setHeightDrag] = useState<HeightDragState | null>(null);
  // V.7: right-click context-menu state. `null` when closed; otherwise
  // anchors the menu at the cursor and stores the target layer id.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    layerKind: string;
  } | null>(null);
  /// `docs/groups.md` — multi-select for `Ctrl+G` and visual highlight.
  /// `selectedLayerId` (from App) is the primary (drives PropertyPanel);
  /// this set tracks every layer that should render with the selected
  /// chrome. Stays in sync via the click handlers below.
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const groupByLayerId = useMemo(() => indexGroups(groups), [groups]);

  // A/B-roll display mode comes from the app-level settings store
  // (`docs/data-model.md`). The store hydrates on app mount via
  // `wireAppSettingsStream`. Atomic selector — never include the rest of
  // the settings struct in a single selector (feedback_zustand_composite_
  // selector).
  const displayMode = useDisplayMode();
  const tailSnapEnabled = useTailSnapEnabled();
  const tailSnapStrengthPx = useTailSnapStrengthPx();

  const orderedTracks = useMemo(() => {
    const all = visualOrderedTracks(tracks);
    if (displayMode === "ShowAll") return all;
    // AB filter: keep role-stamped tracks. R.7 inline-reveal lets one
    // additional hidden track survive the filter at its natural
    // accretion slot — the visualOrderedTracks output already has the
    // slot computed, so we just need to keep that row alongside the
    // role-stamped ones.
    return all.filter(
      ({ track }) =>
        track.role !== null || track.id === (revealedTrackId ?? null),
    );
  }, [tracks, displayMode, revealedTrackId]);

  /// Map a click event on a layer chip to the resulting selection set.
  /// `docs/groups.md`: plain click on a grouped layer selects the
  /// whole group; `Alt+click` selects only the clicked layer (escape
  /// path); `Shift+click` extends the current selection (with the
  /// clicked layer's whole group if any).
  const selectFromClick = useCallback(
    (layerId: string, e: { altKey: boolean; shiftKey: boolean; metaKey: boolean }) => {
      const gid = groupByLayerId.get(layerId);
      const memberSet = (): Set<string> => {
        if (!gid || e.altKey) return new Set([layerId]);
        const g = groups.find((x) => x.id === gid);
        return new Set(g?.layer_ids ?? [layerId]);
      };
      if (e.shiftKey) {
        setSelectedLayerIds((prev) => {
          const next = new Set(prev);
          memberSet().forEach((id) => next.add(id));
          return next;
        });
      } else {
        setSelectedLayerIds(memberSet());
      }
      onSelect(layerId);
    },
    [groupByLayerId, groups, onSelect],
  );

  // Keep the visual set in sync if the primary selection changes from
  // outside (e.g. PropertyPanel click, agent op). Treat the external set
  // as plain-click semantics.
  useEffect(() => {
    if (selectedLayerId === null) {
      setSelectedLayerIds(new Set());
      return;
    }
    setSelectedLayerIds((prev) => {
      if (prev.has(selectedLayerId)) return prev;
      const gid = groupByLayerId.get(selectedLayerId);
      if (!gid) return new Set([selectedLayerId]);
      const g = groups.find((x) => x.id === gid);
      return new Set(g?.layer_ids ?? [selectedLayerId]);
    });
  }, [selectedLayerId, groupByLayerId, groups]);

  /// `docs/groups.md` — Mod+G groups the current multi-selection;
  /// Mod+Shift+G dissolves every group represented in the selection.
  /// Wired through the global `useShortcuts` registry (Phase H-followup
  /// 2026-05-17) so the Keyboard Shortcuts settings panel exposes them
  /// and they're rebindable. Handlers read state via refs to avoid the
  /// stale-closure trap of multi-key chord dispatch.
  const selectedLayerIdsRef = useRef(selectedLayerIds);
  selectedLayerIdsRef.current = selectedLayerIds;
  const groupByLayerIdRef = useRef(groupByLayerId);
  groupByLayerIdRef.current = groupByLayerId;
  const onMutatedRef = useRef(onMutated);
  onMutatedRef.current = onMutated;

  const shortcutOverrides = useMemo<OverrideMap>(
    () => keybindings as OverrideMap,
    [keybindings],
  );
  useShortcuts({
    overrides: shortcutOverrides,
    handlers: {
      groupSelected: async () => {
        const sel = selectedLayerIdsRef.current;
        if (sel.size < 2) return;
        try {
          await groupsCreate(Array.from(sel), null, false);
          await onMutatedRef.current();
        } catch (err) {
          console.error("groups_create failed:", err);
        }
      },
      dissolveSelectedGroup: async () => {
        const sel = selectedLayerIdsRef.current;
        if (sel.size < 1) return;
        const targetGroups = new Set<string>();
        sel.forEach((lid) => {
          const gid = groupByLayerIdRef.current.get(lid);
          if (gid) targetGroups.add(gid);
        });
        if (targetGroups.size === 0) return;
        try {
          for (const gid of targetGroups) {
            await groupsDissolve(gid);
          }
          await onMutatedRef.current();
        } catch (err) {
          console.error("groups_dissolve failed:", err);
        }
      },
    },
  });

  // Cumulative (y, height) per visible track row. Heights vary now, so
  // hit-testing for "which track is the pointer over" needs a real
  // offset table instead of `Math.floor(y / TRACK_HEIGHT)`.
  const trackRows = useMemo(() => {
    const rows: { track: TrackSummary; y: number; height: number }[] = [];
    let y = 0;
    for (const { track } of orderedTracks) {
      const h = trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT;
      rows.push({ track, y, height: h });
      y += h;
    }
    return rows;
  }, [orderedTracks, trackHeights]);

  const pendingLayer = useMemo(() => {
    if (!pendingPlacement) return null;
    for (const track of tracks) {
      const layer = track.layers.find(
        (candidate) => candidate.id === pendingPlacement.layerId,
      );
      if (layer) return layer;
    }
    return null;
  }, [pendingPlacement, tracks]);

  const dragLayer = useMemo(() => {
    if (!drag || drag.kind !== "move") return null;
    for (const track of tracks) {
      const layer = track.layers.find(
        (candidate) => candidate.id === drag.layerId,
      );
      if (layer) return layer;
    }
    return null;
  }, [drag?.kind, drag?.layerId, tracks]);

  useEffect(() => {
    if (!pendingPlacement) return;
    const track = tracks.find((t) => t.id === pendingPlacement.trackId);
    const layer = track?.layers.find((l) => l.id === pendingPlacement.layerId);
    if (
      layer &&
      layer.t_start_us === pendingPlacement.tStartUs &&
      layer.t_end_us === pendingPlacement.tEndUs
    ) {
      setPendingPlacement(null);
    }
  }, [pendingPlacement, tracks]);

  // -------- Initial load + debounced save --------

  // One-shot load on mount. The backend returns defaults pre-workspace
  // (blank-on-boot session), so this is safe to call unconditionally.
  useEffect(() => {
    let cancelled = false;
    viewStateGet()
      .then((state) => {
        if (cancelled) return;
        setPxPerSec(
          clamp(
            state.timeline_px_per_sec,
            MIN_PX_PER_SEC_FLOOR,
            MAX_PX_PER_SEC,
          ),
        );
        setTrackHeights(state.track_heights ?? {});
      })
      .catch((e) => {
        console.warn("view_state load failed:", e);
      })
      .finally(() => {
        if (!cancelled) viewLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced persist. Refs hold the latest values so the timer doesn't
  // need to restart with React's render cadence on every wheel tick.
  const pxPerSecRef = useRef(pxPerSec);
  const trackHeightsRef = useRef(trackHeights);
  // Latest project duration — the wheel handler reads this to compute
  // the "fit-to-viewport" min zoom each tick, so a project getting
  // longer (new clips added) immediately widens the wheel-out range.
  const durationUsRef = useRef(durationUs);
  useEffect(() => {
    pxPerSecRef.current = pxPerSec;
  }, [pxPerSec]);
  useEffect(() => {
    trackHeightsRef.current = trackHeights;
  }, [trackHeights]);
  useEffect(() => {
    durationUsRef.current = durationUs;
  }, [durationUs]);

  useEffect(() => {
    if (!viewLoadedRef.current) return;
    const handle = setTimeout(() => {
      // Prune dead track ids on save so view.json doesn't accumulate
      // entries for tracks the user has deleted (see advisor note: state
      // map keeps stale keys until we filter on the way out).
      const live = new Set(tracks.map((t) => t.id));
      const pruned: Record<string, number> = {};
      for (const [id, h] of Object.entries(trackHeightsRef.current)) {
        if (live.has(id)) pruned[id] = h;
      }
      viewStateSet({
        timeline_px_per_sec: pxPerSecRef.current,
        track_heights: pruned,
      }).catch((e) => console.warn("view_state save failed:", e));
    }, VIEW_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // `tracks` participates so a track-deletion triggers a save that
    // prunes the stale id even if neither zoom nor height changed.
  }, [pxPerSec, trackHeights, tracks]);

  // -------- Ctrl+wheel zoom (cursor-anchored) --------

  // We capture { scrollLeft, cursorXInViewport, oldPxPerSec } when the
  // wheel fires, kick off `setPxPerSec`, and apply the new scrollLeft
  // in a useLayoutEffect once React has re-rendered with the new
  // px/sec. Doing it inline in the handler reads stale state and
  // produces a one-frame jitter (advisor note #2).
  const wheelPendingRef = useRef<{
    scrollLeft: number;
    cursorXInViewport: number;
    oldPxPerSec: number;
  } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // React's JSX `onWheel` is registered passive in modern React, so
    // `preventDefault()` from there silently fails. Attach manually
    // with `{ passive: false }` so we can swallow the default
    // page-scroll behaviour when Ctrl is held.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const cursorXInViewport = e.clientX - rect.left;
      // deltaMode varies by device — normalise lines/pages to pixels
      // before computing the zoom factor (advisor note #3).
      const lineHeight = 16;
      const pageHeight = 100;
      const px =
        e.deltaY *
        (e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? pageHeight : 1);
      // Exponential zoom: small wheel ticks scale by ~ε near 1.0, big
      // ones don't snap-jump. Negative px (scrolling up) zooms in.
      const factor = Math.exp(-px * 0.001);
      const oldPxPerSec = pxPerSecRef.current;
      // Lower bound = "fit-to-viewport" zoom — the level at which the
      // whole timeline exactly fills the visible width. Beyond this
      // there's only empty space to the right of the content, so this
      // is the natural Ctrl+wheel stop for max zoom-out. Recomputed
      // every tick so it tracks viewport resize + project growth.
      const viewportWidth = root.clientWidth;
      const totalSec = Math.max(durationUsRef.current / 1_000_000, 5);
      const fitMin = Math.max(
        MIN_PX_PER_SEC_FLOOR,
        viewportWidth / totalSec,
      );
      const newPxPerSec = clamp(oldPxPerSec * factor, fitMin, MAX_PX_PER_SEC);
      if (newPxPerSec === oldPxPerSec) return;
      wheelPendingRef.current = {
        scrollLeft: root.scrollLeft,
        cursorXInViewport,
        oldPxPerSec,
      };
      setPxPerSec(newPxPerSec);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Re-anchor scroll position so the time under the cursor stays put.
  // Runs synchronously after the layout flip so there's no flash.
  useLayoutEffect(() => {
    const pending = wheelPendingRef.current;
    if (!pending) return;
    wheelPendingRef.current = null;
    const root = rootRef.current;
    if (!root) return;
    const ratio = pxPerSec / pending.oldPxPerSec;
    root.scrollLeft =
      (pending.scrollLeft + pending.cursorXInViewport) * ratio -
      pending.cursorXInViewport;
  }, [pxPerSec]);

  // -------- Layer drag (move / trim) --------

  const trackUnderPointer = useCallback(
    (clientY: number): TrackSummary | null => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const y = clientY - rect.top;
      for (const row of trackRows) {
        if (y >= row.y && y < row.y + row.height) return row.track;
      }
      return null;
    },
    [trackRows],
  );

  /// Snap a raw drag delta so the dragged edge / clip-start lands on
  /// a composition-frame boundary. Snapping the DESTINATION (not the
  /// delta itself) handles the case where the source value was
  /// already off-grid: we always end up on grid regardless of the
  /// pre-state. Returns the adjusted deltaUs.
  const snapDragDelta = useCallback(
    (kind: DragState["kind"], originalTStart: number, originalTEnd: number, rawDeltaUs: number): number => {
      const anchor = kind === "trim-end" ? originalTEnd : originalTStart;
      const snappedDest = snapFrameRound(anchor + rawDeltaUs, fpsNum, fpsDen);
      return snappedDest - anchor;
    },
    [fpsNum, fpsDen],
  );

  const snapMoveDeltaToClipBoundary = useCallback(
    (
      state: DragState,
      frameDeltaUs: number,
    ): number => {
      if (!tailSnapEnabled || state.kind !== "move") return frameDeltaUs;
      const desiredStart = Math.max(0, state.originalTStart + frameDeltaUs);
      const desiredEnd = Math.max(0, state.originalTEnd + frameDeltaUs);
      const thresholdUs = (Math.max(0, tailSnapStrengthPx) / pxPerSec) * 1_000_000;
      if (thresholdUs <= 0) return frameDeltaUs;

      const ignoredLayerIds = new Set<string>([state.layerId]);
      if (!state.escapeGroup) {
        const groupId = groupByLayerId.get(state.layerId);
        const group = groupId ? groups.find((g) => g.id === groupId) : null;
        for (const layerId of group?.layer_ids ?? []) {
          ignoredLayerIds.add(layerId);
        }
      }

      let bestDeltaUs: number | null = null;
      let bestDistanceUs = Number.POSITIVE_INFINITY;
      const considerDelta = (distanceUs: number, deltaUs: number) => {
        if (state.originalTStart + deltaUs < 0) return;
        if (distanceUs <= thresholdUs && distanceUs < bestDistanceUs) {
          bestDistanceUs = distanceUs;
          bestDeltaUs = deltaUs;
        }
      };
      const considerBoundary = (boundaryUs: number) => {
        const startDistanceUs = Math.abs(boundaryUs - desiredStart);
        considerDelta(startDistanceUs, boundaryUs - state.originalTStart);

        const endDistanceUs = Math.abs(boundaryUs - desiredEnd);
        considerDelta(endDistanceUs, boundaryUs - state.originalTEnd);
      };

      for (const { track } of orderedTracks) {
        for (const layer of track.layers) {
          if (ignoredLayerIds.has(layer.id)) continue;
          const boundaries = [
            snapFrameRound(layer.t_start_us, fpsNum, fpsDen),
            snapFrameRound(layer.t_end_us, fpsNum, fpsDen),
          ];
          for (const boundaryUs of boundaries) {
            considerBoundary(boundaryUs);
          }
        }
      }
      const playheadUs = snapFrameRound(currentTimeUs, fpsNum, fpsDen);
      considerBoundary(playheadUs);

      return bestDeltaUs === null ? frameDeltaUs : bestDeltaUs;
    },
    [
      currentTimeUs,
      fpsNum,
      fpsDen,
      groupByLayerId,
      groups,
      orderedTracks,
      pxPerSec,
      tailSnapEnabled,
      tailSnapStrengthPx,
    ],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const rawDeltaUs = (deltaPx / pxPerSec) * 1_000_000;
      const frameDeltaUs = snapDragDelta(
        drag.kind,
        drag.originalTStart,
        drag.originalTEnd,
        rawDeltaUs,
      );
      const overTrack =
        drag.kind === "move" ? trackUnderPointer(e.clientY) : null;
      const deltaUs = snapMoveDeltaToClipBoundary(drag, frameDeltaUs);
      setDrag({
        ...drag,
        deltaUs,
        overTrackId: overTrack?.id ?? null,
      });
    },
    [drag, pxPerSec, snapDragDelta, snapMoveDeltaToClipBoundary, trackUnderPointer],
  );

  const handlePointerUp = useCallback(
    async (e: PointerEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const rawDeltaUs = Math.round((deltaPx / pxPerSec) * 1_000_000);
      const frameDeltaUs = snapDragDelta(
        drag.kind,
        drag.originalTStart,
        drag.originalTEnd,
        rawDeltaUs,
      );
      const overTrack =
        drag.kind === "move" ? trackUnderPointer(e.clientY) : null;
      const deltaUs = snapMoveDeltaToClipBoundary(drag, frameDeltaUs);
      const committed = drag;
      setDrag(null);

      // Treat tiny deltas + same track as a no-op so a click doesn't accidentally
      // shove a layer one frame.
      const sameTrack =
        !overTrack || overTrack.id === committed.trackId;
      if (Math.abs(deltaUs) < 1_000 && sameTrack) return;

      try {
        // `docs/groups.md` — Alt-held at drag start opts the move /
        // trim out of group fanout for this single op.
        const escape = committed.escapeGroup;
        switch (committed.kind) {
          case "move": {
            const newStart = Math.max(0, committed.originalTStart + deltaUs);
            const newEnd =
              newStart + (committed.originalTEnd - committed.originalTStart);
            const destTrackId =
              overTrack && trackAcceptsForLayer(overTrack, committed)
                ? overTrack.id
                : committed.trackId;
            setPendingPlacement({
              layerId: committed.layerId,
              trackId: destTrackId,
              tStartUs: newStart,
              tEndUs: newEnd,
            });
            await moveLayer(committed.layerId, destTrackId, newStart, escape);
            break;
          }
          case "trim-start": {
            const newStart = Math.max(
              0,
              Math.min(
                committed.originalTStart + deltaUs,
                committed.originalTEnd - MIN_LAYER_DURATION_US,
              ),
            );
            await trimLayer(committed.layerId, "in", newStart, escape);
            break;
          }
          case "trim-end": {
            const newEnd = Math.max(
              committed.originalTStart + MIN_LAYER_DURATION_US,
              committed.originalTEnd + deltaUs,
            );
            await trimLayer(committed.layerId, "out", newEnd, escape);
            break;
          }
        }
        await onMutated();
      } catch (err) {
        setPendingPlacement(null);
        console.error("timeline commit failed:", err);
      }
    },
    [drag, onMutated, pxPerSec, snapDragDelta, snapMoveDeltaToClipBoundary, trackUnderPointer],
  );

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [drag, handlePointerMove, handlePointerUp]);

  // -------- Track-height drag --------

  const beginHeightDrag = useCallback(
    (trackId: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // The lane below the handle would normally start a seek; stop the
      // pointerdown here so the seek-on-empty-canvas path never fires.
      e.stopPropagation();
      e.preventDefault();
      const current =
        trackHeightsRef.current[trackId] ?? DEFAULT_TRACK_HEIGHT;
      setHeightDrag({
        trackId,
        startY: e.clientY,
        startHeight: current,
      });
    },
    [],
  );

  useEffect(() => {
    if (!heightDrag) return;
    const onMove = (e: PointerEvent) => {
      const dy = e.clientY - heightDrag.startY;
      const next = clamp(
        Math.round(heightDrag.startHeight + dy),
        MIN_TRACK_HEIGHT,
        MAX_TRACK_HEIGHT,
      );
      setTrackHeights((prev) =>
        prev[heightDrag.trackId] === next
          ? prev
          : { ...prev, [heightDrag.trackId]: next },
      );
    };
    const onUp = () => setHeightDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [heightDrag]);

  // -------- Media drop, seek, render --------

  const onMediaDrop = useCallback(
    async (
      track: TrackSummary,
      payload: MediaDragPayload,
      e: React.DragEvent<HTMLDivElement>,
    ) => {
      if (
        !trackAcceptsMedia(track.kind, payload.kind) &&
        !trackAcceptsMediaForAutoRoute(track.kind, payload.kind)
      ) {
        console.warn(
          `track ${track.kind} doesn't accept media of kind ${payload.kind}`,
        );
        return;
      }
      const m = media.find((mm) => mm.id === payload.mediaId);
      if (!m) {
        console.warn(
          `media drop rejected: ${payload.mediaId} not found in current summary`,
        );
        return;
      }
      const readiness = mediaReadiness(m, importing, proxyState);
      if (!readiness.ready) {
        console.warn(
          `media drop rejected: ${payload.mediaId} is ${readiness.reason}`,
        );
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const tStartUs = Math.max(0, Math.round((x / pxPerSec) * 1_000_000));
      try {
        await addMediaLayer(track.id, payload.mediaId, tStartUs);
        await onMutated();
      } catch (err) {
        console.error("media drop failed:", err);
      }
    },
    [importing, media, onMutated, proxyState, pxPerSec],
  );

  // V.7: context-menu open handler. Captures cursor position +
  // target layer. Triggered by LayerBlock's onContextMenu (right-click).
  const onContextMenu = useCallback(
    (e: React.MouseEvent, layerId: string, layerKind: string) => {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        layerId,
        layerKind,
      });
    },
    [],
  );

  // Close the context menu when the timeline scrolls under it — the
  // popup is anchored to fixed cursor coordinates, so it would float
  // detached over moving content. Outside-click and Escape closing is
  // Base UI's job now.
  useEffect(() => {
    if (!contextMenu) return;
    const onScroll = () => setContextMenu(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [contextMenu]);

  const onSeparateAudio = useCallback(
    async (layerId: string) => {
      setContextMenu(null);
      try {
        await separateAudioToNewTrack(layerId);
        await onMutated();
      } catch (err) {
        console.error("separate audio failed:", err);
      }
    },
    [onMutated],
  );

  const onPrebakeNow = useCallback((layerId: string) => {
    setContextMenu(null);
    requestPrebake(layerId);
  }, []);

  const playheadX = (currentTimeUs / 1_000_000) * pxPerSec;

  const seekFromClientX = useCallback(
    (clientX: number) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const rawUs = Math.max(0, Math.round((x / pxPerSec) * 1_000_000));
      onSeek(snapFrameRound(rawUs, fpsNum, fpsDen));
    },
    [onSeek, pxPerSec, fpsNum, fpsDen],
  );

  // Blade-tool click handler: convert clientX → frame-snapped composition
  // timestamp and ask the actor to split the layer at that point. Reject
  // only when the snapped point lands exactly on a layer edge — the
  // actor would refuse that anyway, and a frame-precise editor needs
  // frame-precise cuts. After a split the user stays in blade mode
  // (NLE convention); press `C` or `Esc` to exit.
  const splitFromClientX = useCallback(
    async (layer: LayerSummary, clientX: number) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const rawUs = Math.max(0, Math.round((x / pxPerSec) * 1_000_000));
      const atUs = snapFrameRound(rawUs, fpsNum, fpsDen);
      if (atUs <= layer.t_start_us || atUs >= layer.t_end_us) return;
      try {
        await splitLayerGrouped(layer.id, atUs, false);
        await onMutated();
      } catch (err) {
        console.error("blade split failed:", err);
      }
    },
    [pxPerSec, fpsNum, fpsDen, onMutated],
  );

  // Esc exits blade mode. Bound at the window level so it fires regardless
  // of focus, and attached only while blade mode is on.
  useEffect(() => {
    if (!bladeMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onExitBlade();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bladeMode, onExitBlade]);

  // Click/drag on empty canvas (lane background, gap below tracks) to seek.
  // Layer / trim-handle / resize-handle pointerdown stops propagation, so
  // this never fires when interacting with an existing control. In blade
  // mode the user is hunting for a layer to cut, not asking to scrub.
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (bladeMode) return;
      seekFromClientX(e.clientX);
      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromClientX, bladeMode],
  );

  return (
    <>
    <div className="timeline-toolbar">
      <DisplayModePill mode={displayMode} />
    </div>
    <div
      ref={rootRef}
      className={`timeline-root ${drag ? "is-dragging" : ""} ${
        heightDrag ? "is-resizing-track" : ""
      } ${bladeMode ? "is-blade-mode" : ""}`}
      onClick={() => onSelect(null)}
      onPointerDown={onCanvasPointerDown}
    >
      <TimelineRuler
        pxPerSec={pxPerSec}
        totalSec={totalSec}
        widthPx={Math.max(widthPx, 200)}
        fpsNum={fpsNum}
        fpsDen={fpsDen}
      />
      <div
        ref={canvasRef}
        className="timeline-canvas"
        style={{ width: Math.max(widthPx, 200) }}
      >
        {orderedTracks.length === 0 && <EmptyHint mode={displayMode} />}
        {/*
          Data model: `tracks[0]` is the bottom of the z-stack, `tracks[last]`
          is the top (see `Project::tracks` doc-comment). The visual order
          groups by kind (Video on top, then Subtitle, then Audio at the
          bottom — Premiere/Resolve/FCP convention) and within each group is
          z-stack-reversed so the top of the group is the top of z-stack.
        */}
        {orderedTracks.map(({ track, isGroupStart }) => (
          <TrackLane
            key={track.id}
            track={track}
            pxPerSec={pxPerSec}
            height={trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT}
            selectedLayerId={selectedLayerId}
            selectedLayerIds={selectedLayerIds}
            groupByLayerId={groupByLayerId}
            dragState={drag}
            pendingPlacement={pendingPlacement}
            pendingLayer={pendingLayer}
            dragLayer={dragLayer}
            bladeMode={bladeMode}
            onBladeSplit={splitFromClientX}
            onSelect={onSelect}
            onSelectFromClick={selectFromClick}
            onDragStart={(state) => setDrag(state)}
            onContextMenu={onContextMenu}
            onMediaDrop={onMediaDrop}
            isGroupStart={isGroupStart}
            isRevealed={track.id === (revealedTrackId ?? null)}
            onHeightDragStart={beginHeightDrag(track.id)}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
          />
        ))}
      </div>
      {currentTimeUs >= 0 && (
        <div
          className="timeline-playhead"
          style={{ left: playheadX }}
        >
          <div className="playhead-knob" />
        </div>
      )}
    </div>
    {contextMenu && (
      <LayerContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        layerId={contextMenu.layerId}
        layerKind={contextMenu.layerKind}
        onClose={() => setContextMenu(null)}
        onSeparateAudio={onSeparateAudio}
        onPrebakeNow={onPrebakeNow}
      />
    )}
    </>
  );
}

/// V.7 floating context menu, rendered with Base UI Menu anchored to a
/// zero-size virtual element at the right-click coordinates — the
/// `contextMenu` state plumbing (and its coexistence with drag/blade
/// pointer handling) is unchanged; only the popup machinery moved to
/// the library (portal, outside-press + Escape close, arrow-key nav).
/// Shows action items scoped to the right-clicked layer's kind.
/// (The 2026-05-17 effect-redesign removed the H.6 render-mode toggle;
/// group html-rendering is now driven by the presence of an
/// HtmlTransform effect on the group, authored via MCP / a future
/// effects panel.)
function LayerContextMenu({
  x,
  y,
  layerId,
  layerKind,
  onClose,
  onSeparateAudio,
  onPrebakeNow,
}: {
  x: number;
  y: number;
  layerId: string;
  layerKind: string;
  onClose: () => void;
  onSeparateAudio: (id: string) => void;
  onPrebakeNow: (id: string) => void;
}) {
  const { t } = useTranslation();
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x,
        y,
        top: y,
        left: x,
        right: x,
        bottom: y,
        width: 0,
        height: 0,
      }),
    }),
    [x, y],
  );
  return (
    <MenuPrimitive.Root
      open
      // Non-modal: no scroll lock — the scroll-close effect in Timeline
      // handles the anchored-to-stale-coordinates case instead.
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={0}
          className="z-50"
        >
          <MenuPrimitive.Popup className="menu-list">
            {layerKind === "Audio" ? (
              <MenuPrimitive.Item
                className="menu-item"
                onClick={() => onSeparateAudio(layerId)}
              >
                {t("timeline.separate_audio", {
                  defaultValue: "Separate audio to new track",
                })}
              </MenuPrimitive.Item>
            ) : layerKind === "Motif" ? (
              <MenuPrimitive.Item
                className="menu-item"
                onClick={() => onPrebakeNow(layerId)}
              >
                {t("timeline.prebake_now", { defaultValue: "Pre-bake now" })}
              </MenuPrimitive.Item>
            ) : (
              <MenuPrimitive.Item className="menu-item" disabled>
                {t("timeline.no_actions_here", {
                  defaultValue: "(no actions for this layer)",
                })}
              </MenuPrimitive.Item>
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/// `docs/data-model.md` R.5b. The pill IS the setting: a click
/// flips the app-level `display_mode` (`appSettingsSet` round-trips
/// through Rust which emits `app_settings:changed` so every
/// subscriber syncs). Same surface the View menu and `T` shortcut
/// (R.8) drive.
function DisplayModePill({ mode }: { mode: "AbRoll" | "ShowAll" }) {
  const { t } = useTranslation();
  const label = mode === "AbRoll" ? "A/B" : t("timeline.mode_all", { defaultValue: "All" });
  const ariaLabel =
    mode === "AbRoll"
      ? t("timeline.mode_ab_hint", { defaultValue: "Showing A/B-roll tracks only. Click to show all." })
      : t("timeline.mode_all_hint", { defaultValue: "Showing all tracks. Click to filter to A/B-roll only." });
  return (
    <button
      type="button"
      className={`timeline-mode-pill ${mode === "AbRoll" ? "is-ab" : ""}`}
      onClick={() => {
        void toggleDisplayMode();
      }}
      title={ariaLabel}
      aria-label={ariaLabel}
      aria-pressed={mode === "AbRoll"}
    >
      {mode === "AbRoll"
        ? t("timeline.mode_ab", { defaultValue: "A/B" })
        : label}
    </button>
  );
}

/// V.10: tracks are kind-agnostic; any layer can land on any track.
/// The cross-kind reject the function used to enforce is gone — the
/// IR routes by LayerParams (V.5), not by track kind.
function trackAcceptsForLayer(_target: TrackSummary, _drag: DragState): boolean {
  return true;
}


function EmptyHint({ mode }: { mode?: "AbRoll" | "ShowAll" }) {
  const { t } = useTranslation();
  // Legacy projects render here when the user is in AB mode but no
  // track carries a role stamp — the user toggles to Show-All
  // manually (Q3 of the redesign locked "no legacy handling").
  const message =
    mode === "AbRoll"
      ? t("timeline.empty_ab_mode", {
          defaultValue:
            "No A/B-roll content here. Drop a clip on Video A or Video B, or click the A/B pill above to switch to Show All.",
        })
      : t("timeline.empty_placeholder");
  return <div className="timeline-empty">{message}</div>;
}

function TrackLane({
  track,
  pxPerSec,
  height,
  selectedLayerId,
  selectedLayerIds,
  groupByLayerId,
  dragState,
  pendingPlacement,
  pendingLayer,
  dragLayer,
  bladeMode,
  onBladeSplit,
  onSelect,
  onSelectFromClick,
  onDragStart,
  onMediaDrop,
  onContextMenu,
  isGroupStart,
  isRevealed,
  onHeightDragStart,
  fpsNum,
  fpsDen,
}: {
  track: TrackSummary;
  pxPerSec: number;
  height: number;
  selectedLayerId: string | null;
  selectedLayerIds: Set<string>;
  groupByLayerId: Map<string, string>;
  dragState: DragState | null;
  pendingPlacement: PendingLayerPlacement | null;
  pendingLayer: LayerSummary | null;
  dragLayer: LayerSummary | null;
  bladeMode: boolean;
  onBladeSplit: (layer: LayerSummary, clientX: number) => void;
  onSelect: (id: string | null) => void;
  onSelectFromClick: (
    layerId: string,
    e: { altKey: boolean; shiftKey: boolean; metaKey: boolean },
  ) => void;
  onDragStart: (state: DragState) => void;
  onMediaDrop: (
    track: TrackSummary,
    payload: MediaDragPayload,
    e: React.DragEvent<HTMLDivElement>,
  ) => void;
  /// V.7 context-menu hook. LayerBlock fires this on right-click; the
  /// Timeline shows a small floating menu and routes the chosen
  /// action.
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
  ) => void;
  isGroupStart: boolean;
  /// R.7 inline-reveal flag. The lane renders with extra chrome
  /// (dashed border / "hidden" badge) so the user knows this row is
  /// only here because they clicked a peek item.
  isRevealed: boolean;
  onHeightDragStart: (e: React.PointerEvent) => void;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const kindLabel = t(`kinds.${track.kind.toLowerCase()}`, {
    defaultValue: track.kind,
  });
  const [dragOverX, setDragOverX] = useState<number | null>(null);

  const renderedLayers = useMemo(() => {
    let layers = track.layers;

    if (pendingPlacement && pendingLayer) {
      const pendingRenderLayer = {
        ...pendingLayer,
        t_start_us: pendingPlacement.tStartUs,
        t_end_us: pendingPlacement.tEndUs,
      };

      if (pendingPlacement.trackId === track.id) {
        let replaced = false;
        layers = layers.map((layer) => {
          if (layer.id !== pendingPlacement.layerId) return layer;
          replaced = true;
          return pendingRenderLayer;
        });
        if (!replaced) layers = [...layers, pendingRenderLayer];
      } else {
        layers = layers.filter(
          (layer) => layer.id !== pendingPlacement.layerId,
        );
      }
    }

    if (
      dragState?.kind === "move" &&
      dragLayer &&
      dragState.overTrackId === track.id &&
      dragState.trackId !== track.id &&
      !layers.some((layer) => layer.id === dragLayer.id)
    ) {
      layers = [...layers, dragLayer];
    }

    if (
      dragState?.kind === "move" &&
      dragState.overTrackId !== null &&
      dragState.overTrackId !== track.id &&
      dragState.trackId === track.id
    ) {
      layers = layers.filter((layer) => layer.id !== dragState.layerId);
    }

    return layers;
  }, [
    dragLayer,
    dragState,
    pendingLayer,
    pendingPlacement,
    track.id,
    track.layers,
  ]);

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const rect = e.currentTarget.getBoundingClientRect();
      setDragOverX(e.clientX - rect.left);
    },
    [],
  );

  const onDragLeave = useCallback(() => {
    setDragOverX(null);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const payload = parseMediaDrag(e);
      setDragOverX(null);
      if (!payload) return;
      e.preventDefault();
      onMediaDrop(track, payload, e);
    },
    [onMediaDrop, track],
  );

  // Highlight the lane the user is currently dragging an existing layer over.
  const isCrossTrackTarget =
    dragState?.kind === "move" &&
    dragState.overTrackId === track.id &&
    dragState.trackId !== track.id;

  return (
    <div
      className={`timeline-track-lane kind-${track.kind.toLowerCase()} ${
        isCrossTrackTarget ? "is-drop-target" : ""
      } ${isGroupStart ? "is-group-start" : ""} ${
        isRevealed ? "is-revealed" : ""
      }`}
      style={{ height }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="track-label">{track.label ?? kindLabel}</div>
      {dragOverX !== null && (
        <div className="drop-indicator" style={{ left: dragOverX }} />
      )}
      {(() => {
        // V.6: compute per-layer slice once per track render. Layers
        // with a co-located opposite-class layer render half-height
        // (top for visual, bottom for audio) so the user sees both in
        // one row. Single-class layers fill the row at full height.
        const slices = computeLayerSlices(renderedLayers);
        return renderedLayers.map((layer) => (
          <LayerBlock
            key={layer.id}
            layer={layer}
            trackId={track.id}
            trackKind={track.kind}
            pxPerSec={pxPerSec}
            laneHeight={height}
            slice={slices.get(layer.id) ?? "full"}
            isPrimary={selectedLayerId === layer.id}
            isSelected={selectedLayerIds.has(layer.id)}
            groupId={groupByLayerId.get(layer.id) ?? null}
            dragState={dragState}
            pendingPlacement={pendingPlacement}
            bladeMode={bladeMode}
            onBladeSplit={onBladeSplit}
            onSelect={onSelect}
            onSelectFromClick={onSelectFromClick}
            onDragStart={onDragStart}
            onContextMenu={onContextMenu}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
          />
        ));
      })()}
      <div
        className="track-resize-handle"
        title={t("timeline.resize_track_hint", {
          defaultValue: "Drag to resize this track",
        })}
        onPointerDown={onHeightDragStart}
      />
    </div>
  );
}

