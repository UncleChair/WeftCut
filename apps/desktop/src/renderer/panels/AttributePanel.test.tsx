// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "../i18n";
import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    updateLayer: vi.fn().mockResolvedValue(undefined),
    updateLayerParams: vi.fn().mockResolvedValue(undefined),
    moveLayer: vi.fn().mockResolvedValue(undefined),
    trimLayer: vi.fn().mockResolvedValue(undefined),
  };
});

import { updateLayer, updateLayerParams, moveLayer, trimLayer } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";

// Mock AppSwitch to a plain button so jsdom never hits Base UI's PointerEvent
// constructor (which jsdom doesn't implement) — same convention as
// properties/EffectsSection.test.tsx. These tests cover the wiring, not the
// switch widget itself.
vi.mock("../components/AppSwitch", () => ({
  AppSwitch: ({ checked, onCheckedChange, ariaLabel, disabled, "data-testid": testId }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    ariaLabel?: string;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { AttributePanel } from "./AttributePanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProjectStore.getState().apply(null);
  clearLayerSelection();
});

function colorTrack(): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: "Visual",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-1",
        kind: "Color",
        label: "Card",
        t_start_us: 0,
        t_end_us: 2_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [
          { id: "effect-1", kind: "blur", enabled: true, params: {} },
        ],
        params: {
          kind: "Color",
          color: {
            mode: "Static",
            value: { r: 0, g: 0, b: 0, a: 255 },
          },
          width: 1920,
          height: 1080,
        },
      } as LayerSummary,
    ],
  };
}

describe("AttributePanel boundary", () => {
  it("renders and edits kind-specific fields without owning the effect chain", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(
      <AttributePanel
        tracks={[colorTrack()]}
        selectedLayerId="layer-1"
        onMutated={onMutated}
        fpsNum={30}
        fpsDen={1}
        currentTimeUs={1_000_000}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Properties" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Color" })).toBeTruthy();
    expect(screen.queryByText("Effects")).toBeNull();

    fireEvent.change(screen.getByLabelText("Color"), {
      target: { value: "#ff0000" },
    });

    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-1", {
        kind: "Color",
        color: { r: 255, g: 0, b: 0, a: 255 },
      }),
    );
    expect(onMutated).toHaveBeenCalledOnce();
  });

  it("shows the existing empty state without an Effect surface", () => {
    render(
      <AttributePanel
        tracks={[]}
        selectedLayerId={null}
        onMutated={async () => {}}
        fpsNum={30}
        fpsDen={1}
        currentTimeUs={0}
      />,
    );

    expect(screen.getByText("Select a layer to edit its properties.")).toBeTruthy();
    expect(screen.queryByText("Effects")).toBeNull();
  });
});

function renderPanel(track: TrackSummary, layerId = "layer-1") {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  render(
    <AttributePanel
      tracks={[track]}
      selectedLayerId={layerId}
      onMutated={onMutated}
      fpsNum={30}
      fpsDen={1}
      currentTimeUs={1_000_000}
    />,
  );
  return onMutated;
}

function summaryWithGroups(groups: ProjectSummary["groups"]): void {
  useProjectStore.getState().apply({
    project_id: "p",
    name: "P",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
    track_count: 1,
    layer_count: 1,
    duration_us: 2_000_000,
    history: { cursor: 0, len: 1, can_undo: false, can_redo: false },
    media: [],
    tracks: [],
    markers: [],
    groups,
    audio_roles: [],
  } as ProjectSummary);
}

function envelope(): HTMLElement {
  return screen.getByRole("region", { name: "Layer" });
}

describe("AttributePanel Layer envelope", () => {
  it("shows label, kind, track, group, enabled, locked, Start, End, and duration for the primary Layer", () => {
    summaryWithGroups([{ id: "g1", label: "Intro", layer_ids: ["layer-1"] }]);
    renderPanel(colorTrack());

    const env = envelope();
    expect(within(env).getByLabelText("Label")).toHaveProperty("value", "Card");
    // Kind + Track + group state are read-only context, not edit surfaces.
    expect(within(env).getByText("Color")).toBeTruthy();
    expect(within(env).getByText("Visual")).toBeTruthy();
    expect(within(env).getByText("Intro")).toBeTruthy();
    expect(within(env).getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
    expect(within(env).getByRole("switch", { name: "Locked" }).getAttribute("aria-checked")).toBe("false");
    // 30 fps: 0 µs → 00:00:00:00, 2 s → 00:00:02:00; duration = End − Start.
    expect(within(env).getByLabelText("Start")).toHaveProperty("value", "00:00:00:00");
    expect(within(env).getByLabelText("End")).toHaveProperty("value", "00:00:02:00");
    expect(within(env).getByLabelText("Duration")).toHaveProperty("value", "00:00:02:00");
  });

  it("shows an explicit none state when the Layer belongs to no group", () => {
    summaryWithGroups([]);
    renderPanel(colorTrack());
    expect(within(envelope()).getByText("None")).toBeTruthy();
  });
});

describe("AttributePanel envelope command routing", () => {
  it("routes label, enabled, and locked edits through update_layer", async () => {
    const onMutated = renderPanel(colorTrack());
    const env = envelope();

    fireEvent.change(within(env).getByLabelText("Label"), { target: { value: "Hero card" } });
    fireEvent.blur(within(env).getByLabelText("Label"));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledWith("layer-1", { label: "Hero card" }));

    fireEvent.click(within(env).getByRole("switch", { name: "Enabled" }));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledWith("layer-1", { enabled: false }));

    fireEvent.click(within(env).getByRole("switch", { name: "Locked" }));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledWith("layer-1", { locked: true }));

    expect(onMutated).toHaveBeenCalledTimes(3);
    expect(moveLayer).not.toHaveBeenCalled();
    expect(trimLayer).not.toHaveBeenCalled();
  });

  it("routes Start through the group-aware move command with the Layer's current Track", async () => {
    const onMutated = renderPanel(colorTrack());
    const start = within(envelope()).getByLabelText("Start");
    fireEvent.change(start, { target: { value: "00:00:01:00" } });
    fireEvent.blur(start);
    await vi.waitFor(() =>
      expect(moveLayer).toHaveBeenCalledWith("layer-1", "track-1", 1_000_000),
    );
    expect(trimLayer).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalledOnce();
  });

  it("routes End and duration through the group-aware trim command", async () => {
    const onMutated = renderPanel(colorTrack());
    const env = envelope();

    const end = within(env).getByLabelText("End");
    fireEvent.change(end, { target: { value: "00:00:03:00" } });
    fireEvent.blur(end);
    await vi.waitFor(() => expect(trimLayer).toHaveBeenCalledWith("layer-1", "out", 3_000_000));

    // Duration 1 s from t_start 0 → trim the out-edge to 1 s.
    const dur = within(env).getByLabelText("Duration");
    fireEvent.change(dur, { target: { value: "00:00:01:00" } });
    fireEvent.blur(dur);
    await vi.waitFor(() => expect(trimLayer).toHaveBeenCalledWith("layer-1", "out", 1_000_000));

    expect(moveLayer).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalledTimes(2);
  });

  it("issues no command when an edit re-enters the current value (no no-op undo)", async () => {
    renderPanel(colorTrack());
    const env = envelope();

    const start = within(env).getByLabelText("Start");
    fireEvent.change(start, { target: { value: "00:00:00:00" } });
    fireEvent.blur(start);

    const end = within(env).getByLabelText("End");
    fireEvent.change(end, { target: { value: "00:00:02:00" } });
    fireEvent.blur(end);

    const dur = within(env).getByLabelText("Duration");
    fireEvent.change(dur, { target: { value: "00:00:02:00" } });
    fireEvent.blur(dur);

    const label = within(env).getByLabelText("Label");
    fireEvent.change(label, { target: { value: "Card" } });
    fireEvent.blur(label);

    await new Promise((r) => setTimeout(r, 50));
    expect(moveLayer).not.toHaveBeenCalled();
    expect(trimLayer).not.toHaveBeenCalled();
    expect(updateLayer).not.toHaveBeenCalled();
  });

  it("rejects an invalid timecode by reverting the field without a command", async () => {
    renderPanel(colorTrack());
    const start = within(envelope()).getByLabelText("Start");
    fireEvent.change(start, { target: { value: "not-a-timecode" } });
    fireEvent.blur(start);
    await new Promise((r) => setTimeout(r, 50));
    expect(moveLayer).not.toHaveBeenCalled();
    expect(start).toHaveProperty("value", "00:00:00:00");
  });

  it("disables timing edits on a locked Layer, keeping label and flags editable", () => {
    const locked = colorTrack();
    locked.layers[0] = { ...locked.layers[0], locked: true } as LayerSummary;
    renderPanel(locked);
    const env = envelope();
    expect(within(env).getByLabelText("Start")).toHaveProperty("disabled", true);
    expect(within(env).getByLabelText("End")).toHaveProperty("disabled", true);
    expect(within(env).getByLabelText("Duration")).toHaveProperty("disabled", true);
    expect(within(env).getByLabelText("Label")).toHaveProperty("disabled", false);
    expect(within(env).getByRole("switch", { name: "Locked" })).toHaveProperty("disabled", false);
  });
});

function audioTrack(): TrackSummary {
  return {
    id: "track-a",
    kind: "Audio",
    label: "A1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-a1",
        kind: "Audio",
        label: "Voice",
        t_start_us: 0,
        t_end_us: 4_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [],
        params: {
          kind: "Audio",
          media_id: "m1",
          media_label: "voice.wav",
          src_in_us: 0,
          src_out_us: 4_000_000,
          gain_db: { mode: "Static", value: 0 },
          pan: { mode: "Static", value: 0 },
          fade_in_us: 0,
          fade_out_us: 0,
          mute: false,
          role: "dialogue",
        },
      } as LayerSummary,
    ],
  };
}

describe("AttributePanel multi-selection", () => {
  it("identifies which primary layer is edited when several layers are selected", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    renderPanel(colorTrack());
    const note = screen.getByText(/changes apply only to this layer/);
    expect(note.textContent).toContain("“Card”");
    expect(note.textContent).toContain("2 layers selected");
  });

  it("omits the primary-layer note for a single selection", () => {
    setLayerSelection("layer-1", ["layer-1"]);
    renderPanel(colorTrack());
    expect(screen.queryByText(/changes apply only to this layer/)).toBeNull();
  });
});

describe("AttributePanel Audio fields", () => {
  it("exposes per-Layer gain, pan, fades, mute, and Audio Role", async () => {
    const onMutated = renderPanel(audioTrack(), "layer-a1");

    // gain/pan are keyframable rows (labels come from the param descriptors).
    expect(screen.getByText("Gain (dB)")).toBeTruthy();
    expect(screen.getByText("Pan")).toBeTruthy();
    expect(screen.getByLabelText("Role")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Mute" }).getAttribute("aria-checked")).toBe("false");

    const fadeIn = screen.getByLabelText("Fade in");
    expect(fadeIn).toHaveProperty("value", "00:00:00:00");
    fireEvent.change(fadeIn, { target: { value: "00:00:01:00" } });
    fireEvent.blur(fadeIn);
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-a1", { kind: "Audio", fade_in_us: 1_000_000 }),
    );

    const fadeOut = screen.getByLabelText("Fade out");
    fireEvent.change(fadeOut, { target: { value: "00:00:02:00" } });
    fireEvent.blur(fadeOut);
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-a1", { kind: "Audio", fade_out_us: 2_000_000 }),
    );

    expect(onMutated).toHaveBeenCalledTimes(2);
  });
});

describe("AttributePanel Audio fade guards", () => {
  it("skips the fade command when the field still holds the current value", async () => {
    renderPanel(audioTrack(), "layer-a1");
    const fadeIn = screen.getByLabelText("Fade in");
    fireEvent.change(fadeIn, { target: { value: "00:00:00:00" } });
    fireEvent.blur(fadeIn);
    await new Promise((r) => setTimeout(r, 50));
    expect(updateLayerParams).not.toHaveBeenCalled();
  });
});
