import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../ipc";

const mocks = vi.hoisted(() => ({
  projectSummary: vi.fn<() => Promise<ProjectSummary>>(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  onProjectChanged: null as (() => void) | null,
}));

vi.mock("../ipc", () => ({
  projectSummary: () => mocks.projectSummary(),
}));

vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (_event: string, callback: () => void) => {
    mocks.onProjectChanged = callback;
    mocks.listen();
    return mocks.unlisten;
  }),
}));

import { useProjectStore, wireProjectStore } from "./projectStore";

function summary(name: string): ProjectSummary {
  return {
    project_id: "project-1",
    name,
    composition: {
      width: 640,
      height: 360,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
    },
    track_count: 0,
    layer_count: 0,
    duration_us: 0,
    history: {
      cursor: 0,
      len: 0,
      can_undo: false,
      can_redo: false,
    },
    media: [],
    tracks: [],
    markers: [],
    transitions: [],
    groups: [],
    audio_roles: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("wireProjectStore summary ordering", () => {
  beforeEach(() => {
    mocks.projectSummary.mockReset();
    mocks.listen.mockReset();
    mocks.unlisten.mockReset();
    mocks.onProjectChanged = null;
    useProjectStore.getState().apply(null);
  });

  it("does not publish an older success while a newer request is pending", async () => {
    mocks.projectSummary.mockResolvedValueOnce(summary("baseline"));
    const unwire = await wireProjectStore();
    const older = deferred<ProjectSummary>();
    const newer = deferred<ProjectSummary>();
    mocks.projectSummary
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    mocks.onProjectChanged!();
    mocks.onProjectChanged!();
    older.resolve(summary("older"));
    await settle();
    expect(useProjectStore.getState().summary?.name).toBe("baseline");

    newer.resolve(summary("newer"));
    await settle();
    expect(useProjectStore.getState().summary?.name).toBe("newer");
    unwire();
  });

  it("does not publish an older failure while a newer request is pending", async () => {
    mocks.projectSummary.mockResolvedValueOnce(summary("baseline"));
    const unwire = await wireProjectStore();
    const older = deferred<ProjectSummary>();
    const newer = deferred<ProjectSummary>();
    mocks.projectSummary
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    mocks.onProjectChanged!();
    mocks.onProjectChanged!();
    older.reject(new Error("stale failure"));
    await settle();
    expect(useProjectStore.getState().summary?.name).toBe("baseline");

    newer.resolve(summary("newer"));
    await settle();
    expect(useProjectStore.getState().summary?.name).toBe("newer");
    unwire();
  });

  it("invalidates an in-flight request when unwired", async () => {
    mocks.projectSummary.mockResolvedValueOnce(summary("baseline"));
    const unwire = await wireProjectStore();
    const pending = deferred<ProjectSummary>();
    mocks.projectSummary.mockReturnValueOnce(pending.promise);

    mocks.onProjectChanged!();
    unwire();
    pending.resolve(summary("after-unwire"));
    await settle();

    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().summary?.name).toBe("baseline");
  });
});
