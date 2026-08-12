// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";

import type {
  HistoryActor,
  HistoryStackEntry,
  HistoryStackView,
  ProjectSummary,
} from "../ipc";

const mocks = vi.hoisted(() => ({
  projectHistoryView: vi.fn(),
  projectJumpTo: vi.fn(),
  logEmit: vi.fn(),
  onProjectChanged: null as (() => void) | null,
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    projectHistoryView: mocks.projectHistoryView,
    projectJumpTo: mocks.projectJumpTo,
    logEmit: mocks.logEmit,
  };
});

vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (_event: string, callback: () => void) => {
    mocks.onProjectChanged = callback;
    return () => {
      mocks.onProjectChanged = null;
    };
  }),
}));

import { HistoryPanel } from "./HistoryPanel";
import { registerRevealTrack } from "../state/navigation";
import { useProjectStore } from "../state/projectStore";
import { playheadTimeUs, setPlayheadTimeUs } from "../state/playheadStore";
import { clearLayerSelection, useSelectionStore } from "../state/selectionStore";
import { useHistoryStore } from "../state/historyStore";

// ── Fixtures ────────────────────────────────────────────────────────────────

const USER: HistoryActor = { kind: "User" };
const agent = (client: string): HistoryActor => ({ kind: "Agent", client });

let seq = 0;
function entry(
  actor: HistoryActor,
  labelKey: string,
  overrides: Partial<HistoryStackEntry> = {},
): HistoryStackEntry {
  seq += 1;
  return {
    op_id: `op-${seq}`,
    actor,
    timestamp: "2026-08-11T10:00:00.000Z",
    summary: "UNTRANSLATED WIRE TEXT",
    label_key: labelKey,
    affected: [],
    entity_labels: [],
    ...overrides,
  };
}

function stackView(
  ops: HistoryStackEntry[],
  overrides: Partial<HistoryStackView> = {},
): HistoryStackView {
  return {
    ops,
    cursor: ops.length - 1,
    len: ops.length,
    checkpoints: [],
    evicted: 0,
    ...overrides,
  };
}

function summaryWith(layerIds: string[]): ProjectSummary {
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
    track_count: 1,
    layer_count: layerIds.length,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [
      {
        id: "t9",
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
    ],
    markers: [],
    groups: [],
    audio_roles: [],
  } as unknown as ProjectSummary;
}

/// Mount the panel with `view` as the seeded stack, waiting for the wiring
/// effect's async seed to land.
async function mountPanel(view: HistoryStackView): Promise<void> {
  mocks.projectHistoryView.mockResolvedValue(view);
  render(<HistoryPanel />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rows(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(".history-entry-row"),
  );
}

function rowAt(index: number): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    `.history-entry-row[data-history-index="${index}"]`,
  );
  if (!el) throw new Error(`no row for index ${index}`);
  return el;
}

function groupHeaders(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(".history-group-row"),
  );
}

beforeEach(() => {
  mocks.projectHistoryView.mockReset();
  mocks.projectJumpTo.mockReset().mockResolvedValue(undefined);
  mocks.logEmit.mockReset().mockResolvedValue(undefined);
  mocks.onProjectChanged = null;
  useHistoryStore.getState().reset();
  useProjectStore.getState().apply(summaryWith(["l1"]));
  clearLayerSelection();
  setPlayheadTimeUs(4_000_000);
});

afterEach(() => {
  cleanup();
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe("HistoryPanel rendering", () => {
  it("renders the translated label_key, never the wire `summary`", async () => {
    await mountPanel(
      stackView([entry(USER, "history.initial"), entry(USER, "history.layer.add")]),
    );
    expect(screen.getByText("Initial")).toBeTruthy();
    expect(screen.getByText("Added layer")).toBeTruthy();
    expect(screen.queryByText("UNTRANSLATED WIRE TEXT")).toBeNull();
  });

  it("interpolates label_args", async () => {
    await mountPanel(
      stackView([
        entry(USER, "history.media.remove_cascade", {
          label_args: { media: "beach.mp4", count: 2 },
        }),
      ]),
    );
    expect(
      screen.getByText("Removed media beach.mp4 and 2 referencing layer(s)"),
    ).toBeTruthy();
  });

  it("renders entity_labels: resolved text as-is, kind_key through t()", async () => {
    await mountPanel(
      stackView([
        entry(USER, "history.layer.delete", {
          affected: [
            { kind: "Layer", id: "l1" },
            { kind: "Layer", id: "l2" },
          ],
          entity_labels: [{ text: "beach.mp4" }, { kind_key: "kinds.color" }],
        }),
      ]),
    );
    // `kinds.color` → "Color"; main holds no locale bundle, so the kind rung
    // travels as a key.
    expect(screen.getByText("beach.mp4, Color")).toBeTruthy();
  });

  it("greys the redo tail and keeps it clickable", async () => {
    await mountPanel(
      stackView(
        [
          entry(USER, "history.initial"),
          entry(USER, "history.layer.add"),
          entry(USER, "history.layer.trim"),
        ],
        { cursor: 1 },
      ),
    );
    expect(rowAt(0).dataset.state).toBe("past");
    expect(rowAt(1).dataset.state).toBe("current");
    expect(rowAt(1).getAttribute("aria-current")).toBe("true");
    expect(rowAt(2).dataset.state).toBe("future");
    expect(rowAt(2).disabled).toBe(false);

    fireEvent.click(rowAt(2));
    await act(async () => {});
    expect(mocks.projectJumpTo).toHaveBeenCalledWith(2);
  });

  it("renders the eviction header as a NON-interactive row", async () => {
    await mountPanel(
      stackView([entry(USER, "history.layer.add")], { evicted: 37 }),
    );
    const header = document.querySelector(".history-evicted-row");
    expect(header?.textContent).toBe("37 earlier steps are out of range");
    expect(header?.tagName).not.toBe("BUTTON");
    expect(document.querySelector("button.history-evicted-row")).toBeNull();
  });

  it("shows the Initial entry as an ordinary top row when nothing was evicted", async () => {
    await mountPanel(
      stackView([entry(USER, "history.initial"), entry(USER, "history.layer.add")]),
    );
    expect(document.querySelector(".history-evicted-row")).toBeNull();
    expect(rowAt(0).textContent).toContain("Initial");
    expect(rowAt(0).disabled).toBe(false);
  });

  it("shows an empty state for a project with no recorded edits", async () => {
    await mountPanel(stackView([]));
    expect(screen.getByText("No edits recorded yet.")).toBeTruthy();
  });
});

// ── Folding ─────────────────────────────────────────────────────────────────

describe("HistoryPanel agent folding", () => {
  const foldedView = () =>
    stackView([
      entry(USER, "history.initial"),
      entry(agent("claude"), "history.layer.split"),
      entry(agent("claude"), "history.layer.split"),
      entry(agent("claude"), "history.marker.add"),
      entry(USER, "history.layer.trim"),
    ]);

  it("folds the agent run and aggregates its own label keys", async () => {
    await mountPanel(foldedView());
    const headers = groupHeaders();
    expect(headers).toHaveLength(1);
    expect(headers[0]!.textContent).toContain("claude");
    expect(headers[0]!.textContent).toContain("3 steps");
    expect(
      document.querySelector(".history-group-aggregate")?.textContent,
    ).toBe("Split layer ×2, Added marker");
    // Collapsed: only the two human rows are rendered as entries.
    expect(rows().map((r) => r.dataset.historyIndex)).toEqual(["0", "4"]);
  });

  it("expands to individually clickable steps and collapses again", async () => {
    await mountPanel(foldedView());
    const toggle = screen.getByRole("button", { name: "Show every step" });
    fireEvent.click(toggle);
    expect(rows().map((r) => r.dataset.historyIndex)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);

    fireEvent.click(rowAt(2));
    await act(async () => {});
    expect(mocks.projectJumpTo).toHaveBeenCalledWith(2);

    fireEvent.click(screen.getByRole("button", { name: "Collapse the run" }));
    expect(rows().map((r) => r.dataset.historyIndex)).toEqual(["0", "4"]);
  });

  it("jumps a group header to the state BEFORE the run", async () => {
    await mountPanel(foldedView());
    fireEvent.click(groupHeaders()[0]!);
    await act(async () => {});
    expect(mocks.projectJumpTo).toHaveBeenCalledWith(0);
  });

  it("disables a group header whose predecessor was evicted", async () => {
    await mountPanel(
      stackView(
        [
          entry(agent("claude"), "history.layer.split"),
          entry(agent("claude"), "history.layer.split"),
          entry(USER, "history.layer.trim"),
        ],
        { evicted: 12 },
      ),
    );
    const header = groupHeaders()[0]!;
    expect(header.disabled).toBe(true);
    expect(header.title).toBe("The state before this run is out of range");
  });

  it("marks a collapsed group current while the cursor sits inside it", async () => {
    await mountPanel(stackView(foldedView().ops, { cursor: 2 }));
    expect(groupHeaders()[0]!.dataset.state).toBe("current");
  });
});

// ── Locking ─────────────────────────────────────────────────────────────────

describe("HistoryPanel lock", () => {
  it("makes every row non-interactive with the reason as tooltip", async () => {
    await mountPanel(
      stackView(
        [
          entry(USER, "history.initial"),
          entry(agent("claude"), "history.layer.split"),
          entry(agent("claude"), "history.layer.split"),
        ],
        { lock_reason: "agent is reverting" },
      ),
    );
    for (const row of rows()) {
      expect(row.disabled).toBe(true);
      expect(row.title).toBe("History is locked: agent is reverting");
    }
    expect(groupHeaders()[0]!.disabled).toBe(true);
    expect(
      document.querySelector(".history-lock-reason")?.textContent,
    ).toBe("History is locked: agent is reverting");

    fireEvent.click(rows()[0]!);
    await act(async () => {});
    expect(mocks.projectJumpTo).not.toHaveBeenCalled();
  });
});

// ── Click → jump → linkage ──────────────────────────────────────────────────

describe("HistoryPanel jump + linkage", () => {
  it("resolves the linkage only AFTER the post-jump refetch lands", async () => {
    const reveal = vi.fn();
    const unregister = registerRevealTrack(reveal);
    // The stale index does not hold `l9` yet — resolving now would select
    // nothing at all.
    useProjectStore.getState().apply(summaryWith(["l1"]));

    await mountPanel(
      stackView([
        entry(USER, "history.initial"),
        entry(USER, "history.layer.add", {
          affected: [{ kind: "Layer", id: "l9" }],
          entity_labels: [{ text: "beach.mp4" }],
        }),
      ]),
    );

    fireEvent.click(rowAt(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The cursor moved; the linkage is parked waiting for the refetch.
    expect(mocks.projectJumpTo).toHaveBeenCalledWith(1);
    expect(reveal).not.toHaveBeenCalled();
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();

    // `project:changed` → `projectSummary()` lands; NOW `l9` is resolvable.
    await act(async () => {
      useProjectStore.getState().apply(summaryWith(["l1", "l9"]));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reveal).toHaveBeenCalledWith("t9", "l9");
    // …and the playhead never moved.
    expect(playheadTimeUs()).toBe(4_000_000);
    unregister();
  });

  it("reveals a Track-only row without selecting anything", async () => {
    const reveal = vi.fn();
    const unregister = registerRevealTrack(reveal);
    await mountPanel(
      stackView([
        entry(USER, "history.track.add", {
          affected: [{ kind: "Track", id: "t9" }],
          entity_labels: [{ text: "A-Roll" }],
        }),
      ]),
    );

    fireEvent.click(rowAt(0));
    await act(async () => {
      await Promise.resolve();
      useProjectStore.getState().apply(summaryWith(["l1"]));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reveal).toHaveBeenCalledWith("t9", null);
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    unregister();
  });

  it("skips the linkage when the jump itself is refused", async () => {
    const reveal = vi.fn();
    const unregister = registerRevealTrack(reveal);
    mocks.projectJumpTo.mockRejectedValueOnce(new Error("HistoryLocked"));
    await mountPanel(
      stackView([
        entry(USER, "history.layer.add", {
          affected: [{ kind: "Layer", id: "l1" }],
        }),
      ]),
    );

    fireEvent.click(rowAt(0));
    await act(async () => {
      useProjectStore.getState().apply(summaryWith(["l1"]));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reveal).not.toHaveBeenCalled();
    unregister();
  });
});

// ── Sticky scroll ───────────────────────────────────────────────────────────

describe("HistoryPanel sticky cursor follow", () => {
  // jsdom does no layout, so the geometry the effect reads is stubbed: the
  // rules under test are "does it scroll" and "does it yield", not pixels.
  function stubGeometry(el: HTMLElement, values: Record<string, number>): void {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(el, key, { value, configurable: true });
    }
  }

  async function refetch(view: HistoryStackView): Promise<void> {
    mocks.projectHistoryView.mockResolvedValue(view);
    await act(async () => {
      mocks.onProjectChanged!();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("follows the cursor, yields when the user scrolls up, resumes at the bottom", async () => {
    // Stable op_ids across refetches (so React reuses the row nodes and the
    // stubbed geometry survives), fresh array identity each time (so the
    // follow effect actually re-runs).
    const ops = Array.from({ length: 4 }, () => entry(USER, "history.layer.add"));
    const nextView = () => stackView([...ops], { cursor: 3 });
    await mountPanel(nextView());

    const list = document.querySelector<HTMLElement>(".history-stack")!;
    Object.defineProperty(list, "scrollTop", { value: 0, writable: true });
    stubGeometry(list, { scrollHeight: 300, clientHeight: 100 });
    stubGeometry(rowAt(3), { offsetTop: 250, offsetHeight: 20 });

    await refetch(nextView());
    // Cursor row bottom (270) sits past the viewport bottom → scrolled to
    // hold it in view.
    expect(list.scrollTop).toBe(170);

    // The user scrolls up: 200 px from the bottom, well past the 24 px slack.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    await refetch(nextView());
    expect(list.scrollTop).toBe(0);

    // …and back to the bottom, which re-arms the follow: the next cursor move
    // (here a jump back to the top of the stack) is followed again.
    list.scrollTop = 200;
    fireEvent.scroll(list);
    stubGeometry(rowAt(0), { offsetTop: 0, offsetHeight: 20 });
    await refetch(stackView([...ops], { cursor: 0 }));
    expect(list.scrollTop).toBe(0);
  });
});

// ── Store lifecycle ─────────────────────────────────────────────────────────

describe("HistoryPanel data lifecycle", () => {
  it("refetches on project:changed and stops on unmount", async () => {
    await mountPanel(stackView([entry(USER, "history.initial")]));
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(1);

    mocks.projectHistoryView.mockResolvedValue(
      stackView([entry(USER, "history.initial"), entry(USER, "history.layer.add")]),
    );
    await act(async () => {
      mocks.onProjectChanged!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rows()).toHaveLength(2);

    cleanup();
    expect(mocks.onProjectChanged).toBeNull();
    expect(useHistoryStore.getState().view).toBeNull();
  });
});
