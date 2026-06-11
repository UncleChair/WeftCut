import { describe, expect, it } from "vitest";
import { SyntheticClock } from "./clock";

/// Controllable fake AudioContext for the audio-master derivation tests.
function fakeCtx(): { state: AudioContextState; currentTime: number } {
  return { state: "running", currentTime: 100 };
}

function bindFake(c: SyntheticClock, ctx: ReturnType<typeof fakeCtx>): void {
  c.bindAudio(ctx as unknown as AudioContext);
}

describe("SyntheticClock frame snap", () => {
  it("positionUs() returns the snapped value after setPosition", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    c.setPosition(17_000);
    expect(c.positionUs()).toBe(33_333);
  });

  it("positionUs() snaps even when fps isn't bound (defaults to 30)", () => {
    const c = new SyntheticClock();
    c.setPosition(17_000);
    expect(c.positionUs()).toBe(33_333);
  });

  it("setPosition is idempotent under snap", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    c.setPosition(17_000);
    const a = c.positionUs();
    c.setPosition(a);
    expect(c.positionUs()).toBe(a);
  });

  it("bindFps after setPosition re-snaps the next read", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    c.setPosition(33_333); // exact frame 1 at 30fps
    c.bindFps(30_000, 1001); // 29.97fps: frame 1 ≈ 33_366.667us
    // 33_333us at 29.97fps rounds to frame 1; output is half-up rounded
    // to match Demuxer.ts source-PTS rounding → 33_367us.
    expect(c.positionUs()).toBe(33_367);
  });
});

describe("SyntheticClock audio-master derivation", () => {
  it("derives the playing position from ctx.currentTime exactly", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    bindFake(c, ctx);
    c.play();
    // 90 audio-clock frames of 1/30 s: derived position tracks the fake
    // context with zero accumulation error.
    for (let i = 1; i <= 90; i++) {
      ctx.currentTime = 100 + i / 30;
      c.tick();
    }
    expect(c.positionUs()).toBe(3_000_000); // 3 s, exact
  });

  it("exposes the anchor while playing and audio-driven, null otherwise", () => {
    const c = new SyntheticClock();
    const ctx = fakeCtx();
    bindFake(c, ctx);
    expect(c.getAnchor()).toBe(null); // paused
    c.play();
    expect(c.getAnchor()).toEqual({ compUs: 0, ctxTime: 100 });
    c.pause();
    expect(c.getAnchor()).toBe(null);
  });

  it("setPosition during play re-anchors so derivation continues from there", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    bindFake(c, ctx);
    c.play();
    ctx.currentTime = 101;
    c.tick();
    c.setPosition(5_000_000);
    expect(c.getAnchor()).toEqual({ compUs: 5_000_000, ctxTime: 101 });
    ctx.currentTime = 102;
    c.tick();
    expect(c.positionUs()).toBe(6_000_000);
  });

  it("falls back to wall deltas while suspended and re-anchors on resume without jumping", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    ctx.state = "suspended";
    bindFake(c, ctx);
    c.play();
    expect(c.getAnchor()).toBe(null); // wall mode
    c.tick(); // wall tick (dt ~0 in test time — position stays ~0)
    const before = c.positionUs();
    // Context starts running at an arbitrary epoch: the flip must
    // re-anchor from the CURRENT position, not jump to the epoch. The
    // anchor stores the RAW (unsnapped) position — a few µs of real wall
    // time elapse inside this test — so assert continuity on the snapped
    // playhead and closeness on the raw anchor, not deep equality.
    ctx.state = "running";
    ctx.currentTime = 555.5;
    c.tick();
    expect(c.positionUs()).toBe(before);
    const anchor = c.getAnchor()!;
    expect(anchor.ctxTime).toBe(555.5);
    expect(Math.abs(anchor.compUs - before)).toBeLessThan(5_000);
    // And from here it derives (snap re-grids the µs of wall residue).
    ctx.currentTime = 556.5;
    c.tick();
    expect(c.positionUs()).toBe(before + 1_000_000);
  });

  it("pause clears the anchor; replay re-anchors at the held position", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    bindFake(c, ctx);
    c.play();
    ctx.currentTime = 102; // +2 s
    c.tick();
    c.pause();
    const held = c.positionUs();
    expect(held).toBe(2_000_000);
    ctx.currentTime = 300; // context keeps running while paused
    c.play();
    expect(c.getAnchor()).toEqual({ compUs: 2_000_000, ctxTime: 300 });
    ctx.currentTime = 301;
    c.tick();
    expect(c.positionUs()).toBe(3_000_000);
  });

  it("never moves backward across ticks with a quantized context clock", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    bindFake(c, ctx);
    c.play();
    ctx.currentTime = 100.5;
    c.tick();
    const p1 = c.positionUs();
    // ctx.currentTime updates in render quanta — a repeat read must not
    // regress the position.
    c.tick();
    expect(c.positionUs()).toBeGreaterThanOrEqual(p1);
  });
});
