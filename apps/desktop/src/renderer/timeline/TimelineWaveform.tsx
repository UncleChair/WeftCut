import { useEffect, useRef, useState } from "react";
import { listen } from "@/bridge/events";
import {
  MEDIA_JOB_EVENTS,
  getWaveformPeaks,
  type WaveformPeaks,
} from "../ipc";

type PeaksEntry =
  | { state: "pending" }
  | { state: "not_ready" }
  | { state: "ready"; peaks: WaveformPeaks }
  | { state: "error"; message: string };

const peaksCache = new Map<string, PeaksEntry>();
const peaksListeners = new Map<string, Set<() => void>>();
const peaksRequestVersions = new Map<string, number>();
const MAX_WAVEFORM_CANVAS_WIDTH = 4096;
let jobListenerInstalled = false;

function firePeaksListeners(mediaId: string) {
  peaksListeners.get(mediaId)?.forEach((cb) => cb());
}

function bumpPeaksRequestVersion(mediaId: string): number {
  const next = (peaksRequestVersions.get(mediaId) ?? 0) + 1;
  peaksRequestVersions.set(mediaId, next);
  return next;
}

async function ensurePeaks(mediaId: string) {
  const cached = peaksCache.get(mediaId);
  if (
    cached?.state === "pending" ||
    cached?.state === "ready" ||
    cached?.state === "error"
  ) {
    return;
  }
  const requestVersion = bumpPeaksRequestVersion(mediaId);
  peaksCache.set(mediaId, { state: "pending" });
  try {
    const peaks = await getWaveformPeaks(mediaId);
    if (peaksRequestVersions.get(mediaId) !== requestVersion) return;
    peaksCache.set(mediaId, { state: "ready", peaks });
  } catch (e) {
    if (peaksRequestVersions.get(mediaId) !== requestVersion) return;
    const message = typeof e === "string" ? e : String(e);
    peaksCache.set(
      mediaId,
      message.includes("not_ready")
        ? { state: "not_ready" }
        : { state: "error", message },
    );
  }
  firePeaksListeners(mediaId);
}

async function installJobListenerOnce() {
  if (jobListenerInstalled) return;
  jobListenerInstalled = true;
  await listen<{ media_id: string; kind: string }>(
    MEDIA_JOB_EVENTS.complete,
    (event) => {
      if (event.payload?.kind !== "waveform") return;
      const mediaId = event.payload.media_id;
      peaksCache.delete(mediaId);
      bumpPeaksRequestVersion(mediaId);
      firePeaksListeners(mediaId);
      if ((peaksListeners.get(mediaId)?.size ?? 0) > 0) {
        void ensurePeaks(mediaId);
      }
    },
  );
}

function useWaveformPeaks(
  mediaId: string,
  enabled: boolean,
): PeaksEntry | undefined {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const listener = () => setTick((t) => t + 1);
    let listeners = peaksListeners.get(mediaId);
    if (!listeners) {
      listeners = new Set();
      peaksListeners.set(mediaId, listeners);
    }
    listeners.add(listener);
    void installJobListenerOnce();
    void ensurePeaks(mediaId);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) peaksListeners.delete(mediaId);
    };
  }, [enabled, mediaId]);
  return enabled ? peaksCache.get(mediaId) : undefined;
}

function drawCenterLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const mid = Math.max(1, height / 2);
  ctx.strokeStyle = "rgba(255,255,255,0.34)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
}

function drawPeaks({
  ctx,
  width,
  height,
  peaks,
  srcInUs,
  srcOutUs,
}: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  peaks: WaveformPeaks;
  srcInUs: number;
  srcOutUs: number;
}) {
  const sourceStart = Math.max(0, Math.min(srcInUs, srcOutUs));
  const sourceEnd = Math.max(srcInUs, srcOutUs);
  const startPeak = Math.max(
    0,
    Math.floor((sourceStart / 1_000_000) * peaks.peaks_per_second),
  );
  const endPeak = Math.min(
    peaks.peaks.length,
    Math.ceil((sourceEnd / 1_000_000) * peaks.peaks_per_second),
  );
  const sourcePeaks = peaks.peaks.slice(startPeak, endPeak);
  if (sourcePeaks.length === 0) {
    drawCenterLine(ctx, width, height);
    return;
  }

  const mid = height / 2;
  const barStride = 2;
  const bars = Math.max(1, Math.ceil(width / barStride));
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i / bars) * sourcePeaks.length);
    const end = Math.max(
      start + 1,
      Math.floor(((i + 1) / bars) * sourcePeaks.length),
    );
    let amp = 0;
    for (let j = start; j < end && j < sourcePeaks.length; j++) {
      amp = Math.max(amp, Math.abs(sourcePeaks[j] ?? 0));
    }
    const barHeight = Math.max(1, amp * (height / 2 - 2));
    ctx.fillRect(i * barStride, mid - barHeight, 1, barHeight * 2);
  }
}

export function TimelineWaveform({
  mediaId,
  srcInUs,
  srcOutUs,
  layerWidthPx,
  layerHeightPx,
  colorHint,
  enabled,
}: {
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
  layerWidthPx: number;
  layerHeightPx: number;
  colorHint: string;
  enabled: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const entry = useWaveformPeaks(mediaId, enabled);
  const state = entry?.state ?? (enabled ? "pending" : "disabled");
  const width = Math.max(
    1,
    Math.min(MAX_WAVEFORM_CANVAS_WIDTH, Math.ceil(layerWidthPx)),
  );
  const height = Math.max(1, Math.ceil(layerHeightPx));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (entry?.state === "ready") {
      drawPeaks({ ctx, width, height, peaks: entry.peaks, srcInUs, srcOutUs });
    } else {
      drawCenterLine(ctx, width, height);
    }
  }, [entry, height, srcInUs, srcOutUs, width]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="timeline-waveform"
      data-state={state}
      className="h-full w-full"
      style={{
        backgroundColor: colorHint,
        backgroundImage:
          state === "ready"
            ? undefined
            : "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.14))",
      }}
      width={width}
      height={height}
    />
  );
}
