import { describe, expect, it, vi } from "vitest";
import { TemplateBaker, type BakeContentSpec } from "./TemplateBaker";

function makeFakeBitmap(): ImageBitmap {
  return { close: vi.fn(), width: 1, height: 1 } as unknown as ImageBitmap;
}

/// Manual scheduler: capture callbacks, run them on demand so the test drives
/// the idle loop deterministically (mirrors TemplatePrewarmer.test.ts).
function manualScheduler() {
  const cbs: (() => void)[] = [];
  return {
    schedule: (cb: () => void) => {
      cbs.push(cb);
      return cbs.length;
    },
    cancel: vi.fn(),
    flush: async () => {
      while (cbs.length) {
        const cb = cbs.shift()!;
        cb();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe("TemplateBaker", () => {
  it("renders + persists every frame of the active content, skipping on-disk", async () => {
    const sched = manualScheduler();
    const persisted: string[] = [];
    const render = vi.fn(async (_f: number) => makeFakeBitmap());
    const baker = new TemplateBaker({
      schedule: sched.schedule,
      cancel: sched.cancel,
      isOnDisk: async (k, f) => k === "a" && f === 0, // frame 0 already baked
      persist: async (k, f, _bmp) => {
        persisted.push(`${k}#${f}`);
      },
      warm: vi.fn(),
      batchSize: 2,
    });
    const spec: BakeContentSpec = {
      cacheKey: "a",
      contentFrame: 0,
      contentDurationFrames: 3,
      render,
    };
    baker.setTargets([spec]);
    await sched.flush();
    // frame 0 skipped (on disk); 1 and 2 baked.
    expect(persisted.sort()).toEqual(["a#1", "a#2"]);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("does nothing when targets is empty", async () => {
    const sched = manualScheduler();
    const persist = vi.fn();
    const baker = new TemplateBaker({
      schedule: sched.schedule,
      cancel: sched.cancel,
      isOnDisk: async () => false,
      persist,
      warm: vi.fn(),
    });
    baker.setTargets([]);
    await sched.flush();
    expect(persist).not.toHaveBeenCalled();
  });

  it("dispose stops further work", async () => {
    const sched = manualScheduler();
    const persist = vi.fn(async () => {});
    const baker = new TemplateBaker({
      schedule: sched.schedule,
      cancel: sched.cancel,
      isOnDisk: async () => false,
      persist,
      warm: vi.fn(),
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 4, render: async () => makeFakeBitmap() }]);
    baker.dispose();
    await sched.flush();
    expect(persist).not.toHaveBeenCalled();
  });
});
