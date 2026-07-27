import { describe, expect, it } from "vitest";
import { createPreviewGpuBudget } from "./previewGpuBudget";

describe("preview GPU budget", () => {
  it("admits at most five concurrent sessions even when their coded area is tiny", () => {
    const budget = createPreviewGpuBudget();

    for (let i = 0; i < 5; i++) {
      expect(budget.reserve(`s${i}`, { width: 1, height: 1 })).not.toBeNull();
    }
    expect(budget.reserve("s5", { width: 1, height: 1 })).toBeNull();
    expect(budget.snapshot()).toEqual({
      currency: "coded-pixel-area",
      sessions: { used: 5, max: 5 },
      codedPixelArea: {
        used: 5,
        max: 3 * 3840 * 2160,
        calibratedFps: 30,
      },
    });
  });

  it("admits three 4K sessions and refuses the fourth by coded pixel area", () => {
    const budget = createPreviewGpuBudget();
    const size4k = { width: 3840, height: 2160 };

    expect(budget.reserve("a", size4k)).not.toBeNull();
    expect(budget.reserve("b", size4k)).not.toBeNull();
    expect(budget.reserve("c", size4k)).not.toBeNull();
    expect(budget.reserve("d", size4k)).toBeNull();
    expect(budget.snapshot().codedPixelArea.used).toBe(3 * 3840 * 2160);
    expect(budget.snapshot().sessions.used).toBe(3);
  });

  it("fails closed without consuming budget for invalid coded dimensions", () => {
    const budget = createPreviewGpuBudget();
    const invalid = [
      { width: 0, height: 1080 },
      { width: -1920, height: 1080 },
      { width: 1920.5, height: 1080 },
      { width: Number.NaN, height: 1080 },
      { width: Number.POSITIVE_INFINITY, height: 1080 },
      { width: Number.MAX_SAFE_INTEGER, height: 2 },
    ];

    invalid.forEach((size, i) => {
      expect(budget.reserve(`invalid-${i}`, size)).toBeNull();
    });
    expect(budget.snapshot().sessions.used).toBe(0);
    expect(budget.snapshot().codedPixelArea.used).toBe(0);
  });

  it("rolls a reservation back so a later session can use the released area", () => {
    const budget = createPreviewGpuBudget();
    const size4k = { width: 3840, height: 2160 };
    const first = budget.reserve("first", size4k)!;
    const second = budget.reserve("second", size4k)!;
    expect(budget.reserve("third", size4k)).not.toBeNull();
    expect(budget.reserve("blocked", size4k)).toBeNull();

    budget.release(second);

    expect(budget.reserve("replacement", size4k)).not.toBeNull();
    expect(budget.snapshot().sessions.used).toBe(3);
    expect(budget.snapshot().codedPixelArea.used).toBe(3 * 3840 * 2160);
    expect(first).not.toBeNull();
  });

  it("fails duplicate ids closed and makes release identity-safe and idempotent", () => {
    const budget = createPreviewGpuBudget();
    const first = budget.reserve("same", { width: 1920, height: 1080 })!;

    expect(budget.reserve("same", { width: 1, height: 1 })).toBeNull();
    expect(budget.snapshot().sessions.used).toBe(1);
    expect(budget.snapshot().codedPixelArea.used).toBe(1920 * 1080);

    budget.release(first);
    budget.release(first);
    expect(budget.snapshot().sessions.used).toBe(0);

    const replacement = budget.reserve("same", { width: 1280, height: 720 })!;
    budget.release(first);
    expect(budget.snapshot().sessions.used).toBe(1);
    expect(budget.snapshot().codedPixelArea.used).toBe(1280 * 720);

    budget.release(replacement);
    expect(budget.snapshot().sessions.used).toBe(0);
    expect(budget.snapshot().codedPixelArea.used).toBe(0);
  });

  it("reuses coded-area capacity after a dynamic mixed-resolution delete", () => {
    const budget = createPreviewGpuBudget();
    const size4k = { width: 3840, height: 2160 };
    const size1080 = { width: 1920, height: 1080 };
    expect(budget.reserve("4k-a", size4k)).not.toBeNull();
    expect(budget.reserve("1080-a", size1080)).not.toBeNull();
    const removable = budget.reserve("4k-b", size4k)!;
    expect(budget.reserve("1080-b", size1080)).not.toBeNull();
    expect(budget.reserve("4k-blocked", size4k)).toBeNull();

    budget.release(removable);

    expect(budget.reserve("4k-replacement", size4k)).not.toBeNull();
    expect(budget.reserve("1080-c", size1080)).not.toBeNull();
    expect(budget.snapshot().sessions.used).toBe(5);
    expect(budget.snapshot().codedPixelArea.used).toBe(
      2 * 3840 * 2160 + 3 * 1920 * 1080,
    );
  });
});
