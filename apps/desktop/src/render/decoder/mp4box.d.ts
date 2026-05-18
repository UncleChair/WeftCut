// Minimal typing shim for mp4box.js — the upstream package ships
// without TypeScript types and the bits we use are stable.
//
// Plan: docs/pixi-renderer-plan.md (P1 — mp4box.js demux)

declare module "mp4box" {
  export interface MP4VideoTrackInfo {
    id: number;
    codec: string;
    movie_duration: number;
    movie_timescale: number;
    timescale: number;
    duration: number;
    nb_samples: number;
    video: {
      width: number;
      height: number;
    };
  }

  export interface MP4AudioTrackInfo {
    id: number;
    codec: string;
    movie_duration: number;
    movie_timescale: number;
    timescale: number;
    duration: number;
    nb_samples: number;
    audio: {
      sample_rate: number;
      channel_count: number;
      sample_size: number;
    };
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    fragment_duration?: number;
    isProgressive: boolean;
    hasIOD: boolean;
    brands: string[];
    created: Date;
    modified: Date;
    videoTracks: MP4VideoTrackInfo[];
    audioTracks: MP4AudioTrackInfo[];
    tracks: Array<MP4VideoTrackInfo | MP4AudioTrackInfo>;
  }

  export interface MP4Sample {
    number: number;
    track_id: number;
    timescale: number;
    description: unknown;
    is_rap: boolean;
    is_sync: boolean;
    cts: number;
    dts: number;
    duration: number;
    size: number;
    data: Uint8Array;
  }

  export interface MP4ExtractionOptions {
    nbSamples?: number;
    rapAlignement?: boolean;
  }

  /// Subset of the `box.write(stream)` family we use for extradata.
  export interface MP4DataStream {
    buffer: ArrayBuffer;
  }

  /// Shape of a track returned by `file.getTrackById`. We only need
  /// the avcC / hvcC / vpcC boxes' write() method to extract codec
  /// extradata for VideoDecoder.configure({ description }).
  export interface MP4Track {
    avcC?: { write(s: MP4DataStream): void };
    hvcC?: { write(s: MP4DataStream): void };
    vpcC?: { write(s: MP4DataStream): void };
  }

  export class DataStream {
    constructor(arrayBuffer?: ArrayBuffer | number, byteOffset?: number, endianness?: number);
    static LITTLE_ENDIAN: number;
    static BIG_ENDIAN: number;
    buffer: ArrayBuffer;
    endianness: number;
    position: number;
  }

  export interface ExtendedArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }

  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (err: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(data: ExtendedArrayBuffer): number;
    flush(): void;
    setExtractionOptions(trackId: number, user: unknown, opts?: MP4ExtractionOptions): void;
    start(): void;
    stop(): void;
    getTrackById(id: number): MP4Track | undefined;
    releaseUsedSamples(trackId: number, sampleNumber: number): void;
  }

  export function createFile(): MP4File;
  // Some bundles re-export createFile under the `MP4Box` namespace.
  export const MP4Box: { createFile(): MP4File };
}
