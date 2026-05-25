import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  addMediaLayer,
  groupsCreate,
  groupsDissolve,
  moveLayer,
  separateAudioToNewTrack,
  splitLayerGrouped,
  trimLayer,
  updateLayer,
  viewStateGet,
  viewStateSet,
  type GroupSummary,
  type KeybindingsMap,
  type LayerSummary,
  type MediaSummary,
  type TrackSummary,
} from "../ipc";
import { mediaReadiness, type ProxyState } from "../panels/mediaReadiness";
import { formatTimecode, frameDurUs, snapFrameRound } from "../frames";
import {
  toggleDisplayMode,
  useDisplayMode,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "../settings/appSettingsStore";
import { useShortcuts, type OverrideMap } from "../shortcuts";

// Zoom + height bounds. The default matches the pre-refactor constant so
// projects that have never written `view.json` look identical to before.
// The lower bound is computed dynamically as `viewport / totalSec` so
// Ctrl+wheel can always zoom out far enough to fit the entire timeline
// in view, regardless of how long it is. `MIN_PX_PER_SEC_FLOOR` is a
// tiny absolute floor that keeps the math sane in pathological cases
// (zero-width viewport, zero-duration project).
const DEFAULT_PX_PER_SEC = 80;
const MIN_PX_PER_SEC_FLOOR = 0.05;
const MAX_PX_PER_SEC = 800;
// V.6 (A/B-roll v2): default row is taller so combined V+A rows have
// room for a thumbnail strip (top half) + waveform strip (bottom half).
// Single-class tracks still fit comfortably at this height.
const DEFAULT_TRACK_HEIGHT = 56;
const MIN_TRACK_HEIGHT = 24;
const MAX_TRACK_HEIGHT = 200;
const MIN_LAYER_DURATION_US = 100_000;
// Debounce window after the last zoom/height edit before we hit disk.
// Resize-drag tends to fire ~60×/sec; 200ms keeps the file write off the
// critical drag path while still landing within a beat of the user
// releasing the handle.
const VIEW_SAVE_DEBOUNCE_MS = 200;

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

interface VisualTrack {
  track: TrackSummary;
  /// True when this is the first lane of its kind group — the renderer adds
  /// a divider line above it. Today the boundaries are: between the video
  /// stack and subtitles, and between subtitles and the audio stack.
  isGroupStart: boolean;
}

/// V.6 layer-overlap class. Visual-class layers (VideoClip,
/// ImageOverlay, Color, Template, Text, Subtitles) can't overlap each
/// other on a track; Audio can't overlap Audio. Visual + Audio CAN
/// coexist at the same time — that's the AE-style "combined row"
/// trigger.
type LayerOverlapClass = "visual" | "audio";

function layerOverlapClass(layer: LayerSummary): LayerOverlapClass {
  return layer.params.kind === "Audio" ? "audio" : "visual";
}

/// Vertical slice the layer occupies within its track row:
///   - "full"   — uses the entire row height (default; no opposite-
///                class layer overlaps in time)
///   - "top"    — uses the top half (Visual layer paired with an
///                Audio layer at the same time slot)
///   - "bottom" — uses the bottom half (Audio layer paired with a
///                Visual layer at the same time slot)
type LayerSlice = "full" | "top" | "bottom";

function computeLayerSlices(
  layers: readonly LayerSummary[],
): Map<string, LayerSlice> {
  // Walk all (visual, audio) pairs; any overlap in time flips both
  // sides to half-height. O(V × A) per track, which is fine because a
  // typical track has at most a handful of layers.
  const slices = new Map<string, LayerSlice>();
  const visual = layers.filter((l) => layerOverlapClass(l) === "visual");
  const audio = layers.filter((l) => layerOverlapClass(l) === "audio");
  for (const v of visual) {
    for (const a of audio) {
      if (v.t_end_us > a.t_start_us && a.t_end_us > v.t_start_us) {
        slices.set(v.id, "top");
        slices.set(a.id, "bottom");
      }
    }
  }
  // Layers that didn't get a half-slot stay full-height.
  for (const l of layers) {
    if (!slices.has(l.id)) slices.set(l.id, "full");
  }
  return slices;
}

// V.8 (`docs/ab-roll-redesign` v2) — track rendering order is now a
// simple reverse of the data-model. Data-model convention (idx 0 =
// bottom of z-stack, last = top) maps directly to "last index renders
// at the top of the screen", matching the editor convention that the
// top-of-z-stack composites visually on top.
//
//   data-model (bottom → top of z-stack)        visual (top → bottom of screen)
//   ┌─────────────────────────────────┐         ┌─────────────────────────────┐
//   │ idx 0 — additional / transient  │         │ B roll                      │
//   │ idx 1 — A roll                  │   ⇄     │ B's separated audio (if any)│
//   │ idx 2 — A's separated audio     │ reverse │ A roll                      │
//   │ idx 3 — B roll                  │         │ A's separated audio (if any)│
//   │ idx 4 — B's separated audio     │         │ additional / transient      │
//   │ idx 5 — additional (extra)      │         └─────────────────────────────┘
//   └─────────────────────────────────┘
//
// Placement rules at creation time (NOT in this function):
//   - import_media: prepends the transient track at idx 0 → visually
//     at the bottom of the timeline, out of the way of A/B work.
//   - separate_audio_to_new_track: inserts at `source.idx` (source
//     shifts up) so audio sits BELOW its video visually.
//
// Group-start dividers separate the kind-buckets visually. Today we
// only emit a divider between the role-stamped tracks and the
// transient tail (the "additional" region at the bottom). Future
// kind-cluster dividers can be added if needed.
function visualOrderedTracks(tracks: TrackSummary[]): VisualTrack[] {
  // Simple reverse: walk the data-model from last index to first.
  const reversed = tracks.slice().reverse();
  const out: VisualTrack[] = [];
  let prevSection: "role" | "extra" | null = null;
  for (const track of reversed) {
    // Role-stamped tracks (the reserved A/B skeleton + their separated
    // audio derivatives if any) form one section; everything else
    // (transient imports, user/agent-added additional tracks) forms
    // the bottom section. The boundary between them gets a divider.
    const section: "role" | "extra" = track.role !== null ? "role" : "extra";
    const isGroupStart = prevSection !== null && section !== prevSection;
    out.push({ track, isGroupStart });
    prevSection = section;
  }
  return out;
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

type DragKind = "move" | "trim-start" | "trim-end";

interface DragState {
  kind: DragKind;
  layerId: string;
  trackId: string;
  /// Carried so cross-track drops only land on tracks of the same kind.
  trackKind: string;
  startX: number;
  startY: number;
  originalTStart: number;
  originalTEnd: number;
  deltaUs: number;
  /// During cross-track drag, which track is the pointer currently over.
  overTrackId: string | null;
  /// `docs/group-system.md` — when true (Alt-held at drag start), this op
  /// stays local even if the dragged layer is in a group. Passed straight
  /// to `moveLayer` / `trimLayer` as `escape_group`.
  escapeGroup: boolean;
}

interface HeightDragState {
  trackId: string;
  startY: number;
  startHeight: number;
}

interface TimelineProps {
  tracks: TrackSummary[];
  /// `docs/group-system.md`. Empty array when no groups exist.
  groups: GroupSummary[];
  durationUs: number;
  currentTimeUs: number;
  selectedLayerId: string | null;
  /// R.7 (`docs/ab-roll-redesign`): when set, this hidden track is
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/// `docs/group-system.md`. Stable, deterministic hue per group id so all
/// members share an accent color across renders. Skips the yellow/green
/// band that conflicts with the "is-selected" highlight in `styles.css`.
function groupHue(groupId: string): number {
  let h = 0;
  for (let i = 0; i < groupId.length; i++) {
    h = (h * 31 + groupId.charCodeAt(i)) >>> 0;
  }
  // 360 hues, skip 60-120 (yellow/green band).
  const raw = h % 300;
  return raw < 60 ? raw : raw + 60;
}

/// Build the layer-id → group-id lookup used by every render path that
/// asks "what group is this in?". `groups` is small in practice (a
/// handful), so a simple O(N*M) walk is cheaper than a Map allocation.
function indexGroups(groups: GroupSummary[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const g of groups) {
    for (const lid of g.layer_ids) {
      idx.set(lid, g.id);
    }
  }
  return idx;
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
  const [heightDrag, setHeightDrag] = useState<HeightDragState | null>(null);
  // V.7: right-click context-menu state. `null` when closed; otherwise
  // anchors the menu at the cursor and stores the target layer id.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    layerKind: string;
  } | null>(null);
  /// `docs/group-system.md` — multi-select for `Ctrl+G` and visual highlight.
  /// `selectedLayerId` (from App) is the primary (drives PropertyPanel);
  /// this set tracks every layer that should render with the selected
  /// chrome. Stays in sync via the click handlers below.
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const groupByLayerId = useMemo(() => indexGroups(groups), [groups]);

  // A/B-roll display mode comes from the app-level settings store
  // (`docs/ab-roll-redesign`). The store hydrates on app mount via
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
  /// `docs/group-system.md`: plain click on a grouped layer selects the
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

  /// `docs/group-system.md` — Mod+G groups the current multi-selection;
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
        // `docs/group-system.md` — Alt-held at drag start opts the move /
        // trim out of group fanout for this single op.
        const escape = committed.escapeGroup;
        switch (committed.kind) {
          case "move": {
            const newStart = Math.max(0, committed.originalTStart + deltaUs);
            const destTrackId =
              overTrack && trackAcceptsForLayer(overTrack, committed)
                ? overTrack.id
                : committed.trackId;
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

  // Close the context menu on any click outside its own area.
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => setContextMenu(null);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onDown, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onDown, true);
    };
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
        onSeparateAudio={onSeparateAudio}
      />
    )}
    </>
  );
}

/// V.7 floating context menu. Anchored at the cursor; closes on any
/// outside pointer-down (wired in Timeline above). Shows action items
/// scoped to the right-clicked layer's kind — today the only entry is
/// "Separate audio to new track" when the target is an Audio layer.
/// (The 2026-05-17 effect-redesign removed the H.6 render-mode toggle;
/// group html-rendering is now driven by the presence of an
/// HtmlTransform effect on the group, authored via MCP / a future
/// effects panel.)
function LayerContextMenu({
  x,
  y,
  layerId,
  layerKind,
  onSeparateAudio,
}: {
  x: number;
  y: number;
  layerId: string;
  layerKind: string;
  onSeparateAudio: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="layer-context-menu"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {layerKind === "Audio" ? (
        <button
          type="button"
          className="layer-context-menu-item"
          onClick={() => onSeparateAudio(layerId)}
        >
          {t("timeline.separate_audio", {
            defaultValue: "Separate audio to new track",
          })}
        </button>
      ) : (
        <span className="layer-context-menu-disabled">
          {t("timeline.no_actions_here", {
            defaultValue: "(no actions for this layer)",
          })}
        </span>
      )}
    </div>
  );
}

/// `docs/ab-roll-redesign` R.5b. The pill IS the setting: a click
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

/// Time ruler that lives at the top of the scrollable `.timeline-root`,
/// replacing the legacy 18 px playhead-strip padding. Width matches the
/// canvas so horizontal scroll keeps ticks aligned with the layers
/// below, and tick density scales with `pxPerSec`.
///
/// Two regimes:
///   - Below `pxPerFrame >= FRAME_MODE_THRESHOLD_PX`: classic
///     second-level NICE_STEPS_SEC ladder, mm:ss labels.
///   - At/above the threshold: switch to frame-grid mode. Major-tick
///     stride is the largest of `NICE_STEPS_FRAMES` where
///     `stride * pxPerFrame >= TARGET_MAJOR_PX_FRAME_MODE`, labels read
///     SMPTE `HH:MM:SS:FF`, and minor ticks land at every single frame
///     regardless of major stride so the user has a visible frame
///     grid to align edits against.
function TimelineRuler({
  pxPerSec,
  totalSec,
  widthPx,
  fpsNum,
  fpsDen,
}: {
  pxPerSec: number;
  totalSec: number;
  widthPx: number;
  fpsNum: number;
  fpsDen: number;
}) {
  // Major-tick candidates: classic 1/2/5 decade ladder extended into
  // sub-second territory for high-zoom cases. Anything above 600 s
  // falls off the top of the ladder and clamps to 600.
  const NICE_STEPS_SEC = [
    0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600,
  ] as const;
  const NICE_STEPS_FRAMES = [1, 2, 5, 10, 30] as const;
  const TARGET_MAJOR_PX = 100;
  const TARGET_MAJOR_PX_FRAME_MODE = 80;
  const SUBDIVISIONS = 5;
  const FRAME_MODE_THRESHOLD_PX = 12;

  const { items, majorSec, isFrameMode } = useMemo(() => {
    const fDur = frameDurUs(fpsNum, fpsDen);
    const pxPerFrame = (fDur / 1_000_000) * pxPerSec;
    const frameMode = pxPerFrame >= FRAME_MODE_THRESHOLD_PX;

    if (frameMode) {
      // Pick the largest stride from [1, 2, 5, 10, 30] where the
      // major-tick spacing meets the target px. Fall back to the
      // largest if none meet the target (very low zoom for a
      // high-fps comp — rare).
      let stride = NICE_STEPS_FRAMES[0]!;
      for (let i = NICE_STEPS_FRAMES.length - 1; i >= 0; i--) {
        if (NICE_STEPS_FRAMES[i]! * pxPerFrame >= TARGET_MAJOR_PX_FRAME_MODE) {
          stride = NICE_STEPS_FRAMES[i]!;
        }
      }
      // Minor ticks at every frame; majors at every `stride` frames.
      const totalFrames =
        Math.ceil(totalSec * 1_000_000 / fDur) + 1;
      const out: { i: number; x: number; t: number; isMajor: boolean }[] = [];
      for (let f = 0; f <= totalFrames; f++) {
        const tUs = f * fDur;
        out.push({
          i: f,
          x: (tUs / 1_000_000) * pxPerSec,
          t: tUs / 1_000_000,
          isMajor: f % stride === 0,
        });
      }
      // stride retained in `f % stride === 0` above — not needed outside this branch.
      void stride;
      return { items: out, majorSec: 0, isFrameMode: true };
    }

    const targetSec = TARGET_MAJOR_PX / pxPerSec;
    let major = NICE_STEPS_SEC[NICE_STEPS_SEC.length - 1] ?? 1;
    for (const s of NICE_STEPS_SEC) {
      if (s >= targetSec) {
        major = s;
        break;
      }
    }
    const minor = major / SUBDIVISIONS;
    const out: { i: number; x: number; t: number; isMajor: boolean }[] = [];
    // Allow a half-step over `totalSec` so the trailing major lands on
    // a clean number if the timeline ends mid-interval — visually it
    // gets clipped by the canvas width, but the major label stays on
    // its grid until the very end.
    const limit = totalSec + minor * 0.5;
    for (let i = 0; ; i++) {
      const t = i * minor;
      if (t > limit) break;
      out.push({ i, x: t * pxPerSec, t, isMajor: i % SUBDIVISIONS === 0 });
    }
    return { items: out, majorSec: major, isFrameMode: false };
  }, [pxPerSec, totalSec, fpsNum, fpsDen]);

  return (
    <div className="timeline-ruler" style={{ width: widthPx }}>
      {items.map((tk) => (
        <div
          key={tk.i}
          className={`ruler-tick ${tk.isMajor ? "is-major" : "is-minor"}`}
          style={{ left: tk.x }}
        >
          {tk.isMajor && (
            <span className="ruler-label">
              {isFrameMode
                ? formatTimecode(Math.round(tk.t * 1_000_000), fpsNum, fpsDen)
                : formatRulerLabel(tk.t, majorSec)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/// `mm:ss` for second-grain steps, `mm:ss.cs` (centiseconds) for
/// sub-second steps so the user sees a meaningful precision delta as
/// they zoom in. Rounding is done in integer milliseconds to keep
/// floating-point accumulation out of the label.
function formatRulerLabel(seconds: number, majorSec: number): string {
  const sec = Math.max(0, seconds);
  const ms = Math.round(sec * 1000);
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const ssStr = String(ss).padStart(2, "0");
  if (majorSec < 1) {
    const cs = Math.round((ms % 1000) / 10);
    return `${mm}:${ssStr}.${String(cs).padStart(2, "0")}`;
  }
  return `${mm}:${ssStr}`;
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
}: {
  track: TrackSummary;
  pxPerSec: number;
  height: number;
  selectedLayerId: string | null;
  selectedLayerIds: Set<string>;
  groupByLayerId: Map<string, { id: string; renderMode: "Native" | "Html" }>;
  dragState: DragState | null;
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
}) {
  const { t } = useTranslation();
  const kindLabel = t(`kinds.${track.kind.toLowerCase()}`, {
    defaultValue: track.kind,
  });
  const [dragOverX, setDragOverX] = useState<number | null>(null);

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
        const slices = computeLayerSlices(track.layers);
        return track.layers.map((layer) => (
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
            bladeMode={bladeMode}
            onBladeSplit={onBladeSplit}
            onSelect={onSelect}
            onSelectFromClick={onSelectFromClick}
            onDragStart={onDragStart}
            onContextMenu={onContextMenu}
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

function LayerBlock({
  layer,
  trackId,
  trackKind,
  pxPerSec,
  laneHeight,
  slice,
  isPrimary,
  isSelected,
  groupId,
  dragState,
  bladeMode,
  onBladeSplit,
  onSelect,
  onSelectFromClick,
  onDragStart,
  onContextMenu,
}: {
  layer: LayerSummary;
  trackId: string;
  trackKind: string;
  pxPerSec: number;
  laneHeight: number;
  /// V.6 vertical slot. "full" = entire row; "top" = top half (visual
  /// layer paired with audio); "bottom" = bottom half (audio paired
  /// with visual). Determines the rendered height + top offset.
  slice: LayerSlice;
  /// Primary selection (drives PropertyPanel). One layer at a time.
  isPrimary: boolean;
  /// Member of the current selection set (highlight only).
  isSelected: boolean;
  /// `docs/group-system.md` — null when ungrouped.
  groupId: string | null;
  dragState: DragState | null;
  /// Blade-tool mode: pointerdown splits at the click point instead
  /// of selecting/dragging. Cursor is set by the timeline-root class.
  bladeMode: boolean;
  onBladeSplit: (layer: LayerSummary, clientX: number) => void;
  onSelect: (id: string | null) => void;
  onSelectFromClick: (
    layerId: string,
    e: { altKey: boolean; shiftKey: boolean; metaKey: boolean },
  ) => void;
  onDragStart: (state: DragState) => void;
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
  ) => void;
}) {
  const { t } = useTranslation();
  const isDragging = dragState?.layerId === layer.id;
  let liveStart = layer.t_start_us;
  let liveEnd = layer.t_end_us;
  if (isDragging && dragState) {
    const dx = dragState.deltaUs;
    switch (dragState.kind) {
      case "move":
        liveStart += dx;
        liveEnd += dx;
        break;
      case "trim-start":
        liveStart = Math.min(
          liveStart + dx,
          liveEnd - MIN_LAYER_DURATION_US,
        );
        break;
      case "trim-end":
        liveEnd = Math.max(
          liveStart + MIN_LAYER_DURATION_US,
          liveEnd + dx,
        );
        break;
    }
  }

  const left = (Math.max(0, liveStart) / 1_000_000) * pxPerSec;
  const width = ((liveEnd - liveStart) / 1_000_000) * pxPerSec;
  const kindLabel = t(`kinds.${layer.kind.toLowerCase()}`, {
    defaultValue: layer.kind,
  });
  const label = layer.label ?? kindLabel;

  // Hide the layer from its source track during cross-track drag — it
  // appears at the new track's position via the live-updated TrackLane render
  // logic in our App tree (TrackLane keys the layer to its current track ID;
  // for cross-track preview we just dim the source).
  const movedAcrossTracks =
    isDragging &&
    dragState?.kind === "move" &&
    dragState.overTrackId !== null &&
    dragState.overTrackId !== trackId;

  // Edge-hover trim: pointerdown within EDGE_ZONE_PX of the layer's
  // left/right edge dispatches trim-start/trim-end; everywhere else
  // dispatches a move. The zone clamps to a third of the chip's width
  // so the two edges never overlap on a narrow clip.
  const EDGE_ZONE_PX = 6;
  const [edgeHover, setEdgeHover] = useState<"left" | "right" | null>(null);

  const edgeZoneFor = (
    clientX: number,
    rect: DOMRect,
  ): "left" | "right" | null => {
    const zone = Math.min(EDGE_ZONE_PX, Math.floor(rect.width / 3));
    if (zone <= 0) return null;
    const rel = clientX - rect.left;
    if (rel < zone) return "left";
    if (rect.width - rel < zone) return "right";
    return null;
  };

  const onPointerMoveHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0) return; // ignore moves with a button held (drag)
    if (layer.locked || bladeMode || isDragging) {
      if (edgeHover !== null) setEdgeHover(null);
      return;
    }
    const next = edgeZoneFor(
      e.clientX,
      e.currentTarget.getBoundingClientRect(),
    );
    if (next !== edgeHover) setEdgeHover(next);
  };

  const onPointerLeaveHover = () => {
    if (edgeHover !== null) setEdgeHover(null);
  };

  const onLayerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || layer.locked) return;
    e.stopPropagation();
    // Blade-tool mode hijacks every pointerdown on the layer surface:
    // the click is a cut request, not a select/drag.
    if (bladeMode) {
      onBladeSplit(layer, e.clientX);
      return;
    }
    const zone = edgeZoneFor(
      e.clientX,
      e.currentTarget.getBoundingClientRect(),
    );
    const kind: DragKind =
      zone === "left" ? "trim-start" : zone === "right" ? "trim-end" : "move";
    // `docs/group-system.md` — match click-selection semantics on
    // pointerdown so drag and click share the same group-aware path.
    onSelectFromClick(layer.id, {
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
    onDragStart({
      kind,
      layerId: layer.id,
      trackId,
      trackKind,
      startX: e.clientX,
      startY: e.clientY,
      originalTStart: layer.t_start_us,
      originalTEnd: layer.t_end_us,
      deltaUs: 0,
      overTrackId: trackId,
      escapeGroup: e.altKey,
    });
  };

  const layerWidthPx = Math.max(width, 4);

  // V.6 vertical slot. Each row has a 4px outer breathing room so the
  // chip doesn't touch the row edges. Within that interior:
  //   - "full"   → one block spans top:4 to bottom-4 (legacy behavior)
  //   - "top"    → top half (4 → midline-1)
  //   - "bottom" → bottom half (midline+1 → height-4)
  // The 1px gap at the midline visually separates V from A in the
  // combined-row case so the user sees they're hit-test independent.
  const ROW_PADDING = 4;
  const interiorTop = ROW_PADDING;
  const interiorHeight = Math.max(8, laneHeight - 2 * ROW_PADDING);
  const halfHeight = Math.max(8, Math.floor((interiorHeight - 1) / 2));
  let sliceTop: number;
  let sliceHeight: number;
  if (slice === "full") {
    sliceTop = interiorTop;
    sliceHeight = interiorHeight;
  } else if (slice === "top") {
    sliceTop = interiorTop;
    sliceHeight = halfHeight;
  } else {
    sliceTop = interiorTop + halfHeight + 1;
    sliceHeight = interiorHeight - halfHeight - 1;
  }

  // `docs/group-system.md` — tinted left border + chain-link icon hue
  // derived from group_id so all members share an accent color.
  const groupStyle: React.CSSProperties = {};
  if (groupId !== null) {
    const hue = groupHue(groupId);
    groupStyle.borderLeft = `2px solid hsl(${hue} 75% 60%)`;
  }

  return (
    <div
      className={`timeline-layer slice-${slice} ${isPrimary ? "is-primary" : ""} ${
        isSelected ? "is-selected" : ""
      } ${isDragging ? "is-dragging" : ""} ${layer.locked ? "is-locked" : ""} ${
        movedAcrossTracks ? "is-ghost" : ""
      }`}
      style={{
        left,
        top: sliceTop,
        width: layerWidthPx,
        height: sliceHeight,
        background: layer.color_hint,
        opacity: movedAcrossTracks
          ? 0.3
          : layer.enabled
            ? 1
            : 0.45,
        // Edge-hover signals "you can trim here"; falls through to the
        // class-driven cursor (grab / grabbing / not-allowed / blade)
        // otherwise.
        cursor:
          !layer.locked && !bladeMode && !isDragging && edgeHover !== null
            ? "ew-resize"
            : undefined,
        ...groupStyle,
      }}
      onClick={(e) => {
        e.stopPropagation();
        // In blade mode the pointerdown already handled the cut; the
        // synthesised click that follows should not flip the selection.
        if (bladeMode) return;
        onSelectFromClick(layer.id, {
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
        });
      }}
      onPointerDown={onLayerPointerDown}
      onPointerMove={onPointerMoveHover}
      onPointerLeave={onPointerLeaveHover}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, layer.id, layer.kind);
      }}
      title={`${layer.kind}: ${(liveStart / 1_000_000).toFixed(2)}s → ${(liveEnd / 1_000_000).toFixed(2)}s`}
    >
      <span className="layer-label">{label}</span>
    </div>
  );
}
