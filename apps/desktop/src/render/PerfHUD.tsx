// Dev-only performance HUD overlaid on the preview canvas. Reads the
// Compositor's `getPerfSnapshot()` every 500 ms and runs its own rAF
// loop to measure real frame intervals. Toggle visibility with
// Ctrl+Shift+P (or pass `forceVisible` from a parent that already
// gates on `import.meta.env.DEV`).
//
// Why this exists: console-only logging is fine for one-shot
// diagnostics but won't catch trends — e.g. "ring drains during scrub
// and never refills". With this HUD pinned to the corner during real
// editing we can watch rAF P99 inch up before the user perceives a
// stutter, or spot a decoder queue stalling at zero while ring is
// also empty.

import { useCallback, useEffect, useRef, useState } from "react";

import type { Compositor, CompositorPerfSnapshot } from "./Compositor";
import type { PlaybackEngine } from "./PlaybackEngine";

interface Props {
  /// Live Compositor ref. The HUD calls `getPerfSnapshot()` on it.
  /// Holding the ref (not the live object) lets the HUD survive
  /// Compositor re-construction after a `setSuspended(true)` /
  /// `setSuspended(false)` export cycle.
  compositorRef: React.RefObject<Compositor | null>;
  /// Engine ref for the current playhead position (used to compute
  /// "ring lookahead past playhead" per clip).
  engineRef: React.RefObject<PlaybackEngine | null>;
}

/// Chromium-private `performance.memory` reading (WebView2 exposes it).
/// `null` when the runtime doesn't have it (e.g. non-Chromium).
interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readMemory(): PerfMemory | null {
  const p = performance as unknown as { memory?: PerfMemory };
  return p.memory ?? null;
}

/// Ring of recent rAF intervals (ms). Sized for ~2 s @ 60 Hz so the
/// P99 is meaningful over the window the HUD displays.
const INTERVAL_RING_CAP = 120;

function p50p99(values: number[]): { p50: number; p99: number } {
  if (values.length === 0) return { p50: 0, p99: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const p50Idx = Math.floor(sorted.length * 0.5);
  const p99Idx = Math.floor(sorted.length * 0.99);
  return {
    p50: sorted[Math.min(p50Idx, sorted.length - 1)] ?? 0,
    p99: sorted[Math.min(p99Idx, sorted.length - 1)] ?? 0,
  };
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatMs(ms: number): string {
  return ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
}

export function PerfHUD({ compositorRef, engineRef }: Props) {
  const [visible, setVisible] = useState(true);
  const [snap, setSnap] = useState<CompositorPerfSnapshot | null>(null);
  const [rafP50, setRafP50] = useState(0);
  const [rafP99, setRafP99] = useState(0);
  const [memory, setMemory] = useState<PerfMemory | null>(null);
  const [playheadUs, setPlayheadUs] = useState(0);

  // rAF interval tracking. We keep the ring + last-tick time on refs
  // so the rAF callback doesn't re-render on every frame; the HUD only
  // re-renders when the 500 ms polling tick recomputes P50/P99.
  const intervalsRef = useRef<number[]>([]);
  const lastRafMsRef = useRef<number | null>(null);

  useEffect(() => {
    let rafHandle = 0;
    const tick = (nowMs: number): void => {
      const prev = lastRafMsRef.current;
      if (prev !== null) {
        const ring = intervalsRef.current;
        ring.push(nowMs - prev);
        if (ring.length > INTERVAL_RING_CAP) ring.shift();
      }
      lastRafMsRef.current = nowMs;
      rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafHandle);
  }, []);

  // 500 ms polling: read Compositor snapshot, recompute rAF percentiles,
  // sample heap memory + playhead. Decoupled from rAF so a steady-state
  // HUD update doesn't itself influence what it's measuring.
  useEffect(() => {
    const id = setInterval(() => {
      const c = compositorRef.current;
      if (c) setSnap(c.getPerfSnapshot());
      const { p50, p99 } = p50p99(intervalsRef.current);
      setRafP50(p50);
      setRafP99(p99);
      setMemory(readMemory());
      setPlayheadUs(engineRef.current?.positionUs() ?? 0);
    }, 500);
    return () => clearInterval(id);
  }, [compositorRef, engineRef]);

  // Ctrl+Shift+P toggle. Captured at the window level so the user
  // doesn't need to focus the HUD to dismiss it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onResetPeaks = useCallback(() => {
    compositorRef.current?.resetPerfPeaks();
  }, [compositorRef]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        padding: "6px 8px",
        font: "11px ui-monospace, monospace",
        color: "#e5e7eb",
        background: "rgba(0,0,0,0.72)",
        borderRadius: 4,
        pointerEvents: "auto",
        zIndex: 50,
        minWidth: 220,
        lineHeight: 1.35,
        userSelect: "none",
      }}
      data-testid="perf-hud"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ color: "#fbbf24" }}>perf</strong>
        <button
          type="button"
          onClick={onResetPeaks}
          style={{
            font: "10px ui-monospace, monospace",
            color: "#9ca3af",
            background: "transparent",
            border: "1px solid #374151",
            borderRadius: 2,
            padding: "1px 5px",
            cursor: "pointer",
          }}
          title="Clear running max"
        >
          reset
        </button>
      </div>

      <div style={{ marginTop: 4 }}>
        rAF: P50 {formatMs(rafP50)}ms · P99 {formatMs(rafP99)}ms
      </div>
      <div>
        composite: {formatMs(snap?.compositeMsLast ?? 0)}ms · max{" "}
        {formatMs(snap?.compositeMsMax ?? 0)}ms
      </div>
      {memory && (
        <div>
          heap: {formatMb(memory.usedJSHeapSize)} /{" "}
          {formatMb(memory.totalJSHeapSize)}
        </div>
      )}

      {snap && snap.clips.length > 0 && (
        <div style={{ marginTop: 4, borderTop: "1px solid #374151", paddingTop: 4 }}>
          {snap.clips.map((clip) => {
            // The HUD doesn't know each clip's t_start_us / src_in_us
            // mapping, so we display the ring head against the playhead
            // composition time directly. Negative means the ring is
            // behind the playhead (decoder catching up); positive is
            // healthy lookahead. Useful as a rough trend rather than
            // an exact source-time comparison.
            const lastMs =
              clip.ringLastPtsUs !== null ? (clip.ringLastPtsUs / 1000).toFixed(0) : "—";
            return (
              <div key={clip.layerId}>
                {clip.layerId.slice(0, 6)}: q={clip.decodeQueueSize} ring=
                {clip.ringSize}@{lastMs}ms
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 4, color: "#6b7280", fontSize: 10 }}>
        playhead {(playheadUs / 1000).toFixed(0)}ms · Ctrl+Shift+P to hide
      </div>
    </div>
  );
}
