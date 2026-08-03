import type { GroupSummary, LayerSummary, TrackSummary } from "../ipc";
import { displayedFrameStartUs, inclusiveOutBoundaryUs } from "../frames";
import {
  animatableParams,
  readParamTrack,
  type ParamDescriptor,
} from "../keyframe/descriptors";

// Zoom + height bounds. DEFAULT_PX_PER_SEC is the fallback for projects with
// no `view.json`.
// The lower bound is computed dynamically as `viewport / totalSec` so
// Ctrl+wheel can always zoom out far enough to fit the entire timeline
// in view, regardless of how long it is. `MIN_PX_PER_SEC_FLOOR` is a
// tiny absolute floor that keeps the math sane in pathological cases
// (zero-width viewport, zero-duration project).
export const DEFAULT_PX_PER_SEC = 80;
export const MIN_PX_PER_SEC_FLOOR = 0.05;
// 2000 px/s exceeds the waveform's stored finest LOD (1000 peaks/s): past
// ~1333 px/s the envelope stretches instead of gaining detail — accepted;
// the filmstrip (the ceiling's driver) keeps densifying to lod 0.
export const MAX_PX_PER_SEC = 2000;
// Empty/short projects still need enough temporal context to feel like an
// editing surface instead of a five-second strip.
export const MIN_TIMELINE_SECONDS = 10;
// Keep the composition tail away from the viewport edge. The proportional
// part makes the post-roll useful on wide workspaces; the floor keeps it
// usable in narrow panes and before the first viewport measurement lands.
export const TIMELINE_END_PADDING_VIEWPORT_RATIO = 0.35;
export const MIN_TIMELINE_END_PADDING_PX = 240;
// Taller default row so combined V+A rows fit a thumbnail strip (top half)
// + waveform strip (bottom half); single-class tracks still fit comfortably.
export const DEFAULT_TRACK_HEIGHT = 56;
export const MIN_TRACK_HEIGHT = 24;
export const MAX_TRACK_HEIGHT = 200;
// Debounce window after the last zoom/height edit before we hit disk.
// Resize-drag tends to fire ~60×/sec; 200ms keeps the file write off the
// critical drag path while still landing within a beat of the user
// releasing the handle.
export const VIEW_SAVE_DEBOUNCE_MS = 200;

export const LAYER_PREVIEW_MIN_PX = 16;
export const LAYER_LABEL_MIN_PX = 48;
export const LAYER_FULL_LABEL_MIN_PX = 120;

/// Width of the sticky track-header column. See the timeline-redesign spec (§1).
export const HEADER_COL_PX = 160;

export function computeTimelineExtent({
  durationUs,
  pxPerSec,
  viewportWidthPx,
}: {
  durationUs: number;
  pxPerSec: number;
  viewportWidthPx: number;
}): { widthPx: number; totalSec: number } {
  const contentSec = Math.max(durationUs / 1_000_000, MIN_TIMELINE_SECONDS);
  const contentWidthPx = contentSec * pxPerSec;
  const safeViewportWidthPx = Math.max(0, viewportWidthPx);
  const endPaddingPx = Math.max(
    MIN_TIMELINE_END_PADDING_PX,
    safeViewportWidthPx * TIMELINE_END_PADDING_VIEWPORT_RATIO,
  );
  const widthPx = Math.max(contentWidthPx, safeViewportWidthPx) + endPaddingPx;
  return { widthPx, totalSec: widthPx / pxPerSec };
}

export interface VisualTrack {
  track: TrackSummary;
  /// True when this is the first lane of its kind group — the renderer adds
  /// a divider line above it. Today the boundary is between the video stack
  /// and the audio stack.
  isGroupStart: boolean;
}

/// Layer-overlap class. Visual-class layers (VideoClip,
/// ImageOverlay, Color, Motif, Text) can't overlap each other on a
/// track; Audio can't overlap Audio. Visual + Audio CAN coexist at
/// the same time — that's the AE-style "combined row" trigger.
export type LayerOverlapClass = "visual" | "audio";

export function layerOverlapClass(layer: LayerSummary): LayerOverlapClass {
  return layer.params.kind === "Audio" ? "audio" : "visual";
}

/// Which header controls a track shows, derived from its content. The header
/// carries the eye (lock is unconditional, unmodeled here); mute/solo live on
/// audio roles (Mixer panel). A pure-audio lane hides the eye — `muted` is its
/// single audio on/off, so the whole-track `enabled` toggle would be redundant;
/// visual-only and empty tracks keep it. `hasAudio` is retained because a
/// pure-audio lane (`hasAudio && !showEye`) drives the audio-lane music glyph.
/// See the audio-track × A/B-roll spec.
export interface TrackHeaderControls {
  showEye: boolean;
  hasAudio: boolean;
}

export function trackHeaderControls(track: TrackSummary): TrackHeaderControls {
  const hasAudio = track.layers.some((l) => layerOverlapClass(l) === "audio");
  const hasVisual = track.layers.some((l) => layerOverlapClass(l) === "visual");
  return {
    showEye: hasVisual || !hasAudio,
    hasAudio,
  };
}

/// Vertical slice the layer occupies within its track row:
///   - "full"   — uses the entire row height (default; no opposite-
///                class layer overlaps in time)
///   - "top"    — uses the top half (Visual layer paired with an
///                Audio layer at the same time slot)
///   - "bottom" — uses the bottom half (Audio layer paired with a
///                Visual layer at the same time slot)
export type LayerSlice = "full" | "top" | "bottom";

export function computeLayerSlices(
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

// Track rendering order is a simple reverse of the data-model. Convention
// (idx 0 = bottom of z-stack, last = top) maps directly to "last index renders
// at the top of the screen", matching the editor convention that the
// top-of-z-stack composites visually on top. See `docs/data-model.md`.
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
export function visualOrderedTracks(tracks: TrackSummary[]): VisualTrack[] {
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

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/// One track lane's MEASURED vertical extent, in client coordinates
/// (`getBoundingClientRect`). Feeds `trackIdAtClientY`.
export interface MeasuredTrackRow {
  trackId: string;
  top: number;
  bottom: number;
}

/// Which track a pointer at `clientY` is over, from measured lane rects.
///
/// LANDMINE: never answer this from an arithmetic y-offset table built out of
/// track heights. A row carries chrome the table cannot see — an expanded
/// track's keyframe sub-lanes sit BETWEEN its lane and the next one — so the
/// table drifts a full row or more per expanded track above the pointer, and
/// the drag hit-test then reports a foreign track. That is not a cosmetic
/// error: `useLayerDrag` treats a track change as edit intent, so a stale
/// table turns a plain click into a committed cross-track move. The DOM
/// already computed this layout; measure it.
///
/// Band rule: a row owns `[its own top, the next row's top)`. That hands the
/// sub-lane strip under an expanded track to the track that owns it, instead
/// of leaving a hole that would snap a mid-drag ghost back to its origin. The
/// last row owns only its own height. Above the first row or below the last
/// returns null — the caller keeps the layer on its origin track.
export function trackIdAtClientY(
  rows: readonly MeasuredTrackRow[],
  clientY: number,
): string | null {
  // Sorted so the band rule never depends on registration order.
  const sorted = rows.slice().sort((a, b) => a.top - b.top);
  for (const [i, row] of sorted.entries()) {
    if (clientY < row.top) return null;
    const next = sorted[i + 1];
    const bandEndY = next ? next.top : row.bottom;
    if (clientY < bandEndY) return row.trackId;
  }
  return null;
}

// Below this on-screen frame width the shadow reads as line jitter, not an
// area — hide it and let the playhead line stand alone.
const PLAYHEAD_FRAME_SHADOW_MIN_PX = 5;

/// One-frame-wide playhead shadow (Avid's position bar; Resolve's "Playhead
/// Shadow"): spans the DISPLAYED frame, from its start to its exclusive end,
/// making "the playhead shows the frame to its right" visible at frame-level
/// zoom. Exact grid boundaries per frame — a nominal `pxPerSec / fps` width
/// would drift at fractional rates (see `approxFrameDurUs`). Returns null
/// when the frame is too narrow on screen or inputs are degenerate.
export function playheadFrameShadowPx(
  tUs: number,
  fpsNum: number,
  fpsDen: number,
  pxPerSec: number,
): { leftPx: number; widthPx: number } | null {
  if (fpsNum <= 0 || fpsDen <= 0 || pxPerSec <= 0) return null;
  const startUs = displayedFrameStartUs(tUs, fpsNum, fpsDen);
  const endUs = inclusiveOutBoundaryUs(tUs, fpsNum, fpsDen);
  const widthPx = ((endUs - startUs) / 1_000_000) * pxPerSec;
  if (widthPx < PLAYHEAD_FRAME_SHADOW_MIN_PX) return null;
  return { leftPx: (startUs / 1_000_000) * pxPerSec, widthPx };
}

/// `docs/features.md#groups`. Stable, deterministic hue per group id so all
/// members share an accent color across renders. Skips the yellow/green
/// band that conflicts with the selection highlight (ring token) on LayerBlock.
export function groupHue(groupId: string): number {
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
export function indexGroups(groups: GroupSummary[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const g of groups) {
    for (const lid of g.layer_ids) {
      idx.set(lid, g.id);
    }
  }
  return idx;
}

/// Map a layer-local keyframe time (µs) to an x offset (px) within a clip
/// chip of `clipDurationUs` rendered `clipWidthPx` wide. Clamps out-of-range
/// keyframes (kept in data after trims) to the clip bounds.
export function keyframeXWithinClip(
  kfTUs: number,
  clipDurationUs: number,
  clipWidthPx: number,
): number {
  if (clipDurationUs <= 0) return 0;
  const u = clamp(kfTUs / clipDurationUs, 0, 1);
  return u * clipWidthPx;
}

/// Absolute x (px) of a keyframe on the timeline ruler: the clip start plus
/// the layer-local keyframe time, scaled by zoom. Used by the expanded
/// sub-lanes (which span the whole track, not one clip).
export function keyframeAbsoluteX(
  layerTStartUs: number,
  kfTUs: number,
  pxPerSec: number,
): number {
  return ((layerTStartUs + kfTUs) / 1_000_000) * pxPerSec;
}

/// The keyframed-property union across a track's layers, in descriptor order
/// — one entry per property that at least one layer animates (Keyframed).
/// Drives the expanded sub-lane rows.
export function trackKeyframeProperties(track: TrackSummary): ParamDescriptor[] {
  const out: ParamDescriptor[] = [];
  // Stable, de-duped, descriptor-ordered: walk each layer's animatable params;
  // include a param the first time any layer has it Keyframed.
  const seen = new Set<string>();
  for (const layer of track.layers) {
    for (const desc of animatableParams(layer.kind)) {
      if (seen.has(desc.paramKey)) continue;
      const t = readParamTrack(layer.params, desc.paramKey);
      if (t && t.mode === "Keyframed") {
        seen.add(desc.paramKey);
      }
    }
  }
  // Emit in the stable order defined by ORDER below (not first-seen order):
  // collect from the canonical descriptor lists.
  const ORDER = ["x", "y", "scale_x", "scale_y", "rotation_deg", "opacity", "gain_db", "pan"];
  for (const key of ORDER) {
    if (!seen.has(key)) continue;
    // find the descriptor (label/fallback) from whichever kind defines it
    for (const layer of track.layers) {
      const d = animatableParams(layer.kind).find((x) => x.paramKey === key);
      if (d) { out.push(d); break; }
    }
  }
  return out;
}

/// Nearest diamond id within `radiusPx` of `pointerX`, else null.
export function keyframeHitTest(
  diamonds: readonly { id: string; x: number }[],
  pointerX: number,
  radiusPx: number,
): string | null {
  let best: { id: string; d: number } | null = null;
  for (const dia of diamonds) {
    const d = Math.abs(dia.x - pointerX);
    if (d <= radiusPx && (best === null || d < best.d)) best = { id: dia.id, d };
  }
  return best?.id ?? null;
}

/// `mm:ss` for second-grain steps, `mm:ss.cs` (centiseconds) for
/// sub-second steps so the user sees a meaningful precision delta as
/// they zoom in. Rounding is done in integer milliseconds to keep
/// floating-point accumulation out of the label.
export function formatRulerLabel(seconds: number, majorSec: number): string {
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
