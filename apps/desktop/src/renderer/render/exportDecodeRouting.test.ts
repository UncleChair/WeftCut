import { describe, expect, it } from "vitest";
import type { MediaSummary } from "../ipc";
import {
  proxyWaitScope,
  resolveExportDecodeRouting,
  type ExportRoutingInputs,
} from "./exportDecodeRouting";

// The setting × component × route × bit-depth matrix for the export decode
// resolver (spec decisions 2/3/8). Mirrors resolveDecodeEngine.test.ts's
// base-factory shape.

type Route = MediaSummary["decode_route"];
const ROUTES = {
  bypass: { route: "bypass" },
  "direct-export": { route: "direct-export", quick_proxy: null },
  proxied: {
    route: "proxied",
    quick_proxy: null,
    full_proxy: "C:\\proxies\\m.mp4",
    format_version: 7,
  },
  "native-sw": {
    route: "native-sw",
    quick_proxy: null,
    full_proxy: null,
    format_version: 7,
  },
} satisfies Record<string, Route>;

function vid(
  id: string,
  route: keyof typeof ROUTES,
  over: Partial<MediaSummary> = {},
): MediaSummary {
  return {
    id,
    label: id,
    path: `C:\\media\\${id}.mov`,
    kind: "Video",
    duration_us: 10_000_000,
    width: 1920,
    height: 1080,
    size_bytes: 1,
    available: true,
    decode_route: ROUTES[route],
    codec: "prores",
    pix_fmt: "yuv422p10le",
    ...over,
  } as MediaSummary;
}

function base(over: Partial<ExportRoutingInputs> = {}): ExportRoutingInputs {
  return {
    setting: "auto",
    componentAvailable: true,
    bitDepth: 8,
    media: [vid("m1", "native-sw")],
    ...over,
  };
}

describe("resolveExportDecodeRouting", () => {
  it("auto + component: blind-spot (native-sw) routes native on the original", () => {
    const r = resolveExportDecodeRouting(base());
    expect(r.effectiveSetting).toBe("auto");
    expect(r.outFormat).toBe("NV12");
    expect(r.routes["m1"]).toEqual({
      engine: "native",
      sourcePath: "C:\\media\\m1.mov",
    });
  });

  it("auto + component: decodable routes stay in-worker WebCodecs", () => {
    const r = resolveExportDecodeRouting(
      base({
        media: [vid("b", "bypass"), vid("d", "direct-export"), vid("p", "proxied")],
      }),
    );
    expect(r.routes["b"]).toEqual({ engine: "webcodecs" });
    expect(r.routes["d"]).toEqual({ engine: "webcodecs" });
    // "proxied" = neither engine opens the original — full-proxy fallback.
    expect(r.routes["p"]).toEqual({ engine: "webcodecs" });
  });

  it("auto without the component: blind-spot falls back to the proxy path", () => {
    const r = resolveExportDecodeRouting(base({ componentAvailable: false }));
    expect(r.effectiveSetting).toBe("auto");
    expect(r.routes["m1"]).toEqual({ engine: "webcodecs" });
  });

  it("ffmpeg pin + component: EVERY source routes native", () => {
    const r = resolveExportDecodeRouting(
      base({
        setting: "ffmpeg",
        media: [
          vid("b", "bypass"),
          vid("d", "direct-export"),
          vid("p", "proxied"),
          vid("n", "native-sw"),
        ],
      }),
    );
    expect(r.effectiveSetting).toBe("ffmpeg");
    for (const id of ["b", "d", "p", "n"]) {
      expect(r.routes[id]).toMatchObject({ engine: "native" });
    }
    expect(r.routes["b"]).toMatchObject({ sourcePath: "C:\\media\\b.mov" });
  });

  it("ffmpeg pin without the component degrades to auto", () => {
    const r = resolveExportDecodeRouting(
      base({
        setting: "ffmpeg",
        componentAvailable: false,
        media: [vid("n", "native-sw"), vid("d", "direct-export")],
      }),
    );
    expect(r.effectiveSetting).toBe("auto");
    expect(r.routes["n"]).toEqual({ engine: "webcodecs" });
    expect(r.routes["d"]).toEqual({ engine: "webcodecs" });
  });

  it("webcodecs pin: today's behavior exactly — blind-spot via proxy", () => {
    const r = resolveExportDecodeRouting(base({ setting: "webcodecs" }));
    expect(r.effectiveSetting).toBe("webcodecs");
    expect(r.routes["m1"]).toEqual({ engine: "webcodecs" });
  });

  it("transport format follows the composite bit depth", () => {
    expect(resolveExportDecodeRouting(base()).outFormat).toBe("NV12");
    expect(resolveExportDecodeRouting(base({ bitDepth: 10 })).outFormat).toBe("I420P10");
  });

  it("10-bit exports route native over the I420P10 transport (auto AND ffmpeg pin)", () => {
    const auto = resolveExportDecodeRouting(base({ bitDepth: 10 }));
    expect(auto.outFormat).toBe("I420P10");
    expect(auto.routes["m1"]).toEqual({
      engine: "native",
      sourcePath: "C:\\media\\m1.mov",
    });
    const pinned = resolveExportDecodeRouting(base({ bitDepth: 10, setting: "ffmpeg" }));
    expect(pinned.routes["m1"]).toEqual({
      engine: "native",
      sourcePath: "C:\\media\\m1.mov",
    });
    expect(pinned.effectiveSetting).toBe("ffmpeg");
  });

  it("non-video media get no table entry", () => {
    const audio = vid("a", "bypass", { kind: "Audio", codec: null, pix_fmt: null });
    const r = resolveExportDecodeRouting(base({ media: [audio] }));
    expect(r.routes["a"]).toBeUndefined();
  });

  it("a video with no original path falls back to webcodecs", () => {
    const r = resolveExportDecodeRouting(base({ media: [vid("m1", "native-sw", { path: "" })] }));
    expect(r.routes["m1"]).toEqual({ engine: "webcodecs" });
  });
});

describe("proxyWaitScope", () => {
  it("drops native-routed media from the readiness gate's scope", () => {
    const media = [vid("n", "native-sw"), vid("d", "direct-export"), vid("p", "proxied")];
    const routing = resolveExportDecodeRouting(base({ media }));
    expect(proxyWaitScope(media, routing).map((m) => m.id)).toEqual(["d", "p"]);
  });

  it("keeps everything when nothing routes native (webcodecs pin keeps today's wait)", () => {
    const media = [vid("n", "native-sw"), vid("p", "proxied")];
    const routing = resolveExportDecodeRouting(base({ setting: "webcodecs", media }));
    expect(proxyWaitScope(media, routing).map((m) => m.id)).toEqual(["n", "p"]);
  });
});
