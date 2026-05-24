import { describe, expect, it } from "vitest";
import { SyntheticClock } from "./clock";

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
