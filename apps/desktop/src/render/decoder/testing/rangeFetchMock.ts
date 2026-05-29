// Test helper: serves HTTP Range requests against an in-memory buffer, so
// AssetRangeSource / mediabunny can read a fixture lazily in node vitest
// without a real asset:// server. Tracks total bytes served for laziness
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

export function makeRangeFetchMock(buffer: Uint8Array): RangeFetchMock {
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
      return new Response(buffer, {
        status: 200,
        headers: { "Content-Length": String(buffer.byteLength) },
      });
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) throw new Error(`mock: bad Range ${range}`);
    const start = Number(m[1]);
    const end = m[2] === "" ? buffer.byteLength - 1 : Number(m[2]); // inclusive
    const slice = buffer.subarray(start, end + 1);
    served += slice.byteLength;
    return new Response(slice, {
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
