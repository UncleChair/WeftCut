import { describe, expect, it } from "vitest";

import { displayedFrameStartUs } from "../frames";
import type { MarkerSummary } from "../ipc";
import { markerStartingInFrame } from "./markerAtFrame";

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function marker(tUs: number, endTUs: number | null = null): MarkerSummary {
  seq += 1;
  return {
    id: `marker-${seq}`,
    t_us: tUs,
    end_t_us: endTUs,
    label: "",
    color_hint: "#0080ff",
  };
}

// 25 fps → 40 000 µs frames: mid-frame arithmetic stays legible.
const FPS = [25, 1] as const;

function find(
  markers: MarkerSummary[],
  playheadUs: number,
  [num, den]: readonly [number, number] = FPS,
): MarkerSummary | null {
  return markerStartingInFrame(markers, playheadUs, num, den);
}

describe("markerStartingInFrame", () => {
  it("finds nothing in an unmarked project", () => {
    expect(find([], 0)).toBeNull();
  });

  it("matches a point marker anywhere inside its frame, not just on its anchor", () => {
    const m = marker(80_000);
    expect(find([m], 80_000)?.id).toBe(m.id);
    // Playhead mid-frame still displays frame 2, so the frame "carries" m.
    expect(find([m], 100_000)?.id).toBe(m.id);
    // First µs of the next frame does not.
    expect(find([m], 120_000)).toBeNull();
  });

  it("ignores markers in other frames", () => {
    expect(find([marker(0), marker(200_000)], 80_000)).toBeNull();
  });

  it("matches a region by its START frame", () => {
    const region = marker(80_000, 400_000);
    expect(find([region], 90_000)?.id).toBe(region.id);
  });

  it("a region merely SPANNING the frame does not block it", () => {
    // Starts is the rule, not coverage: a new point marker may land inside a
    // region — the shot the region describes can still contain a flaw worth
    // its own mark.
    const region = marker(0, 400_000);
    expect(find([region], 200_000)).toBeNull();
  });

  it("several markers on one frame: the first in sorted order wins", () => {
    const first = marker(80_000);
    const second = marker(80_000);
    expect(find([first, second], 80_000)?.id).toBe(first.id);
  });

  it("holds at fractional rates", () => {
    // Derive the anchor through the same helper the matcher uses, so the case
    // asserts the same-frame rule rather than a wasm rounding convention.
    const anchorUs = displayedFrameStartUs(50_000, 30_000, 1_001);
    const m = marker(anchorUs);
    expect(
      markerStartingInFrame([m], anchorUs + 10, 30_000, 1_001)?.id,
    ).toBe(m.id);
    expect(
      markerStartingInFrame([m], anchorUs + 40_000, 30_000, 1_001),
    ).toBeNull();
  });
});
