// mediabunny CustomSource adapter over the Tauri `asset://` protocol. Maps
// mediabunny's read(start,end) / getSize() onto HTTP Range requests so the
// whole file is never loaded — preserving the long-video heap budget. Owns an
// AbortController so disposing the Input cancels in-flight reads.
//
// mediabunny's read range is half-open [start, end) (0 <= start < end <
// fileSize); HTTP Range is inclusive, hence `bytes=start-(end-1)`. The Plan A
// fixture-parse test confirms this off-by-one empirically.

import { CustomSource, type CustomSourceOptions } from "mediabunny";

export class AssetRangeSource {
  private readonly assetUrl: string;
  private readonly abort = new AbortController();
  /// The mediabunny CustomSource — pass `.source` to `new Input({ source })`.
  readonly source: CustomSource;
  /// Exposed for unit tests; production code uses `.source`.
  readonly options: CustomSourceOptions;

  constructor(assetUrl: string) {
    this.assetUrl = assetUrl;
    this.options = {
      getSize: () => this.getSize(),
      read: (start, end) => this.read(start, end),
      dispose: () => this.dispose(),
      // Match the resident budget of the legacy GOP-block LRU (~a few source
      // seconds). Network-style prefetch suits asset:// latency.
      maxCacheSize: 16 * 1024 * 1024,
      prefetchProfile: "network",
    };
    this.source = new CustomSource(this.options);
  }

  dispose(): void {
    if (!this.abort.signal.aborted) this.abort.abort();
  }

  private async getSize(): Promise<number> {
    const res = await fetch(this.assetUrl, {
      headers: { Range: "bytes=0-0" },
      signal: this.abort.signal,
    });
    const cr = res.headers.get("Content-Range"); // "bytes 0-0/<total>"
    const total = cr?.split("/")[1];
    if (total && total !== "*") return Number.parseInt(total, 10);
    const cl = res.headers.get("Content-Length");
    if (cl) return Number.parseInt(cl, 10);
    throw new Error(`AssetRangeSource: no size for ${this.assetUrl}`);
  }

  private async read(start: number, end: number): Promise<Uint8Array> {
    const res = await fetch(this.assetUrl, {
      headers: { Range: `bytes=${start}-${end - 1}` }, // inclusive HTTP range
      signal: this.abort.signal,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    // 200 → server ignored Range and returned the whole file; slice the window.
    if (res.status === 200) return bytes.slice(start, end);
    return bytes;
  }
}
