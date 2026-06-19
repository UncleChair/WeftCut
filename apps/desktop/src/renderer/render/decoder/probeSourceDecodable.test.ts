import { describe, it, expect } from "vitest";
import { raceFirstDecode } from "./probeSourceDecodable";

// Minimal fake matching the Pick<VideoDecoder, "configure"|"decode"|"close"|"flush">
// shape that raceFirstDecode drives. `behavior` decides what the fake does.
//   "needs-flush" models a B-frame stream: a lone keyframe stays parked in the
//   reorder buffer (decode() emits nothing) and only drains on flush() — the
//   real-Chromium/Electron behavior that made the import probe falsely reject decodable
//   H.264.
function makeFake(
  behavior: "output" | "error" | "silent" | "throw-configure" | "throw-decode" | "needs-flush",
) {
  return (h: { output: (frame: VideoFrame) => void; error: (e: unknown) => void }) => ({
    configure() {
      if (behavior === "throw-configure") throw new Error("unsupported config");
    },
    decode() {
      if (behavior === "throw-decode") throw new Error("malformed chunk");
      // Only `.close()` is exercised by raceFirstDecode; a stub frame is enough.
      else if (behavior === "output") h.output({ close() {} } as unknown as VideoFrame);
      else if (behavior === "error") h.error(new Error("decode failed"));
      // "silent" / "needs-flush": decode() alone emits nothing
    },
    flush() {
      // The reorder buffer drains here for a B-frame stream.
      if (behavior === "needs-flush") h.output({ close() {} } as unknown as VideoFrame);
      return Promise.resolve();
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

  it("decodable when the first frame only emits after a flush (B-frame reorder)", async () => {
    // A lone keyframe from a B-frame stream stays parked in the decoder's
    // reorder buffer; without a flush it never emits and the probe times out,
    // falsely judging decodable H.264 undecodable. raceFirstDecode must flush.
    const ok = await raceFirstDecode({
      config: cfg,
      keyChunk: fakeChunk,
      makeDecoder: makeFake("needs-flush"),
      deadlineMs: 100,
    });
    expect(ok).toBe(true);
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
