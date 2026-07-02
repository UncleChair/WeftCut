import { useEffect, useMemo, useRef, useState } from "react";
import { useDprVersion } from "./hooks/useDprVersion";
import { tileEngine } from "./tileEngine/TileEngine";
import {
  ensureWaveformWindow,
  getWaveformChannelCount,
  registerWaveformProducer,
  type WaveformWindow,
} from "./tileEngine/WaveformTileProducer";

registerWaveformProducer();

/// Max CSS width of one render tile canvas. Fixed + small so no single canvas
/// approaches the browser's element-size limit; offscreen tiles are cheap and
/// (with content-visibility) skip rasterization.
const RENDER_TILE_PX = 2048;

/// Below this row height, two 14px-ish lanes would be illegible; fall back to
/// one merged lane spanning the full row instead.
export const STEREO_LANES_MIN_PX = 28;

/// Param-churn (pxPerSec / src window) re-fetch delay: coalesces a burst of
/// zoom-wheel or trim-drag frames into one assembly run instead of one per
/// intermediate value. Mount, mediaId changes, and engine `subscribe`
/// notifications bypass this and fetch immediately — see `useWindowData`.
export const WAVEFORM_REFETCH_DEBOUNCE_MS = 120;

export interface WaveformLane {
  channel: number | "merged";
  midY: number;
  ampPx: number;
}

/// Lays out the horizontal lane(s) a waveform row draws into: two lanes (L
/// over R) once the row is tall enough to read as split channels, else one
/// lane spanning the full row (merged stereo, or plain mono).
export function computeLanes(heightPx: number, channels: number): WaveformLane[] {
  if (channels === 2 && heightPx >= STEREO_LANES_MIN_PX) {
    return [
      { channel: 0, midY: heightPx / 4, ampPx: heightPx / 4 - 1 },
      { channel: 1, midY: (3 * heightPx) / 4, ampPx: heightPx / 4 - 1 },
    ];
  }
  return [{ channel: "merged", midY: heightPx / 2, ampPx: heightPx / 2 - 1 }];
}

/// Collapses two per-channel windows into the envelope a merged lane draws:
/// the outer min/max excursion of either channel, and the louder of the two
/// RMS cores (so the merged lane never reads quieter than its loudest side).
export function mergeStereo(a: WaveformWindow, b: WaveformWindow): WaveformWindow {
  // Defensive only: both channels are fetched for the same [srcIn, srcOut)
  // window at the same LOD, so they should always match length. If a race
  // ever hands us mismatched arrays, merge over the shorter one rather than
  // reading undefined past the end of the other.
  const n = Math.min(a.min.length, b.min.length);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    min[i] = Math.min(a.min[i]!, b.min[i]!);
    max[i] = Math.max(a.max[i]!, b.max[i]!);
    rms[i] = Math.max(a.rms[i]!, b.rms[i]!);
  }
  return { peaksPerSecond: a.peaksPerSecond, startPeak: a.startPeak, min, max, rms };
}

type RenderState = "pending" | "not_ready" | "ready";

interface WindowData {
  state: RenderState;
  channels: number;
  win0: WaveformWindow | null;
  win1: WaveformWindow | null;
}

const INITIAL_WINDOW_DATA: WindowData = { state: "pending", channels: 1, win0: null, win1: null };

/// Runs one channel-count + window(s) assembly for [srcInUs, srcOutUs) at
/// pxPerSec. Pulled out of the hook so both the immediate callers (mount,
/// mediaId change, engine `subscribe` notifications) and the debounced
/// param-churn caller share the exact same resolution logic.
function assembleWindowData(
  mediaId: string,
  srcInUs: number,
  srcOutUs: number,
  pxPerSec: number,
  mediaChannels: number | undefined,
): Promise<WindowData> {
  return getWaveformChannelCount(mediaId)
    // A rejection here (e.g. the waveform file isn't generated yet) must
    // never throw into render; fall back to the mono path, which will
    // independently surface "not_ready"/"pending" from ensureWaveformWindow.
    .catch(() => 1)
    .then((headerChannels) => {
      // The generator always decodes with -ac 2, so the peaks file header
      // reports 2 channels even for a mono source — it alone can't tell a
      // real stereo source from a downmixed mono one. The source's own
      // probed channel count can, so cap the header count with it whenever
      // it's known; a missing/unusable value leaves the header authoritative.
      const channels =
        typeof mediaChannels === "number" && Number.isFinite(mediaChannels) && mediaChannels > 0
          ? Math.min(headerChannels, mediaChannels)
          : headerChannels;
      if (channels === 2) {
        return Promise.all([
          ensureWaveformWindow(mediaId, 0, srcInUs, srcOutUs, pxPerSec),
          ensureWaveformWindow(mediaId, 1, srcInUs, srcOutUs, pxPerSec),
        ]).then(([r0, r1]): WindowData => {
          // Ready only once BOTH channels resolve; a mismatched
          // pending/not_ready pair prefers not_ready (more definitive).
          if (r0 === "not_ready" || r1 === "not_ready") {
            return { state: "not_ready", channels: 2, win0: null, win1: null };
          }
          if (r0 === "pending" || r1 === "pending") {
            return { state: "pending", channels: 2, win0: null, win1: null };
          }
          return { state: "ready", channels: 2, win0: r0, win1: r1 };
        });
      }
      return ensureWaveformWindow(mediaId, 0, srcInUs, srcOutUs, pxPerSec).then((r0): WindowData => {
        if (r0 === "not_ready") return { state: "not_ready", channels: 1, win0: null, win1: null };
        if (r0 === "pending") return { state: "pending", channels: 1, win0: null, win1: null };
        return { state: "ready", channels: 1, win0: r0, win1: null };
      });
    });
}

function useWindowData(
  mediaId: string,
  srcInUs: number,
  srcOutUs: number,
  pxPerSec: number,
  enabled: boolean,
  mediaChannels: number | undefined,
): WindowData {
  const [result, setResult] = useState<WindowData>(INITIAL_WINDOW_DATA);
  // Tracks mediaId across renders so the effect can tell a genuine media
  // swap (different content — fetch immediately, drop the stale window) from
  // param churn on the SAME media (zoom/trim — debounce, keep the stale
  // window on screen, stretched, while the new geometry assembles).
  const prevMediaIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const isNewMedia = prevMediaIdRef.current !== mediaId;
    prevMediaIdRef.current = mediaId;

    // Applies a resolved assembly run, EXCEPT a transient "pending" /
    // "not_ready" must not blank out a window already on screen (zoom
    // mid-flight, or the source briefly regenerating): the stale window
    // keeps rendering rather than flashing a placeholder. Only a fresh
    // media (no window ever fetched for it) shows those states.
    const apply = (next: WindowData) => {
      if (cancelled) return;
      setResult((prev) => (
        (next.state === "pending" || next.state === "not_ready") && prev.win0
          ? prev
          : next
      ));
    };

    const run = () => { void assembleWindowData(mediaId, srcInUs, srcOutUs, pxPerSec, mediaChannels).then(apply); };
    const unsub = tileEngine.subscribe(mediaId, run);

    if (isNewMedia) {
      setResult(INITIAL_WINDOW_DATA);
      run();
      return () => { cancelled = true; unsub(); };
    }

    const timer = setTimeout(run, WAVEFORM_REFETCH_DEBOUNCE_MS);
    return () => { cancelled = true; unsub(); clearTimeout(timer); };
  }, [mediaId, srcInUs, srcOutUs, pxPerSec, enabled, mediaChannels]);
  return result;
}

/// Draws one lane's envelope + RMS core across all CSS-px columns in the
/// tile. Two fill passes (envelope, then RMS core) so `fillStyle` is set once
/// per pass instead of alternating every column.
function drawLane(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  lane: WaveformLane,
  win: WaveformWindow,
  tileStartPx: number,
  totalWidthPx: number,
) {
  const peaks = win.min.length;
  if (peaks === 0) return;
  const { midY, ampPx } = lane;

  // Precompute each column's [lo, hi, rmsMax] once; both fill passes below
  // read from these arrays instead of re-scanning the peak range twice.
  const los = new Float32Array(cssWidth);
  const his = new Float32Array(cssWidth);
  const rmses = new Float32Array(cssWidth);
  for (let px = 0; px < cssWidth; px++) {
    const gpx = tileStartPx + px;
    const p0 = Math.floor((gpx / totalWidthPx) * peaks);
    const p1 = Math.max(p0 + 1, Math.floor(((gpx + 1) / totalWidthPx) * peaks));
    // Seed from the first in-range peak (not 0): a 0-seed assumes the
    // excursion straddles zero, which over-extends the envelope toward the
    // midline for DC-offset/rectified audio whose peaks sit wholly on one
    // side of zero.
    let lo = Infinity;
    let hi = -Infinity;
    let rms = 0;
    let any = false;
    for (let p = p0; p < p1 && p < peaks; p++) {
      const pmin = win.min[p] ?? 0;
      const pmax = win.max[p] ?? 0;
      const prms = win.rms[p] ?? 0;
      if (pmin < lo) lo = pmin;
      if (pmax > hi) hi = pmax;
      if (prms > rms) rms = prms;
      any = true;
    }
    los[px] = any ? lo : 0;
    his[px] = any ? hi : 0;
    rmses[px] = rms;
  }

  ctx.fillStyle = "rgba(255,255,255,0.42)";
  for (let px = 0; px < cssWidth; px++) {
    const yTop = midY - his[px]! * ampPx;
    const yBot = midY - los[px]! * ampPx;
    ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
  }

  ctx.fillStyle = "rgba(255,255,255,0.88)";
  for (let px = 0; px < cssWidth; px++) {
    const rms = rmses[px]!;
    if (rms <= 0) continue;
    const yTop = midY - rms * ampPx;
    const yBot = midY + rms * ampPx;
    ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
  }
}

function drawTile(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  channels: number,
  win0: WaveformWindow | null,
  win1: WaveformWindow | null,
  tileStartPx: number,
  totalWidthPx: number,
) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (!win0 || win0.min.length === 0) {
    const mid = cssHeight / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(cssWidth, mid);
    ctx.stroke();
    return;
  }

  const lanes = computeLanes(cssHeight, channels);
  for (const lane of lanes) {
    let win: WaveformWindow | null;
    if (lane.channel === "merged") {
      win = channels === 2 && win1 ? mergeStereo(win0, win1) : win0;
    } else if (lane.channel === 0) {
      win = win0;
    } else {
      win = win1;
    }
    if (!win || win.min.length === 0) continue;
    drawLane(ctx, cssWidth, lane, win, tileStartPx, totalWidthPx);
  }
}

export function TimelineWaveform({
  mediaId, srcInUs, srcOutUs, layerWidthPx, layerHeightPx, colorHint, enabled, pxPerSec, mediaChannels,
}: {
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
  layerWidthPx: number;
  layerHeightPx: number;
  colorHint: string;
  enabled: boolean;
  pxPerSec: number;
  /// Source audio channel count from probe metadata, when known. Caps the
  /// (always-stereo) peaks-file header count — see assembleWindowData.
  mediaChannels?: number | undefined;
}) {
  const { state, channels, win0, win1 } = useWindowData(mediaId, srcInUs, srcOutUs, pxPerSec, enabled, mediaChannels);
  const dprVersion = useDprVersion();
  const totalWidthPx = Math.max(1, Math.ceil(layerWidthPx));
  const height = Math.max(1, Math.ceil(layerHeightPx));

  const tiles = useMemo(() => {
    const n = Math.max(1, Math.ceil(totalWidthPx / RENDER_TILE_PX));
    return Array.from({ length: n }, (_, i) => ({
      startPx: i * RENDER_TILE_PX,
      widthPx: Math.min(RENDER_TILE_PX, totalWidthPx - i * RENDER_TILE_PX),
    }));
  }, [totalWidthPx]);

  return (
    <div
      data-testid="timeline-waveform"
      data-state={enabled ? state : "disabled"}
      className="flex h-full w-full overflow-hidden"
      style={{
        backgroundColor: colorHint,
        backgroundImage:
          state === "ready"
            ? undefined
            : "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.14))",
      }}
    >
      {tiles.map((tile) => (
        <WaveformTileCanvas
          key={tile.startPx}
          widthPx={tile.widthPx}
          height={height}
          channels={channels}
          win0={state === "ready" ? win0 : null}
          win1={state === "ready" ? win1 : null}
          tileStartPx={tile.startPx}
          totalWidthPx={totalWidthPx}
          dprVersion={dprVersion}
        />
      ))}
    </div>
  );
}

function WaveformTileCanvas({
  widthPx, height, channels, win0, win1, tileStartPx, totalWidthPx, dprVersion,
}: {
  widthPx: number;
  height: number;
  channels: number;
  win0: WaveformWindow | null;
  win1: WaveformWindow | null;
  tileStartPx: number;
  totalWidthPx: number;
  dprVersion: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    drawTile(c, widthPx, height, channels, win0, win1, tileStartPx, totalWidthPx);
    // dprVersion is intentionally unused in the body: drawTile re-reads
    // window.devicePixelRatio fresh on every call, so bumping the version
    // is enough to force this effect (and thus the redraw) to re-run.
  }, [widthPx, height, channels, win0, win1, tileStartPx, totalWidthPx, dprVersion]);
  return (
    <canvas
      ref={ref}
      data-testid="timeline-waveform-tile"
      style={{
        width: `${widthPx}px`,
        height: `${height}px`,
        contentVisibility: "auto",
        containIntrinsicSize: `${widthPx}px ${height}px`,
      }}
    />
  );
}
