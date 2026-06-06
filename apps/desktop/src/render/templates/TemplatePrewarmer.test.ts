import { describe, expect, it, vi } from "vitest";
import { TemplatePrewarmer, type PrewarmContentSpec } from "./TemplatePrewarmer";

function makeBmp(): ImageBitmap { return { close() {} } as unknown as ImageBitmap; }

describe("TemplatePrewarmer", () => {
  it("rasters missing targets in plan order, skips cached, stops when done", async () => {
    const cached = new Set<string>();
    const setSpy = vi.fn((k: string, f: number) => cached.add(`${k}#${f}`));
    const renderSpy = vi.fn(async (_f: number) => makeBmp());
    const pending: (() => void)[] = [];
    const prewarmer = new TemplatePrewarmer({
      cap: 240,
      hasFrame: (k, f) => cached.has(`${k}#${f}`),
      setFrame: setSpy,
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => {},
      batchSize: 2,
    });
    const spec: PrewarmContentSpec = {
      cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: renderSpy,
    };
    prewarmer.setTargets([spec]);
    let guard = 0;
    while (pending.length > 0 && guard++ < 20) {
      const cb = pending.shift()!;
      cb();
      await new Promise((r) => setTimeout(r, 0)); // let async drainBatch settle
    }
    expect(renderSpy).toHaveBeenCalledTimes(3); // frames 0,1,2
    expect(cached.has("a#0") && cached.has("a#1") && cached.has("a#2")).toBe(true);
  });

  it("dispose cancels and stops rastering", async () => {
    const pending: (() => void)[] = [];
    const renderSpy = vi.fn(async () => makeBmp());
    const prewarmer = new TemplatePrewarmer({
      cap: 240, hasFrame: () => false, setFrame: () => {},
      schedule: (cb) => { pending.push(cb); return pending.length; }, cancel: () => {}, batchSize: 1,
    });
    prewarmer.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 5, render: renderSpy }]);
    prewarmer.dispose();
    while (pending.length) { pending.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("dispatches up to batchSize rasters concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release: (() => void)[] = [];
    const render = vi.fn(
      (_f: number) =>
        new Promise<ImageBitmap>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight--;
            resolve(makeBmp());
          });
        }),
    );
    const pending: (() => void)[] = [];
    const prewarmer = new TemplatePrewarmer({
      cap: 240,
      hasFrame: () => false,
      setFrame: () => {},
      schedule: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancel: () => {},
      batchSize: 3,
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 10, render },
    ]);
    pending.shift()!(); // run the first scheduled batch
    await Promise.resolve();
    await Promise.resolve();
    expect(maxInFlight).toBe(3); // batchSize rasters in flight at once
    release.forEach((r) => r());
  });

  it("closes bitmaps that resolve after dispose (mid-batch)", async () => {
    const closed: number[] = [];
    let n = 0;
    const release: (() => void)[] = [];
    const render = vi.fn(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          const id = n++;
          release.push(() =>
            resolve({
              close() {
                closed.push(id);
              },
            } as unknown as ImageBitmap),
          );
        }),
    );
    const setFrame = vi.fn();
    const pending: (() => void)[] = [];
    const prewarmer = new TemplatePrewarmer({
      cap: 240,
      hasFrame: () => false,
      setFrame,
      schedule: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancel: () => {},
      batchSize: 2,
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 5, render },
    ]);
    pending.shift()!(); // start the batch (2 renders in flight, gated)
    await Promise.resolve();
    prewarmer.dispose();
    release.forEach((r) => r()); // resolve after dispose
    await new Promise((r) => setTimeout(r, 0));
    expect(setFrame).not.toHaveBeenCalled();
    expect(closed.length).toBe(2); // both late bitmaps closed, not leaked
  });
});
