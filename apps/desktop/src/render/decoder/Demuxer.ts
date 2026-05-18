// mp4box.js demuxer wrapper. Reads a master proxy file from
// `asset://`, extracts the H.264 track's parameter sets + sample
// table, and emits `EncodedVideoChunk`s on demand for the decoder.
//
// Plan: docs/pixi-renderer-plan.md (P1)

// P0 stub — implementation lands in P1.

export interface DemuxerInit {
  /// `asset://` URL of the master proxy MP4 (1080p H.264 1s-GOP).
  assetUrl: string;
}

export interface SampleRange {
  /// First sample index (inclusive).
  start: number;
  /// Last sample index (exclusive).
  end: number;
}

export class Demuxer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_init: DemuxerInit) {
    // P1: mp4box.MP4File, ArrayBuffer streaming, onReady/onSamples
    // wiring, codec extradata extraction.
  }

  async open(): Promise<void> {
    throw new Error("Demuxer.open: not yet implemented (P1)");
  }

  /// Synchronously read sample at index. Returns null if out of range.
  /// P1: backed by an internal sample cache populated by mp4box's
  /// `onSamples` callback.
  sampleAt(_index: number): EncodedVideoChunk | null {
    return null;
  }

  /// Find the largest sample index with IDR ≤ targetSample.
  /// Used by scrub to seek to the nearest GOP boundary.
  idrBefore(_targetSample: number): number {
    return 0;
  }

  dispose(): void {
    // P1: release ArrayBuffer references, abort fetch.
  }
}
