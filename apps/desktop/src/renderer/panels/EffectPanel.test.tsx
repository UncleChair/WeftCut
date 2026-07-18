// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "../i18n";
import type { LayerSummary, TrackSummary } from "../ipc";

vi.mock("../properties/EffectsSection", () => ({
  EffectsSection: ({
    layer,
    tInLayerUs,
    playheadInSpan,
  }: {
    layer: LayerSummary;
    tInLayerUs: number;
    playheadInSpan: boolean;
  }) => (
    <div
      data-testid="effect-chain"
      data-layer-id={layer.id}
      data-relative-time={tInLayerUs}
      data-in-span={String(playheadInSpan)}
    >
      {layer.effects.length} effect
    </div>
  ),
}));

import { EffectPanel } from "./EffectPanel";

afterEach(() => cleanup());

function trackWithLayer(
  kind: "Color" | "Audio",
  effects = 1,
): TrackSummary {
  return {
    id: "track-1",
    kind: kind === "Audio" ? "Audio" : "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-1",
        kind,
        label: null,
        t_start_us: 1_000_000,
        t_end_us: 3_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: Array.from({ length: effects }, (_, index) => ({
          id: `effect-${index}`,
          kind: "blur",
          enabled: true,
          params: {},
        })),
        params: { kind } as LayerSummary["params"],
      },
    ],
  };
}

describe("EffectPanel boundary", () => {
  it("renders the primary visual Layer's chain with playhead context", () => {
    render(
      <EffectPanel
        tracks={[trackWithLayer("Color", 2)]}
        selectedLayerId="layer-1"
        currentTimeUs={2_000_000}
        onMutated={async () => {}}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Effects" })).toBeTruthy();
    const chain = screen.getByTestId("effect-chain");
    expect(chain.getAttribute("data-layer-id")).toBe("layer-1");
    expect(chain.getAttribute("data-relative-time")).toBe("1000000");
    expect(chain.getAttribute("data-in-span")).toBe("true");
    expect(chain.textContent).toBe("2 effect");
  });

  it("shows an empty state with no chain surface when nothing is selected", () => {
    render(
      <EffectPanel
        tracks={[]}
        selectedLayerId={null}
        currentTimeUs={0}
        onMutated={async () => {}}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Effects" })).toBeTruthy();
    expect(screen.getByText("Select a layer to edit its effects.")).toBeTruthy();
    expect(screen.queryByTestId("effect-chain")).toBeNull();
  });

  it("shows an explicit unsupported state for an Audio selection with no chain surface", () => {
    render(
      <EffectPanel
        tracks={[trackWithLayer("Audio")]}
        selectedLayerId="layer-1"
        currentTimeUs={0}
        onMutated={async () => {}}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Effects" })).toBeTruthy();
    expect(screen.getByText("Audio layers don't support effects.")).toBeTruthy();
    expect(screen.queryByTestId("effect-chain")).toBeNull();
  });
});
