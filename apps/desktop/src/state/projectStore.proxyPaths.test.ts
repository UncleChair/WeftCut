import { describe, it, expect } from "vitest";
import { previewPlaybackPathFor, exportPlaybackPathFor } from "./projectStore";
import type { MediaSummary } from "../ipc";

function video(over: Partial<MediaSummary> = {}): MediaSummary {
  return {
    id: "m1",
    label: "clip",
    path: "/orig.mp4",
    kind: "Video",
    duration_us: 5_000_000,
    width: 3840,
    height: 2160,
    size_bytes: 100_000_000,
    available: true,
    proxy_path: null,
    quick_proxy_path: null,
    proxy_bypassed: false,
    export_uses_original: false,
    ...over,
  };
}

describe("direct-export source resolution", () => {
  it("export reads the original when export_uses_original", () => {
    expect(exportPlaybackPathFor(video({ export_uses_original: true }))).toBe(
      "/orig.mp4",
    );
  });

  it("export still prefers a full proxy when present", () => {
    const m = video({ export_uses_original: true, proxy_path: "/proxy.mp4" });
    expect(exportPlaybackPathFor(m)).toBe("/proxy.mp4");
  });

  it("export never uses the quick (preview) proxy", () => {
    const m = video({ export_uses_original: true, quick_proxy_path: "/q.mp4" });
    expect(exportPlaybackPathFor(m)).toBe("/orig.mp4");
  });

  it("preview uses the quick proxy when present even for direct-export", () => {
    const m = video({ export_uses_original: true, quick_proxy_path: "/q.mp4" });
    expect(previewPlaybackPathFor(m)).toBe("/q.mp4");
  });

  it("non-direct-export non-bypass video is not exportable from source", () => {
    expect(exportPlaybackPathFor(video())).toBeNull();
  });

  it("bypass still resolves to the original for both", () => {
    const m = video({ proxy_bypassed: true });
    expect(previewPlaybackPathFor(m)).toBe("/orig.mp4");
    expect(exportPlaybackPathFor(m)).toBe("/orig.mp4");
  });

  it("preview waits for the quick proxy on a DirectExport source (no fall-through to original)", () => {
    const m = {
      kind: "Video", path: "/orig.mov",
      proxy_path: null, quick_proxy_path: null,
      proxy_bypassed: false, export_uses_original: true,
    } as unknown as MediaSummary;
    // export still reads the original; preview must NOT (could be undecodable HEVC).
    expect(exportPlaybackPathFor(m)).toBe("/orig.mov");
    expect(previewPlaybackPathFor(m)).toBeNull();
  });

  it("preview uses the quick proxy once it lands for a DirectExport source", () => {
    const m = {
      kind: "Video", path: "/orig.mov",
      proxy_path: null, quick_proxy_path: "/quick.mp4",
      proxy_bypassed: false, export_uses_original: true,
    } as unknown as MediaSummary;
    expect(previewPlaybackPathFor(m)).toBe("/quick.mp4");
  });

  it("DirectBoth still previews and exports from the (H.264) original", () => {
    const m = {
      kind: "Video", path: "/orig.mp4",
      proxy_path: null, quick_proxy_path: null,
      proxy_bypassed: true, export_uses_original: false,
    } as unknown as MediaSummary;
    expect(previewPlaybackPathFor(m)).toBe("/orig.mp4");
    expect(exportPlaybackPathFor(m)).toBe("/orig.mp4");
  });
});
