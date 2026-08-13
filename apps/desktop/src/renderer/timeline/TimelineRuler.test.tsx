// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../i18n"; // real en-US bundle, so a tooltip is the shipped string
import type { MarkerSummary, ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
} from "../state/timelineScrollStore";
import { useRangeStore } from "../state/rangeStore";
import { RULER_SCROLL_QUANTUM_PX } from "./rulerModel";
import { TimelineRuler } from "./TimelineRuler";

afterEach(cleanup);
// All three stores are renderer-global; reset them so each case starts at the
// row head with no marks and no markers, regardless of order.
beforeEach(() => {
  setTimelineScrollLeftPx(0);
  useRangeStore.setState({ inUs: null, outUs: null });
  useProjectStore.setState({ summary: null });
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

describe("markers", () => {
  /// 4 s row at 2000 px/s at 30 fps, so 1 s of marker time is 2000 px of row
  /// and every frame is 66.7 px — wide enough that a one-frame region is a bar
  /// and a shorter one is not.
  const renderRuler = ({
    pxPerSec = 2000,
    onScrub = () => {},
  }: { pxPerSec?: number; onScrub?: (clientX: number) => void } = {}) => {
    const widthPx = 4 * pxPerSec;
    return render(
      <TimelineRuler
        pxPerSec={pxPerSec}
        totalSec={4}
        widthPx={widthPx}
        viewportWidthPx={widthPx}
        fpsNum={30}
        fpsDen={1}
        onScrub={onScrub}
      />,
    );
  };

  /// Only `markers` is read off the summary here; the rest is padding to
  /// satisfy the type (same stub shape as proxyPreferenceStore.test.ts).
  const seed = (markers: MarkerSummary[]) => {
    useProjectStore.setState({
      summary: { markers } as unknown as ProjectSummary,
    });
  };

  const point = (over: Partial<MarkerSummary> = {}): MarkerSummary => ({
    id: "point-1",
    t_us: 1_000_000,
    end_t_us: null,
    label: "",
    color_hint: "#ff8800",
    ...over,
  });

  const region = (over: Partial<MarkerSummary> = {}): MarkerSummary => ({
    id: "region-1",
    t_us: 1_000_000,
    end_t_us: 2_000_000,
    label: "",
    color_hint: "#22cc55",
    ...over,
  });

  const layer = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      '[data-testid="timeline-marker-layer"]',
    );

  const marks = (container: HTMLElement): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="timeline-marker"]'),
    );

  const markById = (container: HTMLElement, id: string): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-marker-id="${id}"]`)!;

  // Not just "no marks" — no LAYER either. The local ruler node-count gate
  // reads `parseFloat(style.left)` off every direct child of the strip and
  // sorts it, and the project it creates has no markers; an always-present
  // wrapper would feed NaN into that sort. See the landmine on the layer.
  it("adds nothing to the strip while the project carries no markers", () => {
    const { container } = renderRuler();
    expect(marks(container)).toHaveLength(0);
    expect(layer(container)).toBeNull();
    for (const child of ticks(container)) {
      expect(Number.isNaN(Number.parseFloat(child.style.left))).toBe(false);
    }
  });

  it("puts a point marker's mark on its own time, in its author's colour", () => {
    seed([point({ t_us: 1_500_000, color_hint: "#ff8800" })]);
    const { container } = renderRuler();
    const mark = markById(container, "point-1");
    expect(mark.style.left).toBe("3000px");
    expect(mark.style.background).toBe("rgb(255, 136, 0)");
  });

  it("spans a region marker's bar across its range, in its author's colour", () => {
    seed([
      region({ t_us: 500_000, end_t_us: 1_500_000, color_hint: "#22cc55" }),
    ]);
    const { container } = renderRuler();
    const mark = markById(container, "region-1");
    expect(mark.style.left).toBe("1000px");
    expect(mark.style.width).toBe("2000px");
    expect(mark.style.background).toBe("rgb(34, 204, 85)");
  });

  it("keeps every mark clear of the upper half, where the timecode labels live", () => {
    // The strip is `h-5` (20 px) — see the sizing note on the ruler — so the
    // lower half is the bottom 10 px, measured up from each mark's own bottom
    // offset. A point glyph is a rotated square, so what it paints is its
    // diagonal: its top tip sits at half its height plus half its diagonal.
    seed([point(), region({ t_us: 2_000_000, end_t_us: 3_000_000 })]);
    const { container } = renderRuler();
    expect(marks(container)).toHaveLength(2);
    for (const mark of marks(container)) {
      const bottom = Number.parseFloat(mark.style.bottom);
      const height = Number.parseFloat(mark.style.height);
      const top =
        mark.dataset.shape === "point"
          ? bottom + (height * (1 + Math.SQRT2)) / 2
          : bottom + height;
      expect(top).toBeLessThanOrEqual(10);
    }
  });

  it("outlines a mark both dark and light, so no authored colour can vanish", () => {
    // The ruler is near-black, so the in/out caps' single dark hairline is not
    // enough here: it separates a BRIGHT marker from the background and leaves a
    // near-black one (this case's colour) a smudge. The light ring outside it is
    // what carries that half of the guarantee.
    seed([point({ color_hint: "#14141a" })]);
    const { container } = renderRuler();
    const outline = markById(container, "point-1").className;
    expect(outline).toContain("rgba(0,0,0,");
    expect(outline).toContain("rgba(255,255,255,");
  });

  it("groups the marks under one container, so the tick assertions keep counting ticks", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        point({ id: `m${i}`, t_us: 100_000 * (i + 1) }),
      );
    const { container } = renderRuler();
    const bare = ticks(container).length;

    act(() => seed(many(3)));
    const withThree = ticks(container).length;
    expect(marks(container)).toHaveLength(3);
    // However many marks there are, the strip gains exactly ONE direct child —
    // they all land inside the single marker layer, so the tick assertions and
    // the node-count gate keep measuring ticks.
    expect(withThree).toBe(bare + 1);

    act(() => seed(many(30)));
    expect(marks(container)).toHaveLength(30);
    expect(ticks(container).length).toBe(withThree);
    for (const mark of marks(container)) {
      expect(layer(container)!.contains(mark)).toBe(true);
    }
  });

  it("paints markers over the ticks and under the in/out caps", () => {
    // Same stacking context throughout the strip, so DOM order is the whole
    // z-story — the cap the user is actively placing must win.
    act(() => useRangeStore.setState({ inUs: 1_000_000, outUs: null }));
    seed([point()]);
    const { container } = renderRuler();
    const children = ticks(container);
    const layerIdx = children.indexOf(layer(container)!);
    const capIdx = children.findIndex(
      (el) => el.dataset.testid === "timeline-range-cap-in",
    );
    expect(layerIdx).toBeGreaterThan(0);
    expect(capIdx).toBeGreaterThan(layerIdx);
  });

  it("reads out a point marker as label · timecode", () => {
    seed([point({ t_us: 1_000_000, label: "cut here" })]);
    const { container } = renderRuler();
    expect(markById(container, "point-1").title).toBe("cut here · 00:00:01:00");
  });

  it("reads out a region marker as label · start – end", () => {
    seed([region({ t_us: 1_000_000, end_t_us: 2_000_000, label: "needs VO" })]);
    const { container } = renderRuler();
    expect(markById(container, "region-1").title).toBe(
      "needs VO · 00:00:01:00 – 00:00:02:00",
    );
  });

  it("still reads out the real range for a region too narrow to paint as a bar", () => {
    // Zoomed out to 20 px/s, a two-frame region is 1.3 px — under the bar
    // threshold. The shape degrades to a point AT THE REGION'S START; the hover
    // text keeps reporting the range the shape can no longer show.
    seed([region({ t_us: 1_000_000, end_t_us: 1_066_667, label: "blip" })]);
    const { container } = renderRuler({ pxPerSec: 20 });
    const mark = markById(container, "region-1");
    expect(mark.dataset.shape).toBe("point");
    expect(mark.style.left).toBe("20px");
    expect(mark.title).toBe("blip · 00:00:01:00 – 00:00:01:02");
  });

  // The degrade may drop the region's LENGTH; it may not move its START. A
  // degraded region begins at its x and nothing of it exists before, so the
  // glyph is nudged right by its rotation overhang instead of being centred the
  // way a true point marker is — otherwise ~3.5 px of mark paints over frames
  // the region does not cover.
  it("puts a degraded region's painted left edge on the region's start", () => {
    seed([
      point({ id: "true-point", t_us: 1_000_000 }),
      region({ id: "degraded", t_us: 2_000_000, end_t_us: 2_066_667 }),
    ]);
    const { container } = renderRuler({ pxPerSec: 20 });
    // A true point straddles its frame: half its box sits left of it.
    expect(markById(container, "true-point").style.translate).toBe("-50%");
    // The degraded region does not. The offset is the 45° rotation's overhang —
    // half of (diagonal − side) for the 5 px glyph — so the painted edge, not
    // just the box edge, lands on the start.
    const nudge = (5 * (Math.SQRT2 - 1)) / 2;
    const degraded = markById(container, "degraded");
    expect(Number.parseFloat(degraded.style.translate)).toBeCloseTo(nudge, 5);
    expect(degraded.style.left).toBe("40px");
  });

  it("falls back to the translated noun when a marker carries no label", () => {
    seed([point({ t_us: 1_000_000, label: "" })]);
    const { container } = renderRuler();
    expect(markById(container, "point-1").title).toBe("Marker · 00:00:01:00");
  });

  // The marker layer is permanent, so — like the in/out caps — it must never be
  // able to swallow a gesture that starts on the ruler.
  it("lets a pointerdown that lands on a marker start a ruler scrub", () => {
    const scrubs: number[] = [];
    seed([region({ t_us: 500_000, end_t_us: 1_500_000 })]);
    const { container } = renderRuler({
      onScrub: (clientX) => scrubs.push(clientX),
    });
    fireEvent.pointerDown(markById(container, "region-1"), {
      button: 0,
      clientX: 1234,
    });
    expect(scrubs).toEqual([1234]);
  });

  it("appears the moment a marker is created and goes the moment it is undone", () => {
    const { container } = renderRuler();
    act(() => seed([point()]));
    expect(marks(container)).toHaveLength(1);
    act(() => seed([]));
    expect(marks(container)).toHaveLength(0);
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
