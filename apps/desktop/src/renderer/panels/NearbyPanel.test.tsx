// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

function makeLayer(
  id: string,
  label: string | null,
  kind: string,
  startUs: number,
  endUs: number,
): LayerSummary {
  return {
    id,
    kind,
    label,
    t_start_us: startUs,
    t_end_us: endUs,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind } as LayerSummary["params"],
    effects: [],
  };
}

function makeTrack(
  id: string,
  label: string,
  kind: string,
  layers: LayerSummary[],
): TrackSummary {
  return {
    id,
    kind,
    label,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: true,
    layers,
  };
}

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
    layers: [makeLayer("layer-1", "Clip one", "Color", 500_000, 1_500_000)],
  };
}

// Playhead is mocked at 1s. Track array order is bottom-of-z-stack first:
// Wash sits at the bottom, Song (audio) above it, Logo on top; Later is a
// text layer strictly in the future, so it lands in the Nearby section.
function stackedTracks(): TrackSummary[] {
  return [
    makeTrack("t-wash", "Wash lane", "Video", [
      makeLayer("l-wash", "Wash", "Color", 0, 2_000_000),
    ]),
    makeTrack("t-song", "Song lane", "Audio", [
      makeLayer("l-song", "Song", "Audio", 0, 2_000_000),
    ]),
    makeTrack("t-logo", "Logo lane", "Video", [
      makeLayer("l-logo", "Logo", "ImageOverlay", 500_000, 1_500_000),
    ]),
    makeTrack("t-later", "Later lane", "Video", [
      makeLayer("l-later", "Later", "Text", 2_000_000, 3_000_000),
    ]),
  ];
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
  const { container } = render(
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
  return { onPick, container };
}

/// Row titles inside `root`, in DOM order — the row button carries the
/// layer's display name as its title.
function rowTitles(root: HTMLElement): (string | null)[] {
  return Array.from(root.querySelectorAll(".peek-item")).map((el) =>
    el.getAttribute("title"),
  );
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
    const { onPick } = renderPanel([nearbyTrack()]);

    expect(screen.getByText("Near playhead (1)")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Clip one"));
    expect(onPick).toHaveBeenCalledWith("layer-1", "track-1");
  });

  // Shared naming with the timeline block and the inspector: a row must name
  // the Layer it stands for, never fall back to its track's name.
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

describe("NearbyPanel two sections", () => {
  it("splits rows at the playhead into an At-playhead stack and a Nearby list", () => {
    const { container } = renderPanel(stackedTracks());

    // The category section headers are retired: the only headers are the
    // playhead-boundary pair.
    const headers = Array.from(
      container.querySelectorAll(".peek-section-header"),
    ).map((el) => el.textContent);
    expect(headers).toEqual(["At playhead", "Nearby"]);

    // Visuals order top-of-stack first (Logo's track is above Wash's);
    // the spanning audio row sinks to the tail despite its track position.
    const stack = screen.getByRole("region", { name: "At playhead" });
    expect(rowTitles(stack)).toEqual(["Logo", "Wash", "Song"]);

    const near = screen.getByRole("region", { name: "Nearby" });
    expect(rowTitles(near)).toEqual(["Later"]);
  });

  it("shows a short hint when nothing spans the playhead", () => {
    renderPanel([
      makeTrack("t-later", "Later lane", "Video", [
        makeLayer("l-later", "Later", "Text", 2_000_000, 3_000_000),
      ]),
    ]);

    const stack = screen.getByRole("region", { name: "At playhead" });
    expect(
      within(stack).getByText("Nothing spans the playhead right now"),
    ).toBeTruthy();
    expect(rowTitles(screen.getByRole("region", { name: "Nearby" }))).toEqual([
      "Later",
    ]);
  });

  it("filters both sections through the chips", () => {
    renderPanel(stackedTracks());

    fireEvent.click(screen.getByRole("button", { name: "Audio" }));

    expect(
      rowTitles(screen.getByRole("region", { name: "At playhead" })),
    ).toEqual(["Song"]);
    expect(screen.queryByTitle("Logo")).toBeNull();
    expect(screen.queryByTitle("Later")).toBeNull();
    // An emptied Nearby section disappears rather than sitting as a bare header.
    expect(screen.queryByRole("region", { name: "Nearby" })).toBeNull();
  });

  it("a filter can empty the stack: the hint shows while Nearby keeps its rows", () => {
    renderPanel(stackedTracks());

    fireEvent.click(screen.getByRole("button", { name: "Text" }));

    expect(
      screen.getByText("Nothing spans the playhead right now"),
    ).toBeTruthy();
    expect(rowTitles(screen.getByRole("region", { name: "Nearby" }))).toEqual([
      "Later",
    ]);
  });

  it("keeps the filtered-empty message when nothing of the kind is in the window", () => {
    const { container } = renderPanel([nearbyTrack()]);

    fireEvent.click(screen.getByRole("button", { name: "Text" }));

    expect(
      screen.getByText("Nothing of that kind near the playhead"),
    ).toBeTruthy();
    expect(container.querySelectorAll(".peek-section-header")).toHaveLength(0);
  });

  it("keeps LIVE badge, track name, offset and duration on every row", () => {
    renderPanel(stackedTracks());

    const logo = screen.getByTitle("Logo");
    expect(within(logo).getByText("LIVE")).toBeTruthy();
    expect(within(logo).getByText("Logo lane")).toBeTruthy();
    // Logo runs 0.5s → 1.5s: one second at 30 fps.
    expect(within(logo).getByText("00:00:01:00")).toBeTruthy();

    const later = screen.getByTitle("Later");
    // Later starts one second ahead of the playhead.
    expect(within(later).getByText("+00:00:01:00")).toBeTruthy();
    expect(within(later).getByText("00:00:01:00")).toBeTruthy();
  });
});
