import { describe, expect, it } from "vitest";
import type { MediaSummary } from "../ipc";
import {
  hwExportDecodeAllowed,
  proxyWaitScope,
  resolveExportDecodeRouting,
  routingSourceCounts,
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

// The dialog's routing-summary counts — semantics live on routingSourceCounts.
describe("routingSourceCounts", () => {
  const ALL = [
    vid("b", "bypass"),
    vid("d", "direct-export"),
    vid("p", "proxied"),
    vid("n", "native-sw"),
  ];

  it("auto + component: only 'proxied' feeds from the lossy proxy", () => {
    const routing = resolveExportDecodeRouting(base({ media: ALL }));
    // b/d decode originals in-worker, n decodes the original natively; only
    // p (neither engine opens it) exports off its full proxy.
    expect(routingSourceCounts(ALL, routing)).toEqual({ originals: 3, proxy: 1 });
  });

  it("webcodecs pin: blind spots join 'proxied' on the lossy-proxy side", () => {
    const routing = resolveExportDecodeRouting(base({ setting: "webcodecs", media: ALL }));
    expect(routingSourceCounts(ALL, routing)).toEqual({ originals: 2, proxy: 2 });
  });

  it("auto without the component: blind spots count as proxy-fed", () => {
    const media = [vid("n", "native-sw")];
    const routing = resolveExportDecodeRouting(
      base({ componentAvailable: false, media }),
    );
    expect(routingSourceCounts(media, routing)).toEqual({ originals: 0, proxy: 1 });
  });

  it("ffmpeg pin: every source counts as originals", () => {
    const routing = resolveExportDecodeRouting(base({ setting: "ffmpeg", media: ALL }));
    expect(routingSourceCounts(ALL, routing)).toEqual({ originals: 4, proxy: 0 });
  });

  it("non-video media are not counted", () => {
    const audio = vid("a", "bypass", { kind: "Audio", codec: null, pix_fmt: null });
    const media = [audio, vid("v", "bypass")];
    const routing = resolveExportDecodeRouting(base({ media }));
    expect(routingSourceCounts(media, routing)).toEqual({ originals: 1, proxy: 0 });
  });
});

// The 8-bit WebCodecs export lane's HW-decode ALLOWLIST: only platforms where
// a GPU-backed VideoFrame is proven readable by JS import paths may drop the
// prefer-software black-frame workaround. Windows is hardware-verified; macOS
// is untested; Linux is the platform the workaround exists for.
describe("hwExportDecodeAllowed", () => {
  it("allows hardware decode on Windows only", () => {
    expect(hwExportDecodeAllowed("windows")).toBe(true);
    expect(hwExportDecodeAllowed("mac")).toBe(false);
    expect(hwExportDecodeAllowed("linux")).toBe(false);
  });
});
