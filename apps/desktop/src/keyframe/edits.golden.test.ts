import { describe, expect, it } from "vitest";
import type { AnimTrack, Interpolation, Keyframe } from "../ipc";
import {
  upsertKeyframe,
  removeKeyframe,
  retimeKeyframe,
  setKeyframeInterp,
  smoothKeyframe,
} from "./edits";
import fixture from "./keyframeEditsGolden.fixture.json";

type Track = AnimTrack<number>;
interface Case {
  name: string;
  op: string;
  args: Record<string, unknown>;
  input: Track;
  expect: Track;
}

function applyOp(track: Track, op: string, args: Record<string, unknown>): Track {
  switch (op) {
    case "upsert":
      return upsertKeyframe(track, args.t_us as number, args.value as number);
    case "remove":
      return removeKeyframe(track, args.id as string, args.fallback as number);
    case "retime":
      return retimeKeyframe(track, args.id as string, args.new_t_us as number);
    case "set_interp":
      return setKeyframeInterp(track, args.id as string, args.interp as Interpolation);
    case "smooth_one":
      return smoothKeyframe(track, args.id as string);
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const NEAR = 1e-9;
function interpEq(a: Interpolation, b: Interpolation) {
  expect(a.kind).toBe(b.kind);
  if (a.kind === "Bezier" && b.kind === "Bezier") {
    expect(Math.abs(a.p1[0] - b.p1[0])).toBeLessThan(NEAR);
    expect(Math.abs(a.p1[1] - b.p1[1])).toBeLessThan(NEAR);
    expect(Math.abs(a.p2[0] - b.p2[0])).toBeLessThan(NEAR);
    expect(Math.abs(a.p2[1] - b.p2[1])).toBeLessThan(NEAR);
  }
}

function assertTrackEqIgnoringIds(got: Track, want: Track) {
  expect(got.mode).toBe(want.mode);
  if (got.mode === "Static" && want.mode === "Static") {
    expect(Math.abs(got.value - want.value)).toBeLessThan(NEAR);
    return;
  }
  if (got.mode === "Keyframed" && want.mode === "Keyframed") {
    expect(got.value.length).toBe(want.value.length);
    got.value.forEach((g: Keyframe<number>, i: number) => {
      const w = want.value[i]!;
      expect(g.t_us).toBe(w.t_us);
      expect(Math.abs(g.value - w.value)).toBeLessThan(NEAR);
      interpEq(g.interp, w.interp);
    });
    return;
  }
  throw new Error("mode mismatch");
}

describe("keyframe edits golden", () => {
  for (const c of fixture.cases as Case[]) {
    it(c.name, () => {
      const got = applyOp(c.input, c.op, c.args);
      assertTrackEqIgnoringIds(got, c.expect);
    });
  }
});
