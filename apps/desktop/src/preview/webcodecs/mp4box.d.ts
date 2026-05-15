// Minimal ambient types for the `mp4box` package. The upstream package
// has no maintained TypeScript definitions, so we type only the surface
// the WebCodecs decoder substrate (B1+) actually uses.
declare module "mp4box" {
  export interface MP4Sample {
    /// Composition time (in `timescale` units).
    cts: number;
    /// Sample duration (in `timescale` units).
    duration: number;
    /// Timescale of this track (ticks per second).
    timescale: number;
    /// Whether this sample is a keyframe (IDR for H.264).
    is_sync: boolean;
    /// Raw compressed sample bytes (NAL units in AVCC format for H.264).
    data: ArrayBuffer;
  }

  export interface MP4VideoTrack {
    id: number;
    /// Full ISO BMFF codec string, e.g. "avc1.640028".
    codec: string;
    timescale: number;
    track_width: number;
    track_height: number;
    duration: number;
    nb_samples: number;
    video?: { width: number; height: number };
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    videoTracks: MP4VideoTrack[];
    audioTracks: unknown[];
  }

  /// `mp4box` only exposes a structural box at runtime; the bits we
  /// care about (avcC / hvcC / vpcC / av1C) all share a `write()` method
  /// that serializes into a DataStream-compatible sink.
  export interface MP4BoxBox {
    write(stream: DataStream): void;
  }

  export interface MP4Entry {
    avcC?: MP4BoxBox;
    hvcC?: MP4BoxBox;
    vpcC?: MP4BoxBox;
    av1C?: MP4BoxBox;
  }

  export interface MP4Trak {
    mdia: {
      minf: {
        stbl: {
          stsd: { entries: MP4Entry[] };
        };
      };
    };
  }

  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }

  export interface MP4File {
    onReady: (info: MP4Info) => void;
    onError: (msg: string) => void;
    onSamples: (
      trackId: number,
      user: unknown,
      samples: MP4Sample[],
    ) => void;
    appendBuffer(buf: MP4ArrayBuffer): number;
    flush(): void;
    start(): void;
    stop(): void;
    setExtractionOptions(
      trackId: number,
      user: unknown,
      options: { nbSamples: number },
    ): void;
    getTrackById(trackId: number): MP4Trak;
  }

  /// mp4box exposes its own little binary writer (used by box.write()).
  export class DataStream {
    static BIG_ENDIAN: number;
    static LITTLE_ENDIAN: number;
    buffer: ArrayBuffer;
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: number);
  }

  const MP4Box: {
    createFile(): MP4File;
    DataStream: typeof DataStream;
  };
  export default MP4Box;
}
