import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectSummary } from "../ipc";
import { registerRevealTrack } from "../state/navigation";
import { useProjectStore } from "../state/projectStore";
import { playheadTimeUs, setPlayheadTimeUs } from "../state/playheadStore";
import {
  clearLayerSelection,
  useSelectionStore,
} from "../state/selectionStore";
import { afterNextProjectSummary, revealAffected } from "./historyLinkage";

/// Two tracks, two layers. Only the fields the linkage touches need to be
/// realistic.
function fixtureSummary(layerIds: string[] = ["l1", "l2"]): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: {
      width: 1920,
      height: 1080,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
    },
    track_count: 2,
    layer_count: layerIds.length,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [
      {
        id: "t1",
        kind: "Video",
        label: "A-Roll",
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
        role: "a-roll",
        transient: false,
        layers: layerIds.map((id, i) => ({
          id,
          label: null,
          t_start_us: i * 1_000_000,
          t_end_us: (i + 1) * 1_000_000,
          kind: "Color",
          color_hint: "",
          enabled: true,
          locked: false,
          effects: [],
          params: {
            kind: "Color",
            color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 1 } },
            width: 1920,
            height: 1080,
          },
        })),
      },
      {
        id: "t2",
        kind: "Video",
        label: "Overlay",
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
        role: null,
        transient: false,
        layers: [],
      },
    ],
    markers: [],
    groups: [],
    audio_roles: [],
  } as unknown as ProjectSummary;
}

beforeEach(() => {
  useProjectStore.getState().apply(fixtureSummary());
  clearLayerSelection();
  setPlayheadTimeUs(4_000_000);
  vi.clearAllMocks();
});

describe("revealAffected", () => {
  it("selects + reveals the first resolvable Layer WITHOUT seeking", () => {
    const reveal = vi.fn();
    const un = registerRevealTrack(reveal);
    expect(
      revealAffected([
        { kind: "Marker", id: "m9" },
        { kind: "Layer", id: "l2" },
      ]),
    ).toBe(true);
    expect(reveal).toHaveBeenCalledWith("t1", "l2");
    // The playhead is the user's observation point: a history jump changes
    // what is ON the timeline, not which frame is being looked at.
    expect(playheadTimeUs()).toBe(4_000_000);
    un();
  });

  it("prefers a Layer over a Track even when the Track ref comes first", () => {
    const reveal = vi.fn();
    const un = registerRevealTrack(reveal);
    expect(
      revealAffected([
        { kind: "Track", id: "t2" },
        { kind: "Layer", id: "l1" },
      ]),
    ).toBe(true);
    expect(reveal).toHaveBeenCalledExactlyOnceWith("t1", "l1");
    un();
  });

  it("reveals a Track-only row with a null layer id, selecting nothing", () => {
    const reveal = vi.fn();
    const un = registerRevealTrack(reveal);
    expect(revealAffected([{ kind: "Track", id: "t2" }])).toBe(true);
    expect(reveal).toHaveBeenCalledWith("t2", null);
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    un();
  });

  it("falls back to a plain selection when no reveal handle is mounted", () => {
    expect(revealAffected([{ kind: "Layer", id: "l1" }])).toBe(true);
    expect(useSelectionStore.getState().primaryLayerId).toBe("l1");
  });

  it("resolves nothing for stale refs, an empty array, or markers only", () => {
    const reveal = vi.fn();
    const un = registerRevealTrack(reveal);
    expect(revealAffected([])).toBe(false);
    expect(revealAffected([{ kind: "Layer", id: "ghost" }])).toBe(false);
    expect(revealAffected([{ kind: "Marker", id: "m1" }])).toBe(false);
    expect(revealAffected([{ kind: "Track", id: "ghost" }])).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
    un();
  });
});

describe("afterNextProjectSummary", () => {
  it("resolves on the next projectStore publication, not the current one", async () => {
    const pending = afterNextProjectSummary();
    let settled = false;
    void pending.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    useProjectStore.getState().apply(fixtureSummary(["l1", "l2", "l3"]));
    await pending.settled;
    expect(settled).toBe(true);
  });

  it("stays pending across an unrelated store read", async () => {
    const pending = afterNextProjectSummary();
    let settled = false;
    void pending.settled.then(() => {
      settled = true;
    });
    useProjectStore.getState().layerById.get("l1");
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.cancel();
    await pending.settled;
  });

  it("cancel() resolves and unsubscribes", async () => {
    const pending = afterNextProjectSummary();
    pending.cancel();
    await pending.settled;
    // A later publication must not throw into a torn-down subscription.
    useProjectStore.getState().apply(fixtureSummary());
  });

  it("resolves on the timeout backstop when no broadcast ever lands", async () => {
    vi.useFakeTimers();
    try {
      const pending = afterNextProjectSummary(50);
      let settled = false;
      void pending.settled.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
