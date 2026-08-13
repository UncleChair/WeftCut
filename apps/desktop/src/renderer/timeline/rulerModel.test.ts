import { describe, expect, it } from "vitest";
// `snapFrameRound` IS the actor's snap: `main/state/snap.ts` re-exports this
// same leaf-backed function, so asserting against it here asserts against the
// integer a committed clip edge is stored as. Imported through the renderer
// surface because tsconfig.web.json owns no reference to the main project.
import {
  approxFrameDurUs,
  formatTimecode,
  frameIndexRound,
  snapFrameRound as actorSnap,
  timeUsAtFrame,
} from "../frames";
import {
  MARKER_MIN_REGION_PX,
  RULER_OVERSCAN_PX,
  RULER_SCROLL_QUANTUM_PX,
  computeRulerMarkers,
  computeRulerModel,
  type RulerMarkerSource,
  type RulerModel,
  type RulerModelInput,
  type RulerTick,
} from "./rulerModel";

/// The spec's rate matrix — the broadcast fractional rates and their integer
/// twins.
const RATES: [number, number][] = [
  [24_000, 1001],
  [24, 1],
  [25, 1],
  [30_000, 1001],
  [30, 1],
  [50, 1],
  [60_000, 1001],
  [60, 1],
];

/// Frame indices the ruler must be exact at: a dense head where index
/// off-by-ones live, then 1 min / 1 h at 30 and 60 fps — the range where a
/// nominal-frame-duration ruler has drifted a whole timecode frame.
const TARGET_FRAMES = [0, 1, 2, 1799, 1800, 107_999];
const TARGET_FRAME_24H = 5_183_999;

/// 2000 px/s is MAX_PX_PER_SEC (geometry.ts) — frame mode at every rate in the
/// matrix, and the zoom at which tick drift is most visible.
const MAX_ZOOM_PX_PER_SEC = 2000;

const US_PER_SEC = 1_000_000;
const VIEWPORT_PX = 1200;

/// Canonical grid µs, computed in BigInt so the expectation does NOT inherit the
/// double-precision ceiling the leaf's i128 math exists to avoid. Mirrors the D2
/// output policy — half-up `round(frame * 1e6 * den / num)` — independently of
/// the implementation under test.
function canonicalUs(frame: number, num: number, den: number): number {
  const n = BigInt(num);
  const numer = BigInt(frame) * 1_000_000n * BigInt(den);
  return Number((numer + n / 2n) / n);
}

function tickAt(model: RulerModel, frame: number): RulerTick {
  const tk = model.ticks.find((t) => t.frame === frame);
  if (!tk) throw new Error(`no tick for frame ${frame} in the painted window`);
  return tk;
}

/// A window centred on `frame`, with one frame of row slack past it so the
/// target is never the clipped trailing tick.
function modelAroundFrame(
  frame: number,
  num: number,
  den: number,
  pxPerSec = MAX_ZOOM_PX_PER_SEC,
): RulerModel {
  const tUs = canonicalUs(frame, num, den);
  const xPx = (tUs / US_PER_SEC) * pxPerSec;
  return computeRulerModel({
    fpsNum: num,
    fpsDen: den,
    pxPerSec,
    totalSec: canonicalUs(frame + 1, num, den) / US_PER_SEC,
    scrollLeftPx: Math.max(0, xPx - VIEWPORT_PX / 2),
    viewportWidthPx: VIEWPORT_PX,
  });
}

describe("frame-mode tick times", () => {
  for (const [num, den] of RATES) {
    it(`${num}/${den}: tick i is the actor's snapped time for frame i`, () => {
      for (const i of TARGET_FRAMES) {
        const model = modelAroundFrame(i, num, den);
        expect(model.mode).toBe("frame");
        const tk = tickAt(model, i);
        const expected = canonicalUs(i, num, den);
        expect(tk.tUs).toBe(expected);
        expect(tk.tUs).toBe(actorSnap(expected, num, den));
        // The pixel identity the acceptance calls out follows from the µs one.
        expect(tk.xPx).toBe((expected / US_PER_SEC) * MAX_ZOOM_PX_PER_SEC);
      }
    });
  }

  it("stays exact at the 24 h end of the grid", () => {
    const model = modelAroundFrame(TARGET_FRAME_24H, 60, 1);
    const expected = canonicalUs(TARGET_FRAME_24H, 60, 1);
    expect(tickAt(model, TARGET_FRAME_24H).tUs).toBe(expected);
    expect(tickAt(model, TARGET_FRAME_24H).tUs).toBe(actorSnap(expected, 60, 1));
  });

  it("does not accumulate a nominal frame duration", () => {
    // `i * approxFrameDurUs` is 36 ms adrift by frame 107_999 at 30 fps — more
    // than a whole frame, and 72 px at max zoom.
    const model = modelAroundFrame(107_999, 30, 1);
    const drifted = 107_999 * approxFrameDurUs(30, 1);
    const tk = tickAt(model, 107_999);
    const gapUs = tk.tUs - drifted;
    expect(gapUs).toBeGreaterThan(approxFrameDurUs(30, 1));
    expect((gapUs / US_PER_SEC) * MAX_ZOOM_PX_PER_SEC).toBeGreaterThan(50);
    // A drifted tick would also carry the wrong timecode label.
    expect(formatTimecode(drifted, 30, 1)).not.toBe(
      formatTimecode(tk.tUs, 30, 1),
    );
  });

  it("puts a committed clip edge on its own tick an hour in", () => {
    // What the actor stores when an edge is dropped near the one-hour mark.
    const edgeUs = actorSnap(3_600_000_000, 30_000, 1001);
    const frame = frameIndexRound(edgeUs, 30_000, 1001);
    expect(tickAt(modelAroundFrame(frame, 30_000, 1001), frame).tUs).toBe(
      edgeUs,
    );
  });

  it("keeps minor ticks at every frame and majors on the stride", () => {
    const model = computeRulerModel({
      fpsNum: 30_000,
      fpsDen: 1001,
      pxPerSec: 2000,
      totalSec: 3,
      scrollLeftPx: 0,
      viewportWidthPx: 6000,
    });
    expect(model.majorSec).toBe(0);
    // 2000 px/s at 29.97 is ~66.7 px/frame, so a 2-frame major stride is the
    // smallest that clears the frame-mode major target.
    expect(model.strideFrames).toBe(2);
    for (const tk of model.ticks) expect(tk.isMajor).toBe(tk.frame % 2 === 0);
    // Every frame of the row is present, plus the trailing clipped tick.
    const last = model.ticks[model.ticks.length - 1]!;
    const penultimate = model.ticks[model.ticks.length - 2]!;
    expect(last.tUs).toBeGreaterThanOrEqual(3_000_000);
    expect(penultimate.tUs).toBeLessThan(3_000_000);
  });
});

describe("viewport-bounded tick count", () => {
  /// The acceptance criterion: at one zoom and one viewport, composition length
  /// must not enter the count.
  const DURATIONS: [string, number][] = [
    ["10 s", 10],
    ["1 h", 3600],
    ["24 h", 86_400],
  ];

  function countsAcrossDurations(
    common: Omit<RulerModelInput, "totalSec">,
  ): number[] {
    return DURATIONS.map(
      ([, totalSec]) => computeRulerModel({ ...common, totalSec }).ticks.length,
    );
  }

  it("frame mode: 10 s, 1 h and 24 h paint the same node count", () => {
    for (const scrollLeftPx of [0, 5000]) {
      const counts = countsAcrossDurations({
        fpsNum: 60,
        fpsDen: 1,
        pxPerSec: MAX_ZOOM_PX_PER_SEC,
        scrollLeftPx,
        viewportWidthPx: VIEWPORT_PX,
      });
      expect(new Set(counts).size).toBe(1);
      // 60 fps at 2000 px/s is 33.3 px/frame; the window is the viewport plus
      // two overscans.
      expect(counts[0]).toBeLessThan(80);
    }
  });

  it("second mode: 10 s, 1 h and 24 h paint the same node count", () => {
    const counts = countsAcrossDurations({
      fpsNum: 60,
      fpsDen: 1,
      // 5 px/frame — below the frame-mode threshold, and high enough that the
      // 10 s row is still wider than the window.
      pxPerSec: 300,
      scrollLeftPx: 0,
      viewportWidthPx: VIEWPORT_PX,
    });
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeLessThan(120);
  });

  it("allocates no frame-sized array for a 24 h 60 fps grid", () => {
    // The row holds 5_184_000 frames; the model may hold only the window.
    const model = computeRulerModel({
      fpsNum: 60,
      fpsDen: 1,
      pxPerSec: MAX_ZOOM_PX_PER_SEC,
      totalSec: 86_400,
      scrollLeftPx: 1_000_000,
      viewportWidthPx: VIEWPORT_PX,
    });
    expect(model.mode).toBe("frame");
    expect(model.ticks.length).toBeLessThan(100);
  });

  it("keeps the painted window over the viewport at every scroll offset", () => {
    // The window is built from a scroll offset quantized to
    // RULER_SCROLL_QUANTUM_PX, so it can lag the true offset by just under a
    // quantum. The overscan is what absorbs that — assert the invariant, then
    // assert the coverage it buys.
    expect(RULER_OVERSCAN_PX).toBeGreaterThanOrEqual(RULER_SCROLL_QUANTUM_PX);
    for (const trueScrollLeftPx of [0, 1, 199, 200, 5321, 40_000]) {
      const quantized =
        Math.floor(trueScrollLeftPx / RULER_SCROLL_QUANTUM_PX) *
        RULER_SCROLL_QUANTUM_PX;
      const model = computeRulerModel({
        fpsNum: 60,
        fpsDen: 1,
        pxPerSec: MAX_ZOOM_PX_PER_SEC,
        totalSec: 3600,
        scrollLeftPx: quantized,
        viewportWidthPx: VIEWPORT_PX,
      });
      const xs = model.ticks.map((t) => t.xPx);
      expect(Math.min(...xs)).toBeLessThanOrEqual(trueScrollLeftPx);
      expect(Math.max(...xs)).toBeGreaterThanOrEqual(
        trueScrollLeftPx + VIEWPORT_PX,
      );
    }
  });
});

describe("windowing is a pure restriction of the whole-row grid", () => {
  /// The regression this ticket could introduce: a windowed tick that differs
  /// from the tick the un-windowed grid would have put there. Scrolling the
  /// window across a short row must reproduce the whole-row set exactly.
  function assertWindowsReproduceRow(
    base: Omit<RulerModelInput, "scrollLeftPx" | "viewportWidthPx">,
  ): void {
    const rowPx = base.totalSec * base.pxPerSec;
    const whole = computeRulerModel({
      ...base,
      scrollLeftPx: 0,
      viewportWidthPx: rowPx,
      overscanPx: 0,
    });
    const byFrame = new Map(whole.ticks.map((t) => [t.frame, t]));
    const seen = new Set<number>();
    // A step that is not a divisor of the tick pitch, so windows straddle ticks.
    for (let scrollLeftPx = 0; scrollLeftPx <= rowPx; scrollLeftPx += 137) {
      const model = computeRulerModel({
        ...base,
        scrollLeftPx,
        viewportWidthPx: 300,
      });
      expect(model.mode).toBe(whole.mode);
      expect(model.strideFrames).toBe(whole.strideFrames);
      expect(model.majorSec).toBe(whole.majorSec);
      for (const tk of model.ticks) {
        expect(byFrame.get(tk.frame)).toEqual(tk);
        seen.add(tk.frame);
      }
    }
    expect(seen.size).toBe(whole.ticks.length);
  }

  it("frame mode", () => {
    assertWindowsReproduceRow({
      fpsNum: 30_000,
      fpsDen: 1001,
      pxPerSec: 2000,
      totalSec: 3,
    });
  });

  it("second mode", () => {
    assertWindowsReproduceRow({
      fpsNum: 30,
      fpsDen: 1,
      pxPerSec: 80,
      totalSec: 10,
    });
  });
});

describe("regime selection", () => {
  const at = (pxPerSec: number, num: number, den: number): RulerModel =>
    computeRulerModel({
      fpsNum: num,
      fpsDen: den,
      pxPerSec,
      totalSec: 10,
      scrollLeftPx: 0,
      viewportWidthPx: VIEWPORT_PX,
    });

  it("switches at 12 px per frame, using the nominal frame width", () => {
    // 33_333 µs nominal at 30 fps → the threshold sits at 360.004 px/s.
    expect(at(361, 30, 1).mode).toBe("frame");
    expect(at(359, 30, 1).mode).toBe("second");
    // Same density at 60 fps needs twice the zoom.
    expect(at(361, 60, 1).mode).toBe("second");
    expect(at(721, 60, 1).mode).toBe("frame");
  });

  it("stays on the second ladder for a degenerate fps", () => {
    expect(at(2000, 0, 1).mode).toBe("second");
    expect(at(2000, 30, 0).mode).toBe("second");
  });

  it("has no layout to compute at a non-positive zoom", () => {
    expect(at(0, 30, 1).ticks).toEqual([]);
  });

  it("keeps the second-mode ladder and its trailing half-step", () => {
    // 100/80 px target → the 2 s major, 0.4 s minors, majors every 5th tick.
    const model = computeRulerModel({
      fpsNum: 30,
      fpsDen: 1,
      pxPerSec: 80,
      totalSec: 10,
      scrollLeftPx: 0,
      viewportWidthPx: 800,
    });
    expect(model.mode).toBe("second");
    expect(model.majorSec).toBe(2);
    expect(model.ticks.map((t) => t.tUs).slice(0, 3)).toEqual([
      0, 400_000, 800_000,
    ]);
    expect(model.ticks.filter((t) => t.isMajor).map((t) => t.tUs)).toEqual([
      0, 2_000_000, 4_000_000, 6_000_000, 8_000_000, 10_000_000,
    ]);
    // Half a minor step past totalSec, then stop.
    const last = model.ticks[model.ticks.length - 1]!;
    expect(last.tUs).toBe(10_000_000);
    expect(last.xPx).toBe(800);
  });
});

describe("the two grids agree across the frame-mode threshold", () => {
  /// Acceptance: zooming through the threshold must not jump tick positions.
  /// Both regimes map time to px with the same `tUs / 1e6 * pxPerSec`, so what
  /// has to hold is that the second ladder's times sit on the frame grid to
  /// within half a frame — 6 px at the 12-px-per-frame threshold.
  for (const [num, den] of RATES) {
    it(`${num}/${den}`, () => {
      const frameDurUs = approxFrameDurUs(num, den);
      const thresholdPxPerSec = (12 * US_PER_SEC) / frameDurUs;
      const common = {
        fpsNum: num,
        fpsDen: den,
        totalSec: 60,
        scrollLeftPx: 0,
        viewportWidthPx: VIEWPORT_PX,
      };
      const below = computeRulerModel({
        ...common,
        pxPerSec: thresholdPxPerSec * 0.999,
      });
      const above = computeRulerModel({
        ...common,
        pxPerSec: thresholdPxPerSec * 1.001,
      });
      expect(below.mode).toBe("second");
      expect(above.mode).toBe("frame");

      // Same time → same pixel, in both regimes.
      for (const [model, pxPerSec] of [
        [below, thresholdPxPerSec * 0.999],
        [above, thresholdPxPerSec * 1.001],
      ] as const) {
        for (const tk of model.ticks) {
          expect(tk.xPx).toBeCloseTo((tk.tUs / US_PER_SEC) * pxPerSec, 6);
        }
      }

      // Every second-mode tick lands within half a frame of the frame grid the
      // zoom-in reveals.
      const lastCommonUs = above.ticks[above.ticks.length - 1]!.tUs;
      for (const tk of below.ticks) {
        if (tk.tUs > lastCommonUs) continue;
        const nearest = timeUsAtFrame(
          frameIndexRound(tk.tUs, num, den),
          num,
          den,
        );
        expect(Math.abs(nearest - tk.tUs)).toBeLessThanOrEqual(
          frameDurUs / 2 + 1,
        );
      }
      // What that bound is worth on screen at the crossover.
      expect((frameDurUs / 2 / US_PER_SEC) * thresholdPxPerSec).toBeLessThan(
        6.5,
      );
    });
  }
});

describe("labels", () => {
  it("labels frame-mode majors with the timecode of their canonical time", () => {
    const model = modelAroundFrame(1800, 30_000, 1001);
    const tk = tickAt(model, 1800);
    expect(tk.isMajor).toBe(true);
    expect(tk.label).toBe(formatTimecode(tk.tUs, 30_000, 1001));
    // Minors carry no label — the component keys its <span> off the field.
    expect(model.ticks.find((t) => !t.isMajor)?.label).toBeUndefined();
  });

  it("labels second-mode majors with mm:ss", () => {
    const model = computeRulerModel({
      fpsNum: 30,
      fpsDen: 1,
      pxPerSec: 80,
      totalSec: 10,
      scrollLeftPx: 0,
      viewportWidthPx: 800,
    });
    expect(
      model.ticks.filter((t) => t.isMajor).map((t) => t.label),
    ).toEqual(["0:00", "0:02", "0:04", "0:06", "0:08", "0:10"]);
  });
});

// ===== Markers =============================================================

/// 1000 px/s throughout, so 1 ms of marker time is exactly 1 px of row and every
/// expectation below can be read as a distance.
const MARKER_PX_PER_SEC = 1000;

function marker(
  over: Partial<RulerMarkerSource> & Pick<RulerMarkerSource, "id" | "t_us">,
): RulerMarkerSource {
  return {
    end_t_us: null,
    label: "",
    color_hint: "#ff0000",
    ...over,
  };
}

/// Zero overscan by default, so a windowing expectation is about the interval the
/// case names rather than about `RULER_OVERSCAN_PX`. The one case that is about
/// the overscan passes its own.
function markersIn(
  markers: RulerMarkerSource[],
  over: Partial<Parameters<typeof computeRulerMarkers>[0]> = {},
) {
  return computeRulerMarkers({
    markers,
    pxPerSec: MARKER_PX_PER_SEC,
    scrollLeftPx: 0,
    viewportWidthPx: 1000,
    overscanPx: 0,
    ...over,
  });
}

describe("marker windowing", () => {
  it("emits only the markers the window can show", () => {
    const views = markersIn([
      marker({ id: "before", t_us: 500_000 }),
      marker({ id: "inside", t_us: 1_500_000 }),
      marker({ id: "after", t_us: 4_000_000 }),
    ], { scrollLeftPx: 1000, viewportWidthPx: 1000 });
    expect(views.map((v) => v.id)).toEqual(["inside"]);
  });

  it("keeps a region that only overlaps the window at one edge", () => {
    // Both regions start or end outside the 1000–2000 px window but cross it.
    const views = markersIn([
      marker({ id: "straddles-left", t_us: 200_000, end_t_us: 1_200_000 }),
      marker({ id: "straddles-right", t_us: 1_800_000, end_t_us: 3_000_000 }),
      marker({ id: "spans-both", t_us: 0, end_t_us: 5_000_000 }),
      marker({ id: "clear-of-it", t_us: 3_500_000, end_t_us: 3_600_000 }),
    ], { scrollLeftPx: 1000, viewportWidthPx: 1000 });
    expect(views.map((v) => v.id)).toEqual([
      "spans-both",
      "straddles-left",
      "straddles-right",
    ]);
  });

  it("paints the overscan the ticks already use", () => {
    // 400 px of overscan each side of a 1000–2000 px viewport, i.e. 600–2400 px.
    const inOverscan = markersIn([marker({ id: "m", t_us: 700_000 })], {
      scrollLeftPx: 1000,
      viewportWidthPx: 1000,
      overscanPx: RULER_OVERSCAN_PX,
    });
    expect(inOverscan.map((v) => v.id)).toEqual(["m"]);
    const pastIt = markersIn([marker({ id: "m", t_us: 500_000 })], {
      scrollLeftPx: 1000,
      viewportWidthPx: 1000,
      overscanPx: RULER_OVERSCAN_PX,
    });
    expect(pastIt).toEqual([]);
  });

  it("costs nothing per off-screen marker on a project carrying hundreds", () => {
    // The count must follow the window, never the project — a shot-detection
    // sweep drops hundreds of markers in one commit.
    const many = Array.from({ length: 500 }, (_, i) =>
      marker({ id: `m${i}`, t_us: i * 1_000_000 }),
    );
    expect(markersIn(many, { scrollLeftPx: 0, viewportWidthPx: 1000 })).toHaveLength(2);
  });

  it("has no layout to compute at a non-positive zoom", () => {
    expect(markersIn([marker({ id: "m", t_us: 0 })], { pxPerSec: 0 })).toEqual([]);
  });
});

describe("marker geometry", () => {
  it("puts a point marker's mark on its own time", () => {
    const [view] = markersIn([marker({ id: "m", t_us: 500_000 })]);
    expect(view).toMatchObject({ xPx: 500, widthPx: 0, shape: "point" });
    // A point has no range to report, so the tooltip has no end to print.
    expect(view!.endTUs).toBeNull();
  });

  it("spans a region marker from its start to its end", () => {
    const [view] = markersIn([
      marker({ id: "m", t_us: 200_000, end_t_us: 700_000 }),
    ]);
    expect(view).toMatchObject({
      xPx: 200,
      widthPx: 500,
      shape: "region",
      endTUs: 700_000,
    });
  });

  it("degrades a region under the threshold to the point shape", () => {
    const [view] = markersIn([
      marker({ id: "m", t_us: 1_000_000, end_t_us: 1_002_000 }),
    ]);
    expect(view!.shape).toBe("point");
    expect(view!.widthPx).toBe(0);
    // The lie is about the SHAPE only — the tooltip still gets the real range.
    expect(view!.endTUs).toBe(1_002_000);
  });

  it("anchors a degraded region at its exact start, neither centred nor widened", () => {
    const [view] = markersIn([
      marker({ id: "m", t_us: 1_000_000, end_t_us: 1_002_000 }),
    ]);
    expect(view!.xPx).toBe(1000);
  });

  it("switches shape exactly at the threshold width", () => {
    const at = (widthUs: number) =>
      markersIn([marker({ id: "m", t_us: 0, end_t_us: widthUs })])[0]!.shape;
    const thresholdUs = MARKER_MIN_REGION_PX * 1000;
    expect(at(thresholdUs)).toBe("region");
    expect(at(thresholdUs - 1)).toBe("point");
  });

  it("re-earns the bar when the zoom makes the region wide enough", () => {
    const short = [marker({ id: "m", t_us: 0, end_t_us: 2_000 })];
    expect(markersIn(short, { pxPerSec: 1000 })[0]!.shape).toBe("point");
    expect(markersIn(short, { pxPerSec: 2000 })[0]!.shape).toBe("region");
  });

  it("treats a non-advancing end as a point", () => {
    // Defensive: a zero-length or inverted region has no range to report, so it
    // must not produce a `start – start` tooltip.
    for (const end of [1_000_000, 900_000]) {
      const [view] = markersIn([
        marker({ id: "m", t_us: 1_000_000, end_t_us: end }),
      ]);
      expect(view).toMatchObject({ shape: "point", widthPx: 0, endTUs: null });
    }
  });
});

describe("marker ordering and payload", () => {
  it("orders by time, so a later marker paints over an earlier one", () => {
    const views = markersIn([
      marker({ id: "c", t_us: 900_000 }),
      marker({ id: "a", t_us: 100_000 }),
      marker({ id: "b", t_us: 500_000 }),
    ]);
    expect(views.map((v) => v.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks a same-time tie deterministically", () => {
    const ids = () =>
      markersIn([
        marker({ id: "z", t_us: 100_000 }),
        marker({ id: "a", t_us: 100_000 }),
      ]).map((v) => v.id);
    expect(ids()).toEqual(["a", "z"]);
    expect(ids()).toEqual(ids());
  });

  it("carries the authored colour and label through untouched", () => {
    const [view] = markersIn([
      marker({
        id: "m",
        t_us: 100_000,
        label: "needs VO",
        color_hint: "#0a1b2c",
      }),
    ]);
    expect(view).toMatchObject({
      id: "m",
      label: "needs VO",
      color: "#0a1b2c",
      tUs: 100_000,
    });
  });
});
