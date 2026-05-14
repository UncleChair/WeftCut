import { useCallback, useEffect, useRef, useState } from "react";

import type { MarkerSummary } from "../ipc";

/// Agent-mode mini timeline. Strip with click/drag-to-seek + a tick
/// row + project marker pips + timecode readout. No track lanes —
/// per Q5 the human is supposed to be watching the preview, not
/// editing.
///
/// Layout inside the 80-px-tall pane allocated by `.agent-mini-timeline`:
///   row 1 — tick marks (scale-adaptive)         ~14 px
///   row 2 — scrub bar with playhead + markers   ~36 px
///   row 3 — timecode readout                    ~14 px
interface MiniTimelineProps {
  currentTimeUs: number;
  durationUs: number;
  markers: MarkerSummary[];
  onSeek: (tUs: number) => void;
}

// Pick a "nice number" tick interval (microseconds) such that the gap
// between ticks lands roughly in [60, 200] px. Mirrors the canonical
// 1/2/5 sequence many timeline UIs use.
function pickTickIntervalUs(durationUs: number, widthPx: number): number {
  if (durationUs <= 0 || widthPx <= 0) return 1_000_000;
  const SEC = 1_000_000;
  const MIN = 60 * SEC;
  // Candidate intervals oldest → largest. Stop at the first that
  // produces ≥ 60 px between consecutive ticks at the current width.
  const candidates: number[] = [
    SEC,
    2 * SEC,
    5 * SEC,
    10 * SEC,
    30 * SEC,
    MIN,
    2 * MIN,
    5 * MIN,
    10 * MIN,
    30 * MIN,
    60 * MIN,
  ];
  for (const interval of candidates) {
    const pxBetween = (interval / durationUs) * widthPx;
    if (pxBetween >= 60) return interval;
  }
  return candidates[candidates.length - 1]!;
}

function formatTickLabel(us: number): string {
  // Compact form: "1:00", "0:15", "1:30:00".
  const totalSec = Math.round(us / 1_000_000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  if (h > 0) return `${h}:${pad(m, 2)}:${pad(s, 2)}`;
  return `${m}:${pad(s, 2)}`;
}

function formatTimecode(us: number): string {
  const totalMs = Math.max(0, Math.floor(us / 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

export function MiniTimeline({
  currentTimeUs,
  durationUs,
  markers,
  onSeek,
}: MiniTimelineProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Strip width drives tick density. ResizeObserver writes into
  // state so the next render picks up the new tick set; the setter
  // is short-circuited when width hasn't actually changed so window
  // events that hit other elements don't churn this component.
  const [stripWidth, setStripWidth] = useState<number>(0);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.round(e.contentRect.width);
        setStripWidth((prev) => (prev === w ? prev : w));
      }
    });
    ro.observe(el);
    setStripWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  // Click / drag anywhere on the strip → seek. We use pointer
  // capture so a drag started inside the strip continues to update
  // even when the cursor leaves the bar (matches the editor
  // timeline's UX).
  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = stripRef.current;
      if (!el || durationUs <= 0) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const t = Math.round((x / rect.width) * durationUs);
      onSeek(t);
    },
    [durationUs, onSeek],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      seekFromClientX(e.clientX);
      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromClientX],
  );

  // Compute the tick set + playhead position from the latest known
  // strip width. The render below resolves to a flat list of
  // absolute-positioned divs — simpler than SVG and good enough at
  // this size.
  const width = stripWidth;
  const safeDuration = Math.max(durationUs, 1);
  const tickInterval = pickTickIntervalUs(safeDuration, width);
  const ticks: { tUs: number; left: number }[] = [];
  if (width > 0 && durationUs > 0) {
    for (let t = 0; t <= durationUs; t += tickInterval) {
      ticks.push({ tUs: t, left: (t / durationUs) * width });
    }
  }

  const playheadLeft =
    durationUs > 0
      ? (Math.max(0, Math.min(currentTimeUs, durationUs)) / durationUs) * width
      : 0;

  return (
    <div className="mini-timeline">
      <div className="mini-timeline-ticks">
        {ticks.map(({ tUs, left }) => (
          <div key={tUs} className="mini-tick" style={{ left }}>
            <span className="mini-tick-label">{formatTickLabel(tUs)}</span>
          </div>
        ))}
      </div>
      <div
        ref={stripRef}
        className="mini-timeline-strip-real"
        onPointerDown={onPointerDown}
      >
        {markers.map((m) => {
          if (durationUs <= 0) return null;
          const left = (m.t_us / durationUs) * 100;
          const regionWidth =
            m.end_t_us !== null && m.end_t_us > m.t_us
              ? ((m.end_t_us - m.t_us) / durationUs) * 100
              : 0;
          return (
            <div
              key={m.id}
              className={regionWidth > 0 ? "mini-marker-region" : "mini-marker-pip"}
              style={
                regionWidth > 0
                  ? {
                      left: `${left}%`,
                      width: `${regionWidth}%`,
                      background: m.color_hint,
                    }
                  : { left: `${left}%`, background: m.color_hint }
              }
              title={m.label || "(unnamed marker)"}
            />
          );
        })}
        <div className="mini-playhead" style={{ left: playheadLeft }} />
      </div>
      <div className="mini-timeline-tc">
        {formatTimecode(currentTimeUs)} / {formatTimecode(durationUs)}
      </div>
    </div>
  );
}
