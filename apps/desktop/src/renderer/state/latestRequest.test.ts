import { describe, expect, it, vi } from "vitest";

import { LatestRequestCoordinator } from "./latestRequest";

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

describe("LatestRequestCoordinator", () => {
  it("makes an older request stale as soon as a newer request is issued", async () => {
    const coordinator = new LatestRequestCoordinator();
    const published: string[] = [];
    const older = deferred<string>();
    const newer = deferred<string>();

    const olderRun = coordinator.run(
      () => older.promise,
      (value) => published.push(value),
    );
    const newerRun = coordinator.run(
      () => newer.promise,
      (value) => published.push(value),
    );

    older.resolve("older");
    expect(await olderRun).toBe(false);
    expect(published).toEqual([]);

    newer.resolve("newer");
    expect(await newerRun).toBe(true);
    expect(published).toEqual(["newer"]);
  });

  it("ignores a stale rejection while a newer request is pending", async () => {
    const coordinator = new LatestRequestCoordinator();
    const reject = vi.fn();
    const older = deferred<string>();
    const newer = deferred<string>();

    const olderRun = coordinator.run(
      () => older.promise,
      () => undefined,
      reject,
    );
    const newerRun = coordinator.run(
      () => newer.promise,
      () => undefined,
      reject,
    );

    older.reject(new Error("stale"));
    expect(await olderRun).toBe(false);
    expect(reject).not.toHaveBeenCalled();

    newer.resolve("newer");
    expect(await newerRun).toBe(true);
  });

  it("routes the latest rejection to its handler", async () => {
    const coordinator = new LatestRequestCoordinator();
    const reject = vi.fn();

    const applied = await coordinator.run(
      () => Promise.reject(new Error("latest")),
      () => undefined,
      reject,
    );

    expect(applied).toBe(true);
    expect(reject).toHaveBeenCalledOnce();
    expect(reject.mock.calls[0]?.[0]).toEqual(new Error("latest"));
  });

  it("invalidates a pending request during teardown", async () => {
    const coordinator = new LatestRequestCoordinator();
    const publish = vi.fn();
    const pending = deferred<string>();
    const run = coordinator.run(() => pending.promise, publish);

    coordinator.invalidate();
    pending.resolve("late");

    expect(await run).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});
