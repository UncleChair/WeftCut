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
import type { PlaybackEngine, WarmupStats } from "./PlaybackEngine";

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

/// Circular buffer for rAF intervals. Avoids the O(n) Array.shift on
/// every overflow tick (~7200 shifts/sec at 60 Hz with CAP=120, each
/// re-indexing the full ring — a measurable perturbation of the very
/// interval we're trying to measure on slower machines).
interface IntervalRing {
  buf: number[];
  writeIdx: number;
  filled: boolean;
}

function newIntervalRing(): IntervalRing {
  return { buf: new Array<number>(INTERVAL_RING_CAP), writeIdx: 0, filled: false };
}

function pushInterval(ring: IntervalRing, value: number): void {
  ring.buf[ring.writeIdx] = value;
  ring.writeIdx = (ring.writeIdx + 1) % INTERVAL_RING_CAP;
  if (ring.writeIdx === 0) ring.filled = true;
}

function p50p99FromRing(ring: IntervalRing): { p50: number; p99: number } {
  const len = ring.filled ? INTERVAL_RING_CAP : ring.writeIdx;
  if (len === 0) return { p50: 0, p99: 0 };
  const sorted = ring.buf.slice(0, len).sort((a, b) => a - b);
  const p50Idx = Math.floor(len * 0.5);
  const p99Idx = Math.floor(len * 0.99);
  return {
    p50: sorted[Math.min(p50Idx, len - 1)] ?? 0,
    p99: sorted[Math.min(p99Idx, len - 1)] ?? 0,
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
  const [warmup, setWarmup] = useState<WarmupStats>({
    lastMs: null,
    maxMs: 0,
    lastReason: null,
  });

  // rAF interval tracking. We keep the ring + last-tick time on refs
  // so the rAF callback doesn't re-render on every frame; the HUD only
  // re-renders when the 500 ms polling tick recomputes P50/P99.
  const intervalsRef = useRef<IntervalRing>(newIntervalRing());
  const lastRafMsRef = useRef<number | null>(null);

  useEffect(() => {
    // Reset on every (re)mount — StrictMode double-invokes effects,
    // and lastRafMsRef.current would otherwise survive the unmount
    // and feed a stale prev into the first tick of the re-mount.
    lastRafMsRef.current = null;
    let rafHandle = 0;
    const tick = (nowMs: number): void => {
      const prev = lastRafMsRef.current;
      if (prev !== null) {
        pushInterval(intervalsRef.current, nowMs - prev);
      }
      lastRafMsRef.current = nowMs;
      rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafHandle);
  }, []);

  // When the tab is hidden/blurred, WebView2 pauses rAF. On unhide,
  // the first tick computes a multi-second interval from the
  // pre-hide timestamp and dumps that bogus number into the P50/P99
  // ring for the next ~120 frames, making the HUD look like preview
  // is stuttering. Clear `lastRafMsRef` so the first tick after
  // unhide is treated as the start of a fresh measurement.
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === "visible") {
        lastRafMsRef.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // 500 ms polling: read Compositor snapshot, recompute rAF percentiles,
  // sample heap memory + playhead. Decoupled from rAF so a steady-state
  // HUD update doesn't itself influence what it's measuring.
  useEffect(() => {
    const id = setInterval(() => {
      const c = compositorRef.current;
      if (c) setSnap(c.getPerfSnapshot());
      const { p50, p99 } = p50p99FromRing(intervalsRef.current);
      setRafP50(p50);
      setRafP99(p99);
      setMemory(readMemory());
      const e = engineRef.current;
      setPlayheadUs(e?.positionUs() ?? 0);
      if (e) setWarmup(e.getWarmupStats());
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
    engineRef.current?.resetWarmupStats();
    setWarmup({ lastMs: null, maxMs: 0, lastReason: null });
  }, [compositorRef, engineRef]);

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
        // Sits above the Pixi canvas + status pill, but BELOW page
        // chrome popovers / dropdowns / modals (which use z-index 50+
        // in styles.css). Without this the dev HUD covered the
        // Settings popup and similar.
        zIndex: 1,
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
      <div>
        warmup:{" "}
        {warmup.lastMs === null ? (
          <span style={{ color: "#6b7280" }}>—</span>
        ) : (
          <>
            {formatMs(warmup.lastMs)}ms · max {formatMs(warmup.maxMs)}ms
            {warmup.lastReason && (
              <span
                style={{
                  marginLeft: 4,
                  color: warmup.lastReason === "deadline-hit" ? "#f59e0b" : "#6b7280",
                }}
                title={
                  warmup.lastReason === "deadline-hit"
                    ? "WARMUP_MAX_WAIT_MS cap hit — ring may not have been full; possible initial-frame stutter"
                    : "Lookahead ready before the cap — healthy"
                }
              >
                ({warmup.lastReason === "lookahead-ready" ? "lh" : "cap"})
              </span>
            )}
          </>
        )}
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
