// mp4box.js (v2.x) demuxer wrapper. Reads a master proxy file from
// `asset://`, extracts the H.264 track's parameter sets + sample
// table, and emits `EncodedVideoChunk`s on demand for the decoder.
//
// Plan: docs/pixi-renderer-plan.md (P1)
//
// mp4box 2.x is a different package than 0.5.x: it ships with its own
// TypeScript types, uses an `MP4BoxBuffer` wrapper around `ArrayBuffer`
// (replacing the old "set `fileStart` on a raw ArrayBuffer" trick),
// and exposes the track box hierarchy via typed box classes. The
// codec config box (avcC / hvcC / vpcC) lives nested under
// `trakBox.mdia.minf.stbl.stsd.entries[0]` and the entry classes
// expose it as a property under the same name.

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

/// One indexed sample plus the timestamps in microseconds.
export interface IndexedSample {
  index: number;
  ptsUs: number;
  dtsUs: number;
  durationUs: number;
  keyframe: boolean;
  /// Raw NAL data, owned (copied off mp4box's reused buffer).
  data: Uint8Array;
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

export class Demuxer {
  private file: ISOFile;
  private assetUrl: string;
  private readyP: Promise<VideoTrackMeta>;
  private samples: IndexedSample[] = [];
  private allSamplesP: Promise<void>;
  private allSamplesResolve!: () => void;
  private trackMeta: VideoTrackMeta | null = null;
  private disposed = false;
  private streamingStarted = false;
  /// The whole fetched proxy file, kept alive so per-sample `data`
  /// views into it (`new Uint8Array(buffer, offset, size)`) stay
  /// valid. Without this reference we had to `new Uint8Array(s.data)`
  /// copy every sample's NAL bytes, doubling heap residency for the
  /// proxy. For a 30-minute 1080p CRF22 proxy that's ~500 MB saved.
  /// Released only on `dispose()`.
  private proxyBuffer: ArrayBuffer | null = null;

  constructor(init: DemuxerInit) {
    this.assetUrl = init.assetUrl;
    this.file = createFile();
    this.allSamplesP = new Promise<void>((res) => {
      this.allSamplesResolve = res;
    });

    this.readyP = new Promise<VideoTrackMeta>((resolve, reject) => {
      this.file.onReady = (info: Movie) => {
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
          this.file.setExtractionOptions(videoTrack.id, null, { nbSamples: 100 });
          this.file.start();
          resolve(meta);
        } catch (err) {
          reject(err as Error);
        }
      };

      this.file.onError = (err: string) => {
        reject(new Error(`Demuxer: mp4box error: ${err}`));
      };

      this.file.onSamples = (_id: number, _user: unknown, batch: Sample[]) => {
        const buf = this.proxyBuffer;
        for (const s of batch) {
          // Prefer a zero-copy view into the shared proxy buffer. The
          // raw NAL bytes for sample N sit at `[s.offset, s.offset+s.size)`
          // in the source file; since `streamFile` appends with
          // `fileStart=0`, file offset = buffer offset. Falls back to
          // the (defensive) copy path only if the offsets don't fit
          // the buffer — that shouldn't happen for a fully-fetched
          // proxy, but if mp4box's box parser ever changed how it
          // reports offsets we'd rather emit safe (slower) bytes than
          // throw mid-render.
          let data: Uint8Array;
          if (buf && s.offset + s.size <= buf.byteLength) {
            data = new Uint8Array(buf, s.offset, s.size);
          } else {
            const src = s.data ?? new Uint8Array(0);
            data = new Uint8Array(src);
          }
          this.samples.push({
            index: s.number,
            ptsUs: Math.round((s.cts / s.timescale) * 1e6),
            dtsUs: Math.round((s.dts / s.timescale) * 1e6),
            durationUs: Math.round((s.duration / s.timescale) * 1e6),
            keyframe: s.is_sync,
            data,
          });
        }
        if (this.trackMeta && this.samples.length >= this.trackMeta.nbSamples) {
          this.samples.sort((a, b) => a.index - b.index);
          this.allSamplesResolve();
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
        this.file.onError?.(String(err));
      });
    }
    return this.readyP;
  }

  async ensureSamplesLoaded(): Promise<void> {
    await this.readyP;
    return this.allSamplesP;
  }

  sampleAt(index: number): IndexedSample | null {
    return this.samples[index] ?? null;
  }

  idrAtOrBefore(targetIndex: number): number {
    for (let i = Math.min(targetIndex, this.samples.length - 1); i >= 0; i--) {
      const s = this.samples[i];
      if (s && s.keyframe) return i;
    }
    return 0;
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
    try {
      this.file.stop();
    } catch {
      // ignore
    }
    this.samples = [];
    // Release the proxy ArrayBuffer last — sample `data` views
    // pointed into it, so dropping their owning entries first is
    // required (above) before this reference can be cleared. The
    // VideoDecoder side already closes any in-flight chunks during
    // its own teardown.
    this.proxyBuffer = null;
  }

  // ============================================================
  // private
  // ============================================================

  private async streamFile(): Promise<void> {
    const res = await fetch(this.assetUrl);
    if (!res.ok) {
      throw new Error(`Demuxer: fetch ${this.assetUrl} → ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    // Stash BEFORE the synchronous `appendBuffer` / `flush` below —
    // mp4box drives `onReady` and `onSamples` synchronously during
    // those calls, and `onSamples` reads `this.proxyBuffer` to build
    // zero-copy NAL views into it.
    this.proxyBuffer = buf;
    // mp4box 2.x requires MP4BoxBuffer (ArrayBuffer subclass with a
    // `fileStart` field).
    const mp4buf = MP4BoxBuffer.fromArrayBuffer(buf, 0);
    this.file.appendBuffer(mp4buf, /*last=*/ true);
    this.file.flush();
  }

  private extractDescription(track: Track): Uint8Array {
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
