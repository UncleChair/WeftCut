import { describe, it, expect } from "vitest";
import {
  importOptimizeStatus,
  codecDisplayName,
  is10bit,
  optimizeReason,
  partitionImportItems,
  type OptimizeDeps,
  type ImportItem,
} from "./importOptimize";

const vid = (over: Record<string, unknown>) => ({
  id: "m", label: "clip", kind: "Video", path: "/o.mov",
  duration_us: 1, width: 1920, height: 1080, size_bytes: 1, available: true,
  proxy_path: null, quick_proxy_path: null,
  proxy_bypassed: false, export_uses_original: false,
  codec: "hevc", pix_fmt: "yuv420p",
  ...over,
} as unknown);

const deps = (over: Partial<OptimizeDeps> = {}): OptimizeDeps => ({
  memo: new Map(),
  proxyStateOf: () => undefined,
  routeCorrected: new Set(),
  ...over,
});

describe("importOptimizeStatus", () => {
  it("ready when proxy_path set", () => {
    expect(importOptimizeStatus(vid({ proxy_path: "/p.mp4" }) as any, deps())).toBe("ready");
  });
  it("direct when proxy_bypassed", () => {
    expect(importOptimizeStatus(vid({ proxy_bypassed: true }) as any, deps())).toBe("direct");
  });
  it("classifies a decodable source (memo ok) as bridged", () => {
    expect(
      importOptimizeStatus(vid({ export_uses_original: true }) as any, {
        memo: new Map([["m", "ok"]]),
        proxyStateOf: () => "pending",
        routeCorrected: new Set(),
      }),
    ).toBe("bridged");
  });

  it("settles a decodable DirectExport source to direct once its quick proxy lands", () => {
    // Regression: a QuickOnly/DirectExport source only ever gets quick_proxy_path
    // (never proxy_path). Without settling it would be terminally "bridged" and
    // keep the import dialog open forever (a regression vs the old "direct").
    expect(
      importOptimizeStatus(
        vid({ export_uses_original: true, quick_proxy_path: "/q.mp4" }) as any,
        { memo: new Map([["m", "ok"]]), proxyStateOf: () => undefined, routeCorrected: new Set() },
      ),
    ).toBe("direct");
  });

  it("keeps a decodable full-proxy (10-bit) source bridged when only the quick proxy has landed", () => {
    // QuickThenFull: the quick proxy lands first, but proxy_path (the export
    // master) is the real terminal. export_uses_original is false, so the
    // DirectExport early-settle must NOT fire — stays bridged until proxy_path.
    expect(
      importOptimizeStatus(
        vid({ export_uses_original: false, quick_proxy_path: "/q.mp4", pix_fmt: "yuv420p10le" }) as any,
        { memo: new Map([["m", "ok"]]), proxyStateOf: () => "pending", routeCorrected: new Set() },
      ),
    ).toBe("bridged");
  });

  it("classifies a decodable 10-bit full-proxy source as bridged", () => {
    expect(
      importOptimizeStatus(vid({ pix_fmt: "yuv420p10le" }) as any, {
        memo: new Map([["m", "ok"]]),
        proxyStateOf: () => "pending",
        routeCorrected: new Set(),
      }),
    ).toBe("bridged");
  });

  it("classifies an undecodable, proxy-building source as transcoding", () => {
    expect(
      importOptimizeStatus(vid({ export_uses_original: false }) as any, {
        memo: new Map(),
        proxyStateOf: () => "pending",
        routeCorrected: new Set(),
      }),
    ).toBe("transcoding");
  });

  it("keeps a DirectExport source checking while its probe is in flight", () => {
    expect(
      importOptimizeStatus(vid({ export_uses_original: true }) as any, {
        memo: new Map([["m", "pending"]]),
        proxyStateOf: () => undefined,
        routeCorrected: new Set(),
      }),
    ).toBe("checking");
  });

  it("keeps bypass silent and a finished proxy ready", () => {
    const d = { memo: new Map(), proxyStateOf: () => undefined, routeCorrected: new Set() };
    expect(importOptimizeStatus(vid({ proxy_bypassed: true }) as any, d)).toBe("direct");
    expect(importOptimizeStatus(vid({ proxy_path: "/p.mp4" }) as any, d)).toBe("ready");
  });
  it("checking in the pre-decision window (no routing, no proxyState)", () => {
    expect(importOptimizeStatus(vid({}) as any, deps())).toBe("checking");
  });
  it("failed when the proxy job failed", () => {
    const d = deps({ proxyStateOf: () => "failed" });
    expect(importOptimizeStatus(vid({}) as any, d)).toBe("failed");
  });
  it("direct for non-video media", () => {
    expect(importOptimizeStatus(vid({ kind: "Audio" }) as any, deps())).toBe("direct");
  });
});

describe("codecDisplayName", () => {
  it("maps known codecs", () => {
    expect(codecDisplayName("hevc")).toBe("HEVC");
    expect(codecDisplayName("h264")).toBe("H.264");
    expect(codecDisplayName("av01")).toBe("AV1");
    expect(codecDisplayName("vp09")).toBe("VP9");
    expect(codecDisplayName("prores")).toBe("ProRes");
    expect(codecDisplayName("mpeg2video")).toBe("MPEG-2");
  });
  it("uppercases unknown, handles null", () => {
    expect(codecDisplayName("dnxhd")).toBe("DNxHD");
    expect(codecDisplayName(null)).toBe("未知");
  });
});

describe("is10bit", () => {
  it("true for 10/12-bit pixfmts, false otherwise", () => {
    expect(is10bit("yuv420p10le")).toBe(true);
    expect(is10bit("yuv422p12le")).toBe(true);
    expect(is10bit("yuv420p")).toBe(false);
    expect(is10bit(null)).toBe(false);
  });
});

describe("optimizeReason", () => {
  it("gives a reassuring reason for a bridged clip", () => {
    expect(
      optimizeReason(vid({ export_uses_original: true }) as any, {
        memo: new Map([["m", "ok"]]),
        proxyStateOf: () => "pending",
        routeCorrected: new Set(),
      }).key,
    ).toBe("reason_bridged");
  });
  it("undecodable for route-corrected ids", () => {
    const d = deps({ routeCorrected: new Set(["m"]) });
    expect(optimizeReason(vid({ codec: "hevc" }) as any, d)).toEqual({ key: "reason_undecodable", codec: "HEVC" });
  });
  it("10bit for static 10-bit sources", () => {
    expect(optimizeReason(vid({ codec: "hevc", pix_fmt: "yuv420p10le" }) as any, deps()))
      .toEqual({ key: "reason_10bit", codec: "HEVC" });
  });
  it("transcode for static 8-bit non-family sources", () => {
    expect(optimizeReason(vid({ codec: "prores", pix_fmt: "yuv422p" }) as any, deps()))
      .toEqual({ key: "reason_transcode", codec: "ProRes" });
  });
});

describe("partitionImportItems", () => {
  const item = (over: Partial<ImportItem>): ImportItem => ({
    id: "m", label: "clip", status: "transcoding",
    reason: { key: "reason_transcode", codec: "ProRes" }, ...over,
  });
  it("lists bridged + transcoding + failed, counts checking, drops direct/ready", () => {
    const r = partitionImportItems([
      item({ id: "a", status: "bridged" }),
      item({ id: "b", status: "transcoding" }),
      item({ id: "g", status: "failed" }),
      item({ id: "c", status: "checking" }),
      item({ id: "d", status: "checking" }),
      item({ id: "e", status: "direct" }),
      item({ id: "f", status: "ready" }),
    ]);
    expect(r.listed.map((i) => i.id)).toEqual(["a", "b", "g"]);
    expect(r.checkingCount).toBe(2);
    expect(r.hasAttention).toBe(true);
  });
  it("hasAttention false when nothing listed/checking", () => {
    const r = partitionImportItems([item({ id: "e", status: "direct" })]);
    expect(r.listed).toEqual([]);
    expect(r.checkingCount).toBe(0);
    expect(r.hasAttention).toBe(false);
  });
});
