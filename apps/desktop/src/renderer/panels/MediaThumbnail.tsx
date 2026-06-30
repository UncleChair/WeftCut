import { useEffect, useState } from "react";
import { listen } from "@/bridge/events";
import { convertFileSrc } from "@/bridge/ipc";
import { getMediaThumbnail } from "../ipc";
import { useMediaById } from "../state/projectStore";

type CacheEntry =
  | { state: "pending" }
  | { state: "not_ready" }
  | { state: "ready"; dataUrl: string }
  | { state: "error"; message: string };

const thumbCache = new Map<string, CacheEntry>();
const thumbListeners = new Map<string, Set<() => void>>();
let jobListenerInstalled = false;

function fireListeners(mediaId: string) {
  thumbListeners.get(mediaId)?.forEach((cb) => cb());
}

async function ensureThumbnail(mediaId: string) {
  const cached = thumbCache.get(mediaId);
  if (
    cached?.state === "pending" ||
    cached?.state === "ready" ||
    cached?.state === "error"
  ) {
    return;
  }
  thumbCache.set(mediaId, { state: "pending" });
  try {
    const dataUrl = await getMediaThumbnail(mediaId);
    thumbCache.set(mediaId, { state: "ready", dataUrl });
  } catch (e) {
    const message = typeof e === "string" ? e : String(e);
    if (message.includes("not_ready")) {
      thumbCache.set(mediaId, { state: "not_ready" });
    } else {
      thumbCache.set(mediaId, { state: "error", message });
    }
  }
  fireListeners(mediaId);
}

async function installJobListenerOnce() {
  if (jobListenerInstalled) return;
  jobListenerInstalled = true;
  await listen<{ media_id: string; kind: string }>(
    "media:job_complete",
    (event) => {
      if (event.payload?.kind === "thumbnails") {
        // Drop the stale "not_ready" cache entry AND kick off a fresh fetch.
        // Deleting alone wouldn't help — listeners would re-render but the
        // useEffect deps haven't changed, so no automatic refetch.
        thumbCache.delete(event.payload.media_id);
        void ensureThumbnail(event.payload.media_id);
      }
    },
  );
}

export function MediaThumbnail({
  mediaId,
  mediaKind,
}: {
  mediaId: string;
  mediaKind: string;
}) {
  const [, setTick] = useState(0);
  const media = useMediaById(mediaId);
  const resolvedKind = (media?.kind ?? mediaKind).toLowerCase();

  useEffect(() => {
    // Only videos produce generated thumbnails; image media display the
    // original file directly.
    if (resolvedKind !== "video") return;
    const listener = () => setTick((t) => t + 1);
    let listeners = thumbListeners.get(mediaId);
    if (!listeners) {
      listeners = new Set();
      thumbListeners.set(mediaId, listeners);
    }
    listeners.add(listener);
    void installJobListenerOnce();
    void ensureThumbnail(mediaId);
    return () => {
      listeners?.delete(listener);
    };
  }, [mediaId, resolvedKind]);

  if (resolvedKind === "image" && media?.available) {
    return (
      <img
        className="media-thumbnail"
        src={convertFileSrc(media.path)}
        alt=""
        draggable={false}
      />
    );
  }

  if (resolvedKind !== "video") {
    return <div className="media-thumbnail is-placeholder" />;
  }
  const entry = thumbCache.get(mediaId);
  if (entry?.state === "ready") {
    return (
      <img
        className="media-thumbnail"
        src={entry.dataUrl}
        alt=""
        draggable={false}
      />
    );
  }
  return <div className="media-thumbnail is-placeholder" />;
}
