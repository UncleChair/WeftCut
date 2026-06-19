// Dev-only performance HUD. Two surfaces share one data feed:
//
//  • The inline overlay (this `PerfHUD`) is a compact vitals strip pinned to
//    the preview corner — a glance-and-go health check. Toggle it with
//    Ctrl+Shift+P. Its health dot turns amber when any deeper metric is hot,
//    the cue to pop out the full view.
//  • The popup (`PerfHUDWindow`, `/?perfHud=1`) is the full dashboard:
//    stat tiles, a frame-interval sparkline, an audio meter, and the per-clip
//    decode table. The two are mutually exclusive — while the popup is open
//    the inline overlay is suppressed, and closing the popup restores it.
//
// This component stays mounted regardless of which surface is showing so its
// polling + `PERF_HUD_SNAPSHOT_EVENT` emit keeps feeding the popup, which has
// no Compositor ref of its own.
//
// Why this exists: console-only logging is fine for one-shot diagnostics but
// won't catch trends — e.g. "ring drains during scrub and never refills".
// Pinned during real editing, the HUD lets us watch rAF P99 inch up before
// the user perceives a stutter, or spot a decoder queue stalling at zero
// while the ring is also empty.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { listen, emit, type UnlistenFn } from "@/bridge/events";
import { SecondaryWindow, getCurrentWindow } from "@/bridge/window";
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
  // `{}` when the sample crosses the IPC event boundary to the popup —
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

const HUD_EDGE_MARGIN = 12;
export const PERF_HUD_SNAPSHOT_EVENT = "weftcut://perf-hud-snapshot";
/// Emitted (globally) by the popup from its own close handler so the inline
/// overlay can restore itself the instant the popup is dismissed.
const PERF_HUD_WINDOW_CLOSED_EVENT = "weftcut://perf-hud-window-closed";
/// Emitted (globally) by the popup's reset button; the inline component owns
/// the Compositor ref, so it does the actual peak reset.
const PERF_HUD_RESET_EVENT = "weftcut://perf-hud-reset";
const PERF_HUD_WINDOW_LABEL = "perf-hud";
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

/// One point of the popup's frame-interval sparkline.
interface HistPoint {
  p50: number;
  p99: number;
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

/// Heap usage as a fraction of the hard JS heap ceiling, or null if the
/// runtime doesn't expose `performance.memory`. used/limit (not used/total)
/// is the real OOM-pressure signal — the arena grows on demand.
function heapCapRatioOf(memory: PerfMemory | null): number | null {
  return memory && memory.jsHeapSizeLimit > 0
    ? memory.usedJSHeapSize / memory.jsHeapSizeLimit
    : null;
}

/// True when any tracked metric is in its warn band — drives the inline
/// health dot so the compact strip still tells you when to pop out.
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

// ── Inline strip ──────────────────────────────────────────────────────────

function InlineStat({
  value,
  unit,
  warn,
  title,
}: {
  value: ReactNode;
  unit: string;
  warn?: boolean | undefined;
  title?: string | undefined;
}) {
  return (
    <span className={`perf-stat${warn ? " is-warn" : ""}`} title={title}>
      <span className="perf-stat-val">{value}</span>
      <span className="perf-stat-unit">{unit}</span>
    </span>
  );
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
  const hot = sampleHot(sample);

  return (
    <div className="perf-dash" data-testid="perf-hud-window">
      <header className="perf-dash-head">
        <div className="perf-dash-titlewrap">
          <span className={`perf-dot${hot ? " is-hot" : ""}`} aria-hidden="true" />
          <span className="perf-dash-title">Performance</span>
        </div>
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
                        className={`perf-pill${clip.downgraded ? " is-sw" : ""}`}
                        title={clip.downgraded ? "Software decode (downgraded)" : "Hardware decode"}
                      >
                        {clip.downgraded ? "SW" : "HW"}
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

// ── Inline overlay component ────────────────────────────────────────────────

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
  // True while the detached Performance window is open. Suppresses the inline
  // overlay (see render gate) without unmounting this component, so the
  // snapshot emit keeps feeding the popup.
  const [poppedOut, setPoppedOut] = useState(false);

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

  // When the tab is hidden/blurred, Chromium pauses rAF. On unhide,
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

  // Ctrl+Shift+P toggles ONLY the inline overlay. Captured at the window
  // level so the user doesn't need to focus the HUD to dismiss it; the popup
  // window (a separate renderer) has no such binding by design.
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

  // Pop-out lifecycle. The popup emits `PERF_HUD_WINDOW_CLOSED_EVENT` from its
  // own close handler, restoring the inline overlay the moment it's dismissed
  // (focus-independent — a focus check misses closing the popup on a second
  // monitor while this window stays focused). On mount we also reconcile
  // against any popup that survived an HMR reload.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen(PERF_HUD_WINDOW_CLOSED_EVENT, () => setPoppedOut(false)).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
    });
    void SecondaryWindow.getByLabel(PERF_HUD_WINDOW_LABEL).then((w) => {
      if (!cancelled) setPoppedOut(w !== null);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const onResetPeaks = useCallback(() => {
    compositorRef.current?.resetPerfPeaks();
    engineRef.current?.resetWarmupStats();
    setWarmup({ lastMs: null, maxMs: 0, lastReason: null });
  }, [compositorRef, engineRef]);

  // Reset requested from the popup (which has no Compositor ref of its own).
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen(PERF_HUD_RESET_EVENT, () => onResetPeaks()).then((off) => {
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
  }, [onResetPeaks]);

  useEffect(() => {
    if (visible) return;
    dragRef.current = null;
    setDragging(false);
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible || poppedOut) return;
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
  }, [visible, poppedOut]);

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
      const existing = await SecondaryWindow.getByLabel(PERF_HUD_WINDOW_LABEL);
      if (existing) {
        setPoppedOut(true);
        await existing.show().catch(() => {});
        await existing.setFocus().catch(() => {});
        await emit(PERF_HUD_SNAPSHOT_EVENT, sample).catch(() => {});
        return;
      }
      new SecondaryWindow(PERF_HUD_WINDOW_LABEL, {
        url: "/?perfHud=1",
        title: "WeftCut — Performance",
        width: 640,
        height: 560,
        minWidth: 380,
        minHeight: 320,
        resizable: true,
        decorations: true,
      });
      // Hide the inline overlay now that the pop-out window is requested.
      // (Dev-only: seeding the pop-out's first snapshot + create/error feedback
      // aren't bridged from the secondary-window lifecycle yet.)
      setPoppedOut(true);
    } catch (e) {
      console.error("[weftcut/perf-hud] failed to open popup:", e);
      setPoppedOut(false);
    }
  }, [sample]);

  // Hidden while the popup owns the view (poppedOut) or the user dismissed the
  // overlay (Ctrl+Shift+P → visible). Hooks above keep running regardless, so
  // the popup keeps receiving snapshots.
  if (!visible || poppedOut) return null;

  const hot = sampleHot(sample);
  const fps = fpsFromMs(rafP50);
  const hudStyle: CSSProperties | undefined = hudPosition
    ? { left: hudPosition.left, top: hudPosition.top, bottom: "auto" }
    : undefined;

  return (
    <div
      ref={hudRef}
      className={`perf-hud${dragging ? " is-dragging" : ""}`}
      style={hudStyle}
      data-testid="perf-hud"
    >
      <div
        className="perf-bar"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span
          className={`perf-dot${hot ? " is-hot" : ""}`}
          aria-hidden="true"
          title={hot ? "A metric is in its warn band — pop out for detail" : "All metrics nominal"}
        />
        <span className="perf-bar-title">PERF</span>
        <span className="perf-bar-stats">
          <InlineStat
            value={fps}
            unit="fps"
            warn={rafP99 > 34}
            title={`rAF P50 ${formatMs(rafP50)} ms · P99 ${formatMs(rafP99)} ms`}
          />
          <InlineStat
            value={formatMs(snap?.compositeMsLast ?? 0)}
            unit="ms"
            warn={(snap?.compositeMsMax ?? 0) > 24}
            title={`composite · max ${formatMs(snap?.compositeMsMax ?? 0)} ms`}
          />
          {memory ? (
            <InlineStat
              value={formatMb(memory.usedJSHeapSize)}
              unit="MB"
              warn={heapCapRatioOf(memory) !== null && (heapCapRatioOf(memory) ?? 0) > 0.85}
              title="JS heap used"
            />
          ) : null}
          {sys ? (
            <InlineStat
              value={sys.cpu_percent.toFixed(0)}
              unit="%"
              warn={sys.cpu_percent > 80}
              title={`process CPU · ${sys.process_count}p · ${sys.logical_cores}c`}
            />
          ) : null}
        </span>
        <span className="perf-bar-actions">
          <button
            type="button"
            className="perf-icon-btn"
            onClick={() => void openPerfHudWindow()}
            title="Open performance window"
            aria-label="Open performance window"
          >
            <PanelTopOpenIcon size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="perf-icon-btn"
            onClick={onResetPeaks}
            title="Reset peaks"
            aria-label="Reset performance peaks"
          >
            <RotateCcwIcon size={12} aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  );
}

// ── Popup window component ──────────────────────────────────────────────────

export function PerfHUDWindow() {
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

  // Tell the main window we're closing so it can restore the inline overlay,
  // then complete the close ourselves. `preventDefault` must come before the
  // first await so the window manager sees it; the global emit reaches the main window.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenPromise = win.onCloseRequested(async (event) => {
      event.preventDefault();
      await emit(PERF_HUD_WINDOW_CLOSED_EVENT).catch(() => {});
      await win.destroy().catch(() => {});
    });
    return () => {
      void unlistenPromise.then((off) => off());
    };
  }, []);

  const onReset = useCallback(() => {
    void emit(PERF_HUD_RESET_EVENT).catch(() => {});
  }, []);

  return (
    <div className="perf-hud-window">
      {sample ? (
        <PerfDashboard sample={sample} history={history} onReset={onReset} />
      ) : (
        <div className="perf-hud-window-empty">Waiting for preview performance data…</div>
      )}
    </div>
  );
}
