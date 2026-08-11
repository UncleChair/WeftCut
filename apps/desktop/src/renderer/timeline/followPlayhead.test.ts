import { describe, expect, it } from "vitest";
import { followPageScrollLeft, type FollowViewport } from "./followPlayhead";

/// A 1000 px viewport over a 10 000 px canvas — lead works out to 80 px
/// (8 % of the viewport), edge pad to 12 px.
function view(over: Partial<FollowViewport> = {}): FollowViewport {
  return {
    playheadPx: 500,
    scrollLeftPx: 0,
    viewportPx: 1000,
    maxScrollLeftPx: 9000,
    ...over,
  };
}

describe("followPageScrollLeft", () => {
  it("holds the view while the playhead is inside it", () => {
    expect(followPageScrollLeft(view({ playheadPx: 500 }))).toBeNull();
    expect(followPageScrollLeft(view({ playheadPx: 12 }))).toBeNull();
    expect(followPageScrollLeft(view({ playheadPx: 987 }))).toBeNull();
  });

  it("pages forward when the playhead reaches the right edge, landing it on the lead", () => {
    // 989 is the first px past the trailing pad band.
    expect(followPageScrollLeft(view({ playheadPx: 988 }))).toBeNull();
    expect(followPageScrollLeft(view({ playheadPx: 989 }))).toBe(909);
    expect(followPageScrollLeft(view({ playheadPx: 1200 }))).toBe(1120);
  });

  // The point of paging forward: after the jump the view holds a full screen of
  // upcoming content, so playback runs ~a screenful before the next scroll.
  it("leaves a screenful of lookahead after a forward page", () => {
    const next = followPageScrollLeft(
      view({ playheadPx: 989, scrollLeftPx: 0 }),
    )!;
    const playheadOffsetInView = 989 - next;
    expect(playheadOffsetInView).toBe(80);
    expect(1000 - playheadOffsetInView).toBe(920);
  });

  it("pages a full screen backward, landing the playhead near the right edge", () => {
    // Stepping back off the left edge of the [2000, 3000) window.
    const next = followPageScrollLeft(
      view({ playheadPx: 1995, scrollLeftPx: 2000 }),
    );
    expect(next).toBe(1075);
    // Room to keep stepping back without re-paging on the next press.
    expect(1995 - next!).toBe(920);
  });

  it("clamps to the scroll range instead of overshooting either end", () => {
    expect(
      followPageScrollLeft(view({ playheadPx: 20, scrollLeftPx: 500 })),
    ).toBe(0);
    expect(
      followPageScrollLeft(
        view({ playheadPx: 9995, scrollLeftPx: 8000, maxScrollLeftPx: 9000 }),
      ),
    ).toBe(9000);
  });

  // Parked against an end stop with the playhead in the pad band: the branch
  // fires every frame, and returning the current offset would make every one of
  // them a scroll write.
  it("returns null when the clamped target is where the view already sits", () => {
    expect(
      followPageScrollLeft(
        view({ playheadPx: 9995, scrollLeftPx: 9000, maxScrollLeftPx: 9000 }),
      ),
    ).toBeNull();
    expect(
      followPageScrollLeft(view({ playheadPx: 0, scrollLeftPx: 0 })),
    ).toBeNull();
  });

  it("does nothing when the whole timeline already fits", () => {
    expect(
      followPageScrollLeft(
        view({ playheadPx: 995, scrollLeftPx: 0, maxScrollLeftPx: 0 }),
      ),
    ).toBeNull();
  });

  it("does nothing before the viewport has been measured", () => {
    expect(
      followPageScrollLeft(view({ viewportPx: 0, playheadPx: 5000 })),
    ).toBeNull();
  });

  // A viewport narrower than 2× the pad would otherwise produce a lead past the
  // midpoint, i.e. a backward page that lands left of where it started.
  it("keeps the lead inside a viewport too narrow for the ratio", () => {
    const next = followPageScrollLeft(
      view({ playheadPx: 400, scrollLeftPx: 400, viewportPx: 20 }),
    );
    expect(next).toBe(390);
  });
});
