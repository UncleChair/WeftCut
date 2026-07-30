import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  addMediaLayer,
  addTransition,
  groupsCreate,
  groupsDissolve,
  logEmit,
  moveLayer,
  removeTransition,
  separateAudioToNewTrack,
  splitLayerGrouped,
  updateLayer,
  updateLayerParamTrack,
  type AnimTrack,
  type GroupSummary,
  type KeybindingsMap,
  type LayerSummary,
  type MediaSummary,
  type TrackSummary,
  type TransitionDirection,
  type TransitionSummary,
} from "../ipc";
import { mediaReadiness, type ProxyState } from "../panels/mediaReadiness";
import { formatTimecode, snapFrameRound } from "../frames";
import {
  toggleDisplayMode,
  useDisplayMode,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "../settings/appSettingsStore";
import { useShortcuts, type OverrideMap } from "../shortcuts/useShortcuts";
import { ACTION_DEFS } from "../shortcuts/defs";
import { useCommandProvider } from "../commands/registry";
import {
  NUDGE_MS,
  NUDGE_SAMPLE,
  nudgedStartUs,
  resyncStartUs,
  slippableAudioLayers,
  type SlipLayer,
} from "./audioSlip";
import { deriveAudioSyncOffsets, setAudioSyncOffsets } from "./audioSyncOffsetStore";
import { requestPrebake } from "../render/motifs/prebakeBus";
import {
  DEFAULT_TRACK_HEIGHT,
  HEADER_COL_PX,
  computeTimelineExtent,
  indexGroups,
  playheadFrameShadowPx,
  trackKeyframeProperties,
  visualOrderedTracks,
} from "./geometry";
import { TimelineRuler } from "./TimelineRuler";
import { TrackHeader } from "./TrackHeader";
import { TrackLane } from "./TrackLane";
import type { MediaDragPayload, MediaDropPlan } from "./mediaDrag";
import { KeyframeLane, KeyframeLaneHeaders } from "./KeyframeLane";
import { LayerContextMenu } from "./LayerContextMenu";
import { beginRename } from "./renameStore";
import { useTimelineView } from "./hooks/useTimelineView";
import { useHeightDrag } from "./hooks/useHeightDrag";
import { useLayerDrag } from "./hooks/useLayerDrag";
import { snapTimeToTimelineBoundary } from "./snapping";
import { playheadTimeUs, usePlayheadStore } from "../state/playheadStore";
import { setTimelineScrollLeftPx } from "../state/timelineScrollStore";
import { registerScrollToTime } from "../state/navigation";
import {
  clearLayerSelection,
  clearTransitionSelection,
  extendLayerSelection,
  setLayerSelection,
  usePrimaryLayerId,
  useSelectedLayerIds,
  useSelectedTransitionId,
} from "../state/selectionStore";
import { isEditableTarget } from "../shortcuts/match";
import {
  CUT_CLICK_TOLERANCE_PX,
  defaultTransitionDurationUs,
  findCutNear,
  parseTransitionCommandError,
  type TransitionCut,
  type TransitionKindName,
} from "./transitions";

// Any media kind drops on any track (tracks are kind-agnostic; the
// backend enforces overlap rules). Kept as a stub returning true to
// minimise call-site churn.
function trackAcceptsMedia(_trackKind: string, _mediaKind: string): boolean {
  return true;
}


// Auto-routing is gone — drops land on their target track directly.
// Kept as a no-op stub (returns false) so the
// `trackAcceptsMedia || trackAcceptsMediaForAutoRoute` call-sites still
// compile.
function trackAcceptsMediaForAutoRoute(_trackKind: string, _mediaKind: string): boolean {
  return false;
}

interface TimelineProps {
  tracks: TrackSummary[];
  /// `docs/features.md#groups`. Empty array when no groups exist.
  groups: GroupSummary[];
  /// Transitions between same-track adjacent visual layers, rendered as
  /// chips over the incoming layer's head. Optional — older snapshots and
  /// test fixtures omit the field; absent means empty.
  transitions?: TransitionSummary[];
  durationUs: number;
  /// (`docs/data-model.md`): when set, this hidden track is
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
  /// Media ids whose original can be used as a session preview bridge while
  /// optimization is still running.
  previewDecodable: ReadonlySet<string>;
  visible?: boolean;
  onExitBlade: () => void;
  onSeek: (tUs: number) => void;
  onMutated: () => Promise<void>;
}


const EMPTY_TRANSITIONS: TransitionSummary[] = [];

export function Timeline({
  tracks,
  groups,
  transitions = EMPTY_TRANSITIONS,
  durationUs,
  revealedTrackId,
  keybindings,
  fpsNum,
  fpsDen,
  bladeMode,
  media,
  importing,
  proxyState,
  previewDecodable,
  visible = true,
  onExitBlade,
  onSeek,
  onMutated,
}: TimelineProps) {
  const { t } = useTranslation();
  // Right-click context-menu state. `null` when closed; otherwise
  // anchors the menu at the cursor and stores the target layer id.
  // `cut` is non-null when the click landed within the tolerance band of a
  // hard cut between same-track adjacent visual layers — the menu then
  // offers the "Add transition" section.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    layerKind: string;
    layerEnabled: boolean;
    cut: TransitionCut | null;
  } | null>(null);
  const primaryLayerId = usePrimaryLayerId();
  const selectedLayerIds = useSelectedLayerIds();
  const selectedTransitionId = useSelectedTransitionId();
  const [bladePreview, setBladePreview] = useState<{
    layerId: string;
    atUs: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const {
    pxPerSec,
    trackHeights,
    setTrackHeights,
    trackHeightsRef,
    expandedTracks,
    toggleExpanded,
    viewportWidthPx,
  } = useTimelineView({ rootRef, tracks, durationUs });

  // Net-new capability: horizontal scroll-to-time for palette jumps.
  // pxPerSec is React state; the registered closure reads it through a ref
  // so registration happens once per mount.
  const pxPerSecForScrollRef = useRef(pxPerSec);
  useLayoutEffect(() => {
    pxPerSecForScrollRef.current = pxPerSec;
  }, [pxPerSec]);
  useEffect(
    () =>
      registerScrollToTime((tUs) => {
        const root = rootRef.current;
        if (!root) return;
        const x = (tUs / 1_000_000) * pxPerSecForScrollRef.current;
        const viewport = root.clientWidth - HEADER_COL_PX;
        // Center the target time in the lane area (the first HEADER_COL_PX
        // of the viewport is the sticky track-header column).
        root.scrollLeft = Math.max(0, x - viewport / 2);
        // Publish now rather than waiting for the scroll event's rAF, so the
        // ruler's tick window lands with the jump instead of one frame later.
        setTimelineScrollLeftPx(root.scrollLeft);
      }),
    [],
  );

  // Publish horizontal scroll for the ruler's tick window. Deliberately NOT
  // React state here: this component is the whole timeline tree, and a
  // per-wheel-event re-render of it is the regression the memory ratchet
  // guards (see state/timelineScrollStore.ts). rAF-coalesced so a scroll
  // burst collapses to one store write per frame.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    const publish = () => {
      raf = 0;
      setTimelineScrollLeftPx(root.scrollLeft);
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(publish);
    };
    // Seed: a remount (dock panel switch) starts at scrollLeft 0 without
    // firing a scroll event.
    setTimelineScrollLeftPx(root.scrollLeft);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      root.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Cursor-anchored zoom re-writes `scrollLeft` in a layout effect inside
  // `useTimelineView`, which is registered BEFORE this one — so by the time this
  // runs the re-anchored offset is final, and publishing it here (rather than
  // waiting for the scroll event's rAF) is what keeps the ruler's window from
  // painting the pre-zoom region for one frame.
  useLayoutEffect(() => {
    if (rootRef.current) setTimelineScrollLeftPx(rootRef.current.scrollLeft);
  }, [pxPerSec]);

  const { totalSec, widthPx } = computeTimelineExtent({
    durationUs,
    pxPerSec,
    viewportWidthPx,
  });

  const groupByLayerId = useMemo(() => indexGroups(groups), [groups]);

  // The derived A/V sync offset (R2-D7). Published to a store rather than threaded as
  // a prop so only the badged clip re-renders; `setAudioSyncOffsets` no-ops when the
  // map is unchanged, so an unrelated project update costs nothing.
  useLayoutEffect(() => {
    setAudioSyncOffsets(
      deriveAudioSyncOffsets(
        tracks.flatMap((t) => t.layers),
        groups,
      ),
    );
  }, [tracks, groups]);

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
    // AB filter: keep role-stamped tracks. Inline-reveal lets one
    // additional hidden track survive the filter at its natural
    // accretion slot — the visualOrderedTracks output already has the
    // slot computed, so we just need to keep that row alongside the
    // role-stamped ones.
    return all.filter(
      ({ track }) =>
        track.role !== null || track.id === (revealedTrackId ?? null),
    );
  }, [tracks, displayMode, revealedTrackId]);

  const visibleSnapTracks = useMemo(
    () => orderedTracks.map(({ track }) => track),
    [orderedTracks],
  );
  const mediaDropSnap = useMemo(
    () => ({
      visibleTracks: visibleSnapTracks,
      groups,
      groupByLayerId,
      enabled: tailSnapEnabled,
      strengthPx: tailSnapStrengthPx,
    }),
    [
      groupByLayerId,
      groups,
      tailSnapEnabled,
      tailSnapStrengthPx,
      visibleSnapTracks,
    ],
  );

  /// Map a click event on a layer chip to the resulting selection set.
  /// `docs/features.md#groups`: plain click on a grouped layer selects the
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
      const members = memberSet();
      if (e.shiftKey) extendLayerSelection(layerId, members);
      else setLayerSelection(layerId, members);
    },
    [groupByLayerId, groups],
  );

  /// `docs/features.md#groups` — Mod+G groups the current multi-selection;
  /// Mod+Shift+G dissolves every group represented in the selection.
  /// Wired through the global `useShortcuts` registry so the Keyboard
  /// Shortcuts settings panel exposes them and they're rebindable.
  /// Handlers read state via refs to avoid the
  /// stale-closure trap of multi-key chord dispatch.
  const selectedLayerIdsRef = useRef(selectedLayerIds);
  const groupByLayerIdRef = useRef(groupByLayerId);
  const onMutatedRef = useRef(onMutated);
  useLayoutEffect(() => {
    selectedLayerIdsRef.current = selectedLayerIds;
    groupByLayerIdRef.current = groupByLayerId;
    onMutatedRef.current = onMutated;
  }, [selectedLayerIds, groupByLayerId, onMutated]);

  const shortcutOverrides = useMemo<OverrideMap>(
    () => keybindings as OverrideMap,
    [keybindings],
  );
  // Named so the search-palette command provider below can reference the
  // exact same function objects the shortcut dispatcher uses.
  const handleGroupSelected = useCallback(async () => {
    const sel = selectedLayerIdsRef.current;
    if (sel.size < 2) return;
    try {
      await groupsCreate(Array.from(sel), null, false);
      await onMutatedRef.current();
    } catch (err) {
      console.error("groups_create failed:", err);
    }
  }, []);

  const handleDissolveSelectedGroup = useCallback(async () => {
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
  }, []);

  // ── Sub-frame audio slip (ADR 0038) ────────────────────────────────────────
  // Sample precision cannot be reached by dragging — one sample is 0.042 px at the
  // 2000 px/s zoom ceiling — so these commands ARE the fine-authoring surface.
  // Registered as real actions (not local key handling) so the search palette lists
  // them, Settings → Keyboard can rebind them, and an agent can call them.
  //
  // `escapeGroup: true` on every one of them: the whole point is to move the audio
  // WITHOUT its video partner. That is also what creates the implicit sync offset
  // R2-D7 surfaces as the clip badge — there is no field to write.
  const layersByIdRef = useRef(new Map<string, LayerSummary>());
  const groupsRef = useRef(groups);
  const trackOfLayerRef = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    const byId = new Map<string, LayerSummary>();
    const trackOf = new Map<string, string>();
    for (const t of tracks) {
      for (const l of t.layers) {
        byId.set(l.id, l);
        trackOf.set(l.id, t.id);
      }
    }
    layersByIdRef.current = byId;
    trackOfLayerRef.current = trackOf;
    groupsRef.current = groups;
  }, [tracks, groups]);

  /// Move every selected audio layer to `nextStart(layer)`, or skip it when that
  /// resolves to null / no movement. One `move_layer` per layer, then one refresh.
  const slipSelectedAudio = useCallback(
    async (nextStart: (l: SlipLayer, members: SlipLayer[]) => number | null) => {
      const byId = layersByIdRef.current;
      const targets = slippableAudioLayers(selectedLayerIdsRef.current, [...byId.values()]);
      if (targets.length === 0) return;
      let moved = false;
      for (const audio of targets) {
        const gid = groupByLayerIdRef.current.get(audio.id);
        const members = gid
          ? (groupsRef.current.find((g) => g.id === gid)?.layer_ids ?? [])
              .map((id) => byId.get(id))
              .filter((l): l is LayerSummary => l !== undefined)
          : [];
        const next = nextStart(audio, members);
        if (next === null || next === audio.t_start_us) continue;
        const trackId = trackOfLayerRef.current.get(audio.id);
        if (trackId === undefined) continue;
        try {
          await moveLayer(audio.id, trackId, next, true);
          moved = true;
        } catch (err) {
          console.error("audio slip move_layer failed:", err);
        }
      }
      if (moved) await onMutatedRef.current();
    },
    [],
  );

  const nudgeAudio = useCallback(
    (steps: number) => () => void slipSelectedAudio((l) => nudgedStartUs(l, steps)),
    [slipSelectedAudio],
  );
  const handleNudgeAudioSampleBack = useMemo(() => nudgeAudio(-NUDGE_SAMPLE), [nudgeAudio]);
  const handleNudgeAudioSampleForward = useMemo(() => nudgeAudio(NUDGE_SAMPLE), [nudgeAudio]);
  const handleNudgeAudioMsBack = useMemo(() => nudgeAudio(-NUDGE_MS), [nudgeAudio]);
  const handleNudgeAudioMsForward = useMemo(() => nudgeAudio(NUDGE_MS), [nudgeAudio]);
  const handleResyncAudioToVideo = useCallback(
    () => void slipSelectedAudio((l, members) => resyncStartUs(l, members)),
    [slipSelectedAudio],
  );

  useShortcuts({
    overrides: shortcutOverrides,
    handlers: {
      groupSelected: handleGroupSelected,
      dissolveSelectedGroup: handleDissolveSelectedGroup,
      nudgeAudioSampleBack: handleNudgeAudioSampleBack,
      nudgeAudioSampleForward: handleNudgeAudioSampleForward,
      nudgeAudioMsBack: handleNudgeAudioMsBack,
      nudgeAudioMsForward: handleNudgeAudioMsForward,
      resyncAudioToVideo: handleResyncAudioToVideo,
    },
  });

  useCommandProvider(() => [
    {
      id: "groupSelected",
      actionId: "groupSelected",
      labelKey: ACTION_DEFS.groupSelected.labelKey,
      run: handleGroupSelected,
    },
    {
      id: "dissolveSelectedGroup",
      actionId: "dissolveSelectedGroup",
      labelKey: ACTION_DEFS.dissolveSelectedGroup.labelKey,
      run: handleDissolveSelectedGroup,
    },
    {
      id: "nudgeAudioSampleBack",
      actionId: "nudgeAudioSampleBack",
      labelKey: ACTION_DEFS.nudgeAudioSampleBack.labelKey,
      run: handleNudgeAudioSampleBack,
    },
    {
      id: "nudgeAudioSampleForward",
      actionId: "nudgeAudioSampleForward",
      labelKey: ACTION_DEFS.nudgeAudioSampleForward.labelKey,
      run: handleNudgeAudioSampleForward,
    },
    {
      id: "nudgeAudioMsBack",
      actionId: "nudgeAudioMsBack",
      labelKey: ACTION_DEFS.nudgeAudioMsBack.labelKey,
      run: handleNudgeAudioMsBack,
    },
    {
      id: "nudgeAudioMsForward",
      actionId: "nudgeAudioMsForward",
      labelKey: ACTION_DEFS.nudgeAudioMsForward.labelKey,
      run: handleNudgeAudioMsForward,
    },
    {
      id: "resyncAudioToVideo",
      actionId: "resyncAudioToVideo",
      labelKey: ACTION_DEFS.resyncAudioToVideo.labelKey,
      run: handleResyncAudioToVideo,
    },
  ]);

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

  const { heightDrag, beginHeightDrag } = useHeightDrag({
    trackHeightsRef,
    setTrackHeights,
  });

  const { drag, setDrag, pendingPlacements, pendingLayerById, dragLayerById } =
    useLayerDrag({
      tracks,
      groups,
      groupByLayerId,
      orderedTracks,
      trackRows,
      canvasRef,
      pxPerSec,
      fpsNum,
      fpsDen,
      tailSnapEnabled,
      tailSnapStrengthPx,
      onMutated,
    });

  // -------- Media drop, seek, render --------

  const onMediaDrop = useCallback(
    async (
      track: TrackSummary,
      payload: MediaDragPayload,
      plan: MediaDropPlan,
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
      const readiness = mediaReadiness(m, importing, proxyState, {
        previewDecodable: previewDecodable.has(m.id),
      });
      if (!readiness.ready) {
        console.warn(
          `media drop rejected: ${payload.mediaId} is ${readiness.reason}`,
        );
        return;
      }
      try {
        await addMediaLayer(track.id, payload.mediaId, plan.rawStartUs);
        await onMutated();
      } catch (err) {
        console.error("media drop failed:", err);
      }
    },
    [importing, media, onMutated, previewDecodable, proxyState],
  );

  // Context-menu open handler. Captures cursor position + target layer;
  // triggered by LayerBlock's onContextMenu (right-click). Also hit-tests
  // the click against the cuts on the layer's track: within
  // CUT_CLICK_TOLERANCE_PX of a seam between same-track adjacent visual
  // layers, the menu grows the "Add transition" section.
  const onContextMenu = useCallback(
    (
      e: React.MouseEvent,
      layerId: string,
      layerKind: string,
      layerEnabled: boolean,
    ) => {
      let cut: TransitionCut | null = null;
      const canvas = canvasRef.current;
      const track = tracks.find((candidate) =>
        candidate.layers.some((l) => l.id === layerId),
      );
      if (canvas && track && pxPerSec > 0) {
        const rect = canvas.getBoundingClientRect();
        const xUs = ((e.clientX - rect.left) / pxPerSec) * 1_000_000;
        const toleranceUs = (CUT_CLICK_TOLERANCE_PX / pxPerSec) * 1_000_000;
        cut = findCutNear(track.layers, xUs, toleranceUs);
      }
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        layerId,
        layerKind,
        layerEnabled,
        cut,
      });
    },
    [tracks, pxPerSec],
  );

  // Create a transition at a cut (context-menu action). Default duration is
  // the hardcoded 1 s snapped DOWN to whole comp frames. Errors surface
  // through the status bar / log (the app's error path) — notably
  // TransitionInsufficientHandle carries `available_us`, which the message
  // includes verbatim as a timecode. NO silent clamping.
  const onAddTransition = useCallback(
    async (
      cut: TransitionCut,
      kind: TransitionKindName,
      direction?: TransitionDirection,
    ) => {
      setContextMenu(null);
      try {
        await addTransition({
          fromLayerId: cut.fromLayerId,
          toLayerId: cut.toLayerId,
          durationUs: defaultTransitionDurationUs(fpsNum, fpsDen),
          kind,
          ...(direction !== undefined ? { direction } : {}),
        });
        await onMutated();
      } catch (err) {
        const parsed = parseTransitionCommandError(String(err));
        const message =
          parsed?.name === "TransitionInsufficientHandle"
            ? t("transitions.insufficient_handle", {
                available: formatTimecode(
                  parsed.availableUs ?? 0,
                  fpsNum,
                  fpsDen,
                ),
                defaultValue:
                  "Not enough tail media on the outgoing clip for this transition — available: {{available}}",
              })
            : t("transitions.add_failed", {
                detail: String(err),
                defaultValue: "Add transition failed: {{detail}}",
              });
        void logEmit({
          level: "error",
          category: { kind: "Project" },
          source: { kind: "User" },
          message,
        });
      }
    },
    [fpsNum, fpsDen, onMutated, t],
  );

  // Delete/Backspace removes the selected transition chip. Capture phase +
  // stopImmediatePropagation preempts the app-level delete-selected-layer
  // shortcut (same pattern as the keyframe-diamond Delete in LayerBlock);
  // armed only while a chip is selected, and never while typing in a field.
  useEffect(() => {
    if (selectedTransitionId === null) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      if (isEditableTarget(ev.target)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      void (async () => {
        try {
          await removeTransition(selectedTransitionId);
          clearTransitionSelection();
          await onMutatedRef.current();
        } catch (err) {
          console.error("remove_transition failed:", err);
        }
      })();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedTransitionId]);

  const onCommitLabel = useCallback(
    async (layerId: string, label: string) => {
      try {
        await updateLayer(layerId, { label });
        await onMutated();
      } catch (e) {
        console.warn("update_layer (label) failed:", e);
      }
    },
    [onMutated],
  );

  const onCommitParamTrack = useCallback(
    async (layerId: string, paramKey: string, track: AnimTrack<number>) => {
      try {
        await updateLayerParamTrack(layerId, paramKey, track);
        await onMutated();
      } catch (e) {
        console.warn("commit param track failed:", e);
      }
    },
    [onMutated],
  );

  const onRename = useCallback((layerId: string) => {
    setContextMenu(null);
    beginRename(layerId);
  }, []);

  const onToggleEnabled = useCallback(
    async (layerId: string, enabled: boolean) => {
      setContextMenu(null);
      try {
        await updateLayer(layerId, { enabled });
        await onMutated();
      } catch (e) {
        console.warn("update_layer (enabled) failed:", e);
      }
    },
    [onMutated],
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

  const bladeCutTimeFromClientX = useCallback(
    (layer: LayerSummary, clientX: number): number | null => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const rawUs = Math.max(0, Math.round((x / pxPerSec) * 1_000_000));
      const frameUs = snapFrameRound(rawUs, fpsNum, fpsDen);
      const atUs = snapTimeToTimelineBoundary({
        timeUs: frameUs,
        layerId: layer.id,
        escapeGroup: false,
        visibleTracks: visibleSnapTracks,
        groups,
        groupByLayerId,
        // Event-time read: the playhead is a snap TARGET here, so the value
        // at the moment of the mouse event is the correct one — no reactive
        // subscription needed.
        currentTimeUs: playheadTimeUs(),
        fpsNum,
        fpsDen,
        pxPerSec,
        enabled: tailSnapEnabled,
        strengthPx: tailSnapStrengthPx,
        isValidSnap: (boundaryUs) =>
          boundaryUs > layer.t_start_us && boundaryUs < layer.t_end_us,
      });
      return atUs > layer.t_start_us && atUs < layer.t_end_us ? atUs : null;
    },
    [
      fpsNum,
      fpsDen,
      groupByLayerId,
      groups,
      pxPerSec,
      tailSnapEnabled,
      tailSnapStrengthPx,
      visibleSnapTracks,
    ],
  );

  const updateBladePreview = useCallback(
    (layer: LayerSummary | null, clientX?: number) => {
      if (!bladeMode || !layer || clientX === undefined) {
        setBladePreview(null);
        return;
      }
      const atUs = bladeCutTimeFromClientX(layer, clientX);
      setBladePreview(atUs === null ? null : { layerId: layer.id, atUs });
    },
    [bladeCutTimeFromClientX, bladeMode],
  );

  useEffect(() => {
    if (!bladeMode) setBladePreview(null);
  }, [bladeMode]);

  // Blade-tool click handler: convert clientX → frame-snapped composition
  // timestamp and ask the actor to split the layer at that point. Reject
  // only when the snapped point lands exactly on a layer edge — the
  // actor would refuse that anyway, and a frame-precise editor needs
  // frame-precise cuts. After a split the user stays in blade mode
  // (NLE convention); press `C` or `Esc` to exit.
  const splitFromClientX = useCallback(
    async (layer: LayerSummary, clientX: number) => {
      const atUs = bladeCutTimeFromClientX(layer, clientX);
      if (atUs === null) return;
      setBladePreview(null);
      try {
        await splitLayerGrouped(layer.id, atUs, false);
        await onMutated();
      } catch (err) {
        console.error("blade split failed:", err);
      }
    },
    [bladeCutTimeFromClientX, onMutated],
  );

  // Esc exits blade mode. Bound at the window level so it fires regardless
  // of focus, and attached only while blade mode is on.
  const onExitBladeEvent = useEffectEvent(onExitBlade);
  useEffect(() => {
    if (!bladeMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onExitBladeEvent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bladeMode]);

  // Ruler-only seek: the time ruler is the SOLE surface that moves the
  // playhead. Begins a drag-scrub from the ruler's pointerdown. Decoupled
  // from selection — seeking never clears the selected clip.
  const beginRulerScrub = useCallback(
    (clientX: number) => {
      seekFromClientX(clientX);
      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromClientX],
  );

  return (
    <>
    <div className="flex flex-none items-center gap-2 border-b border-border-soft bg-black/20 px-2 py-1 text-[11px]">
      <DisplayModePill mode={displayMode} />
    </div>
    <div
      ref={rootRef}
      className={`scrollbar-hidden relative min-h-0 w-full flex-1 overflow-auto bg-card ${
        drag ? "cursor-grabbing select-none" : ""
      } ${heightDrag ? "cursor-ns-resize select-none" : ""} ${bladeMode ? "timeline-root-blade" : ""}`}
      onClick={clearLayerSelection}
    >
      <div className="flex min-w-max">
        {/* sticky header column */}
        <div className="sticky left-0 z-10 flex-none border-r border-border bg-card" style={{ width: HEADER_COL_PX }}>
          <div
            data-testid="timeline-ruler-corner"
            className="sticky top-0 z-[1] h-5 border-b border-border-soft bg-card"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          /> {/* ruler corner */}
          {orderedTracks.map(({ track, isGroupStart }) => (
            <Fragment key={track.id}>
              <TrackHeader
                track={track}
                height={trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT}
                isRevealed={track.id === (revealedTrackId ?? null)}
                isGroupStart={isGroupStart}
                isExpanded={expandedTracks.has(track.id)}
                hasKeyframes={trackKeyframeProperties(track).length > 0}
                onToggleExpand={() => toggleExpanded(track.id)}
                onMutated={onMutated}
              />
              {expandedTracks.has(track.id) && (
                <KeyframeLaneHeaders
                  track={track}
                  fpsNum={fpsNum}
                  fpsDen={fpsDen}
                  visible={visible}
                  onCommitParamTrack={onCommitParamTrack}
                />
              )}
            </Fragment>
          ))}
        </div>
        {/* scrolling body */}
        <div className="relative grow">
          <TimelineRuler
            pxPerSec={pxPerSec}
            totalSec={totalSec}
            widthPx={widthPx}
            viewportWidthPx={viewportWidthPx}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
            onScrub={beginRulerScrub}
          />
          <div
            ref={canvasRef}
            data-testid="timeline-canvas"
            className="relative min-w-full"
            style={{ width: widthPx }}
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
              <Fragment key={track.id}>
              <TrackLane
                track={track}
                pxPerSec={pxPerSec}
                height={trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT}
                isExpanded={expandedTracks.has(track.id)}
                selectedLayerId={primaryLayerId}
                selectedLayerIds={selectedLayerIds}
                transitions={transitions}
                selectedTransitionId={selectedTransitionId}
                groupByLayerId={groupByLayerId}
                dragState={drag}
                pendingPlacements={pendingPlacements}
                pendingLayerById={pendingLayerById}
                dragLayerById={dragLayerById}
                bladeMode={bladeMode}
                onBladeSplit={splitFromClientX}
                onBladePreview={updateBladePreview}
                onSelectFromClick={selectFromClick}
                onDragStart={(state) => setDrag(state)}
                onContextMenu={onContextMenu}
                onCommitLabel={onCommitLabel}
                onCommitParamTrack={onCommitParamTrack}
                onMediaDrop={onMediaDrop}
                isGroupStart={isGroupStart}
                isRevealed={track.id === (revealedTrackId ?? null)}
                isResizing={heightDrag !== null}
                onHeightDragStart={beginHeightDrag(track.id)}
                fpsNum={fpsNum}
                fpsDen={fpsDen}
                mediaDropSnap={mediaDropSnap}
              />
              {expandedTracks.has(track.id) && (
                <KeyframeLane
                  track={track}
                  pxPerSec={pxPerSec}
                  onCommitParamTrack={onCommitParamTrack}
                />
              )}
              </Fragment>
            ))}
            {bladePreview && (
              <BladeCutPreview
                x={(bladePreview.atUs / 1_000_000) * pxPerSec}
                label={formatTimecode(bladePreview.atUs, fpsNum, fpsDen)}
                width={widthPx}
              />
            )}
          </div>
          <TimelinePlayhead
            pxPerSec={pxPerSec}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
            visible={visible}
          />
        </div>
      </div>
    </div>
    {contextMenu && (
      <LayerContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        layerId={contextMenu.layerId}
        layerKind={contextMenu.layerKind}
        layerEnabled={contextMenu.layerEnabled}
        transitionCut={contextMenu.cut}
        onClose={() => setContextMenu(null)}
        onRename={onRename}
        onToggleEnabled={onToggleEnabled}
        onSeparateAudio={onSeparateAudio}
        onPrebakeNow={onPrebakeNow}
        onAddTransition={(cut, kind, direction) =>
          void onAddTransition(cut, kind, direction)
        }
      />
    )}
    </>
  );
}

/// The playhead line, updated at frame rate via a TRANSIENT playhead-store
/// subscription (tier 2, see playheadStore.ts): the engine emits once per
/// composition frame during playback, and routing that through React state
/// re-rendered the whole Timeline (and formerly the whole App) per frame.
/// Here the subscription mutates `style.left` on the ref'd node directly —
/// zero React commits while playing.
///
/// The one-frame-wide shadow (child node) makes the display convention
/// visible at frame-level zoom: the playhead shows the frame to its RIGHT
/// (half-open intervals — see docs/data-model.md, boundary semantics). Same
/// transient subscription, same zero-commit rule.
function TimelinePlayhead({
  pxPerSec,
  fpsNum,
  fpsDen,
  visible,
}: {
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  visible: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    const apply = (tUs: number) => {
      const leftPx = (tUs / 1_000_000) * pxPerSec;
      if (ref.current) ref.current.style.left = `${leftPx}px`;
      if (shadowRef.current) {
        const shadow = playheadFrameShadowPx(tUs, fpsNum, fpsDen, pxPerSec);
        if (shadow) {
          shadowRef.current.style.display = "block";
          // Offset relative to the playhead root, which sits at `tUs`.
          shadowRef.current.style.left = `${shadow.leftPx - leftPx}px`;
          shadowRef.current.style.width = `${shadow.widthPx}px`;
        } else {
          shadowRef.current.style.display = "none";
        }
      }
    };
    apply(playheadTimeUs());
    return usePlayheadStore.subscribe((s) => apply(s.timeUs));
  }, [pxPerSec, fpsNum, fpsDen, visible]);
  return (
    <div
      ref={ref}
      data-testid="timeline-playhead"
      className="pointer-events-none absolute bottom-0 top-0 z-[4] w-0.5 rounded-[1px] bg-gradient-to-b from-red-300 via-red-500 to-red-500 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55),0_0_6px_rgba(239,68,68,0.35)]"
      style={{ left: (playheadTimeUs() / 1_000_000) * pxPerSec }}
    >
      <div
        ref={shadowRef}
        data-testid="timeline-playhead-frame-shadow"
        className="pointer-events-none absolute bottom-0 top-0 bg-red-500/10"
        style={{ display: "none" }}
      />
      <div
        data-testid="timeline-playhead-head"
        className="sticky top-0 h-4 w-0"
      >
        <div
          data-testid="timeline-playhead-line-cap"
          className="absolute -left-1.5 top-0 h-0.5 w-3.5 bg-card"
        />
        <div
          data-testid="timeline-playhead-head-shape"
          className="absolute -left-1.5 top-0.5 h-3.5 w-3.5 bg-gradient-to-b from-[#fb7185] via-red-500 to-red-700 [clip-path:polygon(0_0,100%_0,100%_45%,50%_100%,0_45%)] [filter:drop-shadow(0_1px_1.5px_rgba(0,0,0,0.6))]"
        />
      </div>
    </div>
  );
}

function BladeCutPreview({
  x,
  label,
  width,
}: {
  x: number;
  label: string;
  width: number;
}) {
  const labelX = Math.min(Math.max(x, 44), Math.max(44, width - 44));
  return (
    <>
      <div
        data-testid="timeline-blade-preview"
        className="pointer-events-none absolute bottom-0 top-0 z-[5]"
        style={{ left: x }}
        aria-hidden="true"
      >
        <div className="absolute bottom-0 top-0 w-px -translate-x-1/2 bg-amber-300 shadow-[0_0_0_0.5px_rgba(0,0,0,0.65),0_0_8px_rgba(251,191,36,0.55)]" />
        <div className="absolute -left-1.5 top-0 h-3 w-3 bg-amber-300 shadow-[0_1px_2px_rgba(0,0,0,0.55)] [clip-path:polygon(50%_100%,0_0,100%_0)]" />
      </div>
      <div
        className="pointer-events-none absolute top-1 z-[6] -translate-x-1/2 whitespace-nowrap rounded-sm border border-amber-200/50 bg-black/80 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-amber-100 shadow-[0_1px_5px_rgba(0,0,0,0.45)]"
        style={{ left: labelX }}
        aria-hidden="true"
      >
        {label}
      </div>
    </>
  );
}

/// `docs/data-model.md`. The pill IS the setting: a click
/// flips the app-level `display_mode` (`appSettingsSet` round-trips
/// through Rust which emits `app_settings:changed` so every
/// subscriber syncs). Same surface the View menu and `T` shortcut
/// drive.
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
      className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-[3px] text-[11px] font-semibold tracking-wide transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
        mode === "AbRoll"
          ? "border-blue-400/50 bg-blue-950 text-blue-100"
          : "border-border bg-secondary text-foreground hover:bg-accent"
      }`}
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


function EmptyHint({ mode }: { mode?: "AbRoll" | "ShowAll" }) {
  const { t } = useTranslation();
  // Rendered when the user is in AB mode but no track carries a role
  // stamp; the user toggles to Show-All manually.
  const message =
    mode === "AbRoll"
      ? t("timeline.empty_ab_mode", {
          defaultValue:
            "No A/B-roll content here. Drop a clip on Video A or Video B, or click the A/B pill above to switch to Show All.",
        })
      : t("timeline.empty_placeholder");
  return <div className="p-6 text-center text-xs text-muted-foreground">{message}</div>;
}
