import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryStackView } from "../ipc";

const mocks = vi.hoisted(() => ({
  projectHistoryView: vi.fn<() => Promise<HistoryStackView>>(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  onProjectChanged: null as (() => void) | null,
}));

vi.mock("../ipc", () => ({
  projectHistoryView: () => mocks.projectHistoryView(),
}));

vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (_event: string, callback: () => void) => {
    mocks.onProjectChanged = callback;
    mocks.listen();
    return mocks.unlisten;
  }),
}));

import {
  refreshHistoryView,
  useHistoryStore,
  wireHistoryStore,
} from "./historyStore";

function view(cursor: number): HistoryStackView {
  return { ops: [], cursor, len: cursor + 1, checkpoints: [], evicted: 0 };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("historyStore wiring", () => {
  beforeEach(() => {
    mocks.projectHistoryView.mockReset();
    mocks.listen.mockReset();
    mocks.unlisten.mockReset();
    mocks.onProjectChanged = null;
    useHistoryStore.getState().reset();
  });

  it("seeds on wire and refetches on project:changed", async () => {
    mocks.projectHistoryView.mockResolvedValueOnce(view(0));
    const unwire = await wireHistoryStore();
    expect(useHistoryStore.getState().view?.cursor).toBe(0);
    expect(useHistoryStore.getState().ready).toBe(true);

    mocks.projectHistoryView.mockResolvedValueOnce(view(3));
    mocks.onProjectChanged!();
    await settle();
    expect(useHistoryStore.getState().view?.cursor).toBe(3);
    unwire();
  });

  it("subscribes BEFORE the seed fetch so no change event is lost", async () => {
    const seed = deferred<HistoryStackView>();
    mocks.projectHistoryView.mockReturnValueOnce(seed.promise);
    const wiring = wireHistoryStore();
    await settle();
    // The listener is live even though the seed has not resolved yet.
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(mocks.onProjectChanged).not.toBeNull();

    // An event during the seed runs a second fetch; newest wins.
    mocks.projectHistoryView.mockResolvedValueOnce(view(9));
    mocks.onProjectChanged!();
    await settle();
    seed.resolve(view(0));
    await settle();
    expect(useHistoryStore.getState().view?.cursor).toBe(9);
    (await wiring)();
  });

  it("issues no IPC at all once torn down — a closed panel is silent", async () => {
    mocks.projectHistoryView.mockResolvedValue(view(0));
    const unwire = await wireHistoryStore();
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(1);

    const changed = mocks.onProjectChanged!;
    unwire();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(useHistoryStore.getState().view).toBeNull();
    expect(useHistoryStore.getState().ready).toBe(false);

    // Even a stale event handle (or a ticket-04 explicit refresh) fetches
    // nothing while the panel is closed.
    changed();
    await refreshHistoryView();
    await settle();
    expect(mocks.projectHistoryView).toHaveBeenCalledTimes(1);
  });

  it("refreshes explicitly for the actions that emit no project:changed", async () => {
    mocks.projectHistoryView.mockResolvedValueOnce(view(0));
    const unwire = await wireHistoryStore();
    mocks.projectHistoryView.mockResolvedValueOnce(view(5));
    await refreshHistoryView();
    expect(useHistoryStore.getState().view?.cursor).toBe(5);
    unwire();
  });

  it("does not publish an in-flight response after teardown", async () => {
    mocks.projectHistoryView.mockResolvedValueOnce(view(0));
    const unwire = await wireHistoryStore();
    const pending = deferred<HistoryStackView>();
    mocks.projectHistoryView.mockReturnValueOnce(pending.promise);

    mocks.onProjectChanged!();
    unwire();
    pending.resolve(view(7));
    await settle();
    expect(useHistoryStore.getState().view).toBeNull();
  });

  it("marks ready with a null view when the read is refused (no project)", async () => {
    mocks.projectHistoryView.mockRejectedValueOnce(new Error("no project"));
    const unwire = await wireHistoryStore();
    expect(useHistoryStore.getState().view).toBeNull();
    expect(useHistoryStore.getState().ready).toBe(true);
    unwire();
  });
});
