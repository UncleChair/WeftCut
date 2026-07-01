import { useEffect, useMemo, useState } from "react";
import { listen } from "@/bridge/events";
import { convertFileSrc } from "@/bridge/ipc";
import {
  MEDIA_JOB_EVENTS,
  getMediaThumbnails,
  type TimelineThumbnailManifest,
} from "../ipc";

export type TimelineFilmstripFrame = TimelineThumbnailManifest["frames"][number];

type ManifestEntry =
  | { state: "pending" }
  | { state: "not_ready" }
  | { state: "ready"; manifest: TimelineThumbnailManifest }
  | { state: "error"; message: string };

const manifestCache = new Map<string, ManifestEntry>();
const manifestListeners = new Map<string, Set<() => void>>();
let jobListenerInstalled = false;

function fireManifestListeners(mediaId: string) {
  manifestListeners.get(mediaId)?.forEach((cb) => cb());
}

async function ensureManifest(mediaId: string) {
  const cached = manifestCache.get(mediaId);
  if (
    cached?.state === "pending" ||
    cached?.state === "ready" ||
    cached?.state === "error"
  ) {
    return;
  }
  manifestCache.set(mediaId, { state: "pending" });
  try {
    const manifest = await getMediaThumbnails(mediaId);
    manifestCache.set(mediaId, { state: "ready", manifest });
  } catch (e) {
    const message = typeof e === "string" ? e : String(e);
    manifestCache.set(
      mediaId,
      message.includes("not_ready")
        ? { state: "not_ready" }
        : { state: "error", message },
    );
  }
  fireManifestListeners(mediaId);
}

async function installJobListenerOnce() {
  if (jobListenerInstalled) return;
  jobListenerInstalled = true;
  await listen<{ media_id: string; kind: string }>(
    MEDIA_JOB_EVENTS.complete,
    (event) => {
      if (event.payload?.kind !== "thumbnails") return;
      const mediaId = event.payload.media_id;
      manifestCache.delete(mediaId);
      fireManifestListeners(mediaId);
      if ((manifestListeners.get(mediaId)?.size ?? 0) > 0) {
        void ensureManifest(mediaId);
      }
    },
  );
}

function useThumbnailManifest(
  mediaId: string,
  enabled: boolean,
): ManifestEntry | undefined {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const listener = () => setTick((t) => t + 1);
    let listeners = manifestListeners.get(mediaId);
    if (!listeners) {
      listeners = new Set();
      manifestListeners.set(mediaId, listeners);
    }
    listeners.add(listener);
    void installJobListenerOnce();
    void ensureManifest(mediaId);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) manifestListeners.delete(mediaId);
    };
  }, [enabled, mediaId]);
  return enabled ? manifestCache.get(mediaId) : undefined;
}

export function selectFilmstripFrames(
  frames: readonly TimelineFilmstripFrame[],
  srcInUs: number,
  srcOutUs: number,
): TimelineFilmstripFrame[] {
  const start = Math.max(0, Math.min(srcInUs, srcOutUs));
  const end = Math.max(srcInUs, srcOutUs);
  if (end <= start) return [];
  const inWindow = frames.filter(
    (frame) => frame.tUs >= start && frame.tUs < end,
  );
  if (inWindow.length > 0) return inWindow;

  const first = frames[0];
  if (!first) return [];
  const midpoint = start + (end - start) / 2;
  let nearest = first;
  let nearestDistance = Math.abs(first.tUs - midpoint);
  for (const frame of frames.slice(1)) {
    const distance = Math.abs(frame.tUs - midpoint);
    if (distance < nearestDistance) {
      nearest = frame;
      nearestDistance = distance;
    }
  }
  return [nearest];
}

export function TimelineFilmstrip({
  mediaId,
  srcInUs,
  srcOutUs,
  layerWidthPx,
  colorHint,
  enabled,
}: {
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
  layerWidthPx: number;
  colorHint: string;
  enabled: boolean;
}) {
  const entry = useThumbnailManifest(mediaId, enabled);
  const frames = useMemo(
    () =>
      entry?.state === "ready"
        ? selectFilmstripFrames(entry.manifest.frames, srcInUs, srcOutUs)
        : [],
    [entry, srcInUs, srcOutUs],
  );

  if (entry?.state === "ready" && frames.length > 0) {
    return (
      <div
        data-testid="timeline-filmstrip"
        data-state="ready"
        className="flex h-full w-full overflow-hidden"
        style={{ backgroundColor: colorHint }}
      >
        {frames.map((frame) => (
          <img
            key={`${frame.index}-${frame.path}`}
            className="h-full min-w-0 flex-1 object-cover"
            src={convertFileSrc(frame.path)}
            alt=""
            draggable={false}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      data-testid="timeline-filmstrip"
      data-state={entry?.state ?? (enabled ? "pending" : "disabled")}
      className="h-full w-full"
      style={{
        backgroundColor: colorHint,
        backgroundImage:
          layerWidthPx >= 32
            ? "repeating-linear-gradient(90deg, rgba(255,255,255,0.10) 0 1px, transparent 1px 12px)"
            : undefined,
      }}
    />
  );
}
