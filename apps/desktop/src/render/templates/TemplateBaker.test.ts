import { describe, expect, it, vi } from "vitest";
import { TemplateBaker, type BakeContentSpec } from "./TemplateBaker";

function makeFakeBitmap(): ImageBitmap {
  return { close: vi.fn(), width: 1, height: 1 } as unknown as ImageBitmap;
}

/// Drive the idle loop deterministically: run each scheduled callback, then let
/// the async drainBatch fully settle (a macrotask flush via setTimeout(0))
/// before checking for the next re-armed callback. Mirrors
/// TemplatePrewarmer.test.ts. `guard` bounds a runaway loop.
async function drain(pending: (() => void)[]): Promise<void> {
  let guard = 0;
  while (pending.length > 0 && guard++ < 50) {
    const cb = pending.shift()!;
    cb();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("TemplateBaker", () => {
  it("renders + persists every frame of the active content, skipping on-disk", async () => {
    const pending: (() => void)[] = [];
    const persisted: string[] = [];
    const render = vi.fn(async (_f: number) => makeFakeBitmap());
    const baker = new TemplateBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async (k, f) => k === "a" && f === 0, // frame 0 already baked
      persist: async (k, f, _bmp) => { persisted.push(`${k}#${f}`); },
      warm: vi.fn(),
      batchSize: 2,
    });
    const spec: BakeContentSpec = {
      cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render,
    };
    baker.setTargets([spec]);
    await drain(pending);
    expect(persisted.sort()).toEqual(["a#1", "a#2"]); // frame 0 skipped (on disk)
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("does nothing when targets is empty", async () => {
    const pending: (() => void)[] = [];
    const persist = vi.fn();
    const baker = new TemplateBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist,
      warm: vi.fn(),
    });
    baker.setTargets([]);
    await drain(pending);
    expect(persist).not.toHaveBeenCalled();
  });

  it("dispose stops further work", async () => {
    const pending: (() => void)[] = [];
    const persist = vi.fn(async () => {});
    const baker = new TemplateBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist,
      warm: vi.fn(),
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 4, render: async () => makeFakeBitmap() }]);
    baker.dispose();
    await drain(pending);
    expect(persist).not.toHaveBeenCalled();
  });
});
