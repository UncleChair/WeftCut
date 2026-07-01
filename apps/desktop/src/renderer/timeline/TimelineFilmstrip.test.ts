import { describe, expect, it } from "vitest";
import {
  selectFilmstripFrames,
  type TimelineFilmstripFrame,
} from "./TimelineFilmstrip";

const frames: TimelineFilmstripFrame[] = Array.from({ length: 10 }, (_, index) => ({
  index,
  tUs: index * 1_000_000,
  path: `${index}.jpg`,
}));

describe("selectFilmstripFrames", () => {
  it("uses frames from the layer source window", () => {
    expect(
      selectFilmstripFrames(frames, 3_000_000, 7_000_000).map((frame) => frame.index),
    ).toEqual([3, 4, 5, 6]);
  });

  it("uses the nearest representative frame for source windows between cached frames", () => {
    expect(
      selectFilmstripFrames(frames, 3_250_000, 3_750_000).map((frame) => frame.index),
    ).toEqual([3]);
  });
});
