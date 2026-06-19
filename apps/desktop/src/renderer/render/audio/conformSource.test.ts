// ConformSource over a mocked weftcut-media:// fetch — header parse, exact-byte
// loop-read discipline (short 206 responses), de-interleave, and silence
// padding outside the file.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFORM_HEADER_LEN, ConformSource } from "./conformSource";

/// Build VCONF bytes: header (magic, version=1, 48000, channels,
/// frameCount) + interleaved f32le samples.
function buildVconf(channels: number, samples: number[]): Uint8Array {
  const frameCount = samples.length / channels;
  const buf = new ArrayBuffer(CONFORM_HEADER_LEN + samples.length * 4);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode("VCONF\0\0\0"), 0);
  view.setUint32(8, 1, true);
  view.setUint32(12, 48000, true);
  view.setUint32(16, channels, true);
  view.setBigUint64(20, BigInt(frameCount), true);
  samples.forEach((s, i) => {
    view.setFloat32(CONFORM_HEADER_LEN + i * 4, s, true);
  });
  return bytes;
}

/// Mock fetch serving `file` with Range support. When `maxChunk` is set,
/// responses are truncated to that many bytes — exercising the loop-read.
function mockFetch(file: Uint8Array, maxChunk?: number): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.["Range"] ?? "";
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) throw new Error(`test fetch requires a Range header, got "${range}"`);
    const start = Number(m[1]);
    let end = Number(m[2]) + 1;
    if (maxChunk !== undefined) end = Math.min(end, start + maxChunk);
    const body = file.slice(start, Math.min(end, file.byteLength));
    return {
      ok: false,
      status: 206,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConformSource", () => {
  it("parses the header", async () => {
    vi.stubGlobal("fetch", mockFetch(buildVconf(2, [0.1, -0.1, 0.2, -0.2])));
    const src = await ConformSource.open("asset://x.conform");
    expect(src.header).toEqual({
      version: 1,
      sampleRate: 48000,
      channels: 2,
      frameCount: 2,
    });
  });

  it("rejects bad magic", async () => {
    const junk = buildVconf(1, [0.5]);
    junk[0] = 0x58; // 'X'
    vi.stubGlobal("fetch", mockFetch(junk));
    await expect(ConformSource.open("asset://x.conform")).rejects.toThrow(
      /bad conform magic/,
    );
  });

  it("reads and de-interleaves an interior stereo window", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(buildVconf(2, [0.1, -0.1, 0.2, -0.2, 0.3, -0.3])),
    );
    const src = await ConformSource.open("asset://x.conform");
    const [l, r] = await src.readWindow(1, 2);
    expect(Array.from(l!)).toEqual([
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
    expect(Array.from(r!)).toEqual([
      expect.closeTo(-0.2, 5),
      expect.closeTo(-0.3, 5),
    ]);
  });

  it("zero-fills before start and past EOF", async () => {
    vi.stubGlobal("fetch", mockFetch(buildVconf(1, [0.5, 0.6])));
    const src = await ConformSource.open("asset://x.conform");
    const [m] = await src.readWindow(-1, 4);
    expect(Array.from(m!)).toEqual([
      0,
      expect.closeTo(0.5, 5),
      expect.closeTo(0.6, 5),
      0,
    ]);
  });

  it("loops short 206 responses until the exact byte count arrives", async () => {
    // 1000 mono frames = 4000 data bytes; cap each response at 256 bytes
    // so a full window needs many round-trips.
    const samples = Array.from({ length: 1000 }, (_, i) => i / 1000);
    const fetchMock = mockFetch(buildVconf(1, samples), 256);
    vi.stubGlobal("fetch", fetchMock);
    const src = await ConformSource.open("asset://x.conform");
    const [m] = await src.readWindow(0, 1000);
    expect(m!.length).toBe(1000);
    expect(m![999]).toBeCloseTo(0.999, 5);
    // Header read (1) + ceil(4000/256)=16 data reads minimum.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(10);
  });
});
