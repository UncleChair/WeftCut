import { describe, expect, it } from "vitest";

import type { HistoryActor, HistoryStackEntry } from "../ipc";
import {
  aggregateLabels,
  buildHistoryItems,
  groupState,
  historyGroupId,
  rowState,
  type HistoryGroupItem,
} from "./historyRows";

const USER: HistoryActor = { kind: "User" };
const agent = (client: string): HistoryActor => ({ kind: "Agent", client });

let seq = 0;
function entry(
  actor: HistoryActor,
  labelKey = "history.layer.add",
  overrides: Partial<HistoryStackEntry> = {},
): HistoryStackEntry {
  seq += 1;
  return {
    op_id: `op-${seq}`,
    actor,
    timestamp: "2026-08-11T10:00:00.000Z",
    summary: "Added layer",
    label_key: labelKey,
    affected: [],
    entity_labels: [],
    ...overrides,
  };
}

function kinds(items: ReturnType<typeof buildHistoryItems>): string[] {
  return items.map((item) =>
    item.kind === "group"
      ? `group(${item.client}:${item.startIndex}-${item.endIndex})`
      : `entry(${item.index})`,
  );
}

describe("buildHistoryItems — fold derivation", () => {
  it("folds a run of consecutive same-client agent entries", () => {
    const items = buildHistoryItems([
      entry(USER),
      entry(agent("claude")),
      entry(agent("claude")),
      entry(agent("claude")),
    ]);
    expect(kinds(items)).toEqual(["entry(0)", "group(claude:1-3)"]);
    const group = items[1] as HistoryGroupItem;
    expect(group.entries).toHaveLength(3);
    // Header click → the state BEFORE the run.
    expect(group.jumpIndex).toBe(0);
  });

  it("does not fold a run of length 1", () => {
    const items = buildHistoryItems([
      entry(USER),
      entry(agent("claude")),
      entry(USER),
    ]);
    expect(kinds(items)).toEqual(["entry(0)", "entry(1)", "entry(2)"]);
  });

  it("never folds human runs, however long", () => {
    const items = buildHistoryItems([
      entry(USER),
      entry(USER),
      entry(USER),
      entry(USER),
    ]);
    expect(kinds(items)).toEqual([
      "entry(0)",
      "entry(1)",
      "entry(2)",
      "entry(3)",
    ]);
  });

  it("splits interleaved actors into separate runs", () => {
    const items = buildHistoryItems([
      entry(agent("claude")),
      entry(agent("claude")),
      entry(USER),
      entry(agent("claude")),
      entry(agent("claude")),
    ]);
    expect(kinds(items)).toEqual([
      "group(claude:0-1)",
      "entry(2)",
      "group(claude:3-4)",
    ]);
  });

  it("splits two different agent clients back to back", () => {
    const items = buildHistoryItems([
      entry(USER),
      entry(agent("claude")),
      entry(agent("claude")),
      entry(agent("cursor")),
      entry(agent("cursor")),
    ]);
    expect(kinds(items)).toEqual([
      "entry(0)",
      "group(claude:1-2)",
      "group(cursor:3-4)",
    ]);
    expect((items[2] as HistoryGroupItem).jumpIndex).toBe(2);
  });

  it("leaves a group starting at index 0 with no jump target", () => {
    // Eviction does not spare the `Initial` entry, so after an overflow the
    // stack can open mid-run and there is no index holding "before this run".
    const items = buildHistoryItems([
      entry(agent("claude")),
      entry(agent("claude")),
      entry(USER),
    ]);
    expect((items[0] as HistoryGroupItem).jumpIndex).toBeNull();
  });

  it("returns nothing for an empty stack", () => {
    expect(buildHistoryItems([])).toEqual([]);
  });

  it("keys a group by its first entry's op_id so expansion survives refetch", () => {
    const first = entry(agent("claude"));
    const items = buildHistoryItems([first, entry(agent("claude"))]);
    expect(historyGroupId(items[0] as HistoryGroupItem)).toBe(first.op_id);
  });
});

describe("aggregateLabels", () => {
  it("counts label keys in first-appearance order", () => {
    const aggregate = aggregateLabels([
      entry(agent("claude"), "history.layer.split"),
      entry(agent("claude"), "history.marker.add"),
      entry(agent("claude"), "history.layer.split"),
      entry(agent("claude"), "history.marker.add"),
      entry(agent("claude"), "history.marker.add"),
    ]);
    expect(aggregate).toEqual([
      { labelKey: "history.layer.split", count: 2 },
      { labelKey: "history.marker.add", count: 3 },
    ]);
  });

  it("carries the first occurrence's label_args for a templated phrase", () => {
    const aggregate = aggregateLabels([
      entry(agent("claude"), "history.audio.set_role_gain", {
        label_args: { role: "dialogue" },
      }),
      entry(agent("claude"), "history.audio.set_role_gain", {
        label_args: { role: "music" },
      }),
    ]);
    expect(aggregate).toEqual([
      {
        labelKey: "history.audio.set_role_gain",
        labelArgs: { role: "dialogue" },
        count: 2,
      },
    ]);
  });

  it("is computed per group, not across the whole stack", () => {
    const items = buildHistoryItems([
      entry(agent("claude"), "history.layer.split"),
      entry(agent("claude"), "history.layer.split"),
      entry(USER, "history.layer.split"),
      entry(agent("cursor"), "history.marker.add"),
      entry(agent("cursor"), "history.marker.add"),
    ]);
    expect((items[0] as HistoryGroupItem).aggregate).toEqual([
      { labelKey: "history.layer.split", count: 2 },
    ]);
    expect((items[2] as HistoryGroupItem).aggregate).toEqual([
      { labelKey: "history.marker.add", count: 2 },
    ]);
  });
});

describe("rowState / groupState", () => {
  it("classifies rows around the cursor", () => {
    expect(rowState(0, 2)).toBe("past");
    expect(rowState(2, 2)).toBe("current");
    expect(rowState(3, 2)).toBe("future");
  });

  it("marks a group current while the cursor sits anywhere inside it", () => {
    const items = buildHistoryItems([
      entry(USER),
      entry(agent("claude")),
      entry(agent("claude")),
      entry(agent("claude")),
      entry(USER),
    ]);
    const group = items[1] as HistoryGroupItem;
    expect(groupState(group, 0)).toBe("future");
    expect(groupState(group, 1)).toBe("current");
    expect(groupState(group, 2)).toBe("current");
    expect(groupState(group, 3)).toBe("current");
    expect(groupState(group, 4)).toBe("past");
  });
});
