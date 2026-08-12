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
  addTrack,
  addTransition,
  groupsCreate,
  groupsDissolve,
  moveLayer,
  removeTransition,
  separateAudioToNewTrack,
  splitLayerGrouped,
  updateLayer,
  updateLayerParamTrack,
  updateLayerParamTracks,
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
import { findPanelLayer } from "../panels/panelLayer";
import { scaleFanOutFor } from "../keyframe/descriptors";
import { fanOutEntries } from "../keyframe/fanOut";
import { formatTimecode, snapFrameRound } from "../frames";
import {
  useDisplayMode,
  useFollowPlayheadEnabled,
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
  DROP_STRIP_HEIGHT_PX,
  HEADER_COL_PX,
  computeTimelineExtent,
  indexGroups,
  playheadFrameShadowPx,
  trackKeyframeProperties,
  visualOrderedTracks,
} from "./geometry";
import { DropStrip } from "./DropStrip";
import { TimelineRuler } from "./TimelineRuler";
import { TrackHeader } from "./TrackHeader";
import { TrackLane } from "./TrackLane";
import type { MediaDragPayload, MediaDropPlan } from "./mediaDrag";
import { KeyframeLane, KeyframeLaneHeaders } from "./KeyframeLane";
import { LayerContextMenu } from "./LayerContextMenu";
import { beginRename } from "./renameStore";
import { useTimelineView } from "./hooks/useTimelineView";
import { useFollowPlayhead } from "./hooks/useFollowPlayhead";
import { useHeightDrag } from "./hooks/useHeightDrag";
import { useLayerDrag } from "./hooks/useLayerDrag";
import { snapTimeToTimelineBoundary } from "./snapping";
import { playheadTimeUs, usePlayheadStore } from "../state/playheadStore";
import {
  useRangeInUs,
  useRangeOutUs,
  useRangeReveal,
} from "../state/rangeStore";
import { setTimelineScrollLeftPx } from "../state/timelineScrollStore";
import {
  registerScrollToTime,
  revealTrackWithoutSelection,
} from "../state/navigation";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  clearTransitionSelection,
  extendLayerSelection,
  setLayerSelection,
  usePrimaryLayerId,
  useSelectedLayerIds,
  useSelectedTransitionId,
} from "../state/selectionStore";
import { resolveAccelerator } from "../shortcuts/match";
import { subSelectionDeleteYields } from "./subSelectionDelete";
import { useEffectiveBindings } from "../shortcuts/bindings-context";
import { logMutationFailure } from "../errors/tryMutate";
import {
  CUT_CLICK_TOLERANCE_PX,
  defaultTransitionDurationUs,
  findCutNear,
  type TransitionCut,
  type TransitionKindName,
} from "./transitions";

// Any media kind drops on any track (tracks are kind-agnostic); the
// main-process state layer enforces the overlap rules (`main/state/validate.ts`).
function trackAcceptsMedia(_trackKind: string, _mediaKind: string): boolean {
  return true;
}


// Drops land on their target track directly — nothing is auto-routed elsewhere.
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
  /// True while the Blade tool is armed (`toolStore.ts`; `C` selects it).
  /// Layer clicks then split at the click point instead of selecting, and
  /// the cursor turns into a razor. Exit by selecting the Selection tool
  /// (`V`) or pressing Esc (handled here).
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
    zoomBySteps,
  } = useTimelineView({ rootRef, tracks, durationUs });

  // Horizontal scroll-to-time for palette jumps.
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

  // Page the view to keep the playhead visible (app-level pref, default on).
  // Also gated on `visible`, like the playhead line itself: a timeline behind
  // another dock tab has nothing to keep in view.
  const followEnabled = useFollowPlayheadEnabled();
  const { setScrubbing: setFollowScrubbing } = useFollowPlayhead({
    rootRef,
    pxPerSec,
    viewportWidthPx,
    contentWidthPx: widthPx,
    enabled: followEnabled && visible,
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

  /// Handlers for the group actions (`ACTION_DEFS.groupSelected` /
  /// `dissolveSelectedGroup` own the keys and the why). They read state via
  /// refs to avoid the stale-closure trap of multi-key chord dispatch.
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
      logMutationFailure(err, "Group layers");
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
      logMutationFailure(err, "Dissolve group");
    }
  }, []);

  // ── Sub-frame audio slip (ADR 0038) ────────────────────────────────────────
  // Why keys are the authoring surface at all: see the ADR 0038 note on
  // `ACTION_DEFS.nudgeAudioSampleBack`.
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
          logMutationFailure(err, "Slip audio");
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

  // ── Keyboard zoom, anchored on the playhead ────────────────────────────────
  // Read at press time rather than subscribed: the playhead moves once per
  // composition frame and this component is the whole timeline tree, so a
  // subscription here would re-render all of it during playback (the regression
  // `state/timelineScrollStore.ts` guards). A one-off read is also the only
  // correct one — the anchor is where the playhead is when the key goes down.
  const handleZoomTimelineIn = useCallback(
    () => zoomBySteps(1, playheadTimeUs()),
    [zoomBySteps],
  );
  const handleZoomTimelineOut = useCallback(
    () => zoomBySteps(-1, playheadTimeUs()),
    [zoomBySteps],
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
      zoomTimelineIn: handleZoomTimelineIn,
      zoomTimelineOut: handleZoomTimelineOut,
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
    {
      id: "zoomTimelineIn",
      actionId: "zoomTimelineIn",
      labelKey: ACTION_DEFS.zoomTimelineIn.labelKey,
      run: handleZoomTimelineIn,
    },
    {
      id: "zoomTimelineOut",
      actionId: "zoomTimelineOut",
      labelKey: ACTION_DEFS.zoomTimelineOut.labelKey,
      run: handleZoomTimelineOut,
    },
  ]);

  // Live lane-element registry. The drag hit-test measures these nodes rather
  // than recomputing row offsets from track heights — a row's on-screen extent
  // includes chrome that arithmetic misses (see `trackIdAtClientY`).
  const laneElsRef = useRef(new Map<string, HTMLElement>());
  const registerLaneEl = useCallback((trackId: string, el: HTMLElement | null) => {
    if (el) laneElsRef.current.set(trackId, el);
    else laneElsRef.current.delete(trackId);
  }, []);

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
      laneEls: laneElsRef,
      pxPerSec,
      fpsNum,
      fpsDen,
      tailSnapEnabled,
      tailSnapStrengthPx,
      onMutated,
    });

  // -------- Media drop, seek, render --------

  // A spawned lane carries no role, so the A/B filter above would hide the clip
  // the user just dropped. Route it through the existing inline-reveal (R.7)
  // rather than a second visibility rule. Held as state because the reveal
  // registry validates against `projectStore`, which refreshes on its own
  // `project:changed` subscription and can still be one fetch behind this drop.
  const [spawnRevealTrackId, setSpawnRevealTrackId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const trackId = spawnRevealTrackId;
    if (trackId === null) return;
    const attempt = () => {
      if (!revealTrackWithoutSelection(trackId)) return false;
      setSpawnRevealTrackId(null);
      return true;
    };
    if (attempt()) return;
    return useProjectStore.subscribe(() => void attempt());
  }, [spawnRevealTrackId]);

  const onMediaDrop = useCallback(
    async (
      // null = the drop strip: no lane exists yet, so one is created first.
      track: TrackSummary | null,
      payload: MediaDragPayload,
      plan: MediaDropPlan,
    ) => {
      if (
        track !== null &&
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
        // Spawn-then-place is TWO commits, matching what the layer-adding
        // commands already do when their reverse scan finds no free lane
        // (`main/state/actor.ts`, add_color_layer): the track add gets its own
        // op_id, then the layer add gets a second one. One history entry for the
        // whole gesture is #06's problem — moving an EXISTING clip is where the
        // cost of two entries is visible, because undo has to give a lane back.
        const trackId = track !== null ? track.id : await addTrack();
        await addMediaLayer(trackId, payload.mediaId, plan.rawStartUs);
        if (track === null && displayMode !== "ShowAll") {
          setSpawnRevealTrackId(trackId);
        }
        await onMutated();
      } catch (err) {
        console.error("media drop failed:", err);
      }
    },
    [displayMode, importing, media, onMutated, previewDecodable, proxyState],
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
  // through the status bar / log (errors/formatCommandError.ts owns the
  // copy — TransitionInsufficientHandle renders `available_us` with the
  // layer's name). NO silent clamping.
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
        logMutationFailure(err, "Add transition");
      }
    },
    [fpsNum, fpsDen, onMutated],
  );

  // Delete/Backspace removes the selected transition chip. Capture phase +
  // stopImmediatePropagation preempts the app-level delete-selected-layer
  // shortcut (same pattern as the keyframe-diamond Delete in LayerBlock);
  // armed only while a chip is selected, and never while typing in a field or
  // while another panel owns the keyboard (`subSelectionDeleteYields`).
  useEffect(() => {
    if (selectedTransitionId === null) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      if (subSelectionDeleteYields(ev.target)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      void (async () => {
        try {
          await removeTransition(selectedTransitionId);
          clearTransitionSelection();
          await onMutatedRef.current();
        } catch (err) {
          logMutationFailure(err, "Remove transition");
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
        logMutationFailure(e, "Rename layer");
      }
    },
    [onMutated],
  );

  const onCommitParamTrack = useCallback(
    async (layerId: string, paramKey: string, track: AnimTrack<number>) => {
      try {
        // Every timeline keyframe edit (value field, diamond drag, interp
        // menu, curve editor, navigator) funnels through here. A scale write
        // on a LINKED layer fans out to both axes in one batch — otherwise
        // the result-based invariant would read the single-axis write as
        // divergence and silently unlink the layer.
        const layer = findPanelLayer(tracks, layerId);
        const fanOut = scaleFanOutFor(paramKey, layer?.params ?? null);
        if (fanOut) {
          await updateLayerParamTracks(layerId, fanOutEntries(fanOut, track));
        } else {
          await updateLayerParamTrack(layerId, paramKey, track);
        }
        await onMutated();
      } catch (e) {
        logMutationFailure(e, "Edit keyframes");
      }
    },
    [onMutated, tracks],
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
        logMutationFailure(e, "Toggle layer");
      }
    },
    [onMutated],
  );

  // Close the context menu when the timeline scrolls under it — the
  // popup is anchored to fixed cursor coordinates, so it would float
  // detached over moving content. Outside-click and Escape closing belong
  // to Base UI.
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
        logMutationFailure(err, "Separate audio");
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
        logMutationFailure(err, "Blade split");
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
      // Hold the view still for the length of the drag: the user is aiming at a
      // point they can see, and a follow-page mid-gesture would move the target
      // out from under the pointer (see `useFollowPlayhead`).
      setFollowScrubbing(true);
      seekFromClientX(clientX);
      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        setFollowScrubbing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromClientX, setFollowScrubbing],
  );

  return (
    <>
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
          {/* Row-alignment spacer for the drop strip in the body below. These
              two loops paint the same rows in the same order out of two
              columns; a row present in one and missing from the other slides
              every header beneath it out of line with its lane. */}
          <div
            data-testid="timeline-drop-strip-header"
            className="bg-card"
            style={{ height: DROP_STRIP_HEIGHT_PX }}
            aria-hidden="true"
          />
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
            <DropStrip
              pxPerSec={pxPerSec}
              fpsNum={fpsNum}
              fpsDen={fpsDen}
              mediaDropSnap={mediaDropSnap}
              onMediaDrop={onMediaDrop}
            />
            {orderedTracks.length === 0 && <EmptyHint mode={displayMode} />}
            {/*
              Data model: `tracks[0]` is the bottom of the z-stack, `tracks[last]`
              is the top (see `docs/data-model.md`). `visualOrderedTracks`
              reverses that, so the tail of the array is the TOP row here — it
              splits role-stamped lanes from role-less ones, it does NOT bucket
              by kind. The role-less section is the one at the top, which is
              where the strip above spawns into.
            */}
            {orderedTracks.map(({ track, isGroupStart }) => (
              <Fragment key={track.id}>
              <TrackLane
                track={track}
                registerLaneEl={registerLaneEl}
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
            <OutOfRangeDim pxPerSec={pxPerSec} />
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

/**
 * Washes out everything outside the marked in/out span — but only for a beat
 * after the range changes, then fades away. The standing record of the range
 * lives elsewhere — see `RangeCap` in TimelineRuler.tsx for the permanent-mark
 * vs transient-wash split.
 *
 * `z-[4]` clears every LayerBlock (max `z-[3]`) while staying under the blade
 * preview (`z-[5]`) and the playhead, which must never read as out-of-range.
 * The node stays mounted at zero opacity so the fade is a CSS transition
 * rather than a pop; `pointer-events-none` keeps it inert either way.
 */
function OutOfRangeDim({ pxPerSec }: { pxPerSec: number }) {
  const inUs = useRangeInUs();
  const outUs = useRangeOutUs();
  const revealed = useRangeReveal();
  if (inUs === null && outUs === null) return null;
  // An unmarked side means "to the edge", matching `resolveMarkedRange`: one
  // point alone is a complete instruction, not half a range — so that side
  // simply renders no wash.
  const inPx = inUs !== null ? (inUs / 1_000_000) * pxPerSec : 0;
  const outPx = outUs !== null ? (outUs / 1_000_000) * pxPerSec : 0;
  return (
    <div
      data-testid="timeline-out-of-range"
      data-revealed={revealed ? "true" : "false"}
      className={`pointer-events-none absolute inset-0 z-[4] transition-opacity duration-300 ${
        revealed ? "opacity-100" : "opacity-0"
      }`}
      aria-hidden="true"
    >
      {inUs !== null && inPx > 0 && (
        <div
          className="absolute inset-y-0 left-0 bg-background/65"
          style={{ width: inPx }}
        />
      )}
      {/* Anchored `right-0` rather than sized `widthPx - outPx`: the canvas
          carries `min-w-full`, so on a project shorter than the viewport it is
          WIDER than `widthPx` and a computed width would stop short of its real
          right edge, leaving an undimmed strip past the end of the project. */}
      {outUs !== null && (
        <div
          className="absolute inset-y-0 right-0 bg-background/65"
          style={{ left: outPx }}
        />
      )}
    </div>
  );
}

/// The playhead line, updated at frame rate via a TRANSIENT playhead-store
/// subscription (tier 2, see playheadStore.ts): the engine emits once per
/// composition frame during playback, and routing that through React state
/// re-renders the whole Timeline per frame.
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



function EmptyHint({ mode }: { mode?: "AbRoll" | "ShowAll" }) {
  const { t } = useTranslation();
  // Rendered when the user is in AB mode but no track carries a role
  // stamp; the user switches to Show-All manually.
  //
  // The hint names the KEY, not the Quick Actions button: the strip is a Panel
  // the user can close or drag away, whereas the binding is always live. Read
  // through the bindings context so a remap can't make this text lie.
  const binding = useEffectiveBindings("toggleDisplayMode");
  const accelerator = binding ? resolveAccelerator(binding) : "";
  const message =
    mode === "AbRoll"
      ? t("timeline.empty_ab_mode", {
          key: accelerator,
          defaultValue:
            "No A/B-roll content here. Drop a clip on Video A or Video B, or press {{key}} to show all tracks.",
        })
      : t("timeline.empty_placeholder");
  return <div className="p-6 text-center text-xs text-muted-foreground">{message}</div>;
}
