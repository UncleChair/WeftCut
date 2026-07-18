import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommandProvider } from "../commands/registry";
import i18n from "../i18n";
import type { ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { useSearchIndexStore, wireSearchIndex } from "./searchIndexStore";

// Reuse the Task 5/6 fixtureSummary() shape — copied in (one media m1, one
// track t1 with clip l1). Varies media label per test via a parameter.
function fixtureSummary(label = "beach.mp4"): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
    track_count: 1,
    layer_count: 1,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [
      {
        id: "m1", label, path: `C:/x/${label}`, kind: "Video",
        duration_us: 5_000_000, width: 1920, height: 1080, size_bytes: 1,
        available: true, decode_route: { kind: "Original" } as never,
        codec: "h264", pix_fmt: "yuv420p",
      },
    ],
    tracks: [
      {
        id: "t1", kind: "Video", label: "A-Roll", enabled: true, locked: false,
        muted: false, solo: false, role: "a-roll", transient: false,
        layers: [
          {
            id: "l1", label: null, t_start_us: 2_000_000, t_end_us: 4_000_000,
            kind: "VideoClip", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "VideoClip", media_id: "m1", media_label: label,
              src_in_us: 0, src_out_us: 2_000_000,
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              rotation_deg: { mode: "Static", value: 0 },
              opacity: { mode: "Static", value: 1 },
              speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
            },
          },
        ],
      },
    ],
    markers: [],
    groups: [],
    audio_roles: [],
  };
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  useProjectStore.getState().apply(null);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(301); // debounce window
  await vi.advanceTimersByTimeAsync(1);   // async rebuild slice
}

describe("searchIndexStore", () => {
  it("builds an initial index on wire and rebuilds after a debounced summary change", async () => {
    teardown = wireSearchIndex();
    const v0 = useSearchIndexStore.getState().version;

    useProjectStore.getState().apply(fixtureSummary("beach.mp4"));
    // Not yet — debounce pending.
    expect(useSearchIndexStore.getState().entries.some((e) => e.label === "beach.mp4")).toBe(false);
    await flushDebounce();
    const s = useSearchIndexStore.getState();
    expect(s.version).toBeGreaterThan(v0);
    expect(s.entries.some((e) => e.key === "media:m1")).toBe(true);
  });

  it("coalesces a burst of changes into one rebuild", async () => {
    teardown = wireSearchIndex();
    const v0 = useSearchIndexStore.getState().version;
    useProjectStore.getState().apply(fixtureSummary("a.mp4"));
    await vi.advanceTimersByTimeAsync(100);
    useProjectStore.getState().apply(fixtureSummary("b.mp4"));
    await vi.advanceTimersByTimeAsync(100);
    useProjectStore.getState().apply(fixtureSummary("c.mp4"));
    await flushDebounce();
    const s = useSearchIndexStore.getState();
    expect(s.version).toBe(v0 + 1);
    expect(s.entries.some((e) => e.label === "c.mp4")).toBe(true);
    expect(s.entries.some((e) => e.label === "a.mp4")).toBe(false);
  });

  it("re-snapshots command labels when a provider registers", async () => {
    teardown = wireSearchIndex();
    const un = registerCommandProvider(() => [
      { id: "save", labelKey: "actions.save", run: () => {} },
    ]);
    await flushDebounce();
    expect(
      useSearchIndexStore.getState().entries.some((e) => e.key === "command:save"),
    ).toBe(true);
    un();
    await flushDebounce();
    expect(
      useSearchIndexStore.getState().entries.some((e) => e.key === "command:save"),
    ).toBe(false);
  });

  it("re-snapshots command labels on languageChanged", async () => {
    // Pin the starting locale explicitly — the LanguageDetector may resolve
    // either supported language from the host environment, and the signal
    // under test is the en→zh transition, not the detector.
    await i18n.changeLanguage("en-US");
    const un = registerCommandProvider(() => [
      { id: "save", labelKey: "actions.save", run: () => {} },
    ]);
    teardown = wireSearchIndex();
    await flushDebounce();
    const en = useSearchIndexStore
      .getState()
      .entries.find((e) => e.key === "command:save");
    expect(en?.label).toBe("Save");

    await i18n.changeLanguage("zh-CN");
    await flushDebounce();
    const zh = useSearchIndexStore
      .getState()
      .entries.find((e) => e.key === "command:save");
    expect(zh?.label).toBe("保存");
    // en-US label stays a haystack so English queries still hit on zh-CN UI.
    expect(zh?.haystacks).toContain("Save");

    un();
    // Restore — i18n locale (and its localStorage cache, where present) is
    // process-global; don't leak zh-CN into other suites.
    await i18n.changeLanguage("en-US");
  });
});
