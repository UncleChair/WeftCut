// mp4box.js (v2.x) demuxer wrapper. Reads a master proxy file from
// `asset://` via STREAMING fetch + on-demand block byte cache.
//
// Why streaming + range fetch (not one-shot `arrayBuffer()`):
//   At 1080p H.264 CRF22 fast `-bf 0`, a 24-minute proxy lands ~500–
//   700 MB on disk. The previous design pulled the whole thing into
//   `this.proxyBuffer` and let per-sample views into it stay resident.
//   mp4box's internal `MultiBufferStream` ALSO holds references to the
//   parsed buffer chain, so we effectively paid ~2× the proxy size in
//   `usedJSHeapSize`. For long videos this pushed past 1 GB heap.
//
//   The fix is to (1) stream the file into mp4box via `appendBuffer`
//   so no single big ArrayBuffer ever exists in our scope, (2) drop
//   the `ISOFile` reference once the sample table is fully parsed so
//   mp4box's chain can GC, and (3) keep only the recently-needed
//   sample bytes resident via a small LRU of GOP-aligned blocks
//   refilled lazily through HTTP-Range fetches against the same
//   asset URL. Tauri 2's asset protocol honours `Range:` headers
//   (it's the same handler HTML5 `<video>` seeks against).
//
//   Net residency: ~4 GOP-blocks × ~500 KB (one source-second each
//   at v4 proxy bitrate) ≈ 2 MB instead of 500 MB. Heap drops by
//   roughly a factor of the source duration.
//
// API contract:
//   `sampleAt(i)` is still synchronous and returns null transiently
//   when block i isn't cached yet — that's already the pump's signal
//   to break the loop. fetchBlock is fired as a side-effect of the
//   null return so the bytes land before the next rAF tick. The
//   pump retries naturally per `setAnchorTime`.

import {
  createFile,
  DataStream,
  MP4BoxBuffer,
  type ISOFile,
  type Movie,
  type Sample,
  type Track,
} from "mp4box";

export interface DemuxerInit {
  /// `asset://` URL of the master proxy MP4 (1080p H.264 1 s-GOP).
  assetUrl: string;
}

/// One indexed sample as exposed to the pump. The `data` view is a
/// slice into the currently-resident GOP block; valid for the rAF
/// during which `sampleAt(i)` returned it. The pump always immediately
/// constructs an `EncodedVideoChunk` from `data` (which copies into
/// WebCodecs-owned storage), so we don't need to hold the slice
/// across ticks.
export interface IndexedSample {
  index: number;
  ptsUs: number;
  dtsUs: number;
  durationUs: number;
  keyframe: boolean;
  data: Uint8Array;
}

/// Sample metadata kept resident for the whole project lifetime.
/// Roughly 80 bytes × nbSamples; for a 24-min 30 fps proxy that's
/// ~3.5 MB — small enough to keep without thinking about it.
export interface IndexedSampleMeta {
  index: number;
  ptsUs: number;
  dtsUs: number;
  durationUs: number;
  keyframe: boolean;
  byteOffset: number;
  byteSize: number;
}

/// One GOP-aligned span of the proxy file. `firstSampleIdx` points at
/// an IDR; the block ends just before the next IDR (or at EOF). The
/// block is the unit of byte caching + Range fetching.
interface Block {
  firstSampleIdx: number;
  sampleCount: number;
  byteOffset: number;
  byteSize: number;
}

export interface VideoTrackMeta {
  trackId: number;
  /// `avc1.640028`-style codec string for VideoDecoder.configure.
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /// Codec-specific extradata (avcC / hvcC bytes). Required by
  /// VideoDecoder.configure for H.264 / HEVC streams.
  description: Uint8Array;
  nbSamples: number;
  timescale: number;
}

/// A SampleEntry inside `stsd.entries[i]` exposes its codec
/// configuration box as a property whose name matches the box
/// fourcc. mp4box's emitted types use distinct subclasses per
/// codec; we only need a structural view of the few we care about.
interface CodecConfigBox {
  write(stream: DataStream): void;
}

interface SampleEntryWithConfig {
  avcC?: CodecConfigBox;
  hvcC?: CodecConfigBox;
  vpcC?: CodecConfigBox;
  av1C?: CodecConfigBox;
}

/// LRU cap on resident GOP-blocks. 4 GOPs is one source-second of
/// lookbehind plus three of lookahead — comfortably more than the
/// pump's actual window (24 samples) needs, with headroom for the
/// next prefetch. At v4 proxy bitrate this is ~2 MB total.
const BLOCK_CACHE_CAP = 4;

/// Read-chunk size for the streaming fetch. The `body.getReader()`
/// chunks aren't quite this large (WebView2 hands out 16–64 KB
/// chunks), but we don't repack — each chunk is forwarded straight
/// into mp4box.appendBuffer in order. The value is just a hint we
/// don't actually use.

export class Demuxer {
  private file: ISOFile | null;
  private assetUrl: string;
  private readyP: Promise<VideoTrackMeta>;
  private samples: IndexedSampleMeta[] = [];
  private allSamplesP: Promise<void>;
  private allSamplesResolve!: () => void;
  private trackMeta: VideoTrackMeta | null = null;
  private disposed = false;
  private streamingStarted = false;
  /// One block per GOP. Built in `finalizeIndex()` from the
  /// completed sample table.
  private blocks: Block[] = [];
  /// `sampleIdx → block index`. Built alongside `blocks`. Uint32Array
  /// shaves the per-sample object overhead vs a `number[]`.
  private blockBySampleIdx: Uint32Array = new Uint32Array(0);
  /// Resident block bytes. Insertion order = LRU order (oldest first).
  /// Re-inserted on each access to maintain LRU semantics.
  private blockCache = new Map<number, Uint8Array>();
  /// In-flight Range fetches keyed by block id. Multiple pumps asking
  /// for the same block coalesce onto one network round-trip.
  private blockInFlight = new Map<number, Promise<void>>();
  /// One controller for every fetch this Demuxer issues. Aborted in
  /// `dispose()` so pending Range fetches don't keep the project /
  /// closed window alive.
  private abortController = new AbortController();
  /// `setExtractionOptions` requires a track id; we cache it from
  /// `onReady` so `finalizeIndex` can call `releaseUsedSamples` even
  /// after `trackMeta` could in principle be cleared.
  private trackIdForExtraction = 0;

  constructor(init: DemuxerInit) {
    this.assetUrl = init.assetUrl;
    this.file = createFile();
    this.allSamplesP = new Promise<void>((res) => {
      this.allSamplesResolve = res;
    });

    this.readyP = new Promise<VideoTrackMeta>((resolve, reject) => {
      this.file!.onReady = (info: Movie) => {
        try {
          const videoTrack: Track | undefined = info.videoTracks[0];
          if (!videoTrack) {
            reject(new Error("Demuxer: no video track found"));
            return;
          }
          const description = this.extractDescription(videoTrack);
          if (!videoTrack.video) {
            reject(new Error(`Demuxer: track ${videoTrack.id} has no video metadata`));
            return;
          }
          const meta: VideoTrackMeta = {
            trackId: videoTrack.id,
            codec: videoTrack.codec,
            codedWidth: videoTrack.video.width,
            codedHeight: videoTrack.video.height,
            description,
            nbSamples: videoTrack.nb_samples,
            timescale: videoTrack.timescale,
          };
          this.trackMeta = meta;
          this.trackIdForExtraction = videoTrack.id;
          this.file!.setExtractionOptions(videoTrack.id, null, { nbSamples: 100 });
          this.file!.start();
          resolve(meta);
        } catch (err) {
          reject(err as Error);
        }
      };

      this.file!.onError = (_module: string, message: string) => {
        reject(new Error(`Demuxer: mp4box error: ${message}`));
      };

      this.file!.onSamples = (_id: number, _user: unknown, batch: Sample[]) => {
        // We only need (offset, size) plus timestamps — the raw NAL
        // bytes (`s.data`) live in mp4box's `MultiBufferStream` and
        // will be released wholesale when we drop the `file` ref in
        // `finalizeIndex()`. Range-fetching on demand is how the pump
        // gets bytes after that point.
        for (const s of batch) {
          this.samples.push({
            index: s.number,
            ptsUs: Math.round((s.cts / s.timescale) * 1e6),
            dtsUs: Math.round((s.dts / s.timescale) * 1e6),
            durationUs: Math.round((s.duration / s.timescale) * 1e6),
            keyframe: s.is_sync,
            byteOffset: s.offset,
            byteSize: s.size,
          });
        }
        if (this.trackMeta && this.samples.length >= this.trackMeta.nbSamples) {
          this.samples.sort((a, b) => a.index - b.index);
          // Build the block index synchronously so anyone awaiting
          // `ensureSamplesLoaded()` sees a usable demuxer immediately.
          // Defer the mp4box buffer-chain teardown to a microtask
          // because we're still inside mp4box's own onSamples
          // callstack — mutating `this.file` (releaseUsedSamples /
          // stop / null) from inside its iteration is asking for
          // trouble.
          this.buildBlockIndex();
          this.allSamplesResolve();
          queueMicrotask(() => this.releaseMp4box());
        }
      };
    });
  }

  async open(): Promise<VideoTrackMeta> {
    if (!this.streamingStarted) {
      this.streamingStarted = true;
      void this.streamFile().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`Demuxer streamFile failed for ${this.assetUrl}`, err);
        this.file?.onError?.("streamFile", String(err));
      });
    }
    return this.readyP;
  }

  async ensureSamplesLoaded(): Promise<void> {
    await this.readyP;
    return this.allSamplesP;
  }

  /// Metadata-only lookup. Returns the sample's timestamps + byte
  /// offset/size, NEVER null unless `index` is out of range, and
  /// NEVER triggers a Range fetch. Use this when you only need PTS
  /// (e.g. the decoder pool's backward-seek reset check) so the
  /// pump's data-fetching path stays the sole driver of block
  /// fetches.
  sampleMetaAt(index: number): IndexedSampleMeta | null {
    if (index < 0 || index >= this.samples.length) return null;
    return this.samples[index]!;
  }

  /// Look up sample `index`. Returns null if the index is out of
  /// range OR the containing GOP block's bytes aren't currently
  /// resident (in which case a Range fetch is fired and the caller
  /// is expected to retry on the next pump tick). Non-null returns
  /// carry a `data` view into the resident block bytes; the pump
  /// constructs an `EncodedVideoChunk` from it immediately so the
  /// view doesn't need to outlive this rAF.
  sampleAt(index: number): IndexedSample | null {
    if (index < 0 || index >= this.samples.length) return null;
    const meta = this.samples[index]!;
    const blockId = this.blockBySampleIdx[index]!;
    const blockBytes = this.blockCache.get(blockId);
    if (!blockBytes) {
      // Miss: schedule the fetch and let the pump retry on the next
      // tick. Also prefetch the next block to keep the pump fed
      // across GOP boundaries without an extra round-trip every
      // source-second.
      void this.fetchBlock(blockId);
      if (blockId + 1 < this.blocks.length) {
        void this.fetchBlock(blockId + 1);
      }
      return null;
    }
    // LRU touch: re-insert moves this entry to the most-recent end.
    this.blockCache.delete(blockId);
    this.blockCache.set(blockId, blockBytes);
    const block = this.blocks[blockId]!;
    const offsetWithinBlock = meta.byteOffset - block.byteOffset;
    const data = new Uint8Array(
      blockBytes.buffer,
      blockBytes.byteOffset + offsetWithinBlock,
      meta.byteSize,
    );
    return {
      index: meta.index,
      ptsUs: meta.ptsUs,
      dtsUs: meta.dtsUs,
      durationUs: meta.durationUs,
      keyframe: meta.keyframe,
      data,
    };
  }

  idrAtOrBefore(targetIndex: number): number {
    if (this.blocks.length === 0) return 0;
    const blockId = this.blockBySampleIdx[
      Math.min(Math.max(0, targetIndex), this.samples.length - 1)
    ];
    if (blockId === undefined) return 0;
    return this.blocks[blockId]!.firstSampleIdx;
  }

  sampleIndexForPtsUs(tUs: number): number {
    if (this.samples.length === 0) return 0;
    if (tUs <= 0) return 0;
    let lo = 0;
    let hi = this.samples.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.samples[mid]!;
      if (s.ptsUs <= tUs && tUs < s.ptsUs + s.durationUs) {
        return mid;
      }
      if (s.ptsUs > tUs) hi = mid - 1;
      else lo = mid + 1;
    }
    return Math.min(Math.max(0, lo - 1), this.samples.length - 1);
  }

  trackMetaOrThrow(): VideoTrackMeta {
    if (!this.trackMeta) throw new Error("Demuxer: open() not awaited");
    return this.trackMeta;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    try {
      this.file?.stop();
    } catch {
      // ignore
    }
    this.file = null;
    this.samples = [];
    this.blocks = [];
    this.blockBySampleIdx = new Uint32Array(0);
    this.blockCache.clear();
    this.blockInFlight.clear();
  }

  // ============================================================
  // private
  // ============================================================

  /// Stream the proxy into mp4box, chunk by chunk. We never construct
  /// a single ArrayBuffer the size of the whole file in our scope —
  /// each ~16–64 KB stream chunk is wrapped in an MP4BoxBuffer with
  /// the right `fileStart` offset and forwarded into mp4box. mp4box's
  /// `MultiBufferStream` concatenates them internally for parsing.
  /// When we drop the file ref in `finalizeIndex()`, those internals
  /// GC together.
  private async streamFile(): Promise<void> {
    const res = await fetch(this.assetUrl, { signal: this.abortController.signal });
    if (!res.ok) {
      throw new Error(`Demuxer: fetch ${this.assetUrl} → ${res.status}`);
    }
    if (!res.body) {
      // Some implementations don't expose `body` (older WebView2
      // builds) — fall back to the one-shot load. Marginally more
      // heap during init; same end state once `finalizeIndex` drops
      // the file ref.
      const buf = await res.arrayBuffer();
      this.feedMp4box(buf, 0, true);
      return;
    }
    const reader = res.body.getReader();
    let fileOffset = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (this.disposed) {
        await reader.cancel();
        return;
      }
      // `value.buffer` may be a shared underlying buffer the stream
      // reader recycles. Slice into a fresh ArrayBuffer so mp4box's
      // long-lived references to this chunk stay valid until we
      // drop the file ref.
      const own = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      );
      this.feedMp4box(own, fileOffset, false);
      fileOffset += value.byteLength;
    }
    // Trailing zero-length appendBuffer with `last=true` is mp4box's
    // signal to finish processing. Without it, the last partial box
    // is left unparsed.
    this.feedMp4box(new ArrayBuffer(0), fileOffset, true);
    this.file?.flush();
  }

  /// Wraps the appendBuffer + fileStart bookkeeping. Guarded against
  /// post-dispose calls so a late stream chunk doesn't crash on a
  /// nulled file ref.
  private feedMp4box(buf: ArrayBuffer, fileStart: number, isLast: boolean): void {
    if (this.disposed || !this.file) return;
    const mp4buf = MP4BoxBuffer.fromArrayBuffer(buf, fileStart);
    this.file.appendBuffer(mp4buf, isLast);
  }

  /// Bucket samples into GOP-aligned blocks. Each block starts at an
  /// IDR (`keyframe === true`); proxy v4 GOP is one source-second
  /// (`-g <round(fps)>`) so blocks are small + uniform. On
  /// pathological streams without keyframes we degrade to one giant
  /// block + slow seeks, which is the best we can do without the
  /// encoder cooperating. Pure data work — safe to call inside an
  /// `onSamples` callstack.
  private buildBlockIndex(): void {
    this.blocks = [];
    this.blockBySampleIdx = new Uint32Array(this.samples.length);
    let i = 0;
    while (i < this.samples.length) {
      const start = i;
      const first = this.samples[start]!;
      const byteOffset = first.byteOffset;
      i++;
      while (i < this.samples.length && !this.samples[i]!.keyframe) i++;
      const lastInBlock = this.samples[i - 1]!;
      const byteSize = lastInBlock.byteOffset + lastInBlock.byteSize - byteOffset;
      const blockId = this.blocks.length;
      this.blocks.push({
        firstSampleIdx: start,
        sampleCount: i - start,
        byteOffset,
        byteSize,
      });
      for (let j = start; j < i; j++) this.blockBySampleIdx[j] = blockId;
    }
  }

  /// Release mp4box's sample-table + internal buffer chain. Called as
  /// a deferred microtask AFTER the on-samples completion so we don't
  /// mutate `this.file` while we're inside mp4box's own callstack.
  /// This is the actual "free 500 MB" step — the rest of the file
  /// (`buildBlockIndex` etc.) is just bookkeeping.
  private releaseMp4box(): void {
    if (this.disposed || !this.file) return;
    if (this.trackIdForExtraction > 0 && this.samples.length > 0) {
      try {
        this.file.releaseUsedSamples(this.trackIdForExtraction, this.samples.length - 1);
      } catch {
        // Older mp4box variants may not implement this; harmless.
      }
    }
    try {
      this.file.stop();
    } catch {
      // ignore
    }
    // Drop the file ref so the parse leftovers can GC. After this
    // point we'll only ever go back to the proxy via Range fetches.
    this.file = null;
  }

  /// Fetch (or join an in-flight fetch for) a single GOP block via a
  /// `Range` request. Inserts the bytes into the LRU cache on
  /// success; the in-flight promise is held so concurrent pumps for
  /// the same block coalesce.
  private async fetchBlock(blockId: number): Promise<void> {
    if (this.disposed) return;
    if (this.blockCache.has(blockId)) return;
    const inFlight = this.blockInFlight.get(blockId);
    if (inFlight) return inFlight;
    const block = this.blocks[blockId];
    if (!block) return;
    const p = (async () => {
      try {
        const rangeStart = block.byteOffset;
        const rangeEnd = block.byteOffset + block.byteSize - 1;
        const res = await fetch(this.assetUrl, {
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
          signal: this.abortController.signal,
        });
        // Most servers reply 206 Partial Content for honored Range
        // requests. A 200 means the server returned the FULL file —
        // we still trust the slice we wanted to be at the same
        // offset, but log loudly because that's a sign the asset
        // handler isn't honoring Range and our heap savings won't
        // materialize.
        if (res.status === 200) {
          // eslint-disable-next-line no-console
          console.warn(
            `[weftcut/pixi] Range request returned 200 (full file) for ${this.assetUrl}; ` +
              `asset handler may not honor Range — heap will stay high.`,
          );
        } else if (res.status !== 206) {
          throw new Error(`block ${blockId} fetch: status ${res.status}`);
        }
        if (this.disposed) return;
        const buf = await res.arrayBuffer();
        // For the 200 fallback case, slice the requested window out
        // of the full file. For 206 the body is already the slice.
        let bytes: Uint8Array;
        if (res.status === 200) {
          bytes = new Uint8Array(buf, rangeStart, block.byteSize);
        } else {
          bytes = new Uint8Array(buf);
        }
        if (bytes.byteLength !== block.byteSize) {
          // eslint-disable-next-line no-console
          console.warn(
            `[weftcut/pixi] block ${blockId} got ${bytes.byteLength}B, ` +
              `expected ${block.byteSize}B`,
          );
        }
        this.blockCache.set(blockId, bytes);
        // Evict oldest entries (insertion order) past the cap.
        while (this.blockCache.size > BLOCK_CACHE_CAP) {
          const oldest = this.blockCache.keys().next().value;
          if (oldest === undefined) break;
          this.blockCache.delete(oldest);
        }
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        // eslint-disable-next-line no-console
        console.warn(`[weftcut/pixi] block ${blockId} fetch failed:`, e);
      } finally {
        this.blockInFlight.delete(blockId);
      }
    })();
    this.blockInFlight.set(blockId, p);
    return p;
  }

  private extractDescription(track: Track): Uint8Array {
    if (!this.file) throw new Error("Demuxer: file released before description extract");
    const t = this.file.getTrackById(track.id);
    if (!t) throw new Error(`Demuxer: no trakBox ${track.id}`);
    const entries = t.mdia?.minf?.stbl?.stsd?.entries;
    if (!entries || entries.length === 0) {
      throw new Error(
        `Demuxer: track ${track.id} has no stsd entries; codec=${track.codec}`,
      );
    }
    // SampleEntry subclasses (avc1SampleEntry, hvc1SampleEntry, etc.)
    // expose the codec config box as a property. mp4box's typed
    // entries don't share a base for this — cast to the structural
    // shape we actually need.
    const entry = entries[0] as unknown as SampleEntryWithConfig;
    const cfg = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (!cfg) {
      throw new Error(
        `Demuxer: track ${track.id} stsd entry has no avcC / hvcC / vpcC / av1C; codec=${track.codec}`,
      );
    }
    // Allocate a buffer for the box's serialized bytes. The exact
    // size depends on the box; 4096 is comfortably large for any
    // avcC / hvcC / vpcC.
    const stream = new DataStream(new MP4BoxBuffer(4096));
    cfg.write(stream);
    // mp4box's box.write() packs an 8-byte box header (size + type)
    // before the payload; VideoDecoder wants only the payload bytes.
    // `stream.position` is the byte count actually written.
    const written = (stream as unknown as { position: number }).position;
    return new Uint8Array(stream.buffer, 8, Math.max(0, written - 8));
  }
}
