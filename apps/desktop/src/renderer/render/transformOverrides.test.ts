// The two things about this map that are easy to get subtly wrong: the Text box
// channel is ABSOLUTE where everything else is additive, and on that channel
// `null` is a value ("Auto on that axis") distinct from absent ("don't touch").
// The gizmo's own suite drives the whole gesture; this one pins the fold.

import { afterEach, describe, expect, it } from "vitest";

import {
  resetTransformOverrides,
  setTransformOverride,
  subscribeTransformOverrides,
  withTextBoxOverride,
  withTransformOverride,
} from "./transformOverrides";

/// The transform fields `withTransformOverride` is generic over, plus the box
/// pair — i.e. the shape of a resolved Text view, which is the only kind that
/// goes through both folds.
const textView = {
  x: 100,
  y: 50,
  scale_x: 1,
  scale_y: 1,
  rotation_deg: 0,
  anchor_x: 0.5,
  anchor_y: 0.5,
  box_w: 640 as number | null,
  box_h: 360 as number | null,
};

afterEach(() => resetTransformOverrides());

describe("withTextBoxOverride", () => {
  it("is the identity with no override at all — the export realm's whole story", () => {
    expect(withTextBoxOverride("l1", textView)).toBe(textView);
  });

  it("is the identity for a delta that carries no box, so a move drag costs nothing", () => {
    setTransformOverride("l1", { dx: 10, dy: 20 });
    expect(withTextBoxOverride("l1", textView)).toBe(textView);
  });

  it("REPLACES the box rather than adding to it", () => {
    setTransformOverride("l1", { dx: 0, dy: 0, boxW: 960, boxH: 540 });
    const out = withTextBoxOverride("l1", textView);
    expect([out.box_w, out.box_h]).toEqual([960, 540]);
    // Nothing else moved: the box fold touches two fields and no more.
    expect(out.x).toBe(100);
  });

  it("lets null through as Auto instead of falling back to the layer's box", () => {
    // The `??` trap. A double-click back to Auto width publishes `null`, and a
    // fold written with `??` would read that as "absent" and hand back 640 — so
    // the layer would keep wrapping at a width the user just released.
    setTransformOverride("l1", { dx: 0, dy: 0, boxW: null, boxH: null });
    const out = withTextBoxOverride("l1", textView);
    expect([out.box_w, out.box_h]).toEqual([null, null]);
  });

  it("keeps an untouched axis when only one is overridden", () => {
    setTransformOverride("l1", { dx: 0, dy: 0, boxH: 100 });
    const out = withTextBoxOverride("l1", textView);
    expect([out.box_w, out.box_h]).toEqual([640, 100]);
  });

  it("composes with the transform fold, which is how both land on one frame", () => {
    setTransformOverride("l1", { dx: 10, dy: -5, dscaleX: 0.5, boxW: 300, boxH: 120 });
    const out = withTextBoxOverride("l1", withTransformOverride("l1", textView));
    expect(out.x).toBe(110);
    expect(out.scale_x).toBe(1.5);
    expect([out.box_w, out.box_h]).toEqual([300, 120]);
  });

  it("applies to the named layer only", () => {
    setTransformOverride("l1", { dx: 0, dy: 0, boxW: 960, boxH: 540 });
    expect(withTextBoxOverride("l2", textView)).toBe(textView);
  });
});

describe("box equality in setTransformOverride", () => {
  /// How many re-composites a sequence of writes asks for.
  function emits(writes: Array<Parameters<typeof setTransformOverride>[1]>): number {
    let n = 0;
    const off = subscribeTransformOverrides(() => (n += 1));
    for (const w of writes) setTransformOverride("l1", w);
    off();
    return n;
  }

  it("re-composites when only the box changed", () => {
    // Every delta channel is identical, so a check that skipped the box pair
    // would emit once and then go silent for the rest of the drag — the box would
    // freeze on the frame the gesture started.
    expect(
      emits([
        { dx: 0, dy: 0, boxW: 640, boxH: 360 },
        { dx: 0, dy: 0, boxW: 640, boxH: 300 },
      ]),
    ).toBe(2);
  });

  it("does not re-composite when the box is unchanged", () => {
    expect(
      emits([
        { dx: 0, dy: 0, boxW: 640, boxH: 360 },
        { dx: 0, dy: 0, boxW: 640, boxH: 360 },
      ]),
    ).toBe(1);
  });

  it("tells null apart from absent, and from zero", () => {
    // Three distinct states on one channel, and `?? 0` would collapse two of them
    // onto the third — making "back to Auto" invisible to the check.
    expect(
      emits([
        { dx: 0, dy: 0, boxW: 640, boxH: 360 },
        { dx: 0, dy: 0, boxW: null, boxH: null },
        { dx: 0, dy: 0 },
      ]),
    ).toBe(3);
  });
});
