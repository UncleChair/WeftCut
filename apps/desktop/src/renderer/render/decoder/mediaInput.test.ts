/// <reference types="node" />
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeRangeFetchMock } from "./testing/rangeFetchMock";
import { openMediaInput } from "./mediaInput";

function fixture(name: string): Uint8Array {
  const p = fileURLToPath(
    new URL(`../../../../fixtures/media/${name}`, import.meta.url),
  );
  return new Uint8Array(readFileSync(p));
}

describe.each([["tiny.mp4"], ["tiny.mkv"]])("openMediaInput(%s)", (name) => {
  it("yields a decodable video track + first key packet, reading lazily", async () => {
    const buf = fixture(name);
    const mock = makeRangeFetchMock(buf);
    vi.stubGlobal("fetch", mock.fetch);

    const opened = await openMediaInput("weftcut-media://clip");
    const config = await opened.videoTrack.getDecoderConfig();
    expect(config).not.toBeNull();
    expect(config!.codec).toMatch(/^avc1\./); // H.264 in both containers

    const first = await opened.packetSink.getKeyPacket(0);
    expect(first).not.toBeNull();
    expect(first!.type).toBe("key");
    expect(first!.data.byteLength).toBeGreaterThan(0);

    // Laziness mechanism: every read went through a bounded Range request —
    // MediaRangeSource never issued an unranged full-file fetch (the access
    // pattern that would blow the heap). The heap-flat-regardless-of-duration
    // invariant itself is the runtime PerfHUD soak (see the plan); a
    // sub-cache-size fixture is read whole either way, so byte-count can't
    // prove it here.
    expect(mock.fullFetches()).toBe(0);
    expect(mock.readCalls()).toBeGreaterThanOrEqual(2);

    opened.dispose();
    vi.unstubAllGlobals();
  });
});

describe("openMediaInput error handling", () => {
  it("throws when the source has no video track", async () => {
    vi.stubGlobal("fetch", makeRangeFetchMock(new Uint8Array([1, 2, 3, 4])).fetch);
    await expect(openMediaInput("weftcut-media://bad")).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
