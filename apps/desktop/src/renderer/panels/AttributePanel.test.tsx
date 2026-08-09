// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { setAudioUnits } from "../state/audioUnitsStore";
import { setLayerBakeStatuses } from "../timeline/motifBakeStatusStore";
import { clearPropSectionMemory } from "../properties/PropSection";

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
  clearPropSectionMemory();
  setLayerBakeStatuses({});
  setAudioUnits("frames");
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
    const colorSection = screen.getByRole("region", { name: "Color" });
    expect(colorSection).toBeTruthy();
    expect(screen.queryByText("Effects")).toBeNull();

    fireEvent.change(within(colorSection).getByLabelText("Color"), {
      target: { value: "#ff0000" },
    });

    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-1", {
        kind: "Color",
        color: { r: 255, g: 0, b: 0, a: 255 },
      }),
    );
    // waitFor: the commit path resolves through tryMutate's refusal guard, so
    // the refresh lands a microtask after the command call.
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce());
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
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false, fps_locked: false },
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

function advanced(): HTMLElement {
  return screen.getByRole("region", { name: "Advanced" });
}

// The advanced bucket defaults collapsed; expanding it mounts its rows.
function expandAdvanced(): void {
  fireEvent.click(within(advanced()).getByRole("button", { name: "Advanced" }));
}

describe("AttributePanel Layer envelope", () => {
  it("shows identity as one meta line (kind · track · group) and keeps Label/Enabled/Duration core", () => {
    summaryWithGroups([{ id: "g1", label: "Intro", layer_ids: ["layer-1"] }]);
    renderPanel(colorTrack());

    expect(screen.getByText("Color · Visual · Intro")).toBeTruthy();
    const env = envelope();
    expect(within(env).getByLabelText("Label")).toHaveProperty("value", "Card");
    expect(within(env).getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
    // 30 fps: 2 s → 00:00:02:00; duration = End − Start.
    expect(within(env).getByLabelText("Duration")).toHaveProperty("value", "00:00:02:00");
    // The End field is gone; Locked + Start sit in the collapsed advanced bucket.
    expect(screen.queryByLabelText("End")).toBeNull();
    expect(screen.queryByLabelText("Start")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Locked" })).toBeNull();
    expandAdvanced();
    expect(within(advanced()).getByRole("switch", { name: "Locked" }).getAttribute("aria-checked")).toBe("false");
    expect(within(advanced()).getByLabelText("Start")).toHaveProperty("value", "00:00:00:00");
  });

  it("falls back to a localized none when the Layer belongs to no group", () => {
    summaryWithGroups([]);
    renderPanel(colorTrack());
    expect(screen.getByText("Color · Visual · No group")).toBeTruthy();
  });

  it("shows the media label as the identity title for media kinds only", () => {
    summaryWithGroups([]);
    renderPanel(audioTrack(), "layer-a1");
    expect(screen.getByText("Audio · A1 · No group")).toBeTruthy();
    expect(screen.getByText("voice.wav")).toBeTruthy();
    cleanup();
    clearPropSectionMemory();
    summaryWithGroups([]);
    renderPanel(colorTrack());
    expect(screen.queryByText("voice.wav")).toBeNull();
  });

  // A uuid is never a display name, and groups made from the UI are always
  // `label: null` — so an unnamed group must describe itself by member count.
  it("describes an unnamed group by its member count, not its uuid", () => {
    summaryWithGroups([
      {
        id: "019fcc4d-20d4-7f65-b368-47ecbe3ef63d",
        label: null,
        layer_ids: ["layer-1", "layer-2"],
      },
    ]);
    renderPanel(colorTrack());

    expect(screen.getByText("Color · Visual · Group of 2 layers")).toBeTruthy();
    expect(screen.queryByText(/019fcc4d/)).toBeNull();
  });

  it("names the multi-select primary after its media file when unnamed, not its uuid", () => {
    summaryWithGroups([]);
    const track = audioTrack();
    (track.layers[0] as { label: string | null }).label = null;
    setLayerSelection("layer-a1", ["layer-a1", "layer-x"]);
    renderPanel(track, "layer-a1");

    expect(screen.getByText(/“voice\.wav” — 2 layers selected/)).toBeTruthy();
    expect(screen.queryByText(/layer-a1/)).toBeNull();
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

    expandAdvanced();
    fireEvent.click(within(advanced()).getByRole("switch", { name: "Locked" }));
    await vi.waitFor(() => expect(updateLayer).toHaveBeenCalledWith("layer-1", { locked: true }));

    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledTimes(3));
    expect(moveLayer).not.toHaveBeenCalled();
    expect(trimLayer).not.toHaveBeenCalled();
  });

  it("routes Start through the group-aware move command with the Layer's current Track", async () => {
    const onMutated = renderPanel(colorTrack());
    expandAdvanced();
    const start = within(advanced()).getByLabelText("Start");
    fireEvent.change(start, { target: { value: "00:00:01:00" } });
    fireEvent.blur(start);
    await vi.waitFor(() =>
      // escapeGroup=false: a VISUAL start edit moves the whole group, as it always
      // has. Only an audio edit escapes, because a sub-frame audio start is a SLIP
      // (ADR 0038) and dragging the video member with it would put that member off
      // its own grid.
      expect(moveLayer).toHaveBeenCalledWith("layer-1", "track-1", 1_000_000, false),
    );
    expect(trimLayer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce());
  });

  // ── Sub-frame audio entry (ADR 0038 / ticket 11) ─────────────────────────────
  it("offers the audio-units selector on an audio layer only", () => {
    summaryWithGroups([]);
    renderPanel(audioTrack(), "layer-a1");
    expandAdvanced();
    expect(within(advanced()).getByLabelText("Audio units")).toBeTruthy();
    cleanup();
    clearPropSectionMemory();
    summaryWithGroups([]);
    renderPanel(colorTrack());
    expandAdvanced();
    expect(within(advanced()).queryByLabelText("Audio units")).toBeNull();
  });

  it("round-trips a sample-grid position through the Start field in samples", async () => {
    summaryWithGroups([]);
    setAudioUnits("samples");
    const onMutated = renderPanel(audioTrack(), "layer-a1");
    expandAdvanced();
    const start = within(advanced()).getByLabelText("Start");
    // The field READS the mixer's sample index for the stored µs…
    expect(start).toHaveProperty("value", "0");
    // …and a typed index commits the exact µs of THAT sample. 1608 → 33_500 µs, which
    // is half a frame off the 30 fps grid (frame 1 is 33_333) — the whole point: this
    // position is unreachable by dragging and unrepresentable on the frame grid.
    fireEvent.change(start, { target: { value: "1608" } });
    fireEvent.blur(start);
    await vi.waitFor(() =>
      // escapeGroup=true — a sub-frame audio start is a SLIP, so the video member must
      // not follow (it would land off its own grid).
      expect(moveLayer).toHaveBeenCalledWith("layer-a1", "track-a", 33_500, true),
    );
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce());
  });

  it("reads the same audio time in milliseconds when the unit is switched", () => {
    summaryWithGroups([]);
    setAudioUnits("ms");
    renderPanel(audioTrack(), "layer-a1");
    expandAdvanced();
    expect(within(advanced()).getByLabelText("Start")).toHaveProperty("value", "00:00:00.000");
    setAudioUnits("frames");
    // …and the visual layer's readouts are untouched by the mode.
    cleanup();
    clearPropSectionMemory();
    setAudioUnits("ms");
    summaryWithGroups([]);
    renderPanel(colorTrack());
    expandAdvanced();
    expect(within(advanced()).getByLabelText("Start")).toHaveProperty("value", "00:00:00:00");
    setAudioUnits("frames");
  });

  it("routes duration through the group-aware trim command", async () => {
    const onMutated = renderPanel(colorTrack());
    const env = envelope();

    // Duration 1 s from t_start 0 → trim the out-edge to 1 s.
    const dur = within(env).getByLabelText("Duration");
    fireEvent.change(dur, { target: { value: "00:00:01:00" } });
    fireEvent.blur(dur);
    await vi.waitFor(() => expect(trimLayer).toHaveBeenCalledWith("layer-1", "out", 1_000_000));

    expect(moveLayer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce());
  });

  it("issues no command when an edit re-enters the current value (no no-op undo)", async () => {
    renderPanel(colorTrack());
    const env = envelope();
    expandAdvanced();

    const start = within(advanced()).getByLabelText("Start");
    fireEvent.change(start, { target: { value: "00:00:00:00" } });
    fireEvent.blur(start);

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
    expandAdvanced();
    const start = within(advanced()).getByLabelText("Start");
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
    expandAdvanced();
    expect(within(advanced()).getByLabelText("Start")).toHaveProperty("disabled", true);
    expect(within(env).getByLabelText("Duration")).toHaveProperty("disabled", true);
    expect(within(env).getByLabelText("Label")).toHaveProperty("disabled", false);
    expect(within(advanced()).getByRole("switch", { name: "Locked" })).toHaveProperty("disabled", false);
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

function videoTrack(): TrackSummary {
  return {
    id: "track-v",
    kind: "Video",
    label: "V1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-v1",
        kind: "VideoClip",
        label: "Clip",
        t_start_us: 0,
        t_end_us: 2_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [],
        params: {
          kind: "VideoClip",
          media_id: "m1",
          media_label: "clip.mp4",
          src_in_us: 0,
          src_out_us: 2_000_000,
          x: { mode: "Static", value: 0 },
          y: { mode: "Static", value: 0 },
          scale_x: { mode: "Static", value: 1 },
          scale_y: { mode: "Static", value: 1 },
          scale_linked: true,
          rotation_deg: { mode: "Static", value: 0 },
          anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
          opacity: { mode: "Static", value: 1 },
          speed: 1,
          flip_h: false,
          flip_v: false,
          fade_in_us: 0,
          fade_out_us: 0,
        },
      } as LayerSummary,
    ],
  };
}

function motifTrack(): TrackSummary {
  return {
    id: "track-m",
    kind: "Video",
    label: "V1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-m1",
        kind: "Motif",
        label: "Badge",
        t_start_us: 0,
        t_end_us: 2_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [],
        params: {
          kind: "Motif",
          motif_id: "builtin/removed",
          x: { mode: "Static", value: 0 },
          y: { mode: "Static", value: 0 },
          scale_x: { mode: "Static", value: 1 },
          scale_y: { mode: "Static", value: 1 },
          scale_linked: true,
          rotation_deg: { mode: "Static", value: 0 },
          anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
          opacity: { mode: "Static", value: 1 },
          src_in_us: 0,
          props: {},
        },
      } as LayerSummary,
    ],
  };
}

describe("AttributePanel advanced bucket membership", () => {
  it("keeps a Video layer's fades/flips hidden until the bucket is expanded", () => {
    renderPanel(videoTrack(), "layer-v1");
    // Core stands by default…
    expect(screen.getByLabelText("Duration")).toBeTruthy();
    expect(screen.getByLabelText("Speed")).toBeTruthy();
    // …the media label moved to the meta line…
    expect(screen.getByText("clip.mp4")).toBeTruthy();
    // …and Start + the kind-advanced rows wait inside the collapsed bucket.
    expect(screen.queryByLabelText("Start")).toBeNull();
    expect(screen.queryByLabelText("Fade in")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Flip horizontal" })).toBeNull();

    expandAdvanced();
    const adv = advanced();
    expect(within(adv).getByRole("switch", { name: "Locked" })).toBeTruthy();
    expect(within(adv).getByLabelText("Start")).toBeTruthy();
    expect(within(adv).getByLabelText("Fade in")).toBeTruthy();
    expect(within(adv).getByLabelText("Fade out")).toBeTruthy();
    expect(within(adv).getByRole("switch", { name: "Flip horizontal" })).toBeTruthy();
    expect(within(adv).getByRole("switch", { name: "Flip vertical" })).toBeTruthy();
  });

  it("renders the bucket (Locked + Start) even for a Color layer", () => {
    renderPanel(colorTrack());
    expandAdvanced();
    expect(within(advanced()).getByRole("switch", { name: "Locked" })).toBeTruthy();
    expect(within(advanced()).getByLabelText("Start")).toBeTruthy();
  });

  it("hides a Motif layer's bake status unless a bake is active or failed", () => {
    renderPanel(motifTrack(), "layer-m1");
    // No status entry at all → idle → no standing row.
    expect(document.querySelector(".prop-bake-status")).toBeNull();

    act(() => setLayerBakeStatuses({ "layer-m1": { phase: "warming", done: 1, total: 4 } }));
    expect(document.querySelector(".prop-bake-status")?.textContent).toContain("Warming preview");

    act(() => setLayerBakeStatuses({ "layer-m1": { phase: "baking", done: 2, total: 4 } }));
    expect(document.querySelector(".prop-bake-status")?.textContent).toContain("Pre-baking");

    act(() => setLayerBakeStatuses({ "layer-m1": { phase: "error", done: 2, total: 4 } }));
    expect(document.querySelector(".prop-bake-status")?.textContent).toContain("Pre-bake failed");

    // Ready goes quiet again — a finished bake earns no standing row.
    act(() => setLayerBakeStatuses({ "layer-m1": { phase: "ready", done: 4, total: 4 } }));
    expect(document.querySelector(".prop-bake-status")).toBeNull();
  });
});

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
  it("exposes per-Layer gain and fades core; pan, mute, and Role in the advanced bucket", async () => {
    const onMutated = renderPanel(audioTrack(), "layer-a1");

    // gain is a keyframable core row (labels come from the param descriptors).
    expect(screen.getByText("Gain (dB)")).toBeTruthy();
    expect(screen.queryByText("Pan")).toBeNull();
    expandAdvanced();
    expect(within(advanced()).getByText("Pan")).toBeTruthy();
    expect(within(advanced()).getByLabelText("Role")).toBeTruthy();
    expect(within(advanced()).getByRole("switch", { name: "Mute" }).getAttribute("aria-checked")).toBe("false");

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

    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledTimes(2));
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
