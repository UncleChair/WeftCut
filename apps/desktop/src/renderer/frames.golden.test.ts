// Cross-language golden vectors for the frame grid. The SAME fixture is
// asserted by `native/eval/src/lib.rs::golden_vectors_match_fixture` against the
// Rust i128 implementation; a value that passes one side and fails the other is
// snap-math drift — exactly what this test exists to catch (see memory:
// snap_math_drift). Exact `toBe`: f64 (TS) and i128 (Rust) agree bit-for-bit on
// the frame grid up to 24 h timelines.
//
// `cases` pins `snapFrameRound`; `grid_cases` pins `timeUsAtFrame`, the three
// index policies, and the µs each one snaps to.

import { describe, expect, it } from "vitest";
import fixture from "./snapFrameGolden.fixture.json";
import {
  frameIndexCeil,
  frameIndexFloor,
  frameIndexRound,
  snapFrameCeil,
  snapFrameFloor,
  snapFrameRound,
  timeUsAtFrame,
} from "./frames";

// The primitives are wasm-backed (the shared weftcut-eval crate, loaded by the
// global test setup). This golden verifies the wasm reproduces the fixture
// (single source).

interface Case {
  name: string;
  fps_num: number;
  fps_den: number;
  samples: { t_us: number; expect: number }[];
}

interface GridCase {
  name: string;
  fps_num: number;
  fps_den: number;
  frame_times: { frame: number; expect: number }[];
  samples: {
    t_us: number;
    floor_frame: number;
    round_frame: number;
    ceil_frame: number;
    floor_us: number;
    round_us: number;
    ceil_us: number;
  }[];
}

const f = fixture as { cases: Case[]; grid_cases: GridCase[] };

describe("snap_frame_round golden vectors (cross-language)", () => {
  for (const c of f.cases) {
    it(c.name, () => {
      for (const s of c.samples) {
        expect(snapFrameRound(s.t_us, c.fps_num, c.fps_den)).toBe(s.expect);
      }
    });
  }
});

describe("frame-grid golden vectors (cross-language)", () => {
  for (const c of f.grid_cases) {
    it(c.name, () => {
      const n = c.fps_num;
      const d = c.fps_den;
      for (const ft of c.frame_times) {
        expect(timeUsAtFrame(ft.frame, n, d)).toBe(ft.expect);
      }
      for (const s of c.samples) {
        expect(frameIndexFloor(s.t_us, n, d)).toBe(s.floor_frame);
        expect(frameIndexRound(s.t_us, n, d)).toBe(s.round_frame);
        expect(frameIndexCeil(s.t_us, n, d)).toBe(s.ceil_frame);
        expect(snapFrameFloor(s.t_us, n, d)).toBe(s.floor_us);
        expect(snapFrameRound(s.t_us, n, d)).toBe(s.round_us);
        expect(snapFrameCeil(s.t_us, n, d)).toBe(s.ceil_us);
      }
    });
  }
});
