// Process-wide decode-once cache for animated still images. Decoding a GIF/WebP/
// APNG/AVIF yields its full frame set as downscaled ImageBitmaps plus per-frame
// native delays; multiple ImageOverlay layers on the same media share one decode
// (keyed by mediaId + downscale cap). Ref-counted: the cache OWNS the bitmaps
// and closes them when the last sprite releases. Decode is injectable so the
// ref-count/single-flight/eviction logic is unit-testable without ImageDecoder.

import { clampFrameDurationUs } from "./gifTiming";

export interface DecodedAnimation {
  /// Cache-owned. Sprites wrap (never close) these in their own Texture.
  frames: ImageBitmap[];
  /// Per-frame display time in µs, parallel to `frames`, already clamped.
  durationsUs: number[];
  totalUs: number;
  width: number;
  height: number;
}

export type DecodeFn = (
  assetUrl: string,
  maxW: number,
  maxH: number,
) => Promise<DecodedAnimation>;

export interface AnimatedImageCache {
  /// Acquire (decoding on first request for `key`) and add a reference.
  acquire(key: string, assetUrl: string, maxW: number, maxH: number): Promise<DecodedAnimation>;
  /// Drop one reference; on the last release the decode's bitmaps are closed.
  release(key: string): void;
}

interface Entry {
  promise: Promise<DecodedAnimation>;
  refs: number;
  decoded: DecodedAnimation | null;
}

export function createAnimatedImageCache(decode: DecodeFn): AnimatedImageCache {
  const entries = new Map<string, Entry>();

  const closeAll = (a: DecodedAnimation) => {
    for (const f of a.frames) {
      try {
        f.close();
      } catch {
        // best-effort
      }
    }
  };

  return {
    acquire(key, assetUrl, maxW, maxH) {
      let e = entries.get(key);
      if (!e) {
        const entry: Entry = { promise: decode(assetUrl, maxW, maxH), refs: 0, decoded: null };
        entries.set(key, entry);
        entry.promise
          .then((d) => {
            // If still referenced, retain for later release; otherwise the last
            // reference was dropped mid-decode — close now so nothing leaks.
            if (entries.get(key) === entry && entry.refs > 0) entry.decoded = d;
            else closeAll(d);
          })
          .catch(() => {
            if (entries.get(key) === entry) entries.delete(key);
          });
        e = entry;
      }
      e.refs++;
      return e.promise;
    },
    release(key) {
      const e = entries.get(key);
      if (!e) return;
      e.refs--;
      if (e.refs <= 0) {
        entries.delete(key);
        if (e.decoded) closeAll(e.decoded);
        // If decode hasn't resolved yet, the `.then` above closes on arrival.
      }
    },
  };
}

/// Real decode via WebCodecs `ImageDecoder`. Works in both the preview main
/// thread and the export Worker. Each frame is downscaled at decode to
/// `min(originalDim, maxW/maxH)` so memory stays bounded (the composition never
/// shows a GIF larger than itself). Throws on a missing/unsupported decoder so
/// the caller can fall back to the static `createImageBitmap` path (bmp/tiff/svg).
/// Map a bare file extension (no dot) to its canonical image MIME type. Used
/// to recover the type when the weftcut-media:// protocol doesn't set
/// Content-Type and `blob.type` arrives empty.
const EXT_MIME: Record<string, string> = {
  gif: "image/gif",
  webp: "image/webp",
  png: "image/png",
  apng: "image/apng",
  avif: "image/avif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function mimeFromUrl(url: string): string {
  try {
    const raw = new URL(url).pathname;
    const ext = raw.split(".").pop()?.toLowerCase() ?? "";
    return EXT_MIME[ext] ?? "";
  } catch {
    return "";
  }
}

export const decodeAnimatedImage: DecodeFn = async (assetUrl, maxW, maxH) => {
  const Decoder = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
  if (!Decoder) throw new Error("ImageDecoder unavailable");
  const res = await fetch(assetUrl);
  if (!res.ok) throw new Error(`fetch ${assetUrl} -> ${res.status}`);
  const blob = await res.blob();
  // The weftcut-media:// protocol handler doesn't set Content-Type; fall back
  // to extension-based MIME detection so ImageDecoder can identify the format.
  // Also guard against error-page HTML responses (e.g. Electron serving a
  // diagnostic page when the protocol handler fails) — they are not image data.
  const rawType = blob.type;
  const type = (rawType && !rawType.startsWith("text/")) ? rawType : mimeFromUrl(assetUrl);
  if (!type) throw new Error(`ImageDecoder: cannot determine MIME type (blob.type=${rawType}, url=${assetUrl})`);
  // isTypeSupported may return false in some renderer contexts even for
  // supported types; skip the pre-check and let the decoder fail at open time.
  const buf = await blob.arrayBuffer();
  const dec = new Decoder({ data: buf, type });
  const frames: ImageBitmap[] = [];
  const durationsUs: number[] = [];
  let w = 0;
  let h = 0;
  try {
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    if (!track) throw new Error("ImageDecoder: no selected track");
    const count = track.frameCount;
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const { image } = await dec.decode({ frameIndex: i });
      const scale = Math.min(1, maxW / image.displayWidth, maxH / image.displayHeight);
      const rw = Math.max(1, Math.round(image.displayWidth * scale));
      const rh = Math.max(1, Math.round(image.displayHeight * scale));
      // eslint-disable-next-line no-await-in-loop
      const bmp = await createImageBitmap(image, {
        resizeWidth: rw,
        resizeHeight: rh,
        resizeQuality: "high",
      });
      durationsUs.push(clampFrameDurationUs(image.duration));
      image.close();
      frames.push(bmp);
      if (i === 0) { w = rw; h = rh; }
    }
  } catch (err) {
    for (const f of frames) {
      try { f.close(); } catch { /* best-effort */ }
    }
    throw err;
  } finally {
    dec.close();
  }
  let total = 0;
  for (const d of durationsUs) total += d;
  return { frames, durationsUs, totalUs: total, width: w, height: h };
};

/// The singleton every ImageOverlaySprite shares within a JS realm. (Preview and
/// the export Worker are separate realms, so each has its own — correct: their
/// composition dims, hence downscale caps, are independent.)
export const sharedAnimatedImageCache: AnimatedImageCache =
  createAnimatedImageCache(decodeAnimatedImage);
