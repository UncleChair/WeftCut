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

// Mutable so the drag-restack tests can tick the playhead mid-gesture (the
// panel re-reads it per render; a rerender stands in for the store's throttle).
const playhead = vi.hoisted(() => ({ timeUs: 1_000_000 }));

vi.mock("../state/playheadStore", () => ({
  usePlayheadTimeUsThrottled: () => playhead.timeUs,
}));

vi.mock("./MediaThumbnail", () => ({
  MediaThumbnail: () => <span>thumbnail</span>,
}));

import { NearbyPanel } from "./NearbyPanel";

// jsdom has no PointerEvent constructor; MouseEvent carries the same client
// coordinates the pointer sequence needs (EffectsSection.test.tsx prior art).
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

beforeEach(() => {
  settings.displayMode = "AbRoll";
  playhead.timeUs = 1_000_000;
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
    onRestack?: (
      layerId: string,
      anchorLayerId: string,
      position: "above" | "below",
    ) => void;
  } = {},
) {
  const onPick = handlers.onPick ?? vi.fn();
  const { container, rerender } = render(
    <NearbyPanel
      tracks={tracks}
      selectedLayerId={null}
      fpsNum={30}
      fpsDen={1}
      onPick={onPick}
      onGoTo={handlers.onGoTo}
      onRename={handlers.onRename}
      onRestack={handlers.onRestack}
    />,
  );
  const rerenderPanel = () =>
    rerender(
      <NearbyPanel
        tracks={tracks}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={onPick}
        onGoTo={handlers.onGoTo}
        onRename={handlers.onRename}
        onRestack={handlers.onRestack}
      />,
    );
  return { onPick, container, rerenderPanel };
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

describe("NearbyPanel drag restack", () => {
  /// The At-playhead section's <li> rows in DOM order (visual stack first,
  /// audio tail after) — the elements the gesture hit-tests against.
  function stackRows(): HTMLElement[] {
    const stack = screen.getByRole("region", { name: "At playhead" });
    return Array.from(stack.querySelectorAll("li"));
  }

  // jsdom rects are all zero; give each row a real vertical slot so the
  // gesture math has something to hit (EffectsSection.test.tsx prior art).
  function mockRowRects(rows: HTMLElement[], tops: number[], height = 40) {
    rows.forEach((row, i) => {
      const top = tops[i];
      if (top === undefined) return;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 120,
          width: 120,
          x: 0,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
    });
  }

  /// stackedTracks rendered with a restack handler and the two visual rows
  /// (Logo on top, Wash below, Song as the grip-less audio tail) given rects.
  function renderStack(tracks = stackedTracks()) {
    const onRestack = vi.fn();
    const rendered = renderPanel(tracks, { onRestack });
    mockRowRects(stackRows(), [0, 40]);
    return { onRestack, ...rendered };
  }

  it("grips only the At-playhead visual rows; audio and Nearby rows carry none", () => {
    renderStack();

    expect(screen.getByLabelText("Drag to restack Logo")).toBeTruthy();
    expect(screen.getByLabelText("Drag to restack Wash")).toBeTruthy();
    // Audio mixes by role, never stacks; Nearby rows are not at the playhead.
    expect(screen.queryByLabelText("Drag to restack Song")).toBeNull();
    expect(screen.queryByLabelText("Drag to restack Later")).toBeNull();
  });

  it("renders no grips when the host wires no restack handler", () => {
    renderPanel(stackedTracks());
    expect(screen.queryByLabelText(/Drag to restack/)).toBeNull();
  });

  it("emits exactly one restack at drop, none mid-gesture, and never starts an HTML5 drag", () => {
    const { onRestack } = renderStack();
    const dragstart = vi.fn();
    document.addEventListener("dragstart", dragstart);
    try {
      const grip = screen.getByLabelText("Drag to restack Logo");
      expect(grip.getAttribute("draggable")).toBeNull();
      fireEvent.pointerDown(grip, { button: 0, clientX: 8, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });

      // Live insertion indicator mid-gesture, but no command before release.
      const rows = stackRows();
      expect(rows[0]!.className).toContain("peek-row--dragging");
      expect(rows[1]!.className).toContain("peek-row--drop-after");
      expect(onRestack).not.toHaveBeenCalled();

      fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
      expect(onRestack).toHaveBeenCalledTimes(1);
      expect(onRestack).toHaveBeenCalledWith("l-logo", "l-wash", "below");
      expect(dragstart).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("dragstart", dragstart);
    }
  });

  it("dragging the bottom visual row above the top targets 'above' the top row", () => {
    const { onRestack } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Wash"), {
      button: 0,
      clientX: 8,
      clientY: 50,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 5 });
    expect(stackRows()[0]!.className).toContain("peek-row--drop-before");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 5 });
    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-wash", "l-logo", "above");
  });

  it("dropping at a no-op gap shows no indicator and emits nothing", () => {
    const { onRestack, container } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    // y=30 is past Logo's midline: the gap right below the dragged row.
    fireEvent.pointerMove(window, { clientX: 8, clientY: 30 });
    expect(container.querySelector(".peek-row--drop-before")).toBeNull();
    expect(container.querySelector(".peek-row--drop-after")).toBeNull();
    fireEvent.pointerUp(window, { clientX: 8, clientY: 30 });
    expect(onRestack).not.toHaveBeenCalled();
  });

  it("Escape aborts the gesture; a later pointerup commits nothing", () => {
    const { onRestack } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });
    expect(stackRows()[1]!.className).toContain("peek-row--drop-after");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(stackRows()[1]!.className).not.toContain("peek-row--drop-after");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
    expect(onRestack).not.toHaveBeenCalled();
  });

  it("pointercancel disarms the gesture; a later pointerup commits nothing", () => {
    const { onRestack } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });

    fireEvent.pointerCancel(window);
    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
    expect(onRestack).not.toHaveBeenCalled();
  });

  it("freezes the row snapshot while the playhead ticks; drop resolves against the snapshot", () => {
    const { onRestack, rerenderPanel } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });

    // The playhead store ticks to 2.6s mid-gesture: live data would move
    // Logo and Wash out of At-playhead and pull Later in. Frozen rows don't.
    playhead.timeUs = 2_600_000;
    rerenderPanel();
    expect(
      rowTitles(screen.getByRole("region", { name: "At playhead" })),
    ).toEqual(["Logo", "Wash", "Song"]);

    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-logo", "l-wash", "below");

    // The gesture is over: the list snaps back to live data.
    expect(
      rowTitles(screen.getByRole("region", { name: "At playhead" })),
    ).toEqual(["Later"]);
  });

  it("under a category filter, a drop anchors on the visible row — never the hidden neighbour", () => {
    // Bottom→top: Wash (video), Caption (text, hidden by the Video chip),
    // Logo (video). The visible stack is [Logo, Wash].
    const tracks = [
      makeTrack("t-wash", "Wash lane", "Video", [
        makeLayer("l-wash", "Wash", "Color", 0, 2_000_000),
      ]),
      makeTrack("t-cap", "Caption lane", "Video", [
        makeLayer("l-cap", "Caption", "Text", 0, 2_000_000),
      ]),
      makeTrack("t-logo", "Logo lane", "Video", [
        makeLayer("l-logo", "Logo", "ImageOverlay", 500_000, 1_500_000),
      ]),
    ];
    const onRestack = vi.fn();
    renderPanel(tracks, { onRestack });
    fireEvent.click(screen.getByRole("button", { name: "Video" }));
    mockRowRects(stackRows(), [0, 40]);

    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });
    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });

    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-logo", "l-wash", "below");
  });
});
