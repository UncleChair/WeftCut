// Test helper: serves HTTP Range requests against an in-memory buffer, so
// MediaRangeSource / mediabunny can read a fixture lazily in node vitest
// without a real weftcut-media:// server. Tracks total bytes served for laziness
// assertions.

export interface RangeFetchMock {
  /// Drop-in for global `fetch`. Honors `Range: bytes=a-b` (inclusive), 206.
  fetch: (
    input: string | URL,
    init?: { headers?: Record<string, string> },
  ) => Promise<Response>;
  /// Sum of body bytes returned across all calls.
  bytesServed: () => number;
  /// Count of UNRANGED requests (no `Range` header → full-file 200). A lazy
  /// reader should never do this; it's the access pattern that blows the heap.
  fullFetches: () => number;
  /// Total fetch invocations (size probe + data reads).
  readCalls: () => number;
}

export interface RangeFetchMockOptions {
  /// Per-206-response body cap in bytes. Models the SHORT 206 a
  /// `weftcut-media://` fetch is observed to return — a fixed ceiling (~1 MB)
  /// regardless of how many bytes the `Range` header asked for; the workaround
  /// lives in `MediaRangeSource`'s `read`. When set, a request spanning more
  /// than `cap` bytes gets only `cap` bytes back (with a matching
  /// `Content-Range`), so the reader must issue follow-up requests to
  /// fulfill the full window. Defaults to unlimited.
  cap?: number;
}

export function makeRangeFetchMock(
  buffer: Uint8Array,
  options: RangeFetchMockOptions = {},
): RangeFetchMock {
  const cap = options.cap ?? Infinity;
  let served = 0;
  let fullFetches = 0;
  let readCalls = 0;
  const fetchImpl = async (
    _input: string | URL,
    init?: { headers?: Record<string, string> },
  ): Promise<Response> => {
    readCalls += 1;
    const range = init?.headers?.["Range"] ?? init?.headers?.["range"];
    if (!range) {
      fullFetches += 1;
      served += buffer.byteLength;
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: { "Content-Length": String(buffer.byteLength) },
      });
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) throw new Error(`mock: bad Range ${range}`);
    const start = Number(m[1]);
    const reqEnd = m[2] === "" ? buffer.byteLength - 1 : Number(m[2]); // inclusive
    // Truncate the served window to the per-response cap (see above).
    const end = Number.isFinite(cap) ? Math.min(reqEnd, start + cap - 1) : reqEnd;
    const slice = buffer.subarray(start, end + 1);
    served += slice.byteLength;
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${buffer.byteLength}`,
        "Content-Length": String(slice.byteLength),
      },
    });
  };
  return {
    fetch: fetchImpl,
    bytesServed: () => served,
    fullFetches: () => fullFetches,
    readCalls: () => readCalls,
  };
}
