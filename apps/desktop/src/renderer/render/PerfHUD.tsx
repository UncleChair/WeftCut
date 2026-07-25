// Dev-only Performance Monitor. The editor owns a headless telemetry bridge
// because only the Preview renderer has live Compositor/PlaybackEngine refs.
// The bridge is idle until the independent monitor window exists, then streams
// snapshots to that window and tears every sampler/listener down on close.
//
// Why this exists: console-only logging is fine for one-shot diagnostics but
// won't catch trends — e.g. "ring drains during scrub and never refills".
// Pinned during real editing, the HUD lets us watch rAF P99 inch up before
// the user perceives a stutter, or spot a decoder queue stalling at zero
// while the ring is also empty.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen, emit, type UnlistenFn } from "@/bridge/events";
import { SecondaryWindow } from "@/bridge/window";
import { WindowControls } from "@/components/WindowControls";
import { RotateCcwIcon } from "lucide-react";

import { getSystemStats, type SystemStats } from "../ipc";
import type { Compositor, CompositorPerfSnapshot } from "./Compositor";
import type { PlaybackEngine, WarmupStats } from "./PlaybackEngine";
import { throughputFps, type ThroughputSample } from "./perfHudStats";
import {
  PERF_MONITOR_WINDOW_CLOSED_EVENT,
  PERF_MONITOR_WINDOW_LABEL,
  PERF_MONITOR_WINDOW_OPENED_EVENT,
} from "./performanceMonitorWindow";

interface TelemetryProps {
  /// Live Compositor ref. The HUD calls `getPerfSnapshot()` on it.
  /// Holding the ref (not the live object) lets the HUD survive
  /// Compositor re-construction after a `setSuspended(true)` /
  /// `setSuspended(false)` export cycle.
  compositorRef: React.RefObject<Compositor | null>;
  /// Engine ref for the current playhead position (used to compute
  /// "ring lookahead past playhead" per clip).
  engineRef: React.RefObject<PlaybackEngine | null>;
}

/// Chromium-private `performance.memory` reading (Electron's Chromium exposes it).
/// `null` when the runtime doesn't have it (e.g. non-Chromium).
export interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readMemory(): PerfMemory | null {
  const p = performance as unknown as { memory?: PerfMemory };
  const m = p.memory;
  // Copy into a plain object: `performance.memory`'s fields are prototype
  // getters, not own enumerable properties, so the live object serializes to
  // `{}` when the sample crosses the IPC event boundary to the monitor —
  // which rendered the heap tile as "NaN MB".
  return m
    ? {
        usedJSHeapSize: m.usedJSHeapSize,
        totalJSHeapSize: m.totalJSHeapSize,
        jsHeapSizeLimit: m.jsHeapSizeLimit,
      }
    : null;
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
  return `${(bytes / 1024 / 1024).toFixed(0)}`;
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

/// Frames-per-second from a mean frame interval (ms). 0 before the rAF
/// ring has data.
function fpsFromMs(ms: number): number {
  return ms > 0 ? Math.round(1000 / ms) : 0;
}

export const PERF_HUD_SNAPSHOT_EVENT = "weftcut://perf-hud-snapshot";
/// Emitted (globally) by the monitor's reset button; the headless bridge owns
/// the Compositor ref, so it does the actual peak reset.
const PERF_HUD_RESET_EVENT = "weftcut://perf-hud-reset";
/// Sparkline history depth (~30 s at the 500 ms emit cadence).
const SPARK_CAP = 60;

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

/// One point of the monitor's frame-interval sparkline.
interface HistPoint {
  p50: number;
  p99: number;
}

/// Heap usage as a fraction of the hard JS heap ceiling, or null if the
/// runtime doesn't expose `performance.memory`. used/limit (not used/total)
/// is the real OOM-pressure signal — the arena grows on demand.
function heapCapRatioOf(memory: PerfMemory | null): number | null {
  return memory && memory.jsHeapSizeLimit > 0
    ? memory.usedJSHeapSize / memory.jsHeapSizeLimit
    : null;
}

/// True when any tracked metric is in its warn band — drives the monitor's
/// titlebar health dot.
function sampleHot(s: PerfHudSample): boolean {
  if (s.rafP99 > 34) return true;
  if ((s.snap?.compositeMsMax ?? 0) > 24) return true;
  if (s.sys && s.sys.cpu_percent > 80) return true;
  const cap = heapCapRatioOf(s.memory);
  if (cap !== null && cap > 0.85) return true;
  if (s.aud && Number.isFinite(s.aud.peakDb) && s.aud.peakDb > -1) return true;
  if (s.snap?.clips.some((c) => !c.lookaheadFull)) return true;
  if (s.warmup.lastReason === "deadline-hit") return true;
  return false;
}

// ── Dashboard pieces ────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  meta,
  warn,
  title,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode | undefined;
  warn?: boolean | undefined;
  title?: string | undefined;
}) {
  return (
    <div className={`perf-tile${warn ? " is-warn" : ""}`} title={title}>
      <div className="perf-tile-label">{label}</div>
      <div className="perf-tile-value">{value}</div>
      {meta !== undefined ? <div className="perf-tile-meta">{meta}</div> : null}
    </div>
  );
}

/// Frame-interval trend. P50 solid, P99 faint, with 60 fps (16.7 ms) and
/// 30 fps (33.3 ms) guide lines so spikes read against a real budget.
function Sparkline({ points }: { points: HistPoint[] }) {
  if (points.length < 2) {
    return <div className="perf-spark-empty">collecting frame samples…</div>;
  }
  const W = 100;
  const H = 36;
  const p50s = points.map((p) => p.p50);
  const p99s = points.map((p) => p.p99);
  // Floor the scale at the 30 fps budget so a healthy 60 Hz trace doesn't
  // get amplified into alarming-looking noise; let real spikes push it up.
  const peak = Math.max(33.34, ...p99s);
  const toPath = (vals: number[]): string =>
    vals
      .map((v, i) => {
        const x = (i / (vals.length - 1)) * W;
        const y = H - Math.min(1, v / peak) * H;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  const guide60 = H - Math.min(1, 16.67 / peak) * H;
  const guide30 = H - Math.min(1, 33.34 / peak) * H;
  const last = p50s[p50s.length - 1] ?? 0;
  return (
    <div className="perf-spark-wrap">
      <svg
        className="perf-spark"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line className="perf-spark-guide" x1="0" x2={W} y1={guide60} y2={guide60} />
        <line className="perf-spark-guide is-warn" x1="0" x2={W} y1={guide30} y2={guide30} />
        <path className="perf-spark-p99" d={toPath(p99s)} vectorEffect="non-scaling-stroke" />
        <path
          className={`perf-spark-p50${last > 34 ? " is-warn" : ""}`}
          d={toPath(p50s)}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="perf-spark-legend">
        <span className="perf-spark-key perf-spark-key-p50">P50</span>
        <span className="perf-spark-key perf-spark-key-p99">P99</span>
        <span className="perf-spark-grow" />
        <span className="perf-spark-guide-key">— 60fps</span>
        <span className="perf-spark-guide-key is-warn">— 30fps</span>
      </div>
    </div>
  );
}

/// Horizontal dBFS meter (−60…0). Amber near clipping.
function MeterBar({ label, db, warn }: { label: string; db: number; warn?: boolean }) {
  const pct = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 60) / 60)) * 100 : 0;
  return (
    <div className="perf-meter">
      <span className="perf-meter-label">{label}</span>
      <span className="perf-meter-track">
        <span
          className={`perf-meter-fill${warn ? " is-warn" : ""}`}
          style={{ width: `${pct.toFixed(1)}%` }}
        />
      </span>
      <span className="perf-meter-val">{formatDb(db)} dB</span>
    </div>
  );
}

function PerfDashboard({
  sample,
  history,
  onReset,
}: {
  sample: PerfHudSample;
  history: HistPoint[];
  onReset: () => void;
}) {
  const { snap, rafP50, rafP99, memory, playheadUs, warmup, fpsByLayer, sys, aud } = sample;
  const fpsLookup = new Map(fpsByLayer);
  const fps = fpsFromMs(rafP50);
  const heapCapRatio = heapCapRatioOf(memory);
  const prewarm = snap?.upcomingPrewarm;
  const prewarmRequested = prewarm?.clips.filter((c) => c.requested).length ?? 0;
  const prewarmDueMs =
    prewarm?.nextStartUs === null || prewarm?.nextStartUs === undefined
      ? null
      : formatUsAsMs(Math.max(0, prewarm.nextStartUs - prewarm.anchorUs));
  const hasClips = (snap?.clips.length ?? 0) > 0;
  const hasPrewarm = (prewarm?.clips.length ?? 0) > 0;

  return (
    <div className="perf-dash" data-testid="perf-hud-window">
      {/* The window title + health dot live in the titlebar (see PerfHUDWindow);
          this row is just the live playhead + the peaks-reset action. */}
      <header className="perf-dash-head">
        <span className="perf-dash-sub">playhead {(playheadUs / 1000).toFixed(0)} ms</span>
        <span className="perf-dash-grow" />
        <button
          type="button"
          className="perf-icon-btn"
          onClick={onReset}
          title="Reset peaks"
          aria-label="Reset performance peaks"
        >
          <RotateCcwIcon size={13} aria-hidden="true" />
        </button>
      </header>

      <div className="perf-tiles">
        <StatTile
          label="Frame rate"
          value={<>{fps} <span className="perf-tile-unit">fps</span></>}
          meta={`P50 ${formatMs(rafP50)} · P99 ${formatMs(rafP99)} ms`}
          warn={rafP99 > 34}
        />
        <StatTile
          label="Composite"
          value={<>{formatMs(snap?.compositeMsLast ?? 0)} <span className="perf-tile-unit">ms</span></>}
          meta={`max ${formatMs(snap?.compositeMsMax ?? 0)} ms`}
          warn={(snap?.compositeMsMax ?? 0) > 24}
        />
        <StatTile
          label="Warmup"
          value={
            warmup.lastMs === null ? (
              <span className="perf-muted">idle</span>
            ) : (
              <>{formatMs(warmup.lastMs)} <span className="perf-tile-unit">ms</span></>
            )
          }
          meta={
            warmup.lastMs === null
              ? "no warmup yet"
              : `max ${formatMs(warmup.maxMs)} ms · ${
                  warmup.lastReason === "deadline-hit"
                    ? "cap hit"
                    : warmup.lastReason === "lookahead-ready"
                      ? "lookahead"
                      : "—"
                }`
          }
          warn={warmup.lastReason === "deadline-hit"}
          title="Preview warmup before play. 'cap hit' = WARMUP_MAX_WAIT_MS reached before the ring filled (possible initial-frame stutter)."
        />
        <StatTile
          label="Dropped"
          value={
            (snap?.underrun?.droppedFrames ?? 0) === 0 ? (
              <span className="perf-muted">0</span>
            ) : (
              <>{snap!.underrun.droppedFrames} <span className="perf-tile-unit">frames</span></>
            )
          }
          meta={snap?.underrun?.active ? "decode behind NOW" : "this play session"}
          warn={Boolean(snap?.underrun?.active)}
          title="Comp frames painted late while the master clock ran (underrunTracker). The transport-bar dot mirrors this."
        />
        <StatTile
          label="Prewarm"
          value={
            !prewarm ? (
              <span className="perf-muted">—</span>
            ) : prewarmDueMs === null ? (
              "none"
            ) : (
              <>{prewarmDueMs} <span className="perf-tile-unit">ms</span></>
            )
          }
          meta={
            !prewarm
              ? "waiting"
              : prewarmDueMs === null
                ? `idle <${(prewarm.windowUs / 1_000_000).toFixed(1)}s`
                : `${prewarmRequested}/${prewarm.clips.length} requested`
          }
          warn={Boolean(
            prewarm && prewarmDueMs !== null && prewarmRequested < prewarm.clips.length,
          )}
          title="Time until the next upcoming clip starts, and how many of its decoders have been pre-requested."
        />
        {memory ? (
          <StatTile
            label="JS heap"
            value={<>{formatMb(memory.usedJSHeapSize)} <span className="perf-tile-unit">MB</span></>}
            meta={
              <>
                {formatMb(memory.totalJSHeapSize)} MB alloc
                {heapCapRatio !== null ? ` · ${(heapCapRatio * 100).toFixed(0)}% of cap` : ""}
              </>
            }
            warn={heapCapRatio !== null && heapCapRatio > 0.85}
            title="Used heap, current arena size, and % of the hard heap ceiling (the real OOM-pressure signal)."
          />
        ) : null}
        {sys ? (
          <StatTile
            label="Process CPU"
            value={<>{sys.cpu_percent.toFixed(0)}<span className="perf-tile-unit">%</span></>}
            meta={`${formatMb(sys.rss_bytes)} MB RSS · ${sys.process_count}p · ${sys.logical_cores}c`}
            warn={sys.cpu_percent > 80}
            title={`${sys.process_count} processes across the Electron/Chromium tree · ${sys.logical_cores} logical cores`}
          />
        ) : null}
      </div>

      <section className="perf-card">
        <div className="perf-card-title">Frame interval</div>
        <Sparkline points={history} />
      </section>

      {aud ? (
        <section className="perf-card">
          <div className="perf-card-title">Master audio bus</div>
          <MeterBar label="rms" db={aud.rmsDb} />
          <MeterBar
            label="peak"
            db={aud.peakDb}
            warn={Number.isFinite(aud.peakDb) && aud.peakDb > -1}
          />
        </section>
      ) : null}

      {snap && snap.swapsInFlight > 0 ? (
        <div className="perf-alert" title="In-flight no-flash source swaps (bridge→proxy)">
          {snap.swapsInFlight} source swap{snap.swapsInFlight > 1 ? "s" : ""} in flight
        </div>
      ) : null}

      {hasClips ? (
        <section className="perf-card">
          <div className="perf-card-title">Active clips</div>
          <table className="perf-clips">
            <thead>
              <tr>
                <th>Layer</th>
                <th>Dec</th>
                <th className="perf-num">fps</th>
                <th className="perf-num">queue</th>
                <th className="perf-num">ring</th>
                <th>span (ms)</th>
                <th className="perf-num">LA</th>
              </tr>
            </thead>
            <tbody>
              {snap?.clips.map((clip) => {
                const fpsV = fpsLookup.get(clip.layerId) ?? 0;
                const first =
                  clip.ringFirstPtsUs !== null ? (clip.ringFirstPtsUs / 1000).toFixed(0) : "—";
                const last =
                  clip.ringLastPtsUs !== null ? (clip.ringLastPtsUs / 1000).toFixed(0) : "—";
                return (
                  <tr key={clip.layerId}>
                    <td className="perf-clips-id" title={clip.layerId}>
                      {clip.layerId.slice(0, 8)}
                    </td>
                    <td>
                      <span
                        className={`perf-pill${clip.sourceKind === "native-gpu" ? "" : " is-sw"}`}
                        title={
                          clip.sourceKind === "native-gpu"
                            ? "ffmpeg hardware lane (d3d11va shared texture)"
                            : clip.sourceKind === "sw"
                              ? `ffmpeg software lane (NV12 over IPC)${clip.downgraded ? " — downgraded from hardware" : ""}`
                              : clip.sourceKind === "webcodecs"
                                ? "Lite engine (WebCodecs)"
                                : "unknown decode source"
                        }
                      >
                        {clip.sourceKind === "native-gpu"
                          ? "HW"
                          : clip.sourceKind === "sw"
                            ? `SW${clip.downgraded ? "↓" : ""}`
                            : clip.sourceKind === "webcodecs"
                              ? "WC"
                              : "?"}
                      </span>
                    </td>
                    <td className="perf-num">{fpsV.toFixed(0)}</td>
                    <td className="perf-num">{clip.decodeQueueSize}</td>
                    <td className="perf-num">{clip.ringSize}</td>
                    <td className="perf-clips-span">
                      {first}–{last}
                    </td>
                    <td className="perf-num">
                      <span
                        className={clip.lookaheadFull ? "perf-ok" : "perf-warn"}
                        title={
                          clip.lookaheadFull
                            ? "Lookahead window satisfied"
                            : "Decoder running behind the lookahead window"
                        }
                      >
                        {clip.lookaheadFull ? "✓" : "…"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      {hasPrewarm ? (
        <section className="perf-card">
          <div className="perf-card-title">Upcoming prewarm</div>
          <table className="perf-clips">
            <thead>
              <tr>
                <th>Layer</th>
                <th>State</th>
                <th className="perf-num">queue</th>
                <th className="perf-num">ring</th>
                <th>last (ms)</th>
              </tr>
            </thead>
            <tbody>
              {prewarm?.clips.map((clip) => {
                const last =
                  clip.ringLastPtsUs !== null ? formatUsAsMs(clip.ringLastPtsUs) : "—";
                return (
                  <tr key={`prewarm-${clip.layerId}`}>
                    <td className="perf-clips-id" title={clip.layerId}>
                      {clip.layerId.slice(0, 8)}
                    </td>
                    <td>
                      <span className={`perf-pill${clip.requested ? "" : " is-sw"}`}>
                        {clip.requested ? "req" : "idle"}
                      </span>
                    </td>
                    <td className="perf-num">{clip.decodeQueueSize}</td>
                    <td className="perf-num">{clip.ringSize}</td>
                    <td className="perf-clips-span">{last}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

// ── Headless editor telemetry bridge ────────────────────────────────────────

export interface PerfTelemetryProbe {
  active: boolean;
  rafActive: boolean;
  compositorPollActive: boolean;
  systemPollActive: boolean;
  resetListenerActive: boolean;
  compositorPolls: number;
  systemPolls: number;
  broadcasts: number;
}

function e2eProbe(): PerfTelemetryProbe | null {
  if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return null;
  const host = window as typeof window & {
    __weftcutPerfTelemetry?: PerfTelemetryProbe;
  };
  host.__weftcutPerfTelemetry ??= {
    active: false,
    rafActive: false,
    compositorPollActive: false,
    systemPollActive: false,
    resetListenerActive: false,
    compositorPolls: 0,
    systemPolls: 0,
    broadcasts: 0,
  };
  return host.__weftcutPerfTelemetry;
}

export function PerfTelemetryBridge({ compositorRef, engineRef }: TelemetryProps) {
  const [active, setActive] = useState(false);
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
  // Process-tree resource snapshot (CPU%/RSS) from Electron's app.getAppMetrics()
  // via the main process. Null only until the first poll resolves.
  const [sys, setSys] = useState<SystemStats | null>(null);
  // Master audio bus meter (rms/peak dBFS). Null in export mode or before
  // the graph exists.
  const [aud, setAud] = useState<{ rmsDb: number; peakDb: number } | null>(null);

  // rAF interval tracking. We keep the ring + last-tick time on refs
  // so the rAF callback doesn't re-render on every frame; the bridge only
  // re-renders when the 500 ms polling tick recomputes P50/P99.
  const intervalsRef = useRef<IntervalRing | null>(null);
  if (intervalsRef.current === null) intervalsRef.current = newIntervalRing();
  const lastRafMsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    intervalsRef.current = newIntervalRing();
    lastRafMsRef.current = null;
    const probe = e2eProbe();
    if (probe) probe.rafActive = true;
    let rafHandle = 0;
    const tick = (nowMs: number): void => {
      const prev = lastRafMsRef.current;
      if (prev !== null) {
        pushInterval(intervalsRef.current!, nowMs - prev);
      }
      lastRafMsRef.current = nowMs;
      rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafHandle);
      if (probe) probe.rafActive = false;
    };
  }, [active]);

  // When the tab is hidden/blurred, Chromium pauses rAF. On unhide,
  // the first tick computes a multi-second interval from the
  // pre-hide timestamp and dumps that bogus number into the P50/P99
  // ring for the next ~120 frames, making the HUD look like preview
  // is stuttering. Clear `lastRafMsRef` so the first tick after
  // unhide is treated as the start of a fresh measurement.
  useEffect(() => {
    if (!active) return;
    const onVis = (): void => {
      if (document.visibilityState === "visible") {
        lastRafMsRef.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [active]);

  // 500 ms polling: read Compositor snapshot, recompute rAF percentiles,
  // sample heap memory + playhead. Decoupled from rAF so a steady-state
  // dashboard update doesn't itself influence what it's measuring.
  useEffect(() => {
    if (!active) return;
    const probe = e2eProbe();
    if (probe) probe.compositorPollActive = true;
    const id = setInterval(() => {
      if (probe) probe.compositorPolls += 1;
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
      const { p50, p99 } = p50p99FromRing(intervalsRef.current!);
      setRafP50(p50);
      setRafP99(p99);
      setMemory(readMemory());
      const e = engineRef.current;
      setPlayheadUs(e?.positionUs() ?? 0);
      if (e) setWarmup(e.getWarmupStats());
    }, 500);
    return () => {
      clearInterval(id);
      prevSamplesRef.current = new Map();
      if (probe) probe.compositorPollActive = false;
    };
  }, [active, compositorRef, engineRef]);

  // Process-tree resource poll (app.getAppMetrics() via main), on a slower 1 s
  // cadence: CPU/RSS move slowly. It is deliberately absent while the monitor
  // is closed so diagnostics cannot perturb normal editing.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const probe = e2eProbe();
    if (probe) probe.systemPollActive = true;
    const id = setInterval(() => {
      if (probe) probe.systemPolls += 1;
      getSystemStats()
        .then((s) => {
          if (!cancelled) setSys(s);
        })
        .catch(() => {});
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (probe) probe.systemPollActive = false;
    };
  }, [active]);

  // Main broadcasts lifecycle for every labelled secondary window. Only our
  // monitor toggles telemetry. The existence check reconciles HMR/re-mounts
  // when a monitor survived the editor renderer reload.
  useEffect(() => {
    let unlistenOpened: UnlistenFn | null = null;
    let unlistenClosed: UnlistenFn | null = null;
    let cancelled = false;
    let sawLifecycle = false;
    void listen<{ label?: string }>(PERF_MONITOR_WINDOW_OPENED_EVENT, (e) => {
      if (e.payload?.label !== PERF_MONITOR_WINDOW_LABEL) return;
      sawLifecycle = true;
      setActive(true);
    }).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      unlistenOpened = off;
    });
    void listen<{ label?: string }>(PERF_MONITOR_WINDOW_CLOSED_EVENT, (e) => {
      if (e.payload?.label !== PERF_MONITOR_WINDOW_LABEL) return;
      sawLifecycle = true;
      setActive(false);
    }).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      unlistenClosed = off;
    });
    void SecondaryWindow.getByLabel(PERF_MONITOR_WINDOW_LABEL).then((w) => {
      if (!cancelled && !sawLifecycle) setActive(w !== null);
    });
    return () => {
      cancelled = true;
      unlistenOpened?.();
      unlistenClosed?.();
    };
  }, []);

  useEffect(() => {
    const probe = e2eProbe();
    if (probe) probe.active = active;
    return () => {
      if (probe) probe.active = false;
    };
  }, [active]);

  const onResetPeaks = useCallback(() => {
    compositorRef.current?.resetPerfPeaks();
    engineRef.current?.resetWarmupStats();
    setWarmup({ lastMs: null, maxMs: 0, lastReason: null });
  }, [compositorRef, engineRef]);

  // Reset requested from the monitor (which has no Compositor ref of its own).
  // This subscription is intentionally absent whenever the window is closed.
  useEffect(() => {
    if (!active) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    const probe = e2eProbe();
    void listen(PERF_HUD_RESET_EVENT, () => onResetPeaks()).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
      if (probe) probe.resetListenerActive = true;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      if (probe) probe.resetListenerActive = false;
    };
  }, [active, onResetPeaks]);

  const sample = useMemo<PerfHudSample>(
    () => ({
      snap,
      rafP50,
      rafP99,
      memory,
      playheadUs,
      warmup,
      fpsByLayer: Array.from(fpsByLayer.entries()),
      sys,
      aud: aud ? { rmsDb: jsonSafeDb(aud.rmsDb), peakDb: jsonSafeDb(aud.peakDb) } : null,
    }),
    [snap, rafP50, rafP99, memory, playheadUs, warmup, fpsByLayer, sys, aud],
  );

  useEffect(() => {
    if (!active) return;
    const probe = e2eProbe();
    if (probe) probe.broadcasts += 1;
    void emit(PERF_HUD_SNAPSHOT_EVENT, sample).catch(() => {});
  }, [active, sample]);

  return null;
}

// ── Popup window component ──────────────────────────────────────────────────

export function PerformanceMonitorWindow() {
  const [sample, setSample] = useState<PerfHudSample | null>(null);
  const [history, setHistory] = useState<HistPoint[]>([]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<PerfHudSample>(PERF_HUD_SNAPSHOT_EVENT, (event) => {
      setSample(event.payload);
      setHistory((h) => {
        const next = [...h, { p50: event.payload.rafP50, p99: event.payload.rafP99 }];
        return next.length > SPARK_CAP ? next.slice(next.length - SPARK_CAP) : next;
      });
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

  // The caption close button routes through window:close to this sender. Main
  // then broadcasts the labelled close, which idles the editor-side bridge.

  const onReset = useCallback(() => {
    void emit(PERF_HUD_RESET_EVENT).catch(() => {});
  }, []);

  const hot = sample ? sampleHot(sample) : false;

  return (
    <div className="perf-hud-window">
      {/* Self-drawn titlebar matching the main window: drag region + health dot
          + title on the left, shared caption buttons (min/max/close) flush
          right. The window is frameless (decorations:false), so this is the bar. */}
      <div className="perf-titlebar" data-drag-region data-testid="perf-hud-titlebar">
        <span className={`perf-dot${hot ? " is-hot" : ""}`} aria-hidden="true" />
        <span className="perf-titlebar-title">Performance</span>
        <span className="perf-titlebar-grow" />
        <WindowControls />
      </div>
      <div className="perf-hud-body">
        {sample ? (
          <PerfDashboard sample={sample} history={history} onReset={onReset} />
        ) : (
          <div className="perf-hud-window-empty">Waiting for preview performance data…</div>
        )}
      </div>
    </div>
  );
}
