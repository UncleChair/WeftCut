import { describe, it, expect, vi } from "vitest";
import { sourcesNeedingPreflight, preflightExportSources } from "./runExport";

const vid = (over: Record<string, unknown>) => ({
  id: "m1", label: "clip", kind: "Video", path: "/orig.mov",
  proxy_path: null, quick_proxy_path: null,
  proxy_bypassed: false, export_uses_original: false,
  width: 3840, height: 2160,
  ...over,
} as unknown);

describe("sourcesNeedingPreflight", () => {
  it("selects DirectExport-from-original video sources only", () => {
    const pool = new Map<string, any>([
      ["m1", vid({ id: "m1", export_uses_original: true })],              // DirectExport → yes
      ["m2", vid({ id: "m2", proxy_bypassed: true })],                    // DirectBoth (H.264) → no
      ["m3", vid({ id: "m3", export_uses_original: true, proxy_path: "/p.mp4" })], // has proxy → no
      ["m4", vid({ id: "m4", kind: "Audio" })],                           // not video → no
    ]);
    expect(sourcesNeedingPreflight(pool as any).map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("preflightExportSources", () => {
  it("returns [] when every source decodes", async () => {
    const pool = new Map([["m1", vid({ id: "m1", export_uses_original: true })]]);
    const failed = await preflightExportSources(pool as any, {
      urlFor: () => "asset://orig",
      probe: vi.fn().mockResolvedValue(true),
    });
    expect(failed).toEqual([]);
  });

  it("returns the undecodable media ids", async () => {
    const pool = new Map([["m1", vid({ id: "m1", export_uses_original: true })]]);
    const failed = await preflightExportSources(pool as any, {
      urlFor: () => "asset://orig",
      probe: vi.fn().mockResolvedValue(false),
    });
    expect(failed).toEqual(["m1"]);
  });

  it("returns only the undecodable ids when some sources pass and some fail", async () => {
    const pool = new Map([
      ["m1", vid({ id: "m1", export_uses_original: true })],
      ["m2", vid({ id: "m2", export_uses_original: true })],
    ]);
    const failed = await preflightExportSources(pool as any, {
      urlFor: (m: any) => `asset://${m.id}`,
      probe: vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith("m1"))),
    });
    expect(failed).toEqual(["m2"]);
  });
});
