import { describe, it, expect } from "vitest";
import { raceFirstDecode } from "./probeSourceDecodable";

// Minimal fake matching the Pick<VideoDecoder, "configure"|"decode"|"close"> shape
// that raceFirstDecode drives. `behavior` decides what the fake does on decode().
function makeFake(behavior: "output" | "error" | "silent" | "throw-configure" | "throw-decode") {
  return (h: { output: (frame: VideoFrame) => void; error: (e: unknown) => void }) => ({
    configure() {
      if (behavior === "throw-configure") throw new Error("unsupported config");
    },
    decode() {
      if (behavior === "throw-decode") throw new Error("malformed chunk");
      // Only `.close()` is exercised by raceFirstDecode; a stub frame is enough.
      else if (behavior === "output") h.output({ close() {} } as unknown as VideoFrame);
      else if (behavior === "error") h.error(new Error("decode failed"));
      // "silent": do nothing → timeout wins
    },
    close() {},
  });
}

const fakeChunk = {} as unknown as EncodedVideoChunk;
const cfg = { codec: "hev1.1.6.L153.B0" } as VideoDecoderConfig;

describe("raceFirstDecode", () => {
  it("decodable when a frame is output", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("output"), deadlineMs: 100 });
    expect(ok).toBe(true);
  });

  it("undecodable when the decoder errors", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("error"), deadlineMs: 100 });
    expect(ok).toBe(false);
  });

  it("undecodable on the silent-stall timeout (no output, no error)", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("silent"), deadlineMs: 30 });
    expect(ok).toBe(false);
  });

  it("undecodable when configure throws synchronously", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("throw-configure"), deadlineMs: 100 });
    expect(ok).toBe(false);
  });

  it("undecodable when there is no key packet", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: null, makeDecoder: makeFake("output"), deadlineMs: 100 });
    expect(ok).toBe(false);
  });

  it("undecodable when decode throws synchronously", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("throw-decode"), deadlineMs: 100 });
    expect(ok).toBe(false);
  });
});
