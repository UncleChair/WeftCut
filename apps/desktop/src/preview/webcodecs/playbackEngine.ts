// Phase B5 — realtime playback engine.
//
// Wires B1 (decoder substrate) + B2 (WebGL2 compositor) + B3 (IR
// recipe) into an end-to-end playback loop. Owns:
//
//   * DecoderPool — manages a VideoDecoder per active clip; lazily
//     opens decoders when their clip enters the playhead window;
//     closes them on exit. Each clip keeps a small ring buffer of
//     decoded VideoFrames so the RAF loop can pick the latest frame
//     at or before the current timeline time.
//
//   * RasterCache — lazy-loads frame_NNNNN.png files into
//     ImageBitmaps; LRU eviction so long timelines don't run the
//     webview out of GPU memory.
//
//   * ImageCache — one ImageBitmap per static image overlay.
//
//   * PlaybackClock — performance.now()-driven timeline clock for
//     B5. B6 swaps this for an `<audio>`-driven master clock so
//     audio + video stay in sync.
//
// What this DOES NOT yet do (B6):
//   - Audio playback
//   - PreviewSurface integration (lives in the dev harness only)
//   - Per-clip codec fallback to A's segmented cache (failing clips
//     just don't render in B5)
//   - Mid-session decode-error fallback

import { convertFileSrc } from "@tauri-apps/api/core";

import type {
  RecipeClip,
  RecipeImage,
  RecipeRaster,
  WebcodecsRecipe,
} from "../../ipc";
import { Mp4Decoder, type DecodedFrameInfo } from "./decoder";
import {
  WebGL2Compositor,
  type BlendMode,
  type CompositorLayer,
} from "./compositor";

/// How far ahead of the playhead a clip's decoder gets eagerly opened.
/// Larger window = more cold-start hidden, but more concurrent
/// decoders. 1.5s covers a typical crossfade lead-in.
const DECODER_PREFETCH_US = 1_500_000;

/// How long after a clip exits the playhead we keep its decoder
/// alive in case the user seeks back. Closing & reopening is
/// expensive on long clips (full restart-and-skip), so we lean
/// generous.
const DECODER_LINGER_US = 2_000_000;

/// Wall-time milliseconds we wait for a decoder to produce its
/// first frame before flagging it as stalled. Three seconds
/// covers HW probe + fetch + demux + first-IDR decode comfortably;
/// anything longer is a real problem (codec unsupported, file
/// missing, network stuck).
const DECODER_STALL_THRESHOLD_MS = 3_000;

/// Per-clip ring buffer cap. The decoder runs faster than realtime
/// (typically 5–20× on HW-accel WebCodecs), so without a smart
/// eviction policy a small ring would only ever hold frames from the
/// END of the clip — and the RAF loop's "latest frame ≤ playhead"
/// query would never find anything in the early seconds.
///
/// Sizing: 512 frames covers ~17s of 30fps playback. Frames are
/// GPU-resident in Chromium so the CPU memory cost is small; the
/// real bound is the decoder's internal output pool (~32–128 alive
/// frames before stalls), which is why we also evict aggressively
/// once we have a meaningful playhead position. See pushFrame for
/// the distance-from-playhead eviction policy.
const FRAME_RING_CAP = 512;

/// How far behind the playhead we keep frames in case of immediate
/// rewind. Anything older is dropped on the next syncToTime tick.
const FRAME_KEEP_BEHIND_US = 500_000;

/// LRU cap on raster ImageBitmaps. At 1080p RGBA each bitmap is ~8MB;
/// 64 caps memory at ~512MB which is acceptable for a desktop app.
const RASTER_CACHE_CAP = 64;

/// How many raster frames ahead of the current index we prefetch on
/// each access. Without prefetch, every NEW frame index would miss
/// the cache for one RAF tick (during the async load) and render
/// nothing, producing the visible flicker. 6 frames ≈ 200ms at 30fps,
/// enough lead time for the fetch + decode to complete before the
/// playhead lands on it.
const RASTER_PREFETCH_AHEAD = 6;

interface RingEntry {
  timestampUs: number;
  frame: VideoFrame;
}

/// A single video clip's decoder + frame ring. Wraps `Mp4Decoder`.
class ClipDecoder {
  private mp4: Mp4Decoder | null = null;
  /// Sorted by timestampUs ascending.
  private ring: RingEntry[] = [];
  private opening = false;
  private openError: string | null = null;
  private closed = false;
  private maxSeenTimestampUs = Number.NEGATIVE_INFINITY;
  /// Current playhead in clip-local-source time. Updated by
  /// DecoderPool.syncToTime each RAF; drives the eviction window in
  /// pushFrame so we don't lose frames around the playhead when the
  /// decoder bursts ahead.
  private playheadLocalUs = Number.NEGATIVE_INFINITY;
  /// Wall-time of open() start, set in open(); used to detect
  /// stalled decoders that never produce a first frame.
  private openStartedAtWallMs: number | null = null;
  /// Wall-time of first onFrame. Null until the decoder has
  /// produced at least one frame.
  private firstFrameAtWallMs: number | null = null;
  /// Latches once we've surfaced the open error to the engine, so
  /// the LogBus doesn't receive the same entry every RAF tick.
  reportedError = false;
  /// Latches once we've surfaced the stall to the engine.
  reportedStall = false;

  constructor(readonly clip: RecipeClip) {}

  setPlayheadLocal(localTimeUs: number): void {
    this.playheadLocalUs = localTimeUs;
  }

  /// True iff no frame has arrived AND wall-time-since-open exceeds
  /// the stall threshold. The engine watcher reads this each tick.
  isStalled(): boolean {
    if (this.firstFrameAtWallMs !== null) return false;
    if (this.openStartedAtWallMs === null) return false;
    return performance.now() - this.openStartedAtWallMs >= DECODER_STALL_THRESHOLD_MS;
  }

  async open(): Promise<void> {
    if (this.mp4 || this.opening || this.closed) return;
    this.opening = true;
    this.openStartedAtWallMs = performance.now();
    const mp4 = new Mp4Decoder({
      onFrame: (info: DecodedFrameInfo) => {
        if (this.closed) {
          info.frame.close();
          return;
        }
        if (this.firstFrameAtWallMs === null) {
          this.firstFrameAtWallMs = performance.now();
        }
        this.pushFrame(info);
      },
      onError: (detail) => {
        this.openError = detail;
      },
    });
    this.mp4 = mp4;
    try {
      await mp4.open(convertFileSrc(this.clip.mediaPath));
    } catch (e) {
      this.openError = String(e);
    } finally {
      this.opening = false;
    }
  }

  /// Latest frame whose timestamp ≤ localTimeUs. Returns null when
  /// the ring is still warming up or the requested time is before
  /// the earliest decoded frame.
  frameAtOrBefore(localTimeUs: number): VideoFrame | null {
    let best: RingEntry | null = null;
    for (const entry of this.ring) {
      if (entry.timestampUs <= localTimeUs) {
        if (!best || entry.timestampUs > best.timestampUs) best = entry;
      }
    }
    return best?.frame ?? null;
  }

  /// Drop frames before `tUs`. Used by DecoderPool to keep the ring
  /// from holding onto frames the playhead has already passed.
  dropFramesBefore(tUs: number): void {
    let keepFrom = 0;
    while (
      keepFrom < this.ring.length - 1 &&
      (this.ring[keepFrom + 1]?.timestampUs ?? Number.POSITIVE_INFINITY) <= tUs
    ) {
      keepFrom += 1;
    }
    if (keepFrom > 0) {
      for (let i = 0; i < keepFrom; i += 1) {
        this.ring[i]?.frame.close();
      }
      this.ring = this.ring.slice(keepFrom);
    }
  }

  error(): string | null {
    return this.openError;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.ring) entry.frame.close();
    this.ring = [];
    if (this.mp4) {
      await this.mp4.close();
      this.mp4 = null;
    }
  }

  private pushFrame(info: DecodedFrameInfo): void {
    // Most decoders emit in PTS order, but B-frames can produce
    // out-of-order output. Keep the ring sorted by timestamp.
    const entry: RingEntry = {
      timestampUs: info.timestampUs,
      frame: info.frame,
    };
    let insertAt = this.ring.length;
    for (let i = 0; i < this.ring.length; i += 1) {
      const here = this.ring[i];
      if (here && here.timestampUs > info.timestampUs) {
        insertAt = i;
        break;
      }
    }
    this.ring.splice(insertAt, 0, entry);
    if (info.timestampUs > this.maxSeenTimestampUs) {
      this.maxSeenTimestampUs = info.timestampUs;
    }
    // Smart eviction: when the ring overflows the cap, drop frames
    // furthest from the playhead, NOT just the oldest. The decoder
    // happily decodes ahead at 10–20× realtime; an oldest-first
    // policy ejects the frames the RAF loop is about to need (those
    // near the playhead) and keeps the end-of-clip frames.
    //
    // The cap itself is a backstop — the dominant eviction path is
    // dropFramesBefore() called per tick from syncToTime, which
    // trims past frames as the playhead advances.
    while (this.ring.length > FRAME_RING_CAP) {
      this.evictFurthestFromPlayhead();
    }
  }

  private evictFurthestFromPlayhead(): void {
    if (this.ring.length === 0) return;
    const playhead = this.playheadLocalUs;
    if (!Number.isFinite(playhead)) {
      // No playhead set yet — fall back to oldest-first so we don't
      // grow unboundedly during the initial fill before play().
      const evicted = this.ring.shift();
      evicted?.frame.close();
      return;
    }
    const first = this.ring[0];
    const last = this.ring[this.ring.length - 1];
    if (!first || !last) return;
    // Compare distance from playhead of front vs back; evict the
    // larger one. This keeps the ring centered around the playhead.
    const distFront = Math.abs(playhead - first.timestampUs);
    const distBack = Math.abs(playhead - last.timestampUs);
    if (distBack >= distFront) {
      const evicted = this.ring.pop();
      evicted?.frame.close();
    } else {
      const evicted = this.ring.shift();
      evicted?.frame.close();
    }
  }
}

/// Map of layerId → ClipDecoder. Active set is recomputed each tick
/// based on the playhead-relative window.
class DecoderPool {
  private decoders = new Map<string, ClipDecoder>();

  /// Ensure decoders exist for clips within
  /// [t - LINGER, t + PREFETCH] of `tUs`; close decoders outside.
  /// Also drops stale frames inside each kept decoder.
  syncToTime(tUs: number, clips: ReadonlyArray<RecipeClip>): void {
    const wanted = new Set<string>();
    for (const clip of clips) {
      const inWindow =
        tUs >= clip.timelineInUs - DECODER_LINGER_US &&
        tUs <= clip.timelineOutUs + DECODER_PREFETCH_US;
      if (!inWindow) continue;
      wanted.add(clip.layerId);
      const localT = tUs - clip.timelineInUs + clip.sourceInUs;
      let dec = this.decoders.get(clip.layerId);
      if (!dec) {
        dec = new ClipDecoder(clip);
        this.decoders.set(clip.layerId, dec);
        void dec.open();
      } else {
        // Trim frames the playhead has long passed.
        dec.dropFramesBefore(localT - FRAME_KEEP_BEHIND_US);
      }
      // Always update the playhead so pushFrame's smart eviction
      // has a reference point — even on the first tick before any
      // frames have arrived.
      dec.setPlayheadLocal(localT);
    }
    for (const [id, dec] of this.decoders.entries()) {
      if (!wanted.has(id)) {
        void dec.close();
        this.decoders.delete(id);
      }
    }
  }

  /// Latest decoded frame for the given clip at the local source time.
  /// Returns null when the decoder is missing or still warming up.
  frameAt(clip: RecipeClip, tUs: number): VideoFrame | null {
    const dec = this.decoders.get(clip.layerId);
    if (!dec) return null;
    const localT = tUs - clip.timelineInUs + clip.sourceInUs;
    return dec.frameAtOrBefore(localT);
  }

  activeCount(): number {
    return this.decoders.size;
  }

  errors(): Array<{ layerId: string; detail: string }> {
    const out: Array<{ layerId: string; detail: string }> = [];
    for (const [id, dec] of this.decoders.entries()) {
      const e = dec.error();
      if (e) out.push({ layerId: id, detail: e });
    }
    return out;
  }

  /// Return any NEW error / stall events since the last call,
  /// marking them as reported on the underlying decoder so we don't
  /// double-emit. The engine's RAF watcher invokes this once per
  /// tick and pipes the results into the engine's event surface.
  collectNewIssues(): Array<{
    layerId: string;
    kind: "error" | "stall";
    detail: string;
  }> {
    const out: Array<{
      layerId: string;
      kind: "error" | "stall";
      detail: string;
    }> = [];
    for (const [id, dec] of this.decoders.entries()) {
      if (!dec.reportedError) {
        const e = dec.error();
        if (e) {
          dec.reportedError = true;
          out.push({ layerId: id, kind: "error", detail: e });
        }
      }
      if (!dec.reportedStall && dec.isStalled()) {
        dec.reportedStall = true;
        out.push({
          layerId: id,
          kind: "stall",
          detail: `no frame after ${DECODER_STALL_THRESHOLD_MS} ms`,
        });
      }
    }
    return out;
  }

  /// Drop all decoders. Used on recipe swap and on seek-backward
  /// (where ring contents are stale anyway).
  reset(): void {
    for (const dec of this.decoders.values()) {
      void dec.close();
    }
    this.decoders.clear();
  }
}

/// LRU cache of raster ImageBitmaps keyed by absolute frame path.
class RasterCache {
  private bitmaps = new Map<string, ImageBitmap>();
  /// In-flight fetches so concurrent `getOrFetch` calls dedupe.
  private pending = new Map<string, Promise<ImageBitmap | null>>();

  /// Get the cached bitmap for the raster's frame index, prefetching
  /// the next several frames so subsequent ticks have them in cache.
  /// If the requested frame isn't cached yet, falls back to the most
  /// recent cached frame for this raster (any frame index ≤ the
  /// requested one). That eliminates the one-tick flicker between
  /// "fetch started" and "fetch finished".
  getOrFetchFrame(
    rasterDir: string,
    frameIndex: number,
    frameCount: number,
  ): ImageBitmap | null {
    const key = framePath(rasterDir, frameIndex);

    // Prefetch lookahead — fire-and-forget. The cache picks them up
    // on completion; we don't await.
    const last = Math.min(frameCount - 1, frameIndex + RASTER_PREFETCH_AHEAD);
    for (let i = frameIndex; i <= last; i += 1) {
      const k = framePath(rasterDir, i);
      if (!this.bitmaps.has(k) && !this.pending.has(k)) {
        this.pending.set(k, this.fetch(k));
      }
    }

    const cached = this.bitmaps.get(key);
    if (cached) {
      this.bitmaps.delete(key);
      this.bitmaps.set(key, cached);
      return cached;
    }
    // Fallback: walk backwards looking for the closest cached frame
    // BEHIND the playhead. A one-tick-stale frame is invisible at
    // 30fps raster + 60Hz display; a missing frame produces a
    // visible flicker.
    for (let i = frameIndex - 1; i >= 0; i -= 1) {
      const fallback = this.bitmaps.get(framePath(rasterDir, i));
      if (fallback) return fallback;
    }
    return null;
  }

  /// Image overlay path (not a frame sequence).
  getOrFetchImage(absPath: string): ImageBitmap | null {
    return this.getOrFetchRaw(absPath);
  }

  private getOrFetchRaw(absPath: string): ImageBitmap | null {
    const cached = this.bitmaps.get(absPath);
    if (cached) {
      this.bitmaps.delete(absPath);
      this.bitmaps.set(absPath, cached);
      return cached;
    }
    if (!this.pending.has(absPath)) {
      this.pending.set(absPath, this.fetch(absPath));
    }
    return null;
  }

  private async fetch(absPath: string): Promise<ImageBitmap | null> {
    try {
      const res = await fetch(convertFileSrc(absPath));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      this.bitmaps.set(absPath, bmp);
      this.evictIfOver();
      return bmp;
    } catch {
      // Best-effort: skip this frame. The RAF loop will just leave
      // that layer un-drawn for the cycle.
      return null;
    } finally {
      this.pending.delete(absPath);
    }
  }

  private evictIfOver(): void {
    while (this.bitmaps.size > RASTER_CACHE_CAP) {
      // Map preserves insertion order; the FIRST entry is the LRU.
      const oldestKey = this.bitmaps.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.bitmaps.get(oldestKey);
      oldest?.close();
      this.bitmaps.delete(oldestKey);
    }
  }

  clear(): void {
    for (const bmp of this.bitmaps.values()) bmp.close();
    this.bitmaps.clear();
    // Note: in-flight `pending` fetches keep running; their
    // `finally` block deletes themselves and the result drops since
    // the cache is empty. Acceptable for B5.
  }

  dispose(): void {
    this.clear();
    this.pending.clear();
  }
}

function framePath(rasterDir: string, frameIndex: number): string {
  // Frame sequences are written as `frame_00001.png` (1-indexed,
  // 5-digit zero-padded). Mirrors what `raster::render` produces.
  const idx = String(frameIndex + 1).padStart(5, "0");
  // Use backslash on Windows paths or forward slash on POSIX. The
  // recipe stores the directory verbatim from the OS, so we just
  // append using the directory's separator if visible.
  const sep = rasterDir.includes("\\") ? "\\" : "/";
  return `${rasterDir}${rasterDir.endsWith(sep) ? "" : sep}frame_${idx}.png`;
}

/// performance.now()-driven timeline clock. B5 uses this as the
/// master; B6 swaps in an `<audio>` element's currentTime so audio
/// stays in sync with video.
class PlaybackClock {
  private wallStartMs = 0;
  private timelineStartUs = 0;
  private isPaused = true;
  private clampMaxUs: number | null = null;

  setBounds(durationUs: number | null): void {
    this.clampMaxUs = durationUs;
  }

  play(): void {
    if (!this.isPaused) return;
    this.wallStartMs = performance.now();
    this.isPaused = false;
  }

  pause(): void {
    if (this.isPaused) return;
    this.timelineStartUs = this.currentTimeUs();
    this.isPaused = true;
  }

  seek(tUs: number): void {
    const clamped = this.clamp(tUs);
    this.timelineStartUs = clamped;
    this.wallStartMs = performance.now();
  }

  currentTimeUs(): number {
    if (this.isPaused) return this.timelineStartUs;
    const elapsedMs = performance.now() - this.wallStartMs;
    return this.clamp(this.timelineStartUs + Math.floor(elapsedMs * 1000));
  }

  paused(): boolean {
    return this.isPaused;
  }

  private clamp(t: number): number {
    if (t < 0) return 0;
    if (this.clampMaxUs !== null && t > this.clampMaxUs) {
      return this.clampMaxUs;
    }
    return t;
  }
}

export interface PlaybackStats {
  activeDecoders: number;
  errors: ReadonlyArray<{ layerId: string; detail: string }>;
}

export interface DecoderIssue {
  layerId: string;
  mediaPath: string;
  kind: "error" | "stall";
  detail: string;
}

export interface PlaybackEngineEvents {
  onTimeUpdate?: (tUs: number) => void;
  onPausedChange?: (paused: boolean) => void;
  onEnded?: () => void;
  /// Fires once per (layerId, kind) when a clip decoder fails to
  /// open, errors mid-decode, or stalls past the stall threshold
  /// without producing a first frame. PreviewSurface forwards this
  /// to LogBus; B6c future work may auto-fall-back to segmented.
  onDecoderIssue?: (issue: DecoderIssue) => void;
}

export class PlaybackEngine {
  private readonly compositor: WebGL2Compositor;
  private readonly decoderPool = new DecoderPool();
  private readonly rasterCache = new RasterCache();
  private readonly clock = new PlaybackClock();
  private events: PlaybackEngineEvents;
  private recipe: WebcodecsRecipe | null = null;
  private rafHandle: number | null = null;
  private disposed = false;
  private lastReportedT = -1;
  private endedFired = false;
  /// B6a — optional audio master. When present and playable, its
  /// `currentTime` becomes the timeline clock so video+audio stay in
  /// sync without ad-hoc PTS chasing. Source is typically the legacy
  /// preview MP4 (which carries the project's mixed-down audio
  /// track); projects with no audio fall through to the synthetic
  /// `PlaybackClock`.
  private audio: HTMLAudioElement | null = null;
  /// True iff audio has loaded enough metadata to be authoritative.
  /// Cleared on setAudioUrl(null) and when audio errors out.
  private audioReady = false;

  constructor(canvas: HTMLCanvasElement, events: PlaybackEngineEvents = {}) {
    this.compositor = new WebGL2Compositor(canvas);
    this.events = events;
  }

  /// Point the engine at a whole-timeline audio source (or null to
  /// run silent). The legacy preview MP4 is the practical source —
  /// it already carries the mixed audio track. The `<audio>` element
  /// silently ignores the video track, so passing the same path to
  /// both surfaces is fine.
  setAudioUrl(url: string | null): void {
    // Tear down any prior audio element first so we don't leak the
    // underlying decoder / network request.
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio.load();
      this.audio = null;
      this.audioReady = false;
    }
    if (!url) return;
    const el = new Audio();
    el.preload = "auto";
    el.src = url;
    el.addEventListener("loadedmetadata", () => {
      // duration=NaN or 0 means the source has no playable audio
      // (project has no audio tracks); leave audioReady=false so
      // we fall through to the synthetic clock.
      if (Number.isFinite(el.duration) && el.duration > 0) {
        this.audioReady = true;
      }
    });
    el.addEventListener("ended", () => {
      if (!this.endedFired) {
        this.endedFired = true;
        this.events.onEnded?.();
      }
      this.events.onPausedChange?.(true);
    });
    el.addEventListener("error", () => {
      // Source failed to load. Silently fall back to synthetic
      // clock — B6c surfaces this through LogBus.
      this.audioReady = false;
    });
    this.audio = el;
  }

  setRecipe(recipe: WebcodecsRecipe | null): void {
    if (this.recipe === recipe) return;
    this.recipe = recipe;
    this.decoderPool.reset();
    this.rasterCache.clear();
    this.endedFired = false;
    this.clock.setBounds(recipe?.durationUs ?? null);
    if (!recipe) {
      this.clock.pause();
      this.clock.seek(0);
      this.events.onPausedChange?.(true);
      this.events.onTimeUpdate?.(0);
    }
    this.compositor.setSize(
      recipe?.canvas.width ?? 1,
      recipe?.canvas.height ?? 1,
    );
    // Drive an immediate render so the surface reflects the new
    // recipe state even while paused.
    this.renderOnce();
  }

  play(): void {
    if (!this.recipe) return;
    // Pressing Play after auto-pause-at-end leaves the clock at
    // durationUs, where nothing on the recipe is active. Rewind to
    // the start so the user gets a normal replay instead of staring
    // at an empty composition.
    const atEnd =
      this.recipe.durationUs > 0 &&
      this.currentTimeUs() >= this.recipe.durationUs - 50_000;
    if (atEnd) {
      this.seekTo(0);
    }
    if (this.audio && this.audioReady) {
      // play() may reject if the browser denies autoplay; that's
      // fine — the synthetic clock keeps the video moving.
      void this.audio.play().catch(() => {});
    }
    this.clock.play();
    this.endedFired = false;
    this.events.onPausedChange?.(false);
    this.startLoop();
  }

  pause(): void {
    if (this.audio && this.audioReady) {
      this.audio.pause();
    }
    if (this.clock.paused()) return;
    this.clock.pause();
    this.events.onPausedChange?.(true);
    // Leave the loop running so the surface stays painted; the
    // tick is cheap when paused (compositor uses cached frame).
  }

  seekTo(tUs: number): void {
    if (this.audio && this.audioReady) {
      try {
        this.audio.currentTime = tUs / 1_000_000;
      } catch {
        // Some Chromium builds reject setting currentTime before
        // the audio is fully buffered; non-fatal.
      }
    }
    this.clock.seek(tUs);
    this.endedFired = false;
    // Reset the decoder pool on seek. Each ClipDecoder's ring buffer
    // is centered around the previous playhead (dropFramesBefore
    // trims old frames every tick) and the decoder may have already
    // finished decoding the whole clip — so a backward seek can land
    // in a region the ring no longer covers AND can't refill.
    // Closing and reopening cold-starts each affected decoder; the
    // RAF loop's next syncToTime tick will recreate them.
    //
    // For B5 we hammer this on every seek for correctness; B6 can
    // skip the reset when the new playhead is still inside the ring.
    this.decoderPool.reset();
    this.renderOnce();
    this.events.onTimeUpdate?.(this.clock.currentTimeUs());
  }

  paused(): boolean {
    // Synthetic clock is the authoritative paused state. Audio is
    // driven in lockstep but isn't trusted for timing — buffering
    // stalls / underruns in the legacy-preview source caused the
    // RAF loop to "play frame-by-frame" when audio drove the clock.
    return this.clock.paused();
  }

  currentTimeUs(): number {
    // Synthetic clock advances at wall time regardless of audio
    // buffering state. Audio drift can be corrected separately
    // (B6c) by snapping the clock to audio.currentTime when |delta|
    // exceeds a threshold — for B6b we just play them in parallel
    // from the same play()/pause()/seek() actions, which keeps
    // them within ~50ms in practice.
    return this.clock.currentTimeUs();
  }

  durationUs(): number {
    return this.recipe?.durationUs ?? 0;
  }

  stats(): PlaybackStats {
    return {
      activeDecoders: this.decoderPool.activeCount(),
      errors: this.decoderPool.errors(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio.load();
      this.audio = null;
    }
    this.decoderPool.reset();
    this.rasterCache.dispose();
    this.compositor.dispose();
  }

  private startLoop(): void {
    if (this.rafHandle !== null) return;
    const tick = () => {
      if (this.disposed) {
        this.rafHandle = null;
        return;
      }
      this.renderOnce();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private renderOnce(): void {
    if (this.disposed || !this.recipe) return;
    const tUs = this.clock.currentTimeUs();

    // 1. Sync decoder pool with the active clip set
    this.decoderPool.syncToTime(tUs, this.recipe.clips);

    // 2. Collect active layers, sorted by z (back-to-front)
    type Entry = { z: number; layer: CompositorLayer | null };
    const entries: Entry[] = [];
    for (const clip of this.recipe.clips) {
      if (tUs < clip.timelineInUs || tUs >= clip.timelineOutUs) continue;
      const layer = this.buildClipLayer(clip, tUs);
      entries.push({ z: clip.zOrder, layer });
    }
    for (const raster of this.recipe.rasters) {
      if (tUs < raster.timelineInUs || tUs >= raster.timelineOutUs) continue;
      const layer = this.buildRasterLayer(raster, tUs);
      entries.push({ z: raster.zOrder, layer });
    }
    for (const image of this.recipe.images) {
      if (tUs < image.timelineInUs || tUs >= image.timelineOutUs) continue;
      const layer = this.buildImageLayer(image);
      entries.push({ z: image.zOrder, layer });
    }
    entries.sort((a, b) => a.z - b.z);
    const layers: CompositorLayer[] = [];
    for (const e of entries) {
      if (e.layer) layers.push(e.layer);
    }

    // 3. Render
    this.compositor.render(layers);

    // 4. Report timeupdate (throttled to ~30Hz so React doesn't
    // re-render on every RAF)
    if (Math.abs(tUs - this.lastReportedT) > 33_000) {
      this.lastReportedT = tUs;
      this.events.onTimeUpdate?.(tUs);
    }

    // 4b. B6c — surface any new decoder errors / stalls. Once per
    // (clip, kind), so a stalled decoder doesn't spam LogBus every
    // RAF tick.
    if (this.events.onDecoderIssue) {
      const issues = this.decoderPool.collectNewIssues();
      for (const issue of issues) {
        // Look up the clip's mediaPath so the log entry is useful
        // without the user having to map a layer_id back to a clip.
        const clip = this.recipe.clips.find((c) => c.layerId === issue.layerId);
        this.events.onDecoderIssue({
          layerId: issue.layerId,
          mediaPath: clip?.mediaPath ?? "(unknown)",
          kind: issue.kind,
          detail: issue.detail,
        });
      }
    }

    // 5. Auto-pause at end
    if (
      !this.clock.paused() &&
      this.recipe.durationUs > 0 &&
      tUs >= this.recipe.durationUs
    ) {
      this.pause();
      if (!this.endedFired) {
        this.endedFired = true;
        this.events.onEnded?.();
      }
    }
  }

  private buildClipLayer(clip: RecipeClip, tUs: number): CompositorLayer | null {
    const frame = this.decoderPool.frameAt(clip, tUs);
    if (!frame) return null;
    return {
      source: frame,
      transform: clip.transform,
      opacity: clip.opacity,
      blendMode: normalizeBlend(clip.blendMode),
      flipY: clip.flipY,
    };
  }

  private buildRasterLayer(
    raster: RecipeRaster,
    tUs: number,
  ): CompositorLayer | null {
    const localUs = tUs - raster.timelineInUs;
    const frameFloat =
      (localUs / 1_000_000) * (raster.fpsNum / Math.max(1, raster.fpsDen));
    const idx = Math.max(
      0,
      Math.min(raster.frameCount - 1, Math.floor(frameFloat)),
    );
    const bmp = this.rasterCache.getOrFetchFrame(
      raster.rasterDir,
      idx,
      raster.frameCount,
    );
    if (!bmp) return null;
    return {
      source: bmp,
      transform: raster.transform,
      opacity: raster.opacity,
      blendMode: normalizeBlend(raster.blendMode),
    };
  }

  private buildImageLayer(image: RecipeImage): CompositorLayer | null {
    const bmp = this.rasterCache.getOrFetchImage(image.mediaPath);
    if (!bmp) return null;
    return {
      source: bmp,
      transform: image.transform,
      opacity: image.opacity,
      blendMode: normalizeBlend(image.blendMode),
    };
  }
}

function normalizeBlend(s: string): BlendMode {
  // The recipe carries every WeftCut BlendMode variant (multiply,
  // screen, etc.) but the B2 compositor only understands "normal"
  // and "add". B6's compositor pass will expand to the full set;
  // until then we collapse to the closest representable.
  return s === "add" ? "add" : "normal";
}
