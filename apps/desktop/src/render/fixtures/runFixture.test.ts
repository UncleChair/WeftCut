import { describe, expect, test } from "vitest";

import { buildMediaById, expandRelative, joinPath } from "./runFixture";
import type { MediaSummary, ProjectSummary } from "../../ipc";

describe("joinPath", () => {
  test("joins with a forward slash", () => {
    expect(joinPath("/a/b", "c/d")).toBe("/a/b/c/d");
  });

  test("strips trailing + leading separators", () => {
    expect(joinPath("/a/b/", "/c/d")).toBe("/a/b/c/d");
    expect(joinPath("/a/b\\", "\\c\\d")).toBe("/a/b/c\\d");
  });
});

describe("expandRelative", () => {
  const root = "C:/fixtures/001_color";
  test("leaves POSIX-absolute paths alone", () => {
    expect(expandRelative("/abs/path", root)).toBe("/abs/path");
  });

  test("leaves Windows drive-letter paths alone", () => {
    expect(expandRelative("D:/data/clip.mp4", root)).toBe("D:/data/clip.mp4");
    expect(expandRelative("d:\\data\\clip.mp4", root)).toBe("d:\\data\\clip.mp4");
  });

  test("leaves UNC paths alone", () => {
    expect(expandRelative("\\\\server\\share\\clip.mp4", root)).toBe(
      "\\\\server\\share\\clip.mp4",
    );
  });

  test("joins relative paths against the root", () => {
    expect(expandRelative("media/clip.mp4", root)).toBe(
      "C:/fixtures/001_color/media/clip.mp4",
    );
  });
});

describe("buildMediaById", () => {
  function fakeMedia(id: string, path: string, proxy: string | null = null): MediaSummary {
    return {
      id,
      label: id,
      path,
      kind: "Video",
      duration_us: 2_000_000,
      width: 1920,
      height: 1080,
      size_bytes: 0,
      available: true,
      proxy_path: proxy,
      quick_proxy_path: null,
      proxy_bypassed: false,
      export_uses_original: false,
      codec: "h264",
      pix_fmt: "yuv420p",
    };
  }

  function fakeProject(media: MediaSummary[]): ProjectSummary {
    return {
      project_id: "p",
      name: "p",
      composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 },
      track_count: 0,
      layer_count: 0,
      duration_us: 0,
      history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
      media,
      tracks: [],
      markers: [],
      groups: [],
    };
  }

  test("rewrites relative paths against the fixture root", () => {
    const root = "C:/fixtures/001_color";
    const m = fakeMedia("m1", "media/clip.mp4");
    const out = buildMediaById(fakeProject([m]), root);
    expect(out.get("m1")?.path).toBe(`${root}/media/clip.mp4`);
  });

  test("leaves absolute paths alone", () => {
    const root = "C:/fixtures/001_color";
    const m = fakeMedia("m1", "D:/data/clip.mp4");
    const out = buildMediaById(fakeProject([m]), root);
    expect(out.get("m1")?.path).toBe("D:/data/clip.mp4");
  });

  test("rewrites relative proxy paths the same way", () => {
    const root = "C:/fixtures/001_color";
    const m = fakeMedia("m1", "media/clip.mp4", "cache/proxy.mp4");
    const out = buildMediaById(fakeProject([m]), root);
    expect(out.get("m1")?.proxy_path).toBe(`${root}/cache/proxy.mp4`);
  });

  test("preserves a null proxy_path", () => {
    const root = "C:/fixtures/001_color";
    const m = fakeMedia("m1", "media/clip.mp4", null);
    const out = buildMediaById(fakeProject([m]), root);
    expect(out.get("m1")?.proxy_path).toBeNull();
  });

  test("preserves the rest of MediaSummary fields", () => {
    const root = "C:/fixtures/001_color";
    const m = fakeMedia("m1", "media/clip.mp4");
    const out = buildMediaById(fakeProject([m]), root);
    const expanded = out.get("m1")!;
    expect(expanded.id).toBe(m.id);
    expect(expanded.kind).toBe(m.kind);
    expect(expanded.duration_us).toBe(m.duration_us);
    expect(expanded.width).toBe(m.width);
    expect(expanded.height).toBe(m.height);
    expect(expanded.available).toBe(true);
  });
});
