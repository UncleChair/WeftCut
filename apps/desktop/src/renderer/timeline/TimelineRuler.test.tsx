// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
} from "../state/timelineScrollStore";
import { RULER_SCROLL_QUANTUM_PX } from "./rulerModel";
import { TimelineRuler } from "./TimelineRuler";

afterEach(cleanup);
// The scroll store is renderer-global; reset it so each case starts at the row
// head regardless of order.
beforeEach(() => setTimelineScrollLeftPx(0));

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
    // 216_001 ticks before this ticket; the row is 7.2 M px wide either way.
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

describe("scroll subscription", () => {
  /// The acceptance criterion from spec finding 7: the visible interval reaches
  /// the ruler without `scrollLeft` becoming React state above a leaf. Proven
  /// with a counter, not by inspection — a parent that re-rendered on scroll
  /// would be the whole timeline tree in production.
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
