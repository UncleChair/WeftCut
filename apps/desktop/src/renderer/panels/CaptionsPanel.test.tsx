// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import "../i18n";
import { CaptionPanel } from "./CaptionPanel";
import { useProjectStore } from "../state/projectStore";

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    updateLayerParams: vi.fn().mockResolvedValue(undefined),
    restyleCaptions: vi.fn().mockResolvedValue(undefined),
  };
});

import { updateLayerParams, restyleCaptions } from "../ipc";

const ignoreCueActivation = () => {};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/// A Text caption layer at `startUs` with `content` and font size `size`.
function textLayer(id: string, startUs: number, content: string, size = 54) {
  return {
    id,
    label: null,
    t_start_us: startUs,
    t_end_us: startUs + 1_000_000,
    kind: "Text",
    color_hint: "#fff",
    enabled: true,
    locked: false,
    params: {
      kind: "Text" as const,
      content,
      font_family: "Liberation Sans",
      font_size_px: size,
      weight: 400,
      italic: false,
      align: "Center" as const,
      anchor_x: 0.5,
      anchor_y: 1,
      color: { mode: "Static" as const, value: { r: 255, g: 255, b: 255, a: 255 } },
      x: { mode: "Static" as const, value: 960 },
      y: { mode: "Static" as const, value: 990 },
      scale_x: { mode: "Static" as const, value: 1 },
      scale_y: { mode: "Static" as const, value: 1 },
      rotation_deg: { mode: "Static" as const, value: 0 },
      opacity: { mode: "Static" as const, value: 1 },
      outline: null,
      shadow: null,
    },
    effects: [],
  };
}

function captionTrack(id: string, layers: ReturnType<typeof textLayer>[]) {
  return {
    id,
    kind: "Text",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "caption" as const,
    transient: false,
    layers,
  };
}

function apply(tracks: ReturnType<typeof captionTrack>[]) {
  useProjectStore.getState().apply({
    project_id: "p1",
    name: "Test",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
    track_count: tracks.length,
    layer_count: tracks.reduce((n, t) => n + t.layers.length, 0),
    duration_us: 3_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    markers: [],
    groups: [],
    audio_roles: [],
    tracks,
  });
}

/// Single caption track with one cue "Hello" at 1s (layer L1 / track t1).
function seed() {
  apply([captionTrack("t1", [textLayer("L1", 1_000_000, "Hello")])]);
}

describe("CaptionsPanel", () => {
  it("shows empty placeholder when no caption tracks", () => {
    useProjectStore.getState().apply(null);
    render(<CaptionPanel onMutated={async () => {}} onActivateCue={ignoreCueActivation} />);
    expect(
      screen.getByText("Import a subtitle file or auto-caption to create captions."),
    ).toBeTruthy();
  });

  it("lists caption cues as editable inputs", () => {
    seed();
    render(<CaptionPanel onMutated={async () => {}} onActivateCue={ignoreCueActivation} />);
    // The cue's content appears as an input value (getByDisplayValue for inputs)
    expect(screen.getByDisplayValue("Hello")).toBeTruthy();
  });

  it("aggregates cues from every caption track in start-time order", () => {
    // Two overlapping lanes → two caption tracks; the panel flattens BOTH and
    // sorts by start, so the earlier cue on track t2 precedes t1's cue.
    apply([
      captionTrack("t1", [textLayer("L1", 1_000_000, "second")]),
      captionTrack("t2", [textLayer("L2", 500_000, "first")]),
    ]);
    const { container } = render(
      <CaptionPanel onMutated={async () => {}} onActivateCue={ignoreCueActivation} />,
    );
    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input.caption-text"),
    );
    expect(inputs.map((i) => i.value)).toEqual(["first", "second"]);
  });

  it("activates a cue (select + seek + reveal) through onActivateCue", () => {
    seed();
    const onActivateCue = vi.fn();
    render(<CaptionPanel onMutated={async () => {}} onActivateCue={onActivateCue} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to caption at 00:01" }));
    // layerId, trackId, startUs — the host composes select/seek/reveal from these.
    expect(onActivateCue).toHaveBeenCalledWith("L1", "t1", 1_000_000);
  });

  it("marks the selected cue row", () => {
    seed();
    const { container } = render(
      <CaptionPanel
        onMutated={async () => {}}
        onActivateCue={ignoreCueActivation}
        selectedLayerId="L1"
      />,
    );
    expect(container.querySelector(".caption-row.is-selected")).toBeTruthy();
  });

  it("calls updateLayerParams on blur with changed value (inline text edit)", async () => {
    seed();
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<CaptionPanel onMutated={onMutated} onActivateCue={ignoreCueActivation} />);
    const input = screen.getByDisplayValue("Hello");
    fireEvent.change(input, { target: { value: "World" } });
    fireEvent.blur(input);
    // Allow the promise chain to settle
    await Promise.resolve();
    expect(updateLayerParams).toHaveBeenCalledWith("L1", { kind: "Text", content: "World" });
  });

  it("renders a style section with font-size and color controls", () => {
    seed();
    render(<CaptionPanel onMutated={async () => {}} onActivateCue={ignoreCueActivation} />);
    // Style heading visible
    expect(screen.getByText("Caption style")).toBeTruthy();
  });

  it("restyles the whole corpus (restyleCaptions, no track id) on font-size commit", async () => {
    seed();
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<CaptionPanel onMutated={onMutated} onActivateCue={ignoreCueActivation} />);
    // AppNumberField renders <input type="number"> with aria-label from property_panel.font_size_px
    const sizeInput = screen.getByLabelText("Font size (px)");
    fireEvent.change(sizeInput, { target: { value: "80" } });
    fireEvent.blur(sizeInput);
    await Promise.resolve();
    expect(restyleCaptions).toHaveBeenCalledWith({ font_size_px: 80 });
  });

  it("calls restyleCaptions with a color value after debounce on color change", async () => {
    vi.useFakeTimers();
    seed();
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<CaptionPanel onMutated={onMutated} onActivateCue={ignoreCueActivation} />);
    // AppColorField renders <input type="color">; query by its aria-label
    const colorInput = screen.getByLabelText("Color");
    fireEvent.change(colorInput, { target: { value: "#ff0000" } });
    // restyleCaptions is debounced at 250ms — not called yet
    expect(restyleCaptions).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    // Now the debounced call fires; allow the promise chain to settle
    await Promise.resolve();
    expect(restyleCaptions).toHaveBeenCalledOnce();
    const call = (restyleCaptions as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { color: { r: number; g: number; b: number; a: number } },
    ];
    const [patch] = call;
    expect(patch.color).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(typeof patch.color.a).toBe("number");
    vi.useRealTimers();
  });

  it("resynchronizes cue text and style after an external edit or undo", () => {
    seed();
    render(
      <CaptionPanel onMutated={async () => {}} onActivateCue={ignoreCueActivation} />,
    );

    act(() => {
      apply([captionTrack("t1", [textLayer("L1", 1_000_000, "Restored", 72)])]);
    });

    expect(screen.getByDisplayValue("Restored")).toBeTruthy();
    expect((screen.getByLabelText("Font size (px)") as HTMLInputElement).value).toBe("72");
  });
});
