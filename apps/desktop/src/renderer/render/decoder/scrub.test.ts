import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScrubCoalescer } from "./scrub";

describe("ScrubCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once with the latest target after a quiet debounce window", async () => {
    const seen: number[] = [];
    const c = new ScrubCoalescer({
      debounceMs: 50,
      maxWaitMs: 180,
      onStableSeek: async (t) => {
        seen.push(t);
      },
    });
    c.requestSeek(10);
    c.requestSeek(20);
    c.requestSeek(30);
    await vi.advanceTimersByTimeAsync(49);
    expect(seen).toEqual([]); // still inside the debounce window
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([30]); // coalesced to a single fire at the latest target
  });

  it("fires periodically during a continuous drag that never pauses (maxWait)", async () => {
    // The regression this guards: a drag emitting a new seek faster than
    // `debounceMs` keeps resetting the quiet-period timer, so without a
    // ceiling the decoder is never re-targeted and the preview stays frozen
    // for the whole drag. maxWait must still fire (decode + paint) under it.
    const seen: number[] = [];
    const c = new ScrubCoalescer({
      debounceMs: 50,
      maxWaitMs: 100,
      onStableSeek: async (t) => {
        seen.push(t);
      },
    });
    // 10 seeks 30 ms apart (< 50 ms debounce) → debounce alone never elapses.
    let target = 0;
    for (let i = 0; i < 10; i++) {
      c.requestSeek((target += 100));
      await vi.advanceTimersByTimeAsync(30);
    }
    // ~300 ms of unbroken dragging, maxWait=100 → at least a couple of fires.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Each fire carries the most-recent target (monotonically increasing here).
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("after a continuous drag stops, a final precise seek lands the last target", async () => {
    const seen: number[] = [];
    const c = new ScrubCoalescer({
      debounceMs: 50,
      maxWaitMs: 100,
      onStableSeek: async (t) => {
        seen.push(t);
      },
    });
    for (let i = 0; i < 6; i++) {
      c.requestSeek((i + 1) * 100);
      await vi.advanceTimersByTimeAsync(30);
    }
    c.requestSeek(999); // last position, then the user releases
    await vi.advanceTimersByTimeAsync(60); // quiet → debounce fires the final
    expect(seen[seen.length - 1]).toBe(999);
  });

  it("cancel() drops a pending fire", async () => {
    const seen: number[] = [];
    const c = new ScrubCoalescer({
      debounceMs: 50,
      maxWaitMs: 100,
      onStableSeek: async (t) => {
        seen.push(t);
      },
    });
    c.requestSeek(10);
    c.cancel();
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toEqual([]);
  });
});
