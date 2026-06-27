import { describe, it, expect } from "vitest";
import {
  importOptimizeStatus,
  codecDisplayName,
  is10bit,
  optimizeReason,
  importDialogNoteKey,
  partitionImportItems,
  type OptimizeDeps,
  type ImportItem,
} from "./importOptimize";

const vid = (over: Record<string, unknown>) => ({
  id: "m", label: "clip", kind: "Video", path: "/o.mov",
  duration_us: 1, width: 1920, height: 1080, size_bytes: 1, available: true,
  decode_route: { route: "bypass" },
  codec: "hevc", pix_fmt: "yuv420p",
  ...over,
} as unknown);

const deps = (over: Partial<OptimizeDeps> = {}): OptimizeDeps => ({
  memo: new Map(),
  proxyStateOf: () => undefined,
  routeCorrected: new Set(),
  ...over,
});

// ── importOptimizeStatus (frozen behavior, route-driven) ──
// The six output states and the precedence are IDENTICAL to the pre-decode-route
// implementation; only the inputs moved from flat flags to the decode route.
const depsT = (over: Partial<{ memo: Map<string, "ok" | "pending">; ps: any; rc: Set<string> }> = {}) => ({
  memo: over.memo ?? new Map(),
  proxyStateOf: () => over.ps,
  routeCorrected: over.rc ?? new Set<string>(),
});
const V = (decode_route: any, extra: any = {}) =>
  ({ id: "m1", kind: "Video", path: "o.mp4", decode_route, ...extra } as any);

describe("importOptimizeStatus (frozen behavior, route-driven)", () => {
  it("proxied + full ready ⇒ ready", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: "q", full_proxy: "f", format_version: 1 }), depsT())).toBe("ready"));
  it("bypass ⇒ direct", () =>
    expect(importOptimizeStatus(V({ route: "bypass" }), depsT())).toBe("direct"));
  it("direct-export + quick ready ⇒ direct", () =>
    expect(importOptimizeStatus(V({ route: "direct-export", quick_proxy: "q" }), depsT())).toBe("direct"));
  it("decodable this machine ⇒ bridged", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), depsT({ memo: new Map([["m1", "ok"]]) }))).toBe("bridged"));
  it("undecodable + proxy pending ⇒ transcoding", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), depsT({ ps: "pending" }))).toBe("transcoding"));
  it("proxy failed ⇒ failed", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), depsT({ ps: "failed" }))).toBe("failed"));

  // Additional frozen-precedence coverage carried over from the pre-route suite.
  it("keeps a decodable DirectExport source checking while its probe is in flight (memo pending)", () =>
    expect(importOptimizeStatus(V({ route: "direct-export", quick_proxy: null }), depsT({ memo: new Map([["m1", "pending"]]) }))).toBe("checking"));
  it("keeps a decodable full-proxy (10-bit) source bridged when only the quick proxy has landed", () =>
    // QuickThenFull: the quick proxy lands first, but the full master is the real
    // terminal. The DirectExport early-settle must NOT fire — stays bridged.
    expect(importOptimizeStatus(
      V({ route: "proxied", quick_proxy: "q", full_proxy: null, format_version: 0 }, { pix_fmt: "yuv420p10le" }),
      depsT({ memo: new Map([["m1", "ok"]]), ps: "pending" }),
    )).toBe("bridged"));
  it("checking in the pre-decision window (proxied, nothing ready, no memo/proxyState)", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), depsT())).toBe("checking"));
  it("direct for non-video media", () =>
    expect(importOptimizeStatus(V({ route: "bypass" }, { kind: "Audio" }), depsT())).toBe("direct"));
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
      optimizeReason(vid({ decode_route: { route: "direct-export", quick_proxy: null } }) as any, {
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

describe("importDialogNoteKey", () => {
  const item = (over: Partial<ImportItem>): ImportItem => ({
    id: "m",
    label: "clip",
    status: "transcoding",
    reason: { key: "reason_transcode", codec: "ProRes" },
    ...over,
  });

  it("says editable only when every attention item is bridged", () => {
    expect(importDialogNoteKey([item({ status: "bridged" })])).toBe("editable_note");
  });

  it("uses a waiting note for checking/transcoding items", () => {
    expect(importDialogNoteKey([item({ status: "checking" })])).toBe("waiting_note");
    expect(importDialogNoteKey([item({ status: "transcoding" })])).toBe("waiting_note");
  });

  it("uses a mixed note when editable and waiting items coexist", () => {
    expect(importDialogNoteKey([
      item({ id: "a", status: "bridged" }),
      item({ id: "b", status: "transcoding" }),
    ])).toBe("mixed_note");
  });

  it("uses a failed note when failed items are the only attention items", () => {
    expect(importDialogNoteKey([item({ status: "failed" })])).toBe("failed_note");
  });
});
