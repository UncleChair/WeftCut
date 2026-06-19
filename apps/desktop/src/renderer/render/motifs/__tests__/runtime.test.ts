import { describe, it, expect, vi } from "vitest";
import { createMotifRuntime, MOTIF_RUNTIME_SOURCE } from "../runtime";

describe("MOTIF_RUNTIME_SOURCE settle", () => {
  it("contains a meta.settleRafs read (branch behavior verified in real Chromium/Electron)", () => {
    // The render entry must consult meta.settleRafs to choose the settle depth.
    // This is a presence smoke check — the source lives in a String.raw literal
    // that vitest can't execute; the 0/1/2-rAF branching is exercised in the app.
    expect(MOTIF_RUNTIME_SOURCE).toContain("meta.settleRafs");
  });
});

describe("motif runtime seek", () => {
  it("freezes rAF until seek flushes it, at the virtual clock", () => {
    const rt = createMotifRuntime();
    const seen: number[] = [];
    rt.global.requestAnimationFrame((t: number) => seen.push(t));
    expect(seen).toEqual([]);            // not auto-run
    rt.seek(500);
    expect(seen).toEqual([500]);          // flushed at virtual clock
    expect(rt.global.performance.now()).toBe(500);
  });
  it("re-seeking the same t is idempotent for time reads", () => {
    const rt = createMotifRuntime();
    rt.seek(500); rt.seek(1000); rt.seek(500);
    expect(rt.global.performance.now()).toBe(500);
    expect(rt.global.Date.now()).toBe(rt.epoch + 500);
  });
  it("setInterval/setTimeout are neutralized", () => {
    const rt = createMotifRuntime();
    const spy = vi.fn();
    rt.global.setInterval(spy, 1); rt.global.setTimeout(spy, 1);
    rt.seek(5000);
    expect(spy).not.toHaveBeenCalled();
  });
});
