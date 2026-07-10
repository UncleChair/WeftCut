// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../state/navigation", () => ({
  jumpToLayer: vi.fn(() => true),
  jumpToTimeUs: vi.fn(),
  revealInMediaPool: vi.fn(() => true),
}));

import "../i18n"; // side-effect: init global i18next (en-US fallback)
import { jumpToLayer, revealInMediaPool } from "../state/navigation";
import { registerCommandProvider } from "../commands/registry";
import { useSearchIndexStore } from "./searchIndexStore";
import { buildEntries } from "./buildEntries";
import { SearchPalette } from "./SearchPalette";
import type { ProjectSummary } from "../ipc";

// jsdom (this repo's ^25.0.1) doesn't implement Element.scrollIntoView at
// all — the active-row ref callback calls it unconditionally (see
// panels/MediaPool.tsx's precedent for the same call), so every render
// with an active row throws "scrollIntoView is not a function" without
// this no-op shim. Test-environment gap only; not a component bug.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/// Trimmed Task-6 fixture: media m1 "beach.mp4" used by ONE clip (l1 on
/// track t1 "A-Roll" — no second usage), caption layer "lc" with content
/// "字幕第一行" at 1 s, marker mk1 "章节一" at 5 s. Kept to a single media
/// usage (unlike buildEntries.test.ts's two-usage fixture) so the
/// expand-media-row test below has exactly one deterministic usage row.
function fixtureSummary(): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
    track_count: 2,
    layer_count: 2,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [
      {
        id: "m1", label: "beach.mp4", path: "C:/x/beach.mp4", kind: "Video",
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
              kind: "VideoClip", media_id: "m1", media_label: "beach.mp4",
              src_in_us: 0, src_out_us: 2_000_000,
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              opacity: { mode: "Static", value: 1 },
              speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
            },
          },
        ],
      },
      {
        id: "t2", kind: "Subtitle", label: null, enabled: true, locked: false,
        muted: false, solo: false, role: "caption", transient: false,
        layers: [
          {
            id: "lc", label: null, t_start_us: 1_000_000, t_end_us: 3_000_000,
            kind: "Text", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "Text", content: "字幕第一行",
              font_family: "Arial", font_size_px: 16, weight: 400, italic: false,
              align: "Center", anchor_x: 0.5, anchor_y: 0.5,
              color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              opacity: { mode: "Static", value: 1 },
              outline: null, shadow: null,
            },
          },
        ],
      },
    ],
    markers: [
      { id: "mk1", t_us: 5_000_000, end_t_us: null, label: "章节一", color_hint: "" },
    ],
    groups: [],
    audio_roles: [],
  };
}

const runSpy = vi.fn();
let unregister: (() => void) | undefined;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  unregister?.();
  unregister = registerCommandProvider(() => [
    { id: "save", labelKey: "actions.save", actionId: "save", run: runSpy },
  ]);
  useSearchIndexStore.setState({
    entries: buildEntries(fixtureSummary(), [
      { id: "save", label: "Save", enLabel: "Save", actionId: "save" },
    ]),
    version: 1,
  });
});

describe("SearchPalette", () => {
  it("runs a command on Enter and closes", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("save");
    await userEvent.keyboard("{Enter}");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("jumps to a caption matched via pinyin initials", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("zmdyh");
    expect(await screen.findByText(/字幕第一行/)).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(jumpToLayer).toHaveBeenCalledWith("lc");
    expect(onClose).toHaveBeenCalled();
  });

  it("expands a media row into reveal + usage sub-actions", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("beach");
    await userEvent.keyboard("{Enter}"); // media row (top-ranked) → sub-list
    expect(await screen.findByText(/Reveal in media pool/i)).toBeTruthy();
    await userEvent.keyboard("{ArrowDown}{Enter}"); // first usage row
    expect(jumpToLayer).toHaveBeenCalledWith("l1");
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter on the reveal row calls revealInMediaPool", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("beach");
    await userEvent.keyboard("{Enter}{Enter}");
    expect(revealInMediaPool).toHaveBeenCalledWith("m1");
  });
});
