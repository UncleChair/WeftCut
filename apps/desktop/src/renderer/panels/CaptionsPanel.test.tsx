// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "../i18n";
import { CaptionsPanel } from "./CaptionsPanel";
import { useProjectStore } from "../state/projectStore";

vi.mock("../state/playbackStore", () => ({ transportSeek: vi.fn() }));
vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, updateLayerParams: vi.fn().mockResolvedValue(undefined) };
});

import { transportSeek } from "../state/playbackStore";
import { updateLayerParams } from "../ipc";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function seed() {
  const summary = {
    project_id: "p1",
    name: "Test",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
    track_count: 1,
    layer_count: 1,
    duration_us: 3_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    markers: [],
    groups: [],
    audio_roles: [],
    tracks: [
      {
        id: "t1",
        kind: "Text",
        label: null,
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
        role: "caption" as const,
        transient: false,
        layers: [
          {
            id: "L1",
            label: null,
            t_start_us: 1_000_000,
            t_end_us: 2_000_000,
            kind: "Text",
            color_hint: "#fff",
            enabled: true,
            locked: false,
            params: {
              kind: "Text" as const,
              content: "Hello",
              font_family: "Liberation Sans",
              font_size_px: 54,
              weight: 400,
              italic: false,
              align: "Center" as const,
              anchor_x: 0.5,
              anchor_y: 1,
              color: { mode: "Static" as const, value: { r: 255, g: 255, b: 255, a: 255 } },
              x: { mode: "Static" as const, value: 960 },
              y: { mode: "Static" as const, value: 990 },
              opacity: { mode: "Static" as const, value: 1 },
              outline: null,
              shadow: null,
            },
          },
        ],
      },
    ],
  };
  useProjectStore.getState().apply(summary);
}

describe("CaptionsPanel", () => {
  it("shows empty placeholder when no caption tracks", () => {
    useProjectStore.getState().apply(null);
    render(<CaptionsPanel onMutated={async () => {}} />);
    expect(
      screen.getByText("Import a subtitle file or auto-caption to create captions."),
    ).toBeTruthy();
  });

  it("lists caption cues as editable inputs", () => {
    seed();
    render(<CaptionsPanel onMutated={async () => {}} />);
    // The cue's content appears as an input value (getByDisplayValue for inputs)
    expect(screen.getByDisplayValue("Hello")).toBeTruthy();
  });

  it("seeks to cue start when the seek button is clicked", () => {
    seed();
    render(<CaptionsPanel onMutated={async () => {}} />);
    const seekBtn = screen.getByRole("button", { name: "seek 00:01" });
    fireEvent.click(seekBtn);
    expect(transportSeek).toHaveBeenCalledWith(1_000_000);
  });

  it("calls updateLayerParams on blur with changed value", async () => {
    seed();
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<CaptionsPanel onMutated={onMutated} />);
    const input = screen.getByDisplayValue("Hello");
    fireEvent.change(input, { target: { value: "World" } });
    fireEvent.blur(input);
    // Allow the promise chain to settle
    await Promise.resolve();
    expect(updateLayerParams).toHaveBeenCalledWith("L1", { kind: "Text", content: "World" });
  });
});
