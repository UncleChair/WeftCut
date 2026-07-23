import { describe, expect, it } from "vitest";
import { TransitionRtPool, type RtFactory } from "./TransitionRtPool";

// Accounting-only tests through an injected factory — the pool's contract
// is "no per-frame allocation": once a window's 2 RTs exist, replaying
// acquire/release across frames must never create more.

interface FakeRt {
  w: number;
  h: number;
  destroyed: boolean;
}

function fakeFactory(): { factory: RtFactory<FakeRt>; made: FakeRt[] } {
  const made: FakeRt[] = [];
  return {
    made,
    factory: {
      create: (w, h) => {
        const rt = { w, h, destroyed: false };
        made.push(rt);
        return rt;
      },
      destroy: (rt) => {
        rt.destroyed = true;
      },
    },
  };
}

describe("TransitionRtPool", () => {
  it("reuses released textures — steady state never re-creates", () => {
    const { factory } = fakeFactory();
    const pool = new TransitionRtPool(1920, 1080, factory);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.stats()).toMatchObject({ created: 2, outstanding: 2, free: 0 });
    pool.release(a);
    pool.release(b);
    // A later window re-acquires the same two textures.
    const a2 = pool.acquire();
    const b2 = pool.acquire();
    expect([a2, b2]).toEqual(expect.arrayContaining([a, b]));
    expect(pool.stats()).toMatchObject({ created: 2, outstanding: 2, free: 0 });
  });

  it("capacity grows to concurrent demand × textures-per-node and settles there", () => {
    const { factory } = fakeFactory();
    const pool = new TransitionRtPool(1920, 1080, factory);
    // Two concurrent transitions → 4 outstanding.
    const held = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
    expect(pool.stats().created).toBe(4);
    for (const rt of held) pool.release(rt);
    // Replay many frames of a single transition: no growth past the high-water mark.
    for (let i = 0; i < 100; i++) {
      const x = pool.acquire();
      const y = pool.acquire();
      pool.release(x);
      pool.release(y);
    }
    expect(pool.stats().created).toBe(4);
  });

  it("setSize invalidates pooled textures and destroys stale ones on release", () => {
    const { factory } = fakeFactory();
    const pool = new TransitionRtPool(1920, 1080, factory);
    const freed = pool.acquire();
    const outstanding = pool.acquire();
    pool.release(freed);
    pool.setSize(1280, 720);
    expect(freed.destroyed).toBe(true);
    // The outstanding pre-resize texture dies on its way back.
    pool.release(outstanding);
    expect(outstanding.destroyed).toBe(true);
    // Fresh acquire creates at the new size.
    const next = pool.acquire();
    expect([next.w, next.h]).toEqual([1280, 720]);
  });

  it("setSize to the same size is a no-op", () => {
    const { factory } = fakeFactory();
    const pool = new TransitionRtPool(1920, 1080, factory);
    const rt = pool.acquire();
    pool.release(rt);
    pool.setSize(1920, 1080);
    expect(rt.destroyed).toBe(false);
    expect(pool.acquire()).toBe(rt);
  });

  it("drain destroys the free list but keeps the pool usable", () => {
    const { factory } = fakeFactory();
    const pool = new TransitionRtPool(1920, 1080, factory);
    const rt = pool.acquire();
    pool.release(rt);
    pool.drain();
    expect(rt.destroyed).toBe(true);
    expect(pool.acquire().destroyed).toBe(false);
    expect(pool.stats().created).toBe(2);
  });

  it("dispose destroys everything, including late releases", () => {
    const { factory } = fakeFactory();
    const pool = new TransitionRtPool(1920, 1080, factory);
    const held = pool.acquire();
    const freed = pool.acquire();
    pool.release(freed);
    pool.dispose();
    expect(freed.destroyed).toBe(true);
    pool.release(held);
    expect(held.destroyed).toBe(true);
  });
});
