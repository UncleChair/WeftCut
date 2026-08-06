// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
} from "../state/timelineScrollStore";
import { useRangeStore } from "../state/rangeStore";
import { RULER_SCROLL_QUANTUM_PX } from "./rulerModel";
import { TimelineRuler } from "./TimelineRuler";

afterEach(cleanup);
// Both stores are renderer-global; reset them so each case starts at the row
// head with no marks, regardless of order.
beforeEach(() => {
  setTimelineScrollLeftPx(0);
  useRangeStore.setState({ inUs: null, outUs: null });
});

/// The whole row fits the "viewport", so these cases assert tick CONTENT without
/// the window entering it (rulerModel.test.ts owns the windowing).
function renderWholeRow(props: {
  pxPerSec: number;
  totalSec: number;
  fpsNum: number;
  fpsDen: number;
}) {
  const widthPx = props.totalSec * props.pxPerSec;
  return render(
    <TimelineRuler
      pxPerSec={props.pxPerSec}
      totalSec={props.totalSec}
      widthPx={widthPx}
      viewportWidthPx={widthPx}
      fpsNum={props.fpsNum}
      fpsDen={props.fpsDen}
      onScrub={() => {}}
    />,
  );
}

const ticks = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="timeline-ruler"] > *',
    ),
  );

const majorLabels = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll("span")).map(
    (el) => el.textContent ?? "",
  );

describe("<TimelineRuler>", () => {
  it("labels every major tick with the timecode of its canonical time", () => {
    const { container } = renderWholeRow({
      pxPerSec: 2000,
      totalSec: 3,
      fpsNum: 30_000,
      fpsDen: 1001,
    });
    // Expected timecodes derived from the frame INDEX (not from any µs math),
    // so a tick whose time had drifted onto a neighbouring frame would show up
    // as a mismatched label here.
    const expected: string[] = [];
    for (let f = 0; f <= 90; f += 2) {
      const s = Math.floor(f / 30);
      expected.push(
        `00:00:${String(s).padStart(2, "0")}:${String(f % 30).padStart(2, "0")}`,
      );
    }
    expect(majorLabels(container)).toEqual(expected);
  });

  it("labels second mode with mm:ss", () => {
    const { container } = renderWholeRow({
      pxPerSec: 80,
      totalSec: 10,
      fpsNum: 30,
      fpsDen: 1,
    });
    expect(majorLabels(container)).toEqual([
      "0:00",
      "0:02",
      "0:04",
      "0:06",
      "0:08",
      "0:10",
    ]);
  });

  it("keeps the width and the overflow clip that bound fit-zoom scroll", () => {
    const { container } = renderWholeRow({
      pxPerSec: 2000,
      totalSec: 3,
      fpsNum: 30_000,
      fpsDen: 1001,
    });
    const ruler = container.querySelector<HTMLElement>(
      '[data-testid="timeline-ruler"]',
    )!;
    expect(ruler.style.width).toBe("6000px");
    expect(ruler.className).toContain("overflow-hidden");
    // `h-5` is coupled to the playhead knob's top offset (see the sizing note).
    expect(ruler.className).toContain("h-5");
  });

  it("paints a viewport-sized node set for a one-hour 60 fps row", () => {
    // The row is 7.2 M px wide, so the node set must stay viewport-sized.
    const { container } = render(
      <TimelineRuler
        pxPerSec={2000}
        totalSec={3600}
        widthPx={7_200_000}
        viewportWidthPx={1200}
        fpsNum={60}
        fpsDen={1}
        onScrub={() => {}}
      />,
    );
    expect(ticks(container).length).toBeLessThan(100);
  });
});

describe("in/out end caps", () => {
  const cap = (container: HTMLElement, side: "in" | "out") =>
    container.querySelector<HTMLElement>(
      `[data-testid="timeline-range-cap-${side}"]`,
    );

  /// 4 s row at 2000 px/s, so 1 s of time is exactly 2000 px of row.
  const renderRuler = () =>
    renderWholeRow({ pxPerSec: 2000, totalSec: 4, fpsNum: 30, fpsDen: 1 });

  it("paints nothing while the timeline is unmarked", () => {
    const { container } = renderRuler();
    expect(cap(container, "in")).toBeNull();
    expect(cap(container, "out")).toBeNull();
  });

  it("paints each side independently", () => {
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: null }));
    const { container } = renderRuler();
    expect(cap(container, "in")).not.toBeNull();
    expect(cap(container, "out")).toBeNull();
  });

  it("puts the in cap on the boundary", () => {
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: null }));
    const { container } = renderRuler();
    expect(cap(container, "in")!.style.left).toBe("2000px");
  });

  // The end is EXCLUSIVE — the boundary is the right edge of the last kept
  // frame — so the bar sits one bar-width left of it. Getting this backwards
  // would draw the cap over the first excluded frame instead of the last kept
  // one, which reads as an off-by-one frame at any real zoom.
  it("hangs the out cap back off its boundary by its own width", () => {
    act(() => useRangeStore.setState({ inUs: null, outUs: 2_000_000 }));
    const { container } = renderRuler();
    expect(cap(container, "out")!.style.left).toBe("3998px");
  });

  it("updates in place when the marks move", () => {
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: null }));
    const { container } = renderRuler();
    act(() => useRangeStore.setState({ inUs: 1_500_000, outUs: null }));
    expect(cap(container, "in")!.style.left).toBe("3000px");
  });

  // The caps are the permanent half of the design, so they must never be able
  // to swallow a scrub that starts on the ruler.
  it("stays out of the ruler's own pointer handling", () => {
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: 2_000_000 }));
    const { container } = renderRuler();
    for (const side of ["in", "out"] as const) {
      expect(cap(container, side)!.className).toContain("pointer-events-none");
    }
  });
});

describe("scroll subscription", () => {
  /// The acceptance criterion from
  /// `.scratch/timeline-frame-grid/issues/06-ruler-model-and-virtualization.md`:
  /// the visible interval reaches the ruler without `scrollLeft` becoming
  /// React state above a leaf. Proven with a counter, not by inspection — a
  /// parent that re-rendered on scroll would be the whole timeline tree in
  /// production.
  function renderWithParentCounter() {
    const counter = { renders: 0 };
    function Parent() {
      counter.renders++;
      return (
        <TimelineRuler
          pxPerSec={2000}
          totalSec={3600}
          widthPx={7_200_000}
          viewportWidthPx={1200}
          fpsNum={60}
          fpsDen={1}
          onScrub={() => {}}
        />
      );
    }
    return { counter, ...render(<Parent />) };
  }

  it("moves the painted window without re-rendering the parent", () => {
    const { counter, container } = renderWithParentCounter();
    const before = counter.renders;
    const firstTickX = () => ticks(container)[0]!.style.left;
    const headX = firstTickX();

    act(() => setTimelineScrollLeftPx(40_000));
    expect(firstTickX()).not.toBe(headX);
    expect(counter.renders).toBe(before);

    // Every scroll event of a wheel gesture, not just the last one.
    for (let px = 40_000; px < 60_000; px += 250) {
      act(() => setTimelineScrollLeftPx(px));
    }
    expect(counter.renders).toBe(before);
  });

  it("does not recompute inside a scroll quantum", () => {
    const { container } = renderWithParentCounter();
    // Start at a block boundary, then move within it.
    act(() => setTimelineScrollLeftPx(40_000));
    const windowStart = ticks(container)[0]!.style.left;

    act(() => setTimelineScrollLeftPx(40_000 + RULER_SCROLL_QUANTUM_PX - 1));
    expect(ticks(container)[0]!.style.left).toBe(windowStart);

    act(() => setTimelineScrollLeftPx(40_000 + RULER_SCROLL_QUANTUM_PX));
    expect(ticks(container)[0]!.style.left).not.toBe(windowStart);
  });

  it("seeds its window from the store on mount", () => {
    // A remount (dock panel switch) with the store already scrolled must not
    // paint the row head.
    setTimelineScrollLeftPx(40_000);
    expect(timelineScrollLeftPx()).toBe(40_000);
    const { container } = renderWithParentCounter();
    const left = Number.parseFloat(ticks(container)[0]!.style.left);
    expect(left).toBeGreaterThan(39_000);
    expect(left).toBeLessThanOrEqual(40_000);
  });
});
