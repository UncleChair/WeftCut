// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import "../i18n";

import type {
  HistoryCheckpointSummary,
  HistoryStackEntry,
  HistoryStackView,
} from "../ipc";

const mocks = vi.hoisted(() => ({
  projectHistoryView: vi.fn(),
  projectCreateCheckpoint: vi.fn(),
  projectDeleteCheckpoint: vi.fn(),
  projectRestoreCheckpoint: vi.fn(),
  logEmit: vi.fn(),
  onProjectChanged: null as (() => void) | null,
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    projectHistoryView: mocks.projectHistoryView,
    projectCreateCheckpoint: mocks.projectCreateCheckpoint,
    projectDeleteCheckpoint: mocks.projectDeleteCheckpoint,
    projectRestoreCheckpoint: mocks.projectRestoreCheckpoint,
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

import { CheckpointPromptDialog } from "./CheckpointPromptDialog";
import { closeCheckpointPrompt } from "./checkpointPrompt";
import { HistoryPanel } from "./HistoryPanel";
import { useHistoryStore } from "../state/historyStore";

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function entry(labelKey: string): HistoryStackEntry {
  seq += 1;
  return {
    op_id: `op-${seq}`,
    actor: { kind: "User" },
    timestamp: "2026-08-11T10:00:00.000Z",
    summary: "UNTRANSLATED WIRE TEXT",
    label_key: labelKey,
    affected: [],
    entity_labels: [],
  };
}

function checkpoint(
  overrides: Partial<HistoryCheckpointSummary> = {},
): HistoryCheckpointSummary {
  return {
    id: "cp-1",
    label: "Before the recut",
    actor: { kind: "User" },
    created_at: "2026-08-11T10:00:00.000Z",
    ...overrides,
  };
}

function stackView(
  checkpoints: HistoryCheckpointSummary[],
  overrides: Partial<HistoryStackView> = {},
): HistoryStackView {
  const ops = [entry("history.initial")];
  return {
    ops,
    cursor: ops.length - 1,
    len: ops.length,
    window_start: 0,
    checkpoints,
    evicted: 0,
    ...overrides,
  };
}

/// Mount the Panel together with the prompt dialog App owns, since the create
/// flow spans both.
async function mountPanel(view: HistoryStackView): Promise<void> {
  mocks.projectHistoryView.mockResolvedValue(view);
  render(
    <>
      <HistoryPanel />
      <CheckpointPromptDialog />
    </>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

const rows = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".history-checkpoint-row"));

const button = (name: RegExp | string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  mocks.projectHistoryView.mockReset();
  mocks.projectCreateCheckpoint.mockReset().mockResolvedValue("cp-new");
  mocks.projectDeleteCheckpoint.mockReset().mockResolvedValue(undefined);
  mocks.projectRestoreCheckpoint.mockReset().mockResolvedValue(undefined);
  mocks.logEmit.mockReset().mockResolvedValue(undefined);
  mocks.onProjectChanged = null;
  useHistoryStore.getState().reset();
  closeCheckpointPrompt();
});

afterEach(() => {
  cleanup();
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe("checkpoint section", () => {
  it("sits ABOVE the stack, in its own section rather than as stack rows", async () => {
    await mountPanel(stackView([checkpoint()]));
    const section = document.querySelector<HTMLElement>(
      '[data-history-section="checkpoints"]',
    )!;
    const stack = document.querySelector<HTMLElement>(".history-stack")!;
    expect(
      section.compareDocumentPosition(stack) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Never inline: the checkpoint is not among the jumpable stack rows.
    expect(section.contains(stack)).toBe(false);
    expect(stack.querySelectorAll(".history-checkpoint-row")).toHaveLength(0);
  });

  it("states plainly that checkpoints do not survive the session", async () => {
    await mountPanel(stackView([]));
    expect(
      screen.getAllByText(
        "This session only — checkpoints are not saved with the project.",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("says something useful when there are no checkpoints", async () => {
    await mountPanel(stackView([]));
    expect(
      screen.getByText(
        "No checkpoints yet. Create one before a risky edit to keep a named way back.",
      ),
    ).toBeTruthy();
    expect(rows()).toHaveLength(0);
  });

  it("renders label, actor badge, time, Restore and Delete per row", async () => {
    await mountPanel(
      stackView([
        checkpoint(),
        checkpoint({
          id: "cp-2",
          label: "Pre-agent: tidy the cut",
          actor: { kind: "Agent", client: "claude" },
        }),
      ]),
    );
    expect(rows()).toHaveLength(2);
    expect(screen.getByText("Before the recut")).toBeTruthy();
    expect(screen.getByText("Pre-agent: tidy the cut")).toBeTruthy();
    // Same actor vocabulary as the stack rows.
    const actors = rows().map(
      (row) =>
        row.querySelector<HTMLElement>(".history-row-actor")!.dataset.actor,
    );
    expect(actors).toEqual(["user", "agent"]);
    expect(
      rows()[1]!.querySelector(".history-row-actor")!.getAttribute("aria-label"),
    ).toBe("Agent: claude");
    expect(rows()[0]!.querySelector(".history-row-time")!.textContent).toMatch(
      /^\d\d:\d\d:\d\d$/,
    );
    expect(rows()[0]!.querySelectorAll("button")).toHaveLength(2);
  });
});

// ── Restore ─────────────────────────────────────────────────────────────────

describe("checkpoint restore", () => {
  it("restores through the existing IPC and does NOT refetch — restore broadcasts", async () => {
    await mountPanel(stackView([checkpoint()]));
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(1);

    fireEvent.click(button("Restore"));
    await settle();
    expect(mocks.projectRestoreCheckpoint).toHaveBeenCalledWith("cp-1");
    // Restore RECORDS an entry, so `project:changed` fires and the store
    // refetches itself; an explicit refresh here would be a wasted round trip.
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(1);
  });

  it("shows the new stack entry restore recorded once the broadcast lands", async () => {
    await mountPanel(stackView([checkpoint()]));
    fireEvent.click(button("Restore"));
    await settle();

    mocks.projectHistoryView.mockResolvedValue({
      ...stackView([checkpoint()]),
      ops: [entry("history.initial"), entry("history.checkpoint.restore")],
      cursor: 1,
      len: 2,
    });
    await act(async () => {
      mocks.onProjectChanged!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelectorAll(".history-entry-row")).toHaveLength(2);
  });
});

// ── Create ──────────────────────────────────────────────────────────────────

describe("checkpoint create", () => {
  it("prompts for a label, creates, and refetches — create broadcasts nothing", async () => {
    await mountPanel(stackView([]));
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(1);

    fireEvent.click(button("New"));
    await settle();
    const input = screen.getByLabelText("Checkpoint name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Before the recut  " } });
    fireEvent.click(button("Create"));
    await settle();

    // Trimmed: the backend refuses a blank label outright.
    expect(mocks.projectCreateCheckpoint).toHaveBeenCalledWith("Before the recut");
    // `create_checkpoint` emits no `project:changed`, so without this explicit
    // refetch the new row would never appear (ticket 02's constraint).
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Checkpoint name")).toBeNull();
  });

  it("refuses to submit a blank or whitespace-only label", async () => {
    await mountPanel(stackView([]));
    fireEvent.click(button("New"));
    await settle();
    expect(button("Create").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Checkpoint name"), {
      target: { value: "   " },
    });
    expect(button("Create").disabled).toBe(true);
  });

  it("asks for NO confirmation — create is cheap and Delete is its undo", async () => {
    await mountPanel(stackView([]));
    fireEvent.click(button("New"));
    await settle();
    fireEvent.change(screen.getByLabelText("Checkpoint name"), {
      target: { value: "quick" },
    });
    fireEvent.click(button("Create"));
    await settle();
    // One click after the name: no second "are you sure" step anywhere.
    expect(mocks.projectCreateCheckpoint).toHaveBeenCalledTimes(1);
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe("checkpoint delete", () => {
  it("confirms before destroying the recovery point, then refetches", async () => {
    await mountPanel(stackView([checkpoint()]));
    fireEvent.click(button("Delete"));
    await settle();

    // Nothing has been destroyed yet — the dialog is the gate.
    expect(mocks.projectDeleteCheckpoint).not.toHaveBeenCalled();
    expect(screen.getByText("Delete checkpoint?")).toBeTruthy();
    expect(
      screen.getByText(
        "“Before the recut” will be removed, and the state it holds can no longer be restored.",
      ),
    ).toBeTruthy();

    fireEvent.click(button("Delete checkpoint"));
    await settle();
    expect(mocks.projectDeleteCheckpoint).toHaveBeenCalledWith("cp-1");
    // Same no-broadcast reason as create.
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(2);
  });

  // `CheckpointNotFound` is the LIKELIEST failure here, not an exotic one:
  // delete broadcasts nothing, so the row on screen is stale whenever anything
  // else removed the checkpoint first. Skipping the refetch on failure pins that
  // stale row permanently and makes every retry fail identically.
  it("refetches after a FAILED delete too, so a stale row cannot outlive it", async () => {
    await mountPanel(stackView([checkpoint()]));
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(1);

    mocks.projectDeleteCheckpoint.mockRejectedValueOnce(
      new Error(JSON.stringify({ error: "CheckpointNotFound", id: "cp-1" })),
    );
    // The refetch that follows sees the truth: it was already gone.
    mocks.projectHistoryView.mockResolvedValue(stackView([]));

    fireEvent.click(button("Delete"));
    await settle();
    fireEvent.click(button("Delete checkpoint"));
    await settle();

    expect(mocks.projectDeleteCheckpoint).toHaveBeenCalledWith("cp-1");
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(0);
    expect(screen.queryByText("Delete checkpoint?")).toBeNull();
  });

  // A user can delete an agent session's `Pre-agent:` checkpoint — that
  // session's only way back. Delete is deliberately NOT gated on the revert lock
  // (the lock rejects reverts; a delete reverts nothing, and gating it would not
  // help anyway since the user could delete before or after the session), so the
  // honest fix is that the dialog says what is being destroyed.
  it("names the checkpoint's OWNER in the confirmation", async () => {
    await mountPanel(
      stackView([
        checkpoint({
          id: "cp-2",
          label: "Pre-agent: tidy the cut",
          actor: { kind: "Agent", client: "claude" },
        }),
      ]),
    );
    fireEvent.click(button("Delete"));
    await settle();
    expect(
      screen.getByText(
        "Agent “claude” created this checkpoint — it may be that session's only way back.",
      ),
    ).toBeTruthy();
  });

  it("says so plainly when the checkpoint is the user's own", async () => {
    await mountPanel(stackView([checkpoint()]));
    fireEvent.click(button("Delete"));
    await settle();
    expect(screen.getByText("You created this checkpoint.")).toBeTruthy();
  });

  it("cancelling the confirmation destroys nothing", async () => {
    await mountPanel(stackView([checkpoint()]));
    fireEvent.click(button("Delete"));
    await settle();
    // The footer Cancel, not the header ✕ (which carries the same label).
    fireEvent.click(
      within(document.querySelector<HTMLElement>(".export-actions")!).getByRole(
        "button",
        { name: "Cancel" },
      ),
    );
    await settle();
    expect(mocks.projectDeleteCheckpoint).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete checkpoint?")).toBeNull();
    expect(rows()).toHaveLength(1);
  });
});

// ── Locking ─────────────────────────────────────────────────────────────────

describe("checkpoint section under lock_reason", () => {
  it("disables ONLY Restore — the lock rejects revert paths, nothing else", async () => {
    await mountPanel(
      stackView([checkpoint()], { lock_reason: "agent is reverting" }),
    );
    expect(button("Restore").disabled).toBe(true);
    expect(button("Restore").title).toBe("History is locked: agent is reverting");
    // create_checkpoint / delete_checkpoint are NOT gated on the lock, and the
    // backend serves both while it is held — disabling them would be a lie.
    expect(button("New").disabled).toBe(false);
    expect(button("Delete").disabled).toBe(false);

    fireEvent.click(button("Restore"));
    await settle();
    expect(mocks.projectRestoreCheckpoint).not.toHaveBeenCalled();

    fireEvent.click(button("Delete"));
    await settle();
    fireEvent.click(button("Delete checkpoint"));
    await settle();
    expect(mocks.projectDeleteCheckpoint).toHaveBeenCalledWith("cp-1");
  });

  // An empty reason is a lock: `lock_history('')` passes the MCP parser. Testing
  // truthiness would disable Restore (its `disabled` already reads `!== null`)
  // while the tooltip claimed it was available, and let the click handler
  // through.
  it("treats an EMPTY lock reason as a lock on Restore", async () => {
    await mountPanel(stackView([checkpoint()], { lock_reason: "" }));
    expect(button("Restore").disabled).toBe(true);
    expect(button("Restore").title).toBe("History is locked: ");

    fireEvent.click(button("Restore"));
    await settle();
    expect(mocks.projectRestoreCheckpoint).not.toHaveBeenCalled();
  });
});
