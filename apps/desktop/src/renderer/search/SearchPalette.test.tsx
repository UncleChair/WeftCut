// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../state/navigation", () => ({
  jumpToLayer: vi.fn(() => true),
  jumpToTimeUs: vi.fn(),
  revealInMediaPool: vi.fn(() => true),
}));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  logEmit: vi.fn(() => Promise.resolve()),
}));

import { logEmit } from "../ipc";
import i18n from "../i18n"; // also a side-effect: init global i18next (en-US fallback)
import { jumpToLayer, jumpToTimeUs, revealInMediaPool } from "../state/navigation";
import { registerCommandProvider } from "../commands/registry";
import { useSearchIndexStore } from "./searchIndexStore";
import { buildEntries } from "./buildEntries";
import { SearchPalette } from "./SearchPalette";
import type { ProjectSummary } from "../ipc";

// jsdom doesn't implement Element.scrollIntoView at all — the active-row
// ref callback calls it unconditionally (see panels/MediaPool.tsx's
// precedent for the same call), so every render with an active row throws
// "scrollIntoView is not a function" without this no-op shim.
// Test-environment gap only; not a component bug.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/// Trimmed fixture: media m1 "beach.mp4" used by ONE clip (l1 on
/// track t1 "A-Roll" — no second usage), caption layer "lc" with content
/// "字幕第一行" at 1 s, marker mk1 "章节一" at 5 s. Kept to a single media
/// usage (unlike buildEntries.test.ts's two-usage fixture) so the
/// expand-media-row test below has exactly one deterministic usage row.
function fixtureSummary(): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false, fps_locked: false },
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
      // Unused (no layer references it) — only here to exercise the
      // UTF-16 highlight-offset regression test below; must not disturb
      // the "beach" query tests above (distinct label, distinct query).
      {
        id: "m2", label: "🌊 sunset.mp4", path: "C:/x/sunset.mp4", kind: "Video",
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
              scale_linked: true,
              rotation_deg: { mode: "Static", value: 0 },
              anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
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
              align: "Center", anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
              color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              scale_linked: true,
              rotation_deg: { mode: "Static", value: 0 },
              opacity: { mode: "Static", value: 1 },
              outline: null, shadow: null,
              box_w: null, box_h: null, valign: "Middle", line_height: 0, letter_spacing: 0,
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

// buildEntries takes its translators from the caller (it stays pure). These
// tests run on the en-US fallback, so both passes agree.
const LOCALE = {
  t: (key: string, values: Record<string, unknown>) => i18n.t(key, values),
  tEn: (key: string, values: Record<string, unknown>) =>
    i18n.getFixedT("en-US")(key, values),
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  unregister?.();
  unregister = registerCommandProvider(() => [
    { id: "save", labelKey: "actions.save", actionId: "save", run: runSpy },
  ]);
  useSearchIndexStore.setState({
    entries: buildEntries(
      fixtureSummary(),
      [{ id: "save", label: "Save", enLabel: "Save", actionId: "save" }],
      LOCALE,
    ),
    version: 1,
  });
});

describe("SearchPalette", () => {
  it("runs a command on Enter, closes, and logs one Shortcut row", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("save");
    await userEvent.keyboard("{Enter}");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
    // The palette is a command surface: activating an entry must log exactly
    // like the chord that would have run it (registry funnel).
    expect(logEmit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logEmit).mock.calls[0]![0]).toMatchObject({
      category: { kind: "Shortcut" },
      message: "Shortcut: save",
    });
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

  it("highlights astral characters by code point, not code unit index", async () => {
    // Regression test: fuzzysort's `indexes` are UTF-16 code-unit offsets.
    // "🌊 sunset.mp4" has a leading surrogate pair (2 code units, 1 code
    // point) — a naive Array.from(label) code-point walk misreads those
    // offsets and shifts every highlighted mark by one character.
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("sunset");
    const options = await screen.findAllByRole("option");
    const row = options.find((el) => el.getAttribute("aria-selected") === "true");
    expect(row).toBeTruthy();
    const marked = Array.from(row!.querySelectorAll("mark"))
      .map((m) => m.textContent)
      .join("");
    expect(marked).toBe("sunset");
  });

  // The palette lists every registered command, toggles included — and a toggle
  // is the one row kind whose label alone can't say what selecting it does.
  it("shows a checkable command's current state, and re-reads it live", async () => {
    let on = true;
    unregister?.();
    unregister = registerCommandProvider(() => [
      {
        id: "toggleMarkersVisible",
        labelKey: "actions.toggle_markers_visible",
        checked: () => on,
        run: runSpy,
      },
      // A non-checkable command in the same result set: it must claim no state
      // at all rather than read as an off switch.
      { id: "save", labelKey: "actions.save", actionId: "save", run: runSpy },
    ]);
    useSearchIndexStore.setState({
      entries: buildEntries(
        fixtureSummary(),
        [
          {
            id: "toggleMarkersVisible",
            label: "Toggle timeline markers",
            enLabel: "Toggle timeline markers",
          },
          { id: "save", label: "Save", enLabel: "Save", actionId: "save" },
        ],
        LOCALE,
      ),
      version: 1,
    });

    const { unmount } = render(<SearchPalette onClose={vi.fn()} />);
    await userEvent.keyboard("markers");
    const row = () =>
      screen.getAllByRole("option").find((el) => el.textContent?.includes("markers"))!;
    expect(row().getAttribute("aria-checked")).toBe("true");
    expect(row().querySelector(".search-row-check")).toBeTruthy();

    on = false;
    unmount();
    render(<SearchPalette onClose={vi.fn()} />);
    await userEvent.keyboard("markers");
    expect(row().getAttribute("aria-checked")).toBe("false");
    expect(row().querySelector(".search-row-check")).toBeNull();

    await userEvent.keyboard("{Backspace>7/}save");
    const saveRow = screen
      .getAllByRole("option")
      .find((el) => el.textContent?.includes("Save"))!;
    expect(saveRow.hasAttribute("aria-checked")).toBe(false);
  });

  it("keeps the keyboard cursor on its row when an earlier group expands", async () => {
    // 6 commands "Save 0".."Save 5" (command group truncates to 5 visible +
    // a "Show 1 more…" expander) and a marker "save point" so the query
    // "save" produces a later group AFTER the truncated one. Expanding the
    // command group inserts a row before the marker's flat index — the
    // cursor must follow the marker row, not stay parked on the raw index
    // (which would now be the 6th command).
    const cmds = Array.from({ length: 6 }, (_, i) => ({
      id: `save${i}`,
      label: `Save ${i}`,
      enLabel: `Save ${i}`,
    }));
    unregister?.();
    unregister = registerCommandProvider(() =>
      cmds.map((c) => ({ id: c.id, labelKey: "actions.save", run: runSpy })),
    );
    const summary = fixtureSummary();
    summary.markers = [
      { id: "mk1", t_us: 5_000_000, end_t_us: null, label: "save point", color_hint: "" },
    ];
    useSearchIndexStore.setState({ entries: buildEntries(summary, cmds, LOCALE), version: 1 });

    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("save");
    // flat: 5 visible commands (indices 0-4), then the marker (index 5).
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    const before = screen.getAllByRole("option");
    expect(before).toHaveLength(6);
    expect(before[5]?.getAttribute("aria-selected")).toBe("true");
    expect(before[5]?.textContent).toContain("save point");

    await userEvent.click(screen.getByText(/Show 1 more/i));
    expect(screen.getAllByRole("option")).toHaveLength(7);
    await userEvent.keyboard("{Enter}");
    expect(jumpToTimeUs).toHaveBeenCalledWith(5_000_000);
    expect(runSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
