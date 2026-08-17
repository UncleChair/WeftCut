// @vitest-environment node
// The heaviest correctness load of the colour trio, and entirely GPU-free:
// these three writers ARE the grade. The gate that follows them proves
// precision and says nothing about whether a matrix is right — the
// equal-weight-saturation bug this module exists to avoid is invisible to it.
import { describe, expect, it } from "vitest";
import {
  COLOR_MATRIX_LENGTH,
  REC709_LUMA,
  writeBrightness,
  writeContrast,
  writeSaturation,
} from "./colorMatrices";

const WRITERS = {
  brightness: writeBrightness,
  contrast: writeContrast,
  saturation: writeSaturation,
} as const;

const IDENTITY = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/// A slot the writer forgot to fill stays NaN and fails the comparison, so
/// every assertion below doubles as a totality check.
const blank = (): number[] => new Array<number>(COLOR_MATRIX_LENGTH).fill(NaN);

const wrote = (write: (out: number[], v: number) => void, v: number): number[] => {
  const m = blank();
  write(m, v);
  return m;
};

/// The fragment shader's maths, on unpremultiplied input:
///   result.r = m[0]·r + m[1]·g + m[2]·b + m[3]·a + m[4]   (and so on)
/// Kept here rather than in the module because the module's job is to write
/// the matrix, not to evaluate it — this is the test's own reading of
/// colorMatrixFilter.frag.
function transform(m: number[], rgba: [number, number, number, number]): number[] {
  const out: number[] = [];
  for (let row = 0; row < 4; row++) {
    const b = row * 5;
    out.push(
      m[b]! * rgba[0] + m[b + 1]! * rgba[1] + m[b + 2]! * rgba[2] + m[b + 3]! * rgba[3] + m[b + 4]!,
    );
  }
  return out;
}

const closeTo = (got: number[], want: number[]) => {
  expect(got.length).toBe(want.length);
  got.forEach((v, i) => expect(v, `slot ${i}`).toBeCloseTo(want[i]!, 10));
};

describe("colour matrix writers — shared contract", () => {
  for (const [name, write] of Object.entries(WRITERS)) {
    it(`${name}: amount 0 is the identity matrix`, () => {
      closeTo(wrote(write, 0), IDENTITY);
    });

    it(`${name}: the alpha row stays [0,0,0,1,0] at every amount`, () => {
      for (const v of [-100, -50, -1, 0, 1, 37.5, 100]) {
        expect(wrote(write, v).slice(15), `amount ${v}`).toEqual([0, 0, 0, 1, 0]);
      }
    });

    it(`${name}: writes in place — same array, still 20 slots`, () => {
      const m = blank();
      const returned = write(m, 42) as unknown;
      write(m, -13);
      expect(returned).toBeUndefined();
      expect(m.length).toBe(COLOR_MATRIX_LENGTH);
      expect(m).toEqual(wrote(write, -13));
    });
  }
});

describe("writeBrightness", () => {
  it("is a gain of 1 + v/100 on the diagonal, with no offset", () => {
    const m = wrote(writeBrightness, 20);
    closeTo(m, [
      1.2, 0, 0, 0, 0,
      0, 1.2, 0, 0, 0,
      0, 0, 1.2, 0, 0,
      0, 0, 0, 1, 0,
    ]);
  });

  it("preserves black at every positive amount — the reason it is a gain, not a lift", () => {
    for (const v of [1, 20, 50, 100]) {
      const rgb = transform(wrote(writeBrightness, v), [0, 0, 0, 1]).slice(0, 3);
      expect(rgb, `amount ${v}`).toEqual([0, 0, 0]);
    }
  });

  it("scales a mid grey by the gain", () => {
    closeTo(transform(wrote(writeBrightness, 20), [0.5, 0.5, 0.5, 1]), [0.6, 0.6, 0.6, 1]);
  });

  it("-100 is an all-zero diagonal — a black frame", () => {
    const m = wrote(writeBrightness, -100);
    closeTo(m.slice(0, 15), new Array<number>(15).fill(0));
    closeTo(transform(m, [0.8, 0.4, 0.2, 1]), [0, 0, 0, 1]);
  });
});

describe("writeContrast", () => {
  it("is a gain of 1 + v/100 pivoted at 0.5 by an offset of 0.5·(1 − c)", () => {
    const m = wrote(writeContrast, 20);
    closeTo(m, [
      1.2, 0, 0, 0, -0.1,
      0, 1.2, 0, 0, -0.1,
      0, 0, 1.2, 0, -0.1,
      0, 0, 0, 1, 0,
    ]);
  });

  it("leaves mid grey where it is, at every amount (that is what the pivot means)", () => {
    for (const v of [-100, -40, 0, 40, 100]) {
      closeTo(transform(wrote(writeContrast, v), [0.5, 0.5, 0.5, 1]), [0.5, 0.5, 0.5, 1]);
    }
  });

  it("-100 collapses the frame to flat mid grey", () => {
    const m = wrote(writeContrast, -100);
    closeTo(m, [
      0, 0, 0, 0, 0.5,
      0, 0, 0, 0, 0.5,
      0, 0, 0, 0, 0.5,
      0, 0, 0, 1, 0,
    ]);
    const cases: Array<[number, number, number, number]> = [
      [0, 0, 0, 1],
      [1, 1, 1, 1],
      [0.9, 0.1, 0.3, 1],
    ];
    for (const c of cases) closeTo(transform(m, c).slice(0, 3), [0.5, 0.5, 0.5]);
  });

  it("+100 doubles the distance from mid grey", () => {
    closeTo(transform(wrote(writeContrast, 100), [0.6, 0.4, 0.5, 1]), [0.7, 0.3, 0.5, 1]);
  });
});

describe("writeSaturation", () => {
  it("mixes towards Rec.709 luma: every row is the weights at -100", () => {
    const [lr, lg, lb] = REC709_LUMA;
    closeTo(wrote(writeSaturation, -100), [
      lr, lg, lb, 0, 0,
      lr, lg, lb, 0, 0,
      lr, lg, lb, 0, 0,
      0, 0, 0, 1, 0,
    ]);
  });

  // The regression that decided decision 2. pixi's own ColorMatrixFilter
  // .saturate() lays out equal weights (x = amount·2/3 + 1, y = (x−1)·−0.5),
  // so at full desaturation pure green and pure blue BOTH land on 0.333 — a
  // factor of ~9.9 error on blue, and a greyscale that reads as a flat paste.
  it("fully desaturated, pure green is 0.715 and pure blue is 0.072 — not 0.333", () => {
    const m = wrote(writeSaturation, -100);
    const green = transform(m, [0, 1, 0, 1]);
    const blue = transform(m, [0, 0, 1, 1]);
    for (const ch of green.slice(0, 3)) expect(ch).toBeCloseTo(0.7152, 6);
    for (const ch of blue.slice(0, 3)) expect(ch).toBeCloseTo(0.0722, 6);
    expect(green[0]).not.toBeCloseTo(1 / 3, 2);
    expect(blue[0]).not.toBeCloseTo(1 / 3, 2);
    // Green stays brighter than blue — the whole point (user story 4).
    expect(green[0]!).toBeGreaterThan(blue[0]!);
  });

  it("desaturating leaves a neutral grey untouched (the weights sum to 1)", () => {
    for (const v of [-100, -60, 0, 60, 100]) {
      closeTo(transform(wrote(writeSaturation, v), [0.3, 0.3, 0.3, 1]), [0.3, 0.3, 0.3, 1]);
    }
  });

  it("keeps the luma of a colour it desaturates part-way", () => {
    const [lr, lg, lb] = REC709_LUMA;
    const src: [number, number, number, number] = [0.8, 0.4, 0.2, 1];
    const luma = lr * src[0] + lg * src[1] + lb * src[2];
    const out = transform(wrote(writeSaturation, -50), src);
    expect(lr * out[0]! + lg * out[1]! + lb * out[2]!).toBeCloseTo(luma, 10);
  });

  it("+100 pushes colour away from its luma, twice as far", () => {
    const [lr, lg, lb] = REC709_LUMA;
    const src: [number, number, number, number] = [0.8, 0.4, 0.2, 1];
    const luma = lr * src[0] + lg * src[1] + lb * src[2];
    const out = transform(wrote(writeSaturation, 100), src);
    closeTo(out.slice(0, 3), [
      luma + 2 * (src[0] - luma),
      luma + 2 * (src[1] - luma),
      luma + 2 * (src[2] - luma),
    ]);
  });
});
