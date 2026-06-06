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
});
