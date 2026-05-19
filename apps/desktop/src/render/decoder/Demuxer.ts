// mp4box.js demuxer wrapper. Reads a master proxy file from `asset://`,
// extracts the H.264 track's parameter sets + sample table, and emits
// `EncodedVideoChunk`s on demand for the decoder.
//
// Plan: docs/pixi-renderer-plan.md (P1)

import { createFile, type MP4File, type MP4Info, type MP4Sample, type MP4VideoTrackInfo, type ExtendedArrayBuffer, DataStream } from "mp4box";

export interface DemuxerInit {
  /// `asset://` URL of the master proxy MP4 (1080p H.264 1 s-GOP).
  assetUrl: string;
}

/// One indexed sample plus the timestamps in microseconds. We hold
/// `EncodedVideoChunk`-shaped data plus an `is_sync` (IDR) bit so the
/// decoder pump can seek to the nearest GOP boundary without
/// re-parsing.
export interface IndexedSample {
  /// Sample index in the track's sample table.
  index: number;
  /// Composition time in microseconds.
  ptsUs: number;
  /// Decode time in microseconds.
  dtsUs: number;
  /// Sample duration in microseconds.
  durationUs: number;
  /// IDR / sync sample flag.
  keyframe: boolean;
  /// Raw NAL data, owned. The mp4box.js sample's `data` Uint8Array is
  /// reused across `onSamples` callbacks; we copy.
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
  /// Total sample count.
  nbSamples: number;
  /// Track timescale (ticks per second).
  timescale: number;
}

export class Demuxer {
  private file: MP4File;
  private assetUrl: string;
  /// Promise resolved when `onReady` has fired and we have the track
  /// metadata + first extraction batch queued.
  private readyP: Promise<VideoTrackMeta>;
  /// Pre-sorted by sample index. Populated lazily by `onSamples`
  /// callbacks; `ensureSamplesLoaded` waits until all sample callbacks
  /// have fired.
  private samples: IndexedSample[] = [];
  /// Resolved once every sample has been parsed (after `flush`).
  private allSamplesP: Promise<void>;
  private allSamplesResolve!: () => void;
  private trackMeta: VideoTrackMeta | null = null;
  private disposed = false;
  /// Idempotency guard for `open()` — multiple callers awaiting the
  /// same readyP must not each trigger another fetch.
  private streamingStarted = false;

  constructor(init: DemuxerInit) {
    this.assetUrl = init.assetUrl;
    this.file = createFile();
    this.allSamplesP = new Promise<void>((res) => {
      this.allSamplesResolve = res;
    });

    this.readyP = new Promise<VideoTrackMeta>((resolve, reject) => {
      this.file.onReady = (info: MP4Info) => {
        try {
          const videoTrack = info.videoTracks[0];
          if (!videoTrack) {
            reject(new Error("Demuxer: no video track found"));
            return;
          }
          const description = this.extractDescription(videoTrack);
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
          reject(err);
        }
      };

      this.file.onError = (err: string) => {
        reject(new Error(`Demuxer: mp4box error: ${err}`));
      };

      this.file.onSamples = (_id, _user, batch: MP4SampleArray) => {
        for (const s of batch) {
          this.samples.push({
            index: s.number,
            ptsUs: Math.round((s.cts / s.timescale) * 1e6),
            dtsUs: Math.round((s.dts / s.timescale) * 1e6),
            durationUs: Math.round((s.duration / s.timescale) * 1e6),
            keyframe: s.is_sync,
            data: s.data.slice(),
          });
        }
        if (this.trackMeta && this.samples.length >= this.trackMeta.nbSamples) {
          // Sort defensively — mp4box callbacks land in roughly
          // sample-table order but we want absolute determinism.
          this.samples.sort((a, b) => a.index - b.index);
          this.allSamplesResolve();
        }
      };
    });
  }

  /// Resolve once track metadata is parsed. Triggers the fetch on the
  /// first call; subsequent calls share the in-flight `readyP`.
  async open(): Promise<VideoTrackMeta> {
    if (!this.streamingStarted) {
      this.streamingStarted = true;
      void this.streamFile().catch((err) => {
        // Surface as an mp4box error so `onError` rejects readyP.
        // eslint-disable-next-line no-console
        console.error(`Demuxer streamFile failed for ${this.assetUrl}`, err);
        this.file.onError?.(String(err));
      });
    }
    return this.readyP;
  }

  /// Resolve once every sample has been parsed. Used by callers that
  /// need random access (scrub).
  async ensureSamplesLoaded(): Promise<void> {
    await this.readyP;
    return this.allSamplesP;
  }

  /// Synchronous sample lookup by index. Returns null if out of range
  /// or samples haven't been parsed yet (caller should `await
  /// ensureSamplesLoaded()` first).
  sampleAt(index: number): IndexedSample | null {
    return this.samples[index] ?? null;
  }

  /// Find the largest sample index with IDR ≤ targetIndex.
  idrAtOrBefore(targetIndex: number): number {
    for (let i = Math.min(targetIndex, this.samples.length - 1); i >= 0; i--) {
      const s = this.samples[i];
      if (s && s.keyframe) return i;
    }
    return 0;
  }

  /// Translate a composition time to the nearest sample index whose
  /// PTS interval contains it. Linear scan; cheap given <30k samples
  /// per master proxy at typical lengths.
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
    this.file.stop();
    this.samples = [];
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
    // mp4box expects `fileStart` to be set on the appended buffer.
    const eab = buf as ExtendedArrayBuffer;
    eab.fileStart = 0;
    this.file.appendBuffer(eab);
    this.file.flush();
  }

  private extractDescription(track: MP4VideoTrackInfo): Uint8Array {
    const t = this.file.getTrackById(track.id);
    if (!t) throw new Error(`Demuxer: no track ${track.id}`);
    // mp4box stores the codec config in the sample-description box:
    //   trak.mdia.minf.stbl.stsd.entries[0].(avcC | hvcC | vpcC)
    // The track object itself does NOT expose these as direct fields.
    const entries = t.mdia?.minf?.stbl?.stsd?.entries;
    if (!entries || entries.length === 0) {
      throw new Error(
        `Demuxer: track ${track.id} has no stsd entries; codec=${track.codec}`,
      );
    }
    const entry = entries[0]!;
    const cfg = entry.avcC ?? entry.hvcC ?? entry.vpcC;
    if (!cfg) {
      throw new Error(
        `Demuxer: track ${track.id} stsd entry has no avcC / hvcC / vpcC; codec=${track.codec}`,
      );
    }
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    cfg.write(stream);
    // mp4box's DataStream packs the box header before the payload;
    // VideoDecoder wants only the payload (avcC contents), so skip
    // the 8-byte box header (size:4 + type:4).
    return new Uint8Array(stream.buffer, 8);
  }
}

/// mp4box.js types samples as `MP4Sample[]`; alias kept local for
/// readability against the verbose generic name in `onSamples`.
type MP4SampleArray = MP4Sample[];
