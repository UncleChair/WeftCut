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
  return {
    ops: [],
    cursor,
    len: cursor + 1,
    window_start: 0,
    checkpoints: [],
    evicted: 0,
  };
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

  // `ready` earns its keep on the FIRST render and nowhere else: it is what
  // separates "the seed hasn't landed" from "here is the stack". There is no
  // third state — the read is served off a live actor whose stack always holds
  // at least the `Initial` seed, so `view === null` means exactly "not yet".
  it("stays un-ready until the seed lands, then never returns to a null view", async () => {
    const seed = deferred<HistoryStackView>();
    mocks.projectHistoryView.mockReturnValueOnce(seed.promise);
    const wiring = wireHistoryStore();
    await settle();
    expect(useHistoryStore.getState().ready).toBe(false);
    expect(useHistoryStore.getState().view).toBeNull();

    seed.resolve(view(0));
    await settle();
    expect(useHistoryStore.getState().ready).toBe(true);
    expect(useHistoryStore.getState().view).not.toBeNull();
    (await wiring)();
  });

  // The read's HANDLER cannot refuse, but the IPC TRANSPORT can still fail (a
  // torn-down main process, a serialization error). Every caller either discards
  // this promise or awaits it from a click handler, so an escaping rejection is
  // an unhandled one. Stale rows are recoverable — the next `project:changed`
  // refetches; a thrown renderer is not.
  it("swallows a transport failure and keeps the last view on screen", async () => {
    mocks.projectHistoryView.mockResolvedValueOnce(view(3));
    const teardown = await wireHistoryStore();
    await settle();
    expect(useHistoryStore.getState().view?.cursor).toBe(3);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.projectHistoryView.mockRejectedValueOnce(new Error("ipc gone"));
    // Rejects the assertion rather than the test run if this ever throws again.
    await expect(refreshHistoryView()).resolves.toBeUndefined();
    await settle();

    expect(useHistoryStore.getState().view?.cursor).toBe(3); // last view survives
    expect(useHistoryStore.getState().ready).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    // The store is still live: the next successful fetch lands normally.
    mocks.projectHistoryView.mockResolvedValueOnce(view(4));
    await refreshHistoryView();
    await settle();
    expect(useHistoryStore.getState().view?.cursor).toBe(4);
    teardown();
  });

  it("does not let the event-listener path reject either", async () => {
    mocks.projectHistoryView.mockResolvedValueOnce(view(1));
    const teardown = await wireHistoryStore();
    await settle();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.projectHistoryView.mockRejectedValueOnce(new Error("ipc gone"));
    mocks.onProjectChanged?.(); // the `void fetchView()` path — discards the promise
    await settle();

    expect(useHistoryStore.getState().view?.cursor).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    teardown();
  });
});
