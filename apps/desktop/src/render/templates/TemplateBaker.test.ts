import { describe, expect, it, vi } from "vitest";
import { MotifBaker, type BakeContentSpec } from "./TemplateBaker";

function makeFakeBitmap(): ImageBitmap {
  return { close: vi.fn(), width: 1, height: 1 } as unknown as ImageBitmap;
}

/// Drive the idle loop deterministically: run each scheduled callback, then let
/// the async drainBatch fully settle (a macrotask flush via setTimeout(0))
/// before checking for the next re-armed callback. Mirrors
/// MotifPrewarmer.test.ts. `guard` bounds a runaway loop.
async function drain(pending: (() => void)[]): Promise<void> {
  let guard = 0;
  while (pending.length > 0 && guard++ < 50) {
    const cb = pending.shift()!;
    cb();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("MotifBaker", () => {
  it("renders + persists every frame of the active content, skipping on-disk", async () => {
    const pending: (() => void)[] = [];
    const persisted: string[] = [];
    const render = vi.fn(async (_f: number) => makeFakeBitmap());
    const baker = new MotifBaker({
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
    const baker = new MotifBaker({
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
    const baker = new MotifBaker({
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

  it("emits baking on setTargets then ready when all frames complete", async () => {
    const pending: (() => void)[] = [];
    const emits: { k: string; phase: string; done: number; total: number }[] = [];
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => {},
      warm: vi.fn(),
      onStatus: (k, s) => emits.push({ k, ...s }),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: async () => makeFakeBitmap() }]);
    expect(emits[0]).toEqual({ k: "a", phase: "baking", done: 0, total: 3 });
    await drain(pending);
    expect(emits[emits.length - 1]).toEqual({ k: "a", phase: "ready", done: 3, total: 3 });
  });

  it("reaches ready via skips when every frame is already on disk (no render)", async () => {
    const pending: (() => void)[] = [];
    const emits: { phase: string; done: number; total: number }[] = [];
    const render = vi.fn(async () => makeFakeBitmap());
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => true,
      persist: async () => {},
      warm: vi.fn(),
      onStatus: (_k, s) => emits.push(s),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render }]);
    await drain(pending);
    expect(render).not.toHaveBeenCalled();
    expect(emits[emits.length - 1]).toEqual({ phase: "ready", done: 3, total: 3 });
  });

  it("emits error when a frame's persist throws, with counts frozen", async () => {
    const pending: (() => void)[] = [];
    const emits: { phase: string; done: number; total: number }[] = [];
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => { throw new Error("disk full"); },
      warm: vi.fn(),
      onStatus: (_k, s) => emits.push(s),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: async () => makeFakeBitmap() }]);
    await drain(pending);
    const last = emits[emits.length - 1]!;
    expect(last.phase).toBe("error");
    expect(last.done).toBe(0);
  });

  it("does not re-announce baking when setTargets repeats an already-ready content", async () => {
    const pending: (() => void)[] = [];
    const emits: { phase: string; done: number; total: number }[] = [];
    const spec = { cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: async () => makeFakeBitmap() };
    const baker = new MotifBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => {},
      warm: vi.fn(),
      onStatus: (_k, s) => emits.push(s),
      batchSize: 2,
    });
    baker.setTargets([spec]);
    await drain(pending);
    expect(emits[emits.length - 1]!.phase).toBe("ready");
    const countAfterFirstBake = emits.length;
    // Repeat setTargets with the SAME content (as happens every playback frame).
    baker.setTargets([spec]);
    await drain(pending);
    const newEmits = emits.slice(countAfterFirstBake);
    // No "baking" re-announcement, and it stays ready.
    expect(newEmits.some((e) => e.phase === "baking")).toBe(false);
    expect(emits[emits.length - 1]!.phase).toBe("ready");
  });
});
