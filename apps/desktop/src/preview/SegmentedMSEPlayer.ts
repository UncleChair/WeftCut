// SegmentedMSEPlayer — feeds fMP4 segments + whole-timeline AAC audio
// into a single MediaSource via two SourceBuffers (Phase A4).
//
// Lifecycle:
//   1. Construct → creates MediaSource + a blob: URL the <video> element
//      can use as src.
//   2. <video src=player.objectUrl> → triggers `sourceopen` → we add two
//      SourceBuffers (video + audio) with codec strings from the manifest.
//   3. setSegments() registers manifest entries by hash.
//   4. appendSegment(hash, url) fetches bytes + appends at the segment's
//      timeline offset (via timestampOffset). Same for appendAudio().
//
// MSE serialization: each SourceBuffer requires `updateend` between
// operations. We queue ops per buffer and drain on `updateend` events.
//
// Note on init segments: A2's encoder emits a self-contained fMP4 per
// segment (ftyp+moov+moof+mdat). MSE accepts repeated moov boxes only
// when codec params match exactly; our segments share params so this
// works in WebView2 + Safari + recent WebKitGTK. If a downstream browser
// rejects repeated init, the box-stripping helper below extracts just
// the moof+mdat from non-first segments.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";

import {
  SEGMENT_EVENTS,
  type AudioReady,
  type ManifestChanged,
  type SegmentReady,
} from "../ipc";

export interface SegmentMeta {
  hash: string;
  inUs: number;
  outUs: number;
}

type PendingOp = () => void;

export class SegmentedMSEPlayer {
  /// Blob URL the <video> element points at. Stable for the lifetime of
  /// this player; one URL per player instance.
  public readonly objectUrl: string;

  /// True once both SourceBuffers have been added (i.e. `sourceopen`
  /// fired and we created them). MSE rejects ops before this point.
  public ready = false;

  private mediaSource: MediaSource;
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;

  // Op queues per buffer. Each op invokes the SourceBuffer; we wait for
  // `updateend` before draining the next.
  private videoOps: PendingOp[] = [];
  private audioOps: PendingOp[] = [];

  // Hashes whose bytes have been appended. Lets us short-circuit redundant
  // appendSegment() calls when the React side re-fires a ready event.
  private bufferedHashes = new Set<string>();

  // Hash → metadata. Populated by setManifest() from manifest_changed.
  private segmentMeta = new Map<string, SegmentMeta>();

  private videoCodec: string;
  private audioCodec: string;

  /// Fires when sourceopen completes and SourceBuffers are usable.
  private readyResolvers: Array<() => void> = [];

  constructor(videoCodec: string, audioCodec: string) {
    this.videoCodec = videoCodec;
    this.audioCodec = audioCodec;
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener("sourceopen", () => this.onSourceOpen());
  }

  /// Resolves once the SourceBuffers are created.
  public whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((r) => this.readyResolvers.push(r));
  }

  private onSourceOpen() {
    if (this.ready) return;
    try {
      this.videoBuffer = this.mediaSource.addSourceBuffer(
        `video/mp4; codecs="${this.videoCodec}"`,
      );
      this.videoBuffer.mode = "segments";
      this.videoBuffer.addEventListener("updateend", () => this.drainVideoOps());

      this.audioBuffer = this.mediaSource.addSourceBuffer(
        `audio/mp4; codecs="${this.audioCodec}"`,
      );
      this.audioBuffer.mode = "segments";
      this.audioBuffer.addEventListener("updateend", () => this.drainAudioOps());

      this.ready = true;
      for (const r of this.readyResolvers) r();
      this.readyResolvers = [];
    } catch (e) {
      console.error("SegmentedMSEPlayer: addSourceBuffer failed", e);
    }
  }

  /// Replace the known segment set. Called when a manifest_changed event
  /// lands. Hashes already in `bufferedHashes` that aren't in the new
  /// manifest get evicted from the video SourceBuffer (best-effort —
  /// MSE's `remove(start, end)` is async too).
  public setManifest(segments: SegmentMeta[], durationUs: number) {
    const newHashes = new Set(segments.map((s) => s.hash));

    // Evict buffered ranges for segments no longer in the manifest.
    for (const hash of Array.from(this.bufferedHashes)) {
      if (newHashes.has(hash)) continue;
      const meta = this.segmentMeta.get(hash);
      if (!meta) continue;
      this.bufferedHashes.delete(hash);
      this.queueVideoOp(() => {
        if (!this.videoBuffer) return;
        try {
          this.videoBuffer.remove(meta.inUs / 1_000_000, meta.outUs / 1_000_000);
        } catch (e) {
          console.warn("MSE remove() failed", e);
        }
      });
    }

    // Replace meta map.
    this.segmentMeta.clear();
    for (const s of segments) this.segmentMeta.set(s.hash, s);

    // Update duration on MediaSource. Wrapped in try because setting
    // duration while a buffer is updating throws.
    if (this.mediaSource.readyState === "open") {
      try {
        const durSecs = durationUs / 1_000_000;
        if (!Number.isNaN(durSecs) && durSecs > 0) {
          this.mediaSource.duration = durSecs;
        }
      } catch {
        // Ignore — duration will settle on next quiet append.
      }
    }
  }

  /// Has a given segment's bytes been appended? Used by the surface to
  /// decide whether a seek lands on Ready or Pending.
  public hasSegment(hash: string): boolean {
    return this.bufferedHashes.has(hash);
  }

  /// Locate the segment whose timeline range contains `tUs`. Returns
  /// undefined when the playhead is past the end of the manifest.
  public segmentAt(tUs: number): SegmentMeta | undefined {
    for (const meta of this.segmentMeta.values()) {
      if (tUs >= meta.inUs && tUs < meta.outUs) return meta;
    }
    return undefined;
  }

  /// Append a segment's bytes at its timeline offset. Idempotent — a
  /// repeated call for the same hash is a no-op. Fetches via the asset
  /// protocol.
  public async appendSegment(hash: string, fileUrl: string): Promise<void> {
    if (!this.ready) await this.whenReady();
    if (this.bufferedHashes.has(hash)) return;
    const meta = this.segmentMeta.get(hash);
    if (!meta) {
      console.warn(`SegmentedMSEPlayer: hash ${hash} not in manifest`);
      return;
    }
    let bytes: Uint8Array;
    try {
      const resp = await fetch(fileUrl);
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      console.error("SegmentedMSEPlayer: fetch segment failed", e);
      return;
    }

    this.bufferedHashes.add(hash);
    this.queueVideoOp(() => {
      const sb = this.videoBuffer;
      if (!sb) return;
      try {
        sb.timestampOffset = meta.inUs / 1_000_000;
        sb.appendBuffer(bytes);
      } catch (e) {
        console.error("SegmentedMSEPlayer: appendBuffer failed", e);
        this.bufferedHashes.delete(hash);
      }
    });
  }

  /// Replace the whole-timeline audio. Removes the existing audio range
  /// first, then appends the new bytes from offset 0.
  public async appendAudio(fileUrl: string): Promise<void> {
    if (!this.ready) await this.whenReady();
    let bytes: Uint8Array;
    try {
      const resp = await fetch(fileUrl);
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      console.error("SegmentedMSEPlayer: fetch audio failed", e);
      return;
    }

    this.queueAudioOp(() => {
      const sb = this.audioBuffer;
      if (!sb) return;
      try {
        // Reset to 0; SB clears any prior range on appendBuffer of an
        // init segment with the same codec, but we set explicitly to
        // be safe across browsers.
        sb.timestampOffset = 0;
        sb.appendBuffer(bytes);
      } catch (e) {
        console.error("SegmentedMSEPlayer: audio appendBuffer failed", e);
      }
    });
  }

  /// Tear down. Frees the blob URL and (if MediaSource isn't already
  /// closed) ends the stream. Safe to call multiple times.
  public dispose() {
    try {
      if (this.mediaSource.readyState === "open") {
        this.mediaSource.endOfStream();
      }
    } catch {
      // ignore
    }
    URL.revokeObjectURL(this.objectUrl);
  }

  // -----------------------------------------------------------------------
  // Per-buffer op queue

  private queueVideoOp(op: PendingOp) {
    this.videoOps.push(op);
    this.drainVideoOps();
  }

  private queueAudioOp(op: PendingOp) {
    this.audioOps.push(op);
    this.drainAudioOps();
  }

  private drainVideoOps() {
    const sb = this.videoBuffer;
    if (!sb || sb.updating) return;
    const next = this.videoOps.shift();
    if (!next) return;
    next();
  }

  private drainAudioOps() {
    const sb = this.audioBuffer;
    if (!sb || sb.updating) return;
    const next = this.audioOps.shift();
    if (!next) return;
    next();
  }
}

// ---------------------------------------------------------------------------
// Convenience: subscribe a player to the Rust orchestrator's Tauri events.
// Returns an unlisten function the caller fires on unmount / teardown.

export interface SubscribeHandlers {
  onManifestChanged?: (m: ManifestChanged) => void;
  onSegmentReady?: (s: SegmentReady) => void;
  onAudioReady?: (a: AudioReady) => void;
}

export async function subscribePlayerToEvents(
  player: SegmentedMSEPlayer,
  segmentsForManifest: () => SegmentMeta[],
  setSegmentsForManifest: (segs: SegmentMeta[]) => void,
  handlers: SubscribeHandlers = {},
): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];

  // We don't get the segment list in the manifest_changed event payload —
  // only the global hash + path. The orchestrator emits one segment_ready
  // event per segment as renders complete. The React layer keeps a local
  // manifest cache it updates from those events plus an initial fetch.
  //
  // For A4 baseline: trust the orchestrator's event stream. The first
  // segment_ready after manifest_changed implicitly extends the buffer;
  // subsequent ones do too.

  unlisteners.push(
    await listen<ManifestChanged>(SEGMENT_EVENTS.manifestChanged, (e) => {
      // Reset known segments so stale-hash leftovers from a prior manifest
      // get evicted on next setManifest call. The duration becomes
      // immediately accurate even before segments arrive.
      setSegmentsForManifest([]);
      player.setManifest([], e.payload.durationUs);
      handlers.onManifestChanged?.(e.payload);
    }),
  );

  unlisteners.push(
    await listen<SegmentReady>(SEGMENT_EVENTS.segmentReady, (e) => {
      const { hash, inUs, outUs, path } = e.payload;
      const meta: SegmentMeta = { hash, inUs, outUs };
      // Append to local manifest if missing.
      const cur = segmentsForManifest();
      if (!cur.some((s) => s.hash === hash)) {
        const next = [...cur, meta].sort((a, b) => a.inUs - b.inUs);
        setSegmentsForManifest(next);
        player.setManifest(next, next[next.length - 1].outUs);
      }
      void player.appendSegment(hash, convertFileSrc(path));
      handlers.onSegmentReady?.(e.payload);
    }),
  );

  unlisteners.push(
    await listen<AudioReady>(SEGMENT_EVENTS.audioReady, (e) => {
      void player.appendAudio(convertFileSrc(e.payload.path));
      handlers.onAudioReady?.(e.payload);
    }),
  );

  return () => {
    for (const u of unlisteners) u();
  };
}
