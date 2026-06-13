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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PanelTopOpenIcon, RotateCcwIcon } from "lucide-react";

import { getSystemStats, type SystemStats } from "../ipc";
import type { Compositor, CompositorPerfSnapshot } from "./Compositor";
import type { PlaybackEngine, WarmupStats } from "./PlaybackEngine";
import { throughputFps, type ThroughputSample } from "./perfHudStats";

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
export interface PerfMemory {
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

function formatUsAsMs(us: number): string {
  return (us / 1000).toFixed(0);
}

function formatDb(db: number): string {
  return Number.isFinite(db) && db > -119.95 ? db.toFixed(1) : "-inf";
}

function jsonSafeDb(db: number): number {
  return Number.isFinite(db) ? db : -120;
}

type MetricTone = "ok" | "warn" | "muted";
const HUD_EDGE_MARGIN = 12;
export const PERF_HUD_SNAPSHOT_EVENT = "weftcut://perf-hud-snapshot";
const PERF_HUD_WINDOW_LABEL = "perf-hud";

function toneClass(tone: MetricTone | undefined): string {
  return tone ? ` perf-hud-metric-${tone}` : "";
}

function mutedDash(): ReactNode {
  return <span className="perf-hud-muted">—</span>;
}

function MetricCard({
  label,
  value,
  meta,
  tone,
  title,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode | undefined;
  tone?: MetricTone | undefined;
  title?: string | undefined;
}) {
  return (
    <div className={`perf-hud-metric${toneClass(tone)}`} title={title}>
      <div className="perf-hud-label">{label}</div>
      <div className="perf-hud-value">{value}</div>
      {meta ? <div className="perf-hud-meta">{meta}</div> : null}
    </div>
  );
}

export interface PerfHudSample {
  snap: CompositorPerfSnapshot | null;
  rafP50: number;
  rafP99: number;
  memory: PerfMemory | null;
  playheadUs: number;
  warmup: WarmupStats;
  fpsByLayer: Array<[string, number]>;
  sys: SystemStats | null;
  aud: { rmsDb: number; peakDb: number } | null;
}

interface HudPosition {
  left: number;
  top: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originLeft: number;
  originTop: number;
}

function positionsEqual(a: HudPosition | null, b: HudPosition): boolean {
  return a !== null && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5;
}

function clampHudPosition(
  pos: HudPosition,
  hudEl: HTMLElement,
  parentEl: HTMLElement,
): HudPosition {
  const hudRect = hudEl.getBoundingClientRect();
  const parentRect = parentEl.getBoundingClientRect();
  const maxLeft = Math.max(HUD_EDGE_MARGIN, parentRect.width - hudRect.width - HUD_EDGE_MARGIN);
  const maxTop = Math.max(HUD_EDGE_MARGIN, parentRect.height - hudRect.height - HUD_EDGE_MARGIN);
  return {
    left: Math.min(Math.max(HUD_EDGE_MARGIN, pos.left), maxLeft),
    top: Math.min(Math.max(HUD_EDGE_MARGIN, pos.top), maxTop),
  };
}

function hudPositionFromRects(hudEl: HTMLElement, parentEl: HTMLElement): HudPosition {
  const hudRect = hudEl.getBoundingClientRect();
  const parentRect = parentEl.getBoundingClientRect();
  return {
    left: hudRect.left - parentRect.left,
    top: hudRect.top - parentRect.top,
  };
}

function PerfHUDPanel({
  sample,
  onResetPeaks,
  onPopOut,
  onHeaderPointerDown,
  onHeaderPointerMove,
  onHeaderPointerUp,
  onHeaderPointerCancel,
  detached = false,
}: {
  sample: PerfHudSample;
  onResetPeaks?: (() => void) | undefined;
  onPopOut?: (() => void) | undefined;
  onHeaderPointerDown?: ((e: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  onHeaderPointerMove?: ((e: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  onHeaderPointerUp?: ((e: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  onHeaderPointerCancel?: ((e: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  detached?: boolean | undefined;
}) {
  const {
    snap,
    rafP50,
    rafP99,
    memory,
    playheadUs,
    warmup,
    fpsByLayer,
    sys,
    aud,
  } = sample;
  const fpsLookup = new Map(fpsByLayer);
  const prewarm = snap?.upcomingPrewarm;
  const prewarmRequested = prewarm?.clips.filter((clip) => clip.requested).length ?? 0;
  const prewarmDueMs =
    prewarm?.nextStartUs === null || prewarm?.nextStartUs === undefined
      ? null
      : formatUsAsMs(Math.max(0, prewarm.nextStartUs - prewarm.anchorUs));
  const heapCapRatio =
    memory && memory.jsHeapSizeLimit > 0 ? memory.usedJSHeapSize / memory.jsHeapSizeLimit : null;
  const hasPrewarmRows = (prewarm?.clips.length ?? 0) > 0;
  const hasClipRows = (snap?.clips.length ?? 0) > 0;
  const hasDetails = Boolean(hasPrewarmRows || hasClipRows || (snap && snap.swapsInFlight > 0));

  return (
    <>
      <div
        className="perf-hud-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerCancel}
      >
        <div className="perf-hud-heading">
          <div className="perf-hud-title">
            <span className="perf-hud-live-dot" aria-hidden="true" />
            Performance
          </div>
          <div className="perf-hud-subtitle">playhead {(playheadUs / 1000).toFixed(0)}ms</div>
        </div>
        <div className="perf-hud-actions">
          {onPopOut ? (
            <button
              type="button"
              className="perf-hud-icon-button"
              onClick={onPopOut}
              title="Open performance window"
              aria-label="Open performance window"
            >
              <PanelTopOpenIcon size={12} aria-hidden="true" />
            </button>
          ) : null}
          {onResetPeaks ? (
            <button
              type="button"
              className="perf-hud-icon-button"
              onClick={onResetPeaks}
              title="Reset peaks"
              aria-label="Reset performance peaks"
            >
              <RotateCcwIcon size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="perf-hud-grid">
        <MetricCard
          label="rAF"
          value={`${formatMs(rafP50)}ms`}
          meta={`P99 ${formatMs(rafP99)}ms`}
          tone={rafP99 > 34 ? "warn" : undefined}
        />
        <MetricCard
          label="Composite"
          value={`${formatMs(snap?.compositeMsLast ?? 0)}ms`}
          meta={`max ${formatMs(snap?.compositeMsMax ?? 0)}ms`}
          tone={(snap?.compositeMsMax ?? 0) > 24 ? "warn" : undefined}
        />
        <MetricCard
          label="Warmup"
          value={warmup.lastMs === null ? mutedDash() : `${formatMs(warmup.lastMs)}ms`}
          meta={
            warmup.lastMs === null ? (
              "idle"
            ) : (
              <>
                max {formatMs(warmup.maxMs)}ms
                {warmup.lastReason ? (
                  <span
                    className={
                      warmup.lastReason === "deadline-hit"
                        ? "perf-hud-inline-warn"
                        : "perf-hud-inline-muted"
                    }
                    title={
                      warmup.lastReason === "deadline-hit"
                        ? "WARMUP_MAX_WAIT_MS cap hit — ring may not have been full; possible initial-frame stutter"
                        : "Lookahead ready before the cap — healthy"
                    }
                  >
                    {" "}
                    {warmup.lastReason === "lookahead-ready" ? "lh" : "cap"}
                  </span>
                ) : null}
              </>
            )
          }
          tone={warmup.lastReason === "deadline-hit" ? "warn" : undefined}
        />
        <MetricCard
          label="Prewarm"
          value={!prewarm ? mutedDash() : prewarmDueMs === null ? "none" : `${prewarmDueMs}ms`}
          meta={
            !prewarm
              ? "waiting"
              : prewarmDueMs === null
                ? `<${(prewarm.windowUs / 1_000_000).toFixed(1)}s`
                : `${prewarmRequested}/${prewarm.clips.length} req`
          }
          tone={
            prewarm && prewarmDueMs !== null && prewarmRequested < prewarm.clips.length
              ? "warn"
              : undefined
          }
        />
        {memory ? (
          <MetricCard
            label="Heap"
            value={`${formatMb(memory.usedJSHeapSize)}`}
            meta={
              <>
                {formatMb(memory.totalJSHeapSize)}
                {heapCapRatio !== null ? (
                  <span
                    // % of the hard heap ceiling — the actual pressure signal.
                    // used/total only shows fill of the current arena, which
                    // grows on demand; used/limit is how close we are to OOM.
                    className={
                      heapCapRatio > 0.85 ? "perf-hud-inline-warn" : "perf-hud-inline-muted"
                    }
                  >
                    {" "}
                    {`${(heapCapRatio * 100).toFixed(0)}% cap`}
                  </span>
                ) : null}
              </>
            }
            tone={heapCapRatio !== null && heapCapRatio > 0.85 ? "warn" : undefined}
          />
        ) : null}
        {sys ? (
          <MetricCard
            label="CPU"
            value={`${sys.cpu_percent.toFixed(0)}%`}
            meta={`${formatMb(sys.rss_bytes)} · ${sys.process_count}p`}
            tone={sys.cpu_percent > 80 ? "warn" : undefined}
            title={`${sys.process_count} processes · ${sys.logical_cores} logical cores`}
          />
        ) : null}
        {aud ? (
          <MetricCard
            label="Audio"
            value={`rms ${formatDb(aud.rmsDb)}`}
            meta={
              <>
                peak{" "}
                <span
                  className={
                    Number.isFinite(aud.peakDb) && aud.peakDb > -1
                      ? "perf-hud-inline-warn"
                      : undefined
                  }
                >
                  {formatDb(aud.peakDb)} dB
                </span>
              </>
            }
            tone={Number.isFinite(aud.peakDb) && aud.peakDb > -1 ? "warn" : undefined}
            title="Master audio bus (rms / peak dBFS)"
          />
        ) : null}
      </div>

      {hasDetails ? (
        <div className={`perf-hud-details${detached ? " perf-hud-details-detached" : ""}`}>
          {snap && snap.swapsInFlight > 0 ? (
            <div
              className="perf-hud-alert-row"
              title="In-flight no-flash source swaps (bridge→proxy)"
            >
              swaps in flight: {snap.swapsInFlight}
            </div>
          ) : null}

          {hasPrewarmRows ? (
            <div className="perf-hud-section">
              <div className="perf-hud-section-title">Prewarm</div>
              {prewarm?.clips.map((clip) => {
                const lastMs =
                  clip.ringLastPtsUs !== null ? formatUsAsMs(clip.ringLastPtsUs) : "—";
                return (
                  <div
                    key={`prewarm-${clip.layerId}`}
                    className={`perf-hud-row${clip.requested ? "" : " perf-hud-row-warn"}`}
                  >
                    <span className="perf-hud-row-id">{clip.layerId.slice(0, 6)}</span>
                    <span className="perf-hud-row-main">
                      q={clip.decodeQueueSize} · ring={clip.ringSize}@{lastMs}ms
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {hasClipRows ? (
            <div className="perf-hud-section">
              <div className="perf-hud-section-title">Clips</div>
              {snap?.clips.map((clip) => {
                // Ring span shown as [first-last] composition-ms. The HUD
                // doesn't know each clip's t_start_us / src_in_us mapping, so
                // this is a rough lookahead trend, not an exact source-time
                // comparison. `HW`/`SW` flags a software-decode downgrade;
                // the trailing mark is green when the lookahead window is
                // satisfied, amber when the decoder is running behind.
                const firstMs =
                  clip.ringFirstPtsUs !== null ? (clip.ringFirstPtsUs / 1000).toFixed(0) : "—";
                const lastMs =
                  clip.ringLastPtsUs !== null ? (clip.ringLastPtsUs / 1000).toFixed(0) : "—";
                const fps = fpsLookup.get(clip.layerId) ?? 0;
                return (
                  <div key={clip.layerId} className="perf-hud-row perf-hud-clip-row">
                    <span className="perf-hud-row-id">{clip.layerId.slice(0, 6)}</span>
                    <span
                      className={`perf-hud-pill${clip.downgraded ? " perf-hud-pill-warn" : ""}`}
                      title={clip.downgraded ? "Software decode (downgraded)" : "Hardware decode"}
                    >
                      {clip.downgraded ? "SW" : "HW"}
                    </span>
                    <span className="perf-hud-row-main">
                      {fps.toFixed(0)}fps · q={clip.decodeQueueSize} · ring={clip.ringSize} [
                      {firstMs}-{lastMs}]
                    </span>
                    <span
                      className={clip.lookaheadFull ? "perf-hud-ok" : "perf-hud-inline-warn"}
                      title={
                        clip.lookaheadFull
                          ? "Lookahead window satisfied"
                          : "Decoder running behind the lookahead window"
                      }
                    >
                      {clip.lookaheadFull ? "✓" : "…"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
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
  // Live decode fps per clip, derived each poll tick by diffing each
  // clip's cumulative `decodedFrameCount` against the previous sample.
  // Keyed by layerId; entries for clips no longer in the snapshot are
  // dropped automatically (the ref map is rebuilt from the live clips).
  const [fpsByLayer, setFpsByLayer] = useState<Map<string, number>>(new Map());
  const prevSamplesRef = useRef<Map<string, ThroughputSample>>(new Map());
  // System-resource snapshot from the Rust sysmon sampler (process-tree
  // CPU%/RSS). Null until its first tick, or in a release build where the
  // command doesn't exist.
  const [sys, setSys] = useState<SystemStats | null>(null);
  // Master audio bus meter (rms/peak dBFS). Null in export mode or before
  // the graph exists.
  const [aud, setAud] = useState<{ rmsDb: number; peakDb: number } | null>(null);
  const [hudPosition, setHudPosition] = useState<HudPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  // rAF interval tracking. We keep the ring + last-tick time on refs
  // so the rAF callback doesn't re-render on every frame; the HUD only
  // re-renders when the 500 ms polling tick recomputes P50/P99.
  const intervalsRef = useRef<IntervalRing>(newIntervalRing());
  const lastRafMsRef = useRef<number | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

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
      if (c) {
        const s = c.getPerfSnapshot();
        // Diff each clip's cumulative decode count against last tick to
        // get a live fps. Rebuild the sample map from the current clips
        // so handles that have gone away stop being tracked.
        const nowMs = performance.now();
        const nextFps = new Map<string, number>();
        const nextSamples = new Map<string, ThroughputSample>();
        for (const clip of s.clips) {
          const cur: ThroughputSample = { count: clip.decodedFrameCount, atMs: nowMs };
          nextFps.set(clip.layerId, throughputFps(prevSamplesRef.current.get(clip.layerId), cur));
          nextSamples.set(clip.layerId, cur);
        }
        prevSamplesRef.current = nextSamples;
        setFpsByLayer(nextFps);
        setSnap(s);
        setAud(c.getAudioGraph()?.meterSnapshot() ?? null);
      }
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

  // System-resource poll (Rust sysmon), on a slower 1 s cadence: CPU/RSS
  // move slowly and the sampler itself only updates once a second.
  // `get_system_stats` is dev-only — swallow rejection so a release build
  // (no such command) doesn't spam the console.
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(() => {
      getSystemStats()
        .then((s) => {
          if (!cancelled) setSys(s);
        })
        .catch(() => {});
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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

  useEffect(() => {
    if (visible) return;
    dragRef.current = null;
    setDragging(false);
  }, [visible]);

  const onResetPeaks = useCallback(() => {
    compositorRef.current?.resetPerfPeaks();
    engineRef.current?.resetWarmupStats();
    setWarmup({ lastMs: null, maxMs: 0, lastReason: null });
  }, [compositorRef, engineRef]);

  useLayoutEffect(() => {
    if (!visible) return;
    const hudEl = hudRef.current;
    const parentEl = hudEl?.parentElement;
    if (!hudEl || !parentEl) return;

    const keepInBounds = (): void => {
      setHudPosition((pos) => {
        const measured = pos ?? hudPositionFromRects(hudEl, parentEl);
        const next = clampHudPosition(measured, hudEl, parentEl);
        return positionsEqual(pos, next) ? pos : next;
      });
    };

    keepInBounds();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(keepInBounds);
    observer.observe(parentEl);
    observer.observe(hudEl);
    return () => observer.disconnect();
  }, [visible]);

  const beginDrag = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button")) return;

    const hudEl = hudRef.current;
    const parentEl = hudEl?.parentElement;
    if (!hudEl || !parentEl) return;

    const origin = clampHudPosition(hudPositionFromRects(hudEl, parentEl), hudEl, parentEl);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: origin.left,
      originTop: origin.top,
    };
    setHudPosition((pos) => (positionsEqual(pos, origin) ? pos : origin));
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const moveDrag = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const hudEl = hudRef.current;
    const parentEl = hudEl?.parentElement;
    if (!hudEl || !parentEl) return;

    const next = clampHudPosition(
      {
        left: drag.originLeft + e.clientX - drag.startX,
        top: drag.originTop + e.clientY - drag.startY,
      },
      hudEl,
      parentEl,
    );
    setHudPosition((pos) => (positionsEqual(pos, next) ? pos : next));
    e.preventDefault();
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const sample: PerfHudSample = {
    snap,
    rafP50,
    rafP99,
    memory,
    playheadUs,
    warmup,
    fpsByLayer: Array.from(fpsByLayer.entries()),
    sys,
    aud: aud ? { rmsDb: jsonSafeDb(aud.rmsDb), peakDb: jsonSafeDb(aud.peakDb) } : null,
  };

  useEffect(() => {
    void emit(PERF_HUD_SNAPSHOT_EVENT, sample).catch(() => {});
  }, [snap, rafP50, rafP99, memory, playheadUs, warmup, fpsByLayer, sys, aud]);

  const openPerfHudWindow = useCallback(async (): Promise<void> => {
    try {
      const existing = await WebviewWindow.getByLabel(PERF_HUD_WINDOW_LABEL);
      if (existing) {
        await existing.show().catch(() => {});
        await existing.setFocus().catch(() => {});
        await emit(PERF_HUD_SNAPSHOT_EVENT, sample).catch(() => {});
        return;
      }
      const win = new WebviewWindow(PERF_HUD_WINDOW_LABEL, {
        url: "/?perfHud=1",
        title: "WeftCut — Performance",
        width: 620,
        height: 520,
        minWidth: 480,
        minHeight: 360,
        resizable: true,
        decorations: true,
      });
      void win.once("tauri://created", () => {
        void emit(PERF_HUD_SNAPSHOT_EVENT, sample).catch(() => {});
      });
      void win.once("tauri://error", (e) => {
        console.error("[weftcut/perf-hud] webview error:", e);
      });
    } catch (e) {
      console.error("[weftcut/perf-hud] failed to open popup:", e);
    }
  }, [sample]);

  if (!visible) return null;

  const inlineHasDetails = Boolean(
    (snap?.upcomingPrewarm?.clips.length ?? 0) > 0 ||
      (snap?.clips.length ?? 0) > 0 ||
      (snap && snap.swapsInFlight > 0),
  );
  const hudStyle: CSSProperties | undefined = hudPosition
    ? { left: hudPosition.left, top: hudPosition.top, bottom: "auto" }
    : undefined;

  return (
    <div
      ref={hudRef}
      className={`perf-hud${dragging ? " is-dragging" : ""}${
        inlineHasDetails ? " has-details" : ""
      }`}
      style={hudStyle}
      data-testid="perf-hud"
    >
      <PerfHUDPanel
        sample={sample}
        onResetPeaks={onResetPeaks}
        onPopOut={() => void openPerfHudWindow()}
        onHeaderPointerDown={beginDrag}
        onHeaderPointerMove={moveDrag}
        onHeaderPointerUp={endDrag}
        onHeaderPointerCancel={endDrag}
      />
    </div>
  );
}

export function PerfHUDWindow() {
  const [sample, setSample] = useState<PerfHudSample | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<PerfHudSample>(PERF_HUD_SNAPSHOT_EVENT, (event) => {
      setSample(event.payload);
    }).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="perf-hud-window">
      {sample ? (
        <div className="perf-hud perf-hud-detached" data-testid="perf-hud-window">
          <PerfHUDPanel sample={sample} detached />
        </div>
      ) : (
        <div className="perf-hud-window-empty">Waiting for preview performance data…</div>
      )}
    </div>
  );
}
