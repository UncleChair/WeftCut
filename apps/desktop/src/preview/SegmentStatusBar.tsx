// SegmentStatusBar — thin strip above the timeline showing per-segment
// render status. One <div> per segment, width proportional to its
// timeline span. Subscribes to the Rust orchestrator's events to keep
// state current (Phase A5).
//
// Colors:
//   ready   → faint white/transparent
//   running → animated diagonal stripes, accent color
//   pending → solid accent, dimmer
//   failed  → red
//
// Interactions:
//   * hover  → tooltip via the native title attribute (status + range +
//              error detail when failed)
//   * click pending/running → bumps playhead priority via
//              previewSetPlayhead(segment_midpoint)
//   * click failed → calls previewRetrySegment(hash) for a manual retry

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  previewRetrySegment,
  previewSetPlayhead,
  SEGMENT_EVENTS,
  type ManifestChanged,
  type SegmentError,
  type SegmentReady,
} from "../ipc";

type SegmentStatus = "pending" | "running" | "ready" | "failed";

interface SegmentRow {
  hash: string;
  inUs: number;
  outUs: number;
  status: SegmentStatus;
  errorDetail?: string;
}

export function SegmentStatusBar() {
  const { t } = useTranslation();
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [durationUs, setDurationUs] = useState<number>(0);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      const onManifest = await listen<ManifestChanged>(
        SEGMENT_EVENTS.manifestChanged,
        (e) => {
          // Reset; segment_ready events rebuild the row list.
          setSegments([]);
          setDurationUs(e.payload.durationUs);
        },
      );
      const onReady = await listen<SegmentReady>(
        SEGMENT_EVENTS.segmentReady,
        (e) => {
          const { hash, inUs, outUs } = e.payload;
          setSegments((cur) => upsertSegment(cur, { hash, inUs, outUs, status: "ready" }));
        },
      );
      const onError = await listen<SegmentError>(
        SEGMENT_EVENTS.segmentError,
        (e) => {
          setSegments((cur) =>
            cur.map((s) =>
              s.hash === e.payload.hash
                ? { ...s, status: "failed" as const, errorDetail: e.payload.detail }
                : s,
            ),
          );
        },
      );
      if (cancelled) {
        onManifest();
        onReady();
        onError();
        return;
      }
      unlisteners.push(onManifest, onReady, onError);
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  if (segments.length === 0 || durationUs <= 0) {
    return null;
  }

  return (
    <div className="segment-status-bar" role="region" aria-label="render status">
      {segments.map((seg) => {
        const widthPct = ((seg.outUs - seg.inUs) / durationUs) * 100;
        const leftPct = (seg.inUs / durationUs) * 100;
        const title = formatTooltip(seg, t);
        const className = `segment-status-cell segment-status-${seg.status}`;
        return (
          <button
            key={seg.hash}
            type="button"
            className={className}
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
            }}
            title={title}
            aria-label={title}
            onClick={() => onSegmentClick(seg)}
          />
        );
      })}
    </div>
  );
}

function upsertSegment(rows: SegmentRow[], next: SegmentRow): SegmentRow[] {
  const idx = rows.findIndex((s) => s.hash === next.hash);
  if (idx === -1) {
    return [...rows, next].sort((a, b) => a.inUs - b.inUs);
  }
  const out = rows.slice();
  // Preserve a `failed` status across a stale `ready` reorder by NOT
  // overwriting failed unless the new status is also failed or ready
  // with newer data.
  out[idx] = { ...out[idx], ...next };
  return out;
}

function formatTooltip(
  seg: SegmentRow,
  t: (k: string, fallback?: string) => string,
): string {
  const inSec = (seg.inUs / 1_000_000).toFixed(1);
  const outSec = (seg.outUs / 1_000_000).toFixed(1);
  const status = t(`preview.segment_status.${seg.status}`, seg.status);
  let line = `${status} • ${inSec}s – ${outSec}s`;
  if (seg.status === "failed" && seg.errorDetail) {
    // Show only the first line of the error to keep the tooltip readable.
    const first = seg.errorDetail.split("\n", 1)[0];
    line += `\n${first}`;
  }
  return line;
}

function onSegmentClick(seg: SegmentRow) {
  if (seg.status === "failed") {
    void previewRetrySegment(seg.hash).catch((e) =>
      console.error("preview_retry_segment failed", e),
    );
    return;
  }
  if (seg.status === "pending" || seg.status === "running") {
    // Move the playhead-priority pointer to the midpoint of this segment
    // so the next priority recompute promotes it to PriorityClass::Playhead.
    const mid = Math.round((seg.inUs + seg.outUs) / 2);
    void previewSetPlayhead(mid).catch(() => {});
    return;
  }
  // ready: no-op (segment is already on disk).
}
