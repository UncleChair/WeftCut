// mediabunny CustomSource adapter over the `weftcut-media://` Range protocol. Maps
// mediabunny's read(start,end) / getSize() onto HTTP Range requests so the
// whole file is never loaded — preserving the long-video heap budget. Owns an
// AbortController so disposing the Input cancels in-flight reads.
//
// mediabunny's read range is half-open [start, end) (0 <= start < end <
// fileSize); HTTP Range is inclusive, hence `bytes=start-(end-1)`. The Plan A
// fixture-parse test confirms this off-by-one empirically.

import { CustomSource, type CustomSourceOptions } from "mediabunny";

export class MediaRangeSource {
  private readonly mediaUrl: string;
  private readonly abort = new AbortController();
  /// The mediabunny CustomSource — pass `.source` to `new Input({ source })`.
  readonly source: CustomSource;
  /// Exposed for unit tests; production code uses `.source`.
  readonly options: CustomSourceOptions;

  constructor(mediaUrl: string) {
    this.mediaUrl = mediaUrl;
    this.options = {
      getSize: () => this.getSize(),
      read: (start, end) => this.read(start, end),
      dispose: () => this.dispose(),
      // Match the resident budget of the legacy GOP-block LRU (~a few source
      // seconds). Network-style prefetch suits weftcut-media:// latency.
      maxCacheSize: 16 * 1024 * 1024,
      prefetchProfile: "network",
    };
    this.source = new CustomSource(this.options);
  }

  dispose(): void {
    if (!this.abort.signal.aborted) this.abort.abort();
  }

  private async getSize(): Promise<number> {
    const res = await fetch(this.mediaUrl, {
      headers: { Range: "bytes=0-0" },
      signal: this.abort.signal,
    });
    const cr = res.headers.get("Content-Range"); // "bytes 0-0/<total>"
    const total = cr?.split("/")[1];
    if (total && total !== "*") return Number.parseInt(total, 10);
    const cl = res.headers.get("Content-Length");
    if (cl) return Number.parseInt(cl, 10);
    throw new Error(`MediaRangeSource: no size for ${this.mediaUrl}`);
  }

  private async read(start: number, end: number): Promise<Uint8Array> {
    // mediabunny's CustomSource contract requires `read` to return EXACTLY
    // `end - start` bytes. The weftcut-media:// Range handler caps
    // each 206 body at a fixed ceiling (~1 MB observed), so a single request
    // for a larger window comes back short — and mediabunny throws
    // "Requested N bytes, but got M", wedging the decoder. Loop across
    // follow-up Range requests for the remaining tail until the window is
    // filled. (The legacy mp4box demuxer never hit this because its GOP-block
    // cache issued bounded sub-ceiling reads.)
    const total = end - start;
    const out = new Uint8Array(total);
    let filled = 0;
    while (filled < total) {
      const res = await fetch(this.mediaUrl, {
        // inclusive HTTP range; re-anchored at the unfilled tail each pass
        headers: { Range: `bytes=${start + filled}-${end - 1}` },
        signal: this.abort.signal,
      });
      // 200 → server ignored Range and returned the whole file; slice the
      // window and we're done (no partial-response ceiling applies).
      if (res.status === 200) {
        return new Uint8Array(await res.arrayBuffer()).slice(start, end);
      }
      const chunk = new Uint8Array(await res.arrayBuffer());
      if (chunk.byteLength === 0) {
        // No progress possible — fail loudly rather than hand mediabunny a
        // short buffer (which surfaces as its opaque length-mismatch throw).
        throw new Error(
          `MediaRangeSource: short read for ${this.mediaUrl} ` +
            `bytes=${start}-${end - 1}: got ${filled} of ${total} bytes`,
        );
      }
      // Clamp so a server that over-serves can't overflow `out`.
      const n = Math.min(chunk.byteLength, total - filled);
      out.set(chunk.subarray(0, n), filled);
      filled += n;
    }
    return out;
  }
}
