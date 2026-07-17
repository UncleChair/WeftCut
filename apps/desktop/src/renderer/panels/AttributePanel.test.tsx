// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";
import type { LayerSummary, TrackSummary } from "../ipc";

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    updateLayerParams: vi.fn().mockResolvedValue(undefined),
  };
});

import { updateLayerParams } from "../ipc";
import { AttributePanel } from "./AttributePanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
