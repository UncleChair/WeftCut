import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getWaveformPeaks, type WaveformPeaks } from "../ipc";

type CacheEntry =
  | { state: "pending" }
  | { state: "not_ready" }
  | { state: "ready"; data: WaveformPeaks }
  | { state: "error"; message: string };

const peaksCache = new Map<string, CacheEntry>();
const peaksListeners = new Map<string, Set<() => void>>();
let jobListenerInstalled = false;

function notifyPeaks(mediaId: string) {
  peaksListeners.get(mediaId)?.forEach((cb) => cb());
}

function invalidate(mediaId: string) {
  peaksCache.delete(mediaId);
  notifyPeaks(mediaId);
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
  peaksCache.set(mediaId, { state: "pending" });
  try {
    const data = await getWaveformPeaks(mediaId);
    peaksCache.set(mediaId, { state: "ready", data });
  } catch (e) {
    const message = typeof e === "string" ? e : String(e);
    if (message.includes("not_ready")) {
      peaksCache.set(mediaId, { state: "not_ready" });
    } else {
      peaksCache.set(mediaId, { state: "error", message });
    }
  }
  notifyPeaks(mediaId);
}

async function installJobListenerOnce() {
  if (jobListenerInstalled) return;
  jobListenerInstalled = true;
  await listen<{ media_id: string; kind: string }>(
    "media:job_complete",
    (event) => {
      if (event.payload?.kind === "waveform") {
        invalidate(event.payload.media_id);
      }
    },
  );
}

function useWaveformPeaks(mediaId: string | null): CacheEntry | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!mediaId) return;
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
    };
  }, [mediaId]);
  if (!mediaId) return null;
  return peaksCache.get(mediaId) ?? null;
}

interface Props {
  mediaId: string;
  /// Source-clock start of the layer's visible window, in microseconds.
  srcInUs: number;
  /// Source-clock end of the layer's visible window, in microseconds.
  srcOutUs: number;
  /// Canvas display width in CSS pixels.
  width: number;
  /// Canvas display height in CSS pixels.
  height: number;
  /// Stroke color for the peaks (rgba string).
  color?: string;
}

export function WaveformCanvas({
  mediaId,
  srcInUs,
  srcOutUs,
  width,
  height,
  color = "rgba(255, 255, 255, 0.7)",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const entry = useWaveformPeaks(mediaId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!entry || entry.state !== "ready") {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.floor(width));
    const cssH = Math.max(1, Math.floor(height));
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { peaks, peaks_per_second } = entry.data;
    if (peaks.length === 0 || cssW <= 0) return;

    // Peak index range covered by this layer's source window.
    const startPeak = Math.max(
      0,
      Math.floor((srcInUs / 1_000_000) * peaks_per_second),
    );
    const endPeak = Math.min(
      peaks.length,
      Math.ceil((srcOutUs / 1_000_000) * peaks_per_second),
    );
    const span = Math.max(1, endPeak - startPeak);

    // Centerline waveform: per pixel column, take max-abs of the peaks
    // falling into that column, draw a vertical bar from center.
    const mid = cssH / 2;
    ctx.fillStyle = color;
    const peaksPerPx = span / cssW;
    for (let x = 0; x < cssW; x++) {
      const a = startPeak + Math.floor(x * peaksPerPx);
      const b = Math.min(endPeak, startPeak + Math.ceil((x + 1) * peaksPerPx));
      let peak = 0;
      for (let i = a; i < b; i++) {
        const v = peaks[i];
        if (v > peak) peak = v;
      }
      const half = Math.max(0.5, peak * mid);
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }, [entry, srcInUs, srcOutUs, width, height, color]);

  const cssW = Math.max(1, Math.floor(width));
  const cssH = Math.max(1, Math.floor(height));

  return (
    <canvas
      ref={canvasRef}
      className="waveform-canvas"
      style={{
        width: cssW,
        height: cssH,
        display: "block",
        pointerEvents: "none",
      }}
    />
  );
}
