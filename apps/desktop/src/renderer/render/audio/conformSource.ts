// Range-reads over a VCONF conform file served via asset://. No decode —
// the file IS the samples (48 kHz f32le interleaved; header per
// `src-tauri/src/jobs/conform.rs`). Loop-read discipline per the asset://
// ~1 MB 206 cap: a single Range response may come back short, so reads
// re-issue until the exact byte count arrives (same rule as
// `AssetRangeSource`).

export interface ConformHeader {
  version: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
}

export const CONFORM_HEADER_LEN = 28;

export class ConformSource {
  private constructor(
    readonly url: string,
    readonly header: ConformHeader,
  ) {}

  static async open(url: string): Promise<ConformSource> {
    const head = await rangeRead(url, 0, CONFORM_HEADER_LEN);
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const magic = new TextDecoder().decode(head.subarray(0, 5));
    if (magic !== "VCONF") throw new Error(`bad conform magic at ${url}`);
    const header: ConformHeader = {
      version: dv.getUint32(8, true),
      sampleRate: dv.getUint32(12, true),
      channels: dv.getUint32(16, true),
      frameCount: Number(dv.getBigUint64(20, true)),
    };
    if (header.version !== 1) {
      throw new Error(`unsupported conform version ${header.version}`);
    }
    if (header.channels < 1 || header.channels > 2) {
      throw new Error(`conform channels ${header.channels} out of range`);
    }
    return new ConformSource(url, header);
  }

  /// Read `frameCount` frames starting at `startFrame` (may be negative or
  /// run past EOF — out-of-range portions are zero-filled silence),
  /// de-interleaved into one Float32Array per channel. Explicit
  /// `ArrayBuffer` backing so `AudioBuffer.copyToChannel`'s strict
  /// `Float32Array<ArrayBuffer>` overload accepts the result.
  async readWindow(
    startFrame: number,
    frameCount: number,
  ): Promise<Float32Array<ArrayBuffer>[]> {
    const ch = this.header.channels;
    const out = Array.from(
      { length: ch },
      () => new Float32Array(new ArrayBuffer(frameCount * 4)),
    );
    const total = this.header.frameCount;
    const readStart = Math.min(Math.max(startFrame, 0), total);
    const readEnd = Math.min(Math.max(startFrame + frameCount, 0), total);
    if (readEnd <= readStart) return out;
    const bytes = await rangeRead(
      this.url,
      CONFORM_HEADER_LEN + readStart * ch * 4,
      (readEnd - readStart) * ch * 4,
    );
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dstOff = readStart - startFrame;
    const n = readEnd - readStart;
    for (let f = 0; f < n; f++) {
      for (let c = 0; c < ch; c++) {
        out[c]![dstOff + f] = dv.getFloat32((f * ch + c) * 4, true);
      }
    }
    return out;
  }
}

/// Loop until exactly `len` bytes arrive — a single asset:// 206 caps at
/// ~1 MB and a short read would otherwise hand consumers truncated data.
async function rangeRead(
  url: string,
  offset: number,
  len: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(len);
  let got = 0;
  while (got < len) {
    const start = offset + got;
    const end = offset + len - 1;
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`conform range read failed: HTTP ${res.status}`);
    }
    const chunk = new Uint8Array(await res.arrayBuffer());
    if (chunk.byteLength === 0) {
      throw new Error("conform range read returned 0 bytes");
    }
    const take = Math.min(chunk.byteLength, len - got);
    out.set(chunk.subarray(0, take), got);
    got += take;
  }
  return out;
}
