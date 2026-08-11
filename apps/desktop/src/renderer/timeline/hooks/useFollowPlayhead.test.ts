// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPlayheadTimeUs, usePlayheadStore } from "../../state/playheadStore";
import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
} from "../../state/timelineScrollStore";
import { useFollowPlayhead } from "./useFollowPlayhead";

/// A stand-in scroll root. The hook only ever WRITES `scrollLeft` (it reads the
/// offset from the scroll store), so a plain object suffices — and jsdom would
/// clamp a real element's `scrollLeft` to 0 anyway, since it never lays out.
function root(): { current: HTMLDivElement | null; el: { scrollLeft: number } } {
  const el = { scrollLeft: 0 };
  return { current: el as unknown as HTMLDivElement, el };
}

/// 100 px/s over a 1000 px viewport: one screenful is 10 s of content.
const VIEW = {
  pxPerSec: 100,
  viewportWidthPx: 1000,
  contentWidthPx: 10_000,
  enabled: true,
};

describe("useFollowPlayhead", () => {
  // Both stores are module-global, and an un-unmounted hook stays subscribed to
  // the playhead — a leaked one from an earlier case would scroll this one's
  // view. Reset the state, drop the subscribers.
  beforeEach(() => {
    usePlayheadStore.setState({ timeUs: 0 });
    setTimelineScrollLeftPx(0);
  });
  afterEach(cleanup);

  it("pages the view when playback walks the playhead off the right edge", () => {
    const rootRef = root();
    renderHook(() => useFollowPlayhead({ rootRef, ...VIEW }));

    act(() => setPlayheadTimeUs(5_000_000)); // 500 px — still in view
    expect(rootRef.el.scrollLeft).toBe(0);

    act(() => setPlayheadTimeUs(10_000_000)); // 1000 px — past the edge
    expect(rootRef.el.scrollLeft).toBe(920);
    // Published eagerly so the ruler's tick window lands with the jump rather
    // than one frame later.
    expect(timelineScrollLeftPx()).toBe(920);
  });

  it("brings the playhead back after a backward jump", () => {
    const rootRef = root();
    setTimelineScrollLeftPx(5000);
    renderHook(() => useFollowPlayhead({ rootRef, ...VIEW }));

    act(() => setPlayheadTimeUs(2_000_000)); // 200 px, far left of the window
    expect(rootRef.el.scrollLeft).toBe(0);
  });

  it("holds the view still while the ruler is being scrubbed", () => {
    const rootRef = root();
    const { result } = renderHook(() => useFollowPlayhead({ rootRef, ...VIEW }));

    act(() => result.current.setScrubbing(true));
    act(() => setPlayheadTimeUs(30_000_000));
    expect(rootRef.el.scrollLeft).toBe(0);
    expect(timelineScrollLeftPx()).toBe(0);

    // Released: the next playhead move follows again.
    act(() => result.current.setScrubbing(false));
    act(() => setPlayheadTimeUs(31_000_000));
    expect(rootRef.el.scrollLeft).toBe(3020);
  });

  it("does nothing while disabled, and catches up when switched on", () => {
    const rootRef = root();
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useFollowPlayhead({ rootRef, ...VIEW, enabled: props.enabled }),
      { initialProps: { enabled: false } },
    );

    act(() => setPlayheadTimeUs(40_000_000));
    expect(rootRef.el.scrollLeft).toBe(0);

    rerender({ enabled: true });
    expect(rootRef.el.scrollLeft).toBe(3920);
  });

  // Zoom picks its own anchor (`timeline/zoom.ts`). Re-anchoring on a pxPerSec
  // change would silently override that on every wheel tick.
  it("does not re-anchor when only the zoom changes", () => {
    const rootRef = root();
    const { rerender } = renderHook(
      (props: { pxPerSec: number }) =>
        useFollowPlayhead({ rootRef, ...VIEW, pxPerSec: props.pxPerSec }),
      { initialProps: { pxPerSec: 100 } },
    );

    act(() => setPlayheadTimeUs(3_000_000)); // 300 px @ 100 px/s — in view
    expect(rootRef.el.scrollLeft).toBe(0);

    // At 500 px/s the playhead sits at 1500 px, well outside the window.
    rerender({ pxPerSec: 500 });
    expect(rootRef.el.scrollLeft).toBe(0);

    // …but the zoom IS picked up by the next real playhead move.
    act(() => setPlayheadTimeUs(3_100_000));
    expect(rootRef.el.scrollLeft).toBe(1470);
  });

  // A mount's first commit has no measurement (the layout effect that takes it
  // has not run yet), so the catch-up has to survive until one lands.
  it("catches up when the viewport is first measured", () => {
    const rootRef = root();
    setTimelineScrollLeftPx(0);
    usePlayheadStore.setState({ timeUs: 40_000_000 });
    const { rerender } = renderHook(
      (props: { viewportWidthPx: number }) =>
        useFollowPlayhead({ rootRef, ...VIEW, ...props }),
      { initialProps: { viewportWidthPx: 0 } },
    );
    expect(rootRef.el.scrollLeft).toBe(0);

    rerender({ viewportWidthPx: 1000 });
    expect(rootRef.el.scrollLeft).toBe(3920);
  });

  it("stops following once unmounted", () => {
    const rootRef = root();
    const { unmount } = renderHook(() => useFollowPlayhead({ rootRef, ...VIEW }));
    unmount();

    act(() => setPlayheadTimeUs(50_000_000));
    expect(rootRef.el.scrollLeft).toBe(0);
  });
});
