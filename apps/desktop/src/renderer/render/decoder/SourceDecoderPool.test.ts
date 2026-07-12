// @vitest-environment jsdom
//
// Task 6 (collapsed decode-engine model): `SourceDecoderPool.acquire()`
// branches on `engine: 'ffmpeg'` to build a `FfmpegSource` (native hardware/
// software decode, chosen by `resolveDecodeEngine`), falling through to the
// default WebCodecs `SourceHandle` otherwise. The old per-strategy routing to
// two separate native decode-handle classes was removed in Task 9 —
// `FfmpegSource` now owns hardware/software lane selection internally.
import { describe, expect, it } from "vitest";
import { SourceDecoderPool } from "./SourceDecoderPool";

describe("SourceDecoderPool.acquire engine routing", () => {
  it("acquire(engine:'ffmpeg') builds an FfmpegSource decoding sourcePath", () => {
    const pool = new SourceDecoderPool();
    const h = pool.acquire({
      layerId: "L",
      mediaId: "m",
      proxyAssetUrl: "",
      engine: "ffmpeg",
      sourcePath: "C:/x.mp4",
      codec: "h264",
      pixFmt: "yuv420p",
      componentAvailable: true,
    } as never);

    expect(h.constructor.name).toBe("FfmpegSource");

    pool.dispose();
  });

  it("acquire(engine:'webcodecs') builds the WebCodecs SourceHandle via SourceMedia", () => {
    const pool = new SourceDecoderPool();
    const h = pool.acquire({
      layerId: "L2",
      mediaId: "m2",
      proxyAssetUrl: "weftcut-media://p.mp4",
      engine: "webcodecs",
    } as never);

    expect(h.constructor.name).toBe("SourceHandle");

    pool.dispose();
  });
});
