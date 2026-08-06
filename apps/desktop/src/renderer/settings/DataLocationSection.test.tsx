// @vitest-environment jsdom
//
// Covers the "Data location" Settings section (exported from
// SettingsPanel.tsx). The data-root IPC wrappers are stubbed and the
// `evt:dataRoot:progress` stream is mocked at the bridge so the copy-progress
// bar can be driven deterministically.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DataRootMigrateResult } from "../ipc";

// Stubbed data-root IPC wrappers. `importActual` keeps DATA_ROOT_EVENTS + types real
// so the component and the test agree on the `dataRoot:progress` event name.
const ipc = vi.hoisted(() => ({
  dataRootCurrent: vi.fn(),
  dataRootPickAndMigrate: vi.fn(),
  dataRootRelaunch: vi.fn(),
  dataRootOpenFolder: vi.fn(),
  dataRootPendingCleanup: vi.fn(),
  dataRootDeleteOld: vi.fn(),
  dataRootDismissCleanup: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});

// Fake event bridge: record the progress handler by name; the tests fire ticks
// through it. `unlisten` proves the subscription is torn down when the migration
// settles.
const events = vi.hoisted(() => ({
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));

vi.mock("@/bridge/events", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      events.listeners.set(event, handler);
      return events.unlisten;
    },
  ),
  emit: vi.fn(),
}));

import i18n from "../i18n";
import { DataLocationSection } from "./SettingsPanel";

const onError = vi.fn();

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onError.mockReset();
  events.listeners.clear();
  events.unlisten.mockReset();
  ipc.dataRootCurrent.mockReset().mockResolvedValue({
    path: "/home/u/.config/WeftCut/data",
    isFallback: false,
  });
  ipc.dataRootPendingCleanup.mockReset().mockResolvedValue(null);
  ipc.dataRootPickAndMigrate.mockReset();
  ipc.dataRootRelaunch.mockReset().mockResolvedValue(undefined);
  ipc.dataRootOpenFolder.mockReset().mockResolvedValue(undefined);
  ipc.dataRootDeleteOld.mockReset().mockResolvedValue(undefined);
  ipc.dataRootDismissCleanup.mockReset().mockResolvedValue(undefined);
});

describe("DataLocationSection", () => {
  it("shows the current data root fetched on mount", async () => {
    render(<DataLocationSection onError={onError} />);
    expect(
      await screen.findByText("/home/u/.config/WeftCut/data"),
    ).toBeTruthy();
    // Not a fallback → no annotation badge.
    expect(screen.queryByText(/Fallback/)).toBeNull();
  });

  it("annotates the fallback default when a configured root is unavailable", async () => {
    ipc.dataRootCurrent.mockResolvedValue({
      path: "/home/u/.config/WeftCut/data",
      isFallback: true,
    });
    render(<DataLocationSection onError={onError} />);
    expect(await screen.findByText(/Fallback/)).toBeTruthy();
  });

  it("runs a copy migration, shows progress, then the relaunch affordance", async () => {
    let resolveMigrate!: (r: DataRootMigrateResult) => void;
    ipc.dataRootPickAndMigrate.mockReturnValue(
      new Promise<DataRootMigrateResult>((res) => {
        resolveMigrate = res;
      }),
    );

    render(<DataLocationSection onError={onError} />);
    await screen.findByText("/home/u/.config/WeftCut/data");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    // The migration subscribes to progress for its duration.
    await waitFor(() =>
      expect(events.listeners.has("dataRoot:progress")).toBe(true),
    );

    // Drive a determinate copy tick → 3/6 files = 50%.
    act(() => {
      events.listeners.get("dataRoot:progress")!({
        payload: {
          phase: "copy",
          bucket: "motifs",
          copiedFiles: 3,
          totalFiles: 6,
        },
      });
    });
    expect(screen.getByText(/3 \/ 6 files/)).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");

    // Resolve success → relaunch affordance appears; IPC not auto-relaunched.
    await act(async () => {
      resolveMigrate({ ok: true, mode: "copy", newPath: "/mnt/media/data" });
    });
    const restart = await screen.findByRole("button", {
      name: "Restart to apply",
    });
    expect(ipc.dataRootRelaunch).not.toHaveBeenCalled();

    await userEvent.click(restart);
    expect(ipc.dataRootRelaunch).toHaveBeenCalledTimes(1);
    // Progress subscription torn down once the migration settled.
    expect(events.unlisten).toHaveBeenCalled();
  });

  it("shows the rollback error on failure and leaves the path unchanged", async () => {
    ipc.dataRootPickAndMigrate.mockResolvedValue({
      ok: false,
      error: "target disk is full",
    });

    render(<DataLocationSection onError={onError} />);
    await screen.findByText("/home/u/.config/WeftCut/data");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("target disk is full");
    // data_root unchanged: the current path is still displayed, no relaunch.
    expect(screen.getByText("/home/u/.config/WeftCut/data")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Restart to apply" }),
    ).toBeNull();
    expect(ipc.dataRootRelaunch).not.toHaveBeenCalled();
  });

  it("returns silently to idle when the picker is cancelled", async () => {
    ipc.dataRootPickAndMigrate.mockResolvedValue({ ok: false, cancelled: true });

    render(<DataLocationSection onError={onError} />);
    await screen.findByText("/home/u/.config/WeftCut/data");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    await waitFor(() =>
      expect(ipc.dataRootPickAndMigrate).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Restart to apply" }),
    ).toBeNull();
  });

  it("deletes the old copy only on explicit confirm", async () => {
    ipc.dataRootPendingCleanup.mockResolvedValue({ oldPath: "/old/WeftCut/data" });

    render(<DataLocationSection onError={onError} />);
    // Post-relaunch cleanup prompt surfaces.
    expect(await screen.findByText("Delete old data copy?")).toBeTruthy();
    expect(screen.getByText(/\/old\/WeftCut\/data/)).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Delete old copy" }),
    );
    await waitFor(() => expect(ipc.dataRootDeleteOld).toHaveBeenCalledTimes(1));
    // Dialog dismissed after the delete resolves.
    await waitFor(() =>
      expect(screen.queryByText("Delete old data copy?")).toBeNull(),
    );
  });

  it("keeps the old copy and dismisses when the user declines", async () => {
    ipc.dataRootPendingCleanup.mockResolvedValue({ oldPath: "/old/WeftCut/data" });

    render(<DataLocationSection onError={onError} />);
    expect(await screen.findByText("Delete old data copy?")).toBeTruthy();

    // The footer button (visible text "Keep"); the dialog's ✕ shares the same
    // non-destructive aria-label, so match on text to pick the footer control.
    await userEvent.click(screen.getByText("Keep"));
    expect(ipc.dataRootDeleteOld).not.toHaveBeenCalled();
    // Keep is a one-time dismiss: it clears the marker so the prompt never
    // re-appears on the next launch (no delete of the old copy).
    await waitFor(() =>
      expect(ipc.dataRootDismissCleanup).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(screen.queryByText("Delete old data copy?")).toBeNull(),
    );
  });
});
