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

function renderPanel(
  tracks: TrackSummary[],
  handlers: {
    onPick?: (layerId: string, trackId: string) => void;
    onGoTo?: (layerId: string, trackId: string, startUs: number) => void;
    onRename?: (layerId: string, nextLabel: string) => void;
  } = {},
) {
  const onPick = handlers.onPick ?? vi.fn();
  render(
    <NearbyPanel
      tracks={tracks}
      selectedLayerId={null}
      fpsNum={30}
      fpsDen={1}
      onPick={onPick}
      onGoTo={handlers.onGoTo}
      onRename={handlers.onRename}
    />,
  );
  return onPick;
}

describe("NearbyPanel", () => {
  it("explains Show All mode instead of collapsing to a blank Panel", () => {
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

    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText("All tracks visible")).toBeTruthy();
  });

  it("explains an empty nearby window instead of a blank Panel", () => {
    render(
      <NearbyPanel
        tracks={[]}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={() => {}}
      />,
    );

    expect(screen.getByText("Nothing near the playhead")).toBeTruthy();
  });

  it("renders nearby items and reveals the picked layer without seeking", () => {
    const onPick = renderPanel([nearbyTrack()]);

    expect(screen.getByText("Near playhead (1)")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Clip one"));
    expect(onPick).toHaveBeenCalledWith("layer-1", "track-1");
  });

  // Shared naming with the timeline block and the inspector. The old local chain
  // ended at the track name, so an unnamed Layer rendered "B-roll / B-roll" —
  // the row said nothing about the Layer it stood for.
  it("names an unnamed layer by its kind, not by its track", () => {
    const track = nearbyTrack();
    (track.layers[0] as { label: string | null }).label = null;
    renderPanel([track]);

    expect(screen.getByTitle("Color")).toBeTruthy();
    expect(screen.queryByTitle("B-roll")).toBeNull();
  });

  it("Go To seeks to the layer's start", () => {
    const onGoTo = vi.fn();
    renderPanel([nearbyTrack()], { onGoTo });

    fireEvent.click(screen.getByLabelText("Go to Clip one"));
    expect(onGoTo).toHaveBeenCalledWith("layer-1", "track-1", 500_000);
  });

  it("double-click renames through the label command on Enter", () => {
    const onRename = vi.fn();
    renderPanel([nearbyTrack()], { onRename });

    fireEvent.doubleClick(screen.getByTitle("Clip one"));
    const input = screen.getByLabelText("Rename Clip one");
    fireEvent.change(input, { target: { value: "Renamed clip" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("layer-1", "Renamed clip");
  });

  it("Escape cancels an inline rename without committing", () => {
    const onRename = vi.fn();
    renderPanel([nearbyTrack()], { onRename });

    fireEvent.doubleClick(screen.getByTitle("Clip one"));
    const input = screen.getByLabelText("Rename Clip one");
    fireEvent.change(input, { target: { value: "Renamed clip" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
  });
});
