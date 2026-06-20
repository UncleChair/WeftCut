import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  addMediaLayer,
  groupsCreate,
  groupsDissolve,
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
  DEFAULT_TRACK_HEIGHT,
  HEADER_COL_PX,
  indexGroups,
  trackKeyframeProperties,
  visualOrderedTracks,
} from "./geometry";
import { TimelineRuler } from "./TimelineRuler";
import { TrackHeader } from "./TrackHeader";
import { TrackLane, type MediaDragPayload } from "./TrackLane";
import { KeyframeLane, KeyframeLaneHeaders } from "./KeyframeLane";
import { LayerContextMenu } from "./LayerContextMenu";
import { beginRename } from "./renameStore";
import { useTimelineView } from "./hooks/useTimelineView";
import { useHeightDrag } from "./hooks/useHeightDrag";
import { useLayerDrag } from "./hooks/useLayerDrag";

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
  /// `docs/groups.md`. Empty array when no groups exist.
  groups: GroupSummary[];
  durationUs: number;
  currentTimeUs: number;
  selectedLayerId: string | null;
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
  previewDecodable,
  onExitBlade,
  onSelect,
  onSeek,
  onMutated,
}: TimelineProps) {
  // Right-click context-menu state. `null` when closed; otherwise
  // anchors the menu at the cursor and stores the target layer id.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    layerKind: string;
    layerEnabled: boolean;
  } | null>(null);
  /// `docs/groups.md` — multi-select for `Ctrl+G` and visual highlight.
  /// `selectedLayerId` (from App) is the primary (drives PropertyPanel);
  /// this set tracks every layer that should render with the selected
  /// chrome. Stays in sync via the click handlers below.
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const {
    pxPerSec,
    trackHeights,
    setTrackHeights,
    trackHeightsRef,
    expandedTracks,
    toggleExpanded,
  } = useTimelineView({ rootRef, tracks, durationUs });

  const totalSec = Math.max(durationUs / 1_000_000, 5);
  const widthPx = totalSec * pxPerSec;

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
  /// Wired through the global `useShortcuts` registry so the Keyboard
  /// Shortcuts settings panel exposes them and they're rebindable.
  /// Handlers read state via refs to avoid the
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

  const { heightDrag, beginHeightDrag } = useHeightDrag({
    trackHeightsRef,
    setTrackHeights,
  });

  const { drag, setDrag, pendingPlacement, pendingLayer, dragLayer } =
    useLayerDrag({
      tracks,
      groups,
      groupByLayerId,
      orderedTracks,
      trackRows,
      canvasRef,
      pxPerSec,
      currentTimeUs,
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
      const readiness = mediaReadiness(m, importing, proxyState, {
        previewDecodable: previewDecodable.has(m.id),
      });
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
    [importing, media, onMutated, previewDecodable, proxyState, pxPerSec],
  );

  // Context-menu open handler. Captures cursor position + target layer;
  // triggered by LayerBlock's onContextMenu (right-click).
  const onContextMenu = useCallback(
    (
      e: React.MouseEvent,
      layerId: string,
      layerKind: string,
      layerEnabled: boolean,
    ) => {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        layerId,
        layerKind,
        layerEnabled,
      });
    },
    [],
  );

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
      className={`relative min-h-0 w-full flex-1 overflow-auto bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
        drag ? "cursor-grabbing select-none" : ""
      } ${heightDrag ? "cursor-ns-resize select-none" : ""} ${bladeMode ? "timeline-root-blade" : ""}`}
      onClick={() => onSelect(null)}
    >
      <div className="flex min-w-max">
        {/* sticky header column */}
        <div className="sticky left-0 z-10 flex-none border-r border-border bg-card" style={{ width: HEADER_COL_PX }}>
          <div
            className="h-5 border-b border-border-soft"
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
                  currentTimeUs={currentTimeUs}
                  fpsNum={fpsNum}
                  fpsDen={fpsDen}
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
            widthPx={Math.max(widthPx, 200)}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
            onScrub={beginRulerScrub}
          />
          <div
            ref={canvasRef}
            className="relative min-w-full"
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
              <Fragment key={track.id}>
              <TrackLane
                track={track}
                pxPerSec={pxPerSec}
                height={trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT}
                isExpanded={expandedTracks.has(track.id)}
                selectedLayerId={selectedLayerId}
                selectedLayerIds={selectedLayerIds}
                groupByLayerId={groupByLayerId}
                dragState={drag}
                pendingPlacement={pendingPlacement}
                pendingLayer={pendingLayer}
                dragLayer={dragLayer}
                bladeMode={bladeMode}
                onBladeSplit={splitFromClientX}
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
          </div>
          {currentTimeUs >= 0 && (
            <div
              data-testid="timeline-playhead"
              className="pointer-events-none absolute bottom-0 top-0.5 z-[4] w-0.5 rounded-[1px] bg-gradient-to-b from-red-300 via-red-500 to-red-500 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55),0_0_6px_rgba(239,68,68,0.35)]"
              style={{ left: playheadX }}
            >
              <div className="absolute -left-1.5 top-0 h-3.5 w-3.5 bg-gradient-to-b from-[#fb7185] via-red-500 to-red-700 [clip-path:polygon(0_0,100%_0,100%_45%,50%_100%,0_45%)] [filter:drop-shadow(0_1px_1.5px_rgba(0,0,0,0.6))]" />
            </div>
          )}
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
        onClose={() => setContextMenu(null)}
        onRename={onRename}
        onToggleEnabled={onToggleEnabled}
        onSeparateAudio={onSeparateAudio}
        onPrebakeNow={onPrebakeNow}
      />
    )}
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
