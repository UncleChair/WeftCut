import { useEffect, useMemo, useRef, useState } from "react";
import { tileEngine } from "./tileEngine/TileEngine";
import {
  ensureWaveformWindow,
  registerWaveformProducer,
  type WaveformWindow,
} from "./tileEngine/WaveformTileProducer";

registerWaveformProducer();

/// Max CSS width of one render tile canvas. Fixed + small so no single canvas
/// approaches the browser's element-size limit; offscreen tiles are cheap and
/// (with content-visibility) skip rasterization.
const RENDER_TILE_PX = 2048;

type RenderState = "pending" | "not_ready" | "ready";

function useWindowData(
  mediaId: string,
  srcInUs: number,
  srcOutUs: number,
  pxPerSec: number,
  enabled: boolean,
): { state: RenderState; window: WaveformWindow | null } {
  const [result, setResult] = useState<{ state: RenderState; window: WaveformWindow | null }>(
    { state: "pending", window: null },
  );
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = () => {
      void ensureWaveformWindow(mediaId, 0, srcInUs, srcOutUs, pxPerSec).then((r) => {
        if (cancelled) return;
        if (r === "pending") setResult({ state: "pending", window: null });
        else if (r === "not_ready") setResult({ state: "not_ready", window: null });
        else setResult({ state: "ready", window: r });
      });
    };
    const unsub = tileEngine.subscribe(mediaId, run);
    run();
    return () => { cancelled = true; unsub(); };
  }, [mediaId, srcInUs, srcOutUs, pxPerSec, enabled]);
  return result;
}

function drawTile(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  win: WaveformWindow | null,
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
  const mid = cssHeight / 2;

  if (!win || win.min.length === 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(cssWidth, mid);
    ctx.stroke();
    return;
  }

  // Map this tile's px range [tileStartPx, tileStartPx+cssWidth) to peak indices.
  const peaks = win.min.length;
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  const amp = cssHeight / 2 - 1;
  for (let px = 0; px < cssWidth; px++) {
    const gpx = tileStartPx + px;
    const p0 = Math.floor((gpx / totalWidthPx) * peaks);
    const p1 = Math.max(p0 + 1, Math.floor(((gpx + 1) / totalWidthPx) * peaks));
    let lo = 0, hi = 0;
    for (let p = p0; p < p1 && p < peaks; p++) {
      lo = Math.min(lo, win.min[p] ?? 0);
      hi = Math.max(hi, win.max[p] ?? 0);
    }
    const yTop = mid - hi * amp;
    const yBot = mid - lo * amp;
    ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
  }
}

export function TimelineWaveform({
  mediaId, srcInUs, srcOutUs, layerWidthPx, layerHeightPx, colorHint, enabled, pxPerSec,
}: {
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
  layerWidthPx: number;
  layerHeightPx: number;
  colorHint: string;
  enabled: boolean;
  pxPerSec: number;
}) {
  const { state, window: win } = useWindowData(mediaId, srcInUs, srcOutUs, pxPerSec, enabled);
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
          win={state === "ready" ? win : null}
          tileStartPx={tile.startPx}
          totalWidthPx={totalWidthPx}
        />
      ))}
    </div>
  );
}

function WaveformTileCanvas({
  widthPx, height, win, tileStartPx, totalWidthPx,
}: {
  widthPx: number;
  height: number;
  win: WaveformWindow | null;
  tileStartPx: number;
  totalWidthPx: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    drawTile(c, widthPx, height, win, tileStartPx, totalWidthPx);
  }, [widthPx, height, win, tileStartPx, totalWidthPx]);
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
