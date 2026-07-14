// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";
import type { LayerSummary, TrackSummary } from "../ipc";

const settings = vi.hoisted(() => ({ displayMode: "AbRoll" }));

vi.mock("../settings/appSettingsStore", () => ({
  useDeltaWindowUs: () => 5_000_000,
  useDisplayMode: () => settings.displayMode,
}));

vi.mock("../state/playheadStore", () => ({
  usePlayheadTimeUsThrottled: () => 1_000_000,
}));

vi.mock("./MediaThumbnail", () => ({
  MediaThumbnail: () => <span>thumbnail</span>,
}));

import { NearbyPanel } from "./NearbyPanel";

beforeEach(() => {
  settings.displayMode = "AbRoll";
});

afterEach(() => cleanup());

function nearbyTrack(): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: "B-roll",
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
        label: "Clip one",
        t_start_us: 500_000,
        t_end_us: 1_500_000,
        enabled: true,
        locked: false,
        color_hint: "#888",
        params: { kind: "Color" } as LayerSummary["params"],
        effects: [],
      },
    ],
  };
}

function renderPanel(tracks: TrackSummary[], onPick = vi.fn()) {
  render(
    <NearbyPanel
      tracks={tracks}
      selectedLayerId={null}
      fpsNum={30}
      fpsDen={1}
      onPick={onPick}
    />,
  );
  return onPick;
}

describe("NearbyPanel", () => {
  it("contributes no layout outside A/B Roll mode", () => {
    settings.displayMode = "ShowAll";
    const { container } = render(
      <NearbyPanel
        tracks={[nearbyTrack()]}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={() => {}}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("collapses when the nearby window has no items", () => {
    const { container } = render(
      <NearbyPanel
        tracks={[]}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={() => {}}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nearby items and reports the picked layer and track", () => {
    const onPick = renderPanel([nearbyTrack()]);

    expect(screen.getByText("Near playhead (1)")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Clip one"));
    expect(onPick).toHaveBeenCalledWith("layer-1", "track-1");
  });
});
