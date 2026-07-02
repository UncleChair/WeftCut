import { useEffect, useMemo, useRef, useState } from "react";
import { useDprVersion } from "./hooks/useDprVersion";
import { useSegmentVisibility } from "./hooks/useSegmentVisibility";
import { tileEngine } from "./tileEngine/TileEngine";
import {
  FILMSTRIP_MAX_LOD,
  chooseFilmstripLod,
  filmstripThumbWidthPx,
  filmstripTileKey,
  registerFilmstripProducer,
  spacingUs,
  visibleTileRange,
  type FilmstripTileValue,
} from "./tileEngine/FilmstripTileProducer";

registerFilmstripProducer();

/// Max CSS width of one render tile canvas — same fixed-size-segment pattern
/// as TimelineWaveform's RENDER_TILE_PX (see that file for the rationale).
const RENDER_TILE_PX = 2048;

/// Param-churn (pxPerSec / trim / height) re-request delay: coalesces a burst
/// of zoom-wheel or trim-drag frames into one request pass instead of one per
/// intermediate value. Mount, mediaId changes, and engine `subscribe`
/// notifications bypass this and request immediately.
export const FILMSTRIP_FETCH_DEBOUNCE_MS = 140;

/// How far to EITHER side of the target LOD the painter's pass falls back to
/// when the ideal tile isn't cached yet — a mis-sized-but-present thumbnail
/// beats a blank frame while the target tile is in flight. The coarser side
/// bridges zoom-in (cached coarse tiles hold until finer ones land); the
/// finer side bridges zoom-out (cached fine tiles hold until coarser ones
/// land) — without it, raising the target LOD would clear already-rendered
/// content until the debounced fetch resolves.
const LOD_FALLBACK_SPAN = 3;

/// Painter's-pass LOD order, least → most authoritative: finer backfill
/// (target−3 … target−1, ascending) first, then the coarse fallback down to
/// the target (target+3 … target, descending), each side clamped to the
/// valid LOD range — so target-LOD tiles always paint last, on top of every
/// fallback.
function paintLodOrder(targetLod: number): number[] {
  const lods: number[] = [];
  for (let lod = Math.max(targetLod - LOD_FALLBACK_SPAN, 0); lod < targetLod; lod++) {
    lods.push(lod);
  }
  for (let lod = Math.min(targetLod + LOD_FALLBACK_SPAN, FILMSTRIP_MAX_LOD); lod >= targetLod; lod--) {
    lods.push(lod);
  }
  return lods;
}

/// Places a decoded tile at its true source time, holding natural aspect
/// ratio at the given lane height. Pure/canvas-free so it's unit-testable
/// without a real 2d context. A degenerate source window or bitmap height
/// (either would otherwise divide by zero) yields a zero-size rect instead
/// of NaN/Infinity — callers skip the draw when `w <= 0`.
export function tileDrawRect(
  tUs: number,
  srcInUs: number,
  srcOutUs: number,
  clipWidthPx: number,
  laneHeightPx: number,
  bmpWidth: number,
  bmpHeight: number,
): { x: number; w: number; h: number } {
  if (srcOutUs <= srcInUs || bmpHeight <= 0) return { x: 0, w: 0, h: 0 };
  const x = ((tUs - srcInUs) / (srcOutUs - srcInUs)) * clipWidthPx;
  const h = laneHeightPx;
  const w = laneHeightPx * (bmpWidth / bmpHeight);
  return { x, w, h };
}

type FilmstripDataState = "pending" | "not_ready" | "ready";

/// One thumbnail box's screen-time extent, in source microseconds: the
/// natural-aspect thumb width (fixed by lane height + media aspect) mapped
/// through the current px/s zoom. Independent of LOD — it's pure screen
/// geometry, reused as the `visibleTileRange` reach at every LOD in the
/// painter's pass and at the target LOD alone in the request pass.
function thumbWidthUsFor(thumbWidthPx: number, pxPerSec: number): number {
  return pxPerSec > 0 ? (thumbWidthPx / pxPerSec) * 1e6 : 0;
}

interface SegmentGeom {
  startPx: number;
  widthPx: number;
}

interface PxWindow {
  loPx: number;
  hiPx: number;
}

/// The horizontal fetch/consult windows for the strip: one per VISIBLE
/// canvas segment, extended by a full segment width on each side so
/// near-viewport tiles warm before they scroll in, clamped to the strip.
/// Hidden segments contribute nothing — that clipping is the memory bound:
/// covering a layer's entire src window would queue every tile of a long
/// clip at deep zoom (hundreds of ~half-MB ImageBitmaps) no matter what's
/// on screen.
function visibleSegmentWindows(
  segments: SegmentGeom[],
  isSegmentVisible: (startPx: number) => boolean,
  totalWidthPx: number,
): PxWindow[] {
  const out: PxWindow[] = [];
  for (const seg of segments) {
    if (!isSegmentVisible(seg.startPx)) continue;
    out.push({
      loPx: Math.max(0, seg.startPx - RENDER_TILE_PX),
      hiPx: Math.min(totalWidthPx, seg.startPx + seg.widthPx + RENDER_TILE_PX),
    });
  }
  return out;
}

/// Maps a horizontal px window on the strip back into source time (linear
/// px→time across the layer's [srcInUs, srcOutUs) span) and returns the tile
/// indices at `spacing` whose boxes intersect it. Px inputs are clamped to
/// the strip, so the result is always a sub-range of the full-strip range.
function tileRangeForPxWindow(
  window: PxWindow,
  srcInUs: number,
  srcOutUs: number,
  totalWidthPx: number,
  spacing: number,
  thumbWidthUs: number,
  mediaDurationUs: number | undefined,
): { first: number; last: number } {
  const span = srcOutUs - srcInUs;
  const loUs = srcInUs + (Math.max(0, window.loPx) / totalWidthPx) * span;
  const hiUs = srcInUs + (Math.min(totalWidthPx, window.hiPx) / totalWidthPx) * span;
  return visibleTileRange(loUs, hiUs, spacing, thumbWidthUs, mediaDurationUs);
}

/// Runs the debounced request pass: for the TARGET lod only, and only for
/// tiles inside a VISIBLE segment's fetch window (see
/// `visibleSegmentWindows`), (re)issues `engine.request` for any key that's
/// missing or errored. Mount, a genuine mediaId change, engine `subscribe`
/// notifications, and segment-visibility changes run immediately; geometry
/// churn on the same media debounces — same run/apply seam shape as
/// TimelineWaveform's `useWindowData`. Returns a version counter bumped by
/// the subscribe callback and by each completed pass, so the (separate,
/// undebounced) draw pass knows to re-read the engine.
function useFilmstripRequests({
  mediaId,
  srcInUs,
  srcOutUs,
  targetLod,
  thumbWidthUs,
  mediaDurationUs,
  enabled,
  segments,
  totalWidthPx,
  isSegmentVisible,
  visibilityVersion,
}: {
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
  targetLod: number;
  thumbWidthUs: number;
  mediaDurationUs: number | undefined;
  enabled: boolean;
  segments: SegmentGeom[];
  totalWidthPx: number;
  isSegmentVisible: (startPx: number) => boolean;
  visibilityVersion: number;
}): number {
  const [version, setVersion] = useState(0);
  const prevMediaIdRef = useRef<string | undefined>(undefined);
  const prevVisibilityVersionRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const isNewMedia = prevMediaIdRef.current !== mediaId;
    prevMediaIdRef.current = mediaId;
    const visibilityChanged = prevVisibilityVersionRef.current !== visibilityVersion;
    prevVisibilityVersionRef.current = visibilityVersion;

    const run = () => {
      if (cancelled) return;
      const spacing = spacingUs(targetLod);
      // Overlapping neighbour windows revisit indices; dedupe so each tile is
      // considered once per pass.
      const seen = new Set<number>();
      for (const w of visibleSegmentWindows(segments, isSegmentVisible, totalWidthPx)) {
        const { first, last } = tileRangeForPxWindow(
          w, srcInUs, srcOutUs, totalWidthPx, spacing, thumbWidthUs, mediaDurationUs,
        );
        for (let i = first; i <= last; i++) {
          if (seen.has(i)) continue;
          seen.add(i);
          const key = filmstripTileKey(mediaId, targetLod, i);
          const e = tileEngine.get(key);
          if (!e || e.state === "error") tileEngine.request(key);
        }
      }
      setVersion((v) => v + 1);
    };

    const unsub = tileEngine.subscribe(mediaId, run);

    // A segment scrolling into view is as urgent as a subscribe notify: its
    // pixels are blank until its tiles are fetched, so it must not wait out
    // the param-churn debounce.
    if (isNewMedia || visibilityChanged) {
      run();
      return () => {
        cancelled = true;
        unsub();
      };
    }

    const timer = setTimeout(run, FILMSTRIP_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      unsub();
      clearTimeout(timer);
    };
  }, [
    mediaId,
    srcInUs,
    srcOutUs,
    targetLod,
    thumbWidthUs,
    mediaDurationUs,
    enabled,
    segments,
    totalWidthPx,
    isSegmentVisible,
    visibilityVersion,
  ]);

  return version;
}

/// Computes the container's data-state without touching a 2d context: reruns
/// the exact painter's-pass key selection the canvas segments use (target ±
/// LOD_FALLBACK_SPAN, clipped to the visible segments' windows), counting
/// how many tiles would actually draw (non-degenerate rect) at ANY consulted
/// LOD — that count drives "ready" — while the `not_ready` determination
/// stays keyed on TARGET-lod slots only (proxy-wait semantics). Kept
/// context-free so jsdom (whose canvas getContext returns null) can still
/// observe ready/not_ready/pending transitions.
function computeFilmstripDataState(
  mediaId: string,
  srcInUs: number,
  srcOutUs: number,
  targetLod: number,
  thumbWidthUs: number,
  mediaDurationUs: number | undefined,
  totalWidthPx: number,
  laneHeightPx: number,
  windows: PxWindow[],
): FilmstripDataState {
  let painted = 0;
  let targetNotReady = false;
  for (const lod of paintLodOrder(targetLod)) {
    const spacing = spacingUs(lod);
    const seen = new Set<number>();
    for (const w of windows) {
      const { first, last } = tileRangeForPxWindow(
        w, srcInUs, srcOutUs, totalWidthPx, spacing, thumbWidthUs, mediaDurationUs,
      );
      for (let i = first; i <= last; i++) {
        if (seen.has(i)) continue;
        seen.add(i);
        const entry = tileEngine.get<FilmstripTileValue>(filmstripTileKey(mediaId, lod, i));
        if (lod === targetLod && entry?.state === "not_ready") targetNotReady = true;
        if (entry?.state !== "ready") continue;
        const r = tileDrawRect(
          entry.value.tUs,
          srcInUs,
          srcOutUs,
          totalWidthPx,
          laneHeightPx,
          entry.value.bitmap.width,
          entry.value.bitmap.height,
        );
        if (r.w > 0) painted++;
      }
    }
  }
  if (painted > 0) return "ready";
  if (targetNotReady) return "not_ready";
  return "pending";
}

export function TimelineFilmstrip({
  mediaId,
  srcInUs,
  srcOutUs,
  layerWidthPx,
  layerHeightPx,
  pxPerSec,
  colorHint,
  enabled,
  mediaWidth,
  mediaHeight,
  mediaDurationUs,
}: {
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
  layerWidthPx: number;
  layerHeightPx: number;
  pxPerSec: number;
  colorHint: string;
  enabled: boolean;
  /// Natural media dimensions, when known — used only to hold the thumbnail's
  /// true aspect ratio. Falls back to a 16:9 assumption while metadata is
  /// still loading, per `filmstripThumbWidthPx`.
  mediaWidth?: number | undefined;
  mediaHeight?: number | undefined;
  /// Caps the tail LOD's visible range to the real source duration, when
  /// known. Undefined leaves the range uncapped.
  mediaDurationUs?: number | undefined;
}) {
  const totalWidthPx = Math.max(1, Math.ceil(layerWidthPx));
  const laneHeightPx = Math.max(1, Math.ceil(layerHeightPx));
  const thumbWidthPx = filmstripThumbWidthPx(laneHeightPx, mediaWidth, mediaHeight);
  const targetLod = chooseFilmstripLod(thumbWidthPx, pxPerSec);
  const thumbWidthUs = thumbWidthUsFor(thumbWidthPx, pxPerSec);
  const dprVersion = useDprVersion();

  const tiles = useMemo<SegmentGeom[]>(() => {
    const n = Math.max(1, Math.ceil(totalWidthPx / RENDER_TILE_PX));
    return Array.from({ length: n }, (_, i) => ({
      startPx: i * RENDER_TILE_PX,
      widthPx: Math.min(RENDER_TILE_PX, totalWidthPx - i * RENDER_TILE_PX),
    }));
  }, [totalWidthPx]);

  // ---- Per-segment visibility ---------------------------------------------
  // Shared strip-visibility hook (also used by TimelineWaveform): the
  // request, draw, and data-state passes consult only segments the observer
  // has reported visible.
  const { isSegmentVisible, observeSegment, visibilityVersion } = useSegmentVisibility();

  const version = useFilmstripRequests({
    mediaId,
    srcInUs,
    srcOutUs,
    targetLod,
    thumbWidthUs,
    mediaDurationUs,
    enabled,
    segments: tiles,
    totalWidthPx,
    isSegmentVisible,
    visibilityVersion,
  });

  const [dataState, setDataState] = useState<FilmstripDataState>("pending");

  useEffect(() => {
    if (!enabled) return;
    setDataState(
      computeFilmstripDataState(
        mediaId,
        srcInUs,
        srcOutUs,
        targetLod,
        thumbWidthUs,
        mediaDurationUs,
        totalWidthPx,
        laneHeightPx,
        visibleSegmentWindows(tiles, isSegmentVisible, totalWidthPx),
      ),
    );
    // dprVersion doesn't affect which tiles are consulted, only the backing
    // store the (separately effected) canvas segments paint into — depending
    // on it here just keeps this pass's timing aligned with theirs.
  }, [
    enabled,
    version,
    mediaId,
    srcInUs,
    srcOutUs,
    targetLod,
    thumbWidthUs,
    mediaDurationUs,
    totalWidthPx,
    laneHeightPx,
    dprVersion,
    tiles,
    isSegmentVisible,
    visibilityVersion,
  ]);

  return (
    <div
      data-testid="timeline-filmstrip"
      data-state={enabled ? dataState : "disabled"}
      className="flex h-full w-full overflow-hidden"
      style={{
        backgroundColor: colorHint,
        backgroundImage:
          layerWidthPx >= 32
            ? "repeating-linear-gradient(90deg, rgba(255,255,255,0.10) 0 1px, transparent 1px 12px)"
            : undefined,
      }}
    >
      {enabled &&
        tiles.map((tile) => (
          <FilmstripTileCanvas
            key={tile.startPx}
            mediaId={mediaId}
            srcInUs={srcInUs}
            srcOutUs={srcOutUs}
            targetLod={targetLod}
            thumbWidthUs={thumbWidthUs}
            mediaDurationUs={mediaDurationUs}
            totalWidthPx={totalWidthPx}
            laneHeightPx={laneHeightPx}
            segmentStartPx={tile.startPx}
            segmentWidthPx={tile.widthPx}
            version={version}
            dprVersion={dprVersion}
            visible={isSegmentVisible(tile.startPx)}
            observe={observeSegment}
          />
        ))}
    </div>
  );
}

function FilmstripTileCanvas({
  mediaId,
  srcInUs,
  srcOutUs,
  targetLod,
  thumbWidthUs,
  mediaDurationUs,
  totalWidthPx,
  laneHeightPx,
  segmentStartPx,
  segmentWidthPx,
  version,
  dprVersion,
  visible,
  observe,
}: {
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
  targetLod: number;
  thumbWidthUs: number;
  mediaDurationUs: number | undefined;
  totalWidthPx: number;
  laneHeightPx: number;
  segmentStartPx: number;
  segmentWidthPx: number;
  version: number;
  dprVersion: number;
  visible: boolean;
  observe: (el: HTMLCanvasElement, startPx: number) => () => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, segmentStartPx);
  }, [observe, segmentStartPx]);

  useEffect(() => {
    // Offscreen segments skip entirely: reassigning canvas.width below
    // reallocates the backing store, and doing that for every segment on
    // every tile arrival is what melted long clips. The `visible` dep
    // repaints this segment the moment it scrolls (near) into view.
    if (!visible) return;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(segmentWidthPx * dpr));
    canvas.height = Math.max(1, Math.round(laneHeightPx * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, segmentWidthPx, laneHeightPx);

    for (const lod of paintLodOrder(targetLod)) {
      const spacing = spacingUs(lod);
      const { first, last } = visibleTileRange(srcInUs, srcOutUs, spacing, thumbWidthUs, mediaDurationUs);
      for (let i = first; i <= last; i++) {
        const entry = tileEngine.get<FilmstripTileValue>(filmstripTileKey(mediaId, lod, i));
        if (entry?.state !== "ready") continue;
        const { bitmap, tUs } = entry.value;
        const r = tileDrawRect(tUs, srcInUs, srcOutUs, totalWidthPx, laneHeightPx, bitmap.width, bitmap.height);
        if (r.w <= 0) continue;
        ctx.drawImage(bitmap, r.x - segmentStartPx, 0, r.w, r.h);
      }
    }
    // dprVersion is intentionally unused in the body: the resolution readback
    // above is always fresh, so bumping the version is enough to force this
    // effect (and thus the redraw at the new backing size) to re-run.
  }, [
    mediaId,
    srcInUs,
    srcOutUs,
    targetLod,
    thumbWidthUs,
    mediaDurationUs,
    totalWidthPx,
    laneHeightPx,
    segmentStartPx,
    segmentWidthPx,
    version,
    dprVersion,
    visible,
  ]);

  return (
    <canvas
      ref={ref}
      data-testid="timeline-filmstrip-tile"
      style={{
        width: `${segmentWidthPx}px`,
        height: `${laneHeightPx}px`,
        contentVisibility: "auto",
        containIntrinsicSize: `${segmentWidthPx}px ${laneHeightPx}px`,
      }}
    />
  );
}
