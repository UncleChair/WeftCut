import { describe, expect, it } from "vitest";
import type { EffectView, LayerSummary } from "./index";

describe("EffectView", () => {
  it("LayerSummary carries an effects array of EffectView", () => {
    const e: EffectView = { id: "x", kind: "blur", enabled: true, params: { strength: { mode: "Static", value: 8 } } };
    const layer: Pick<LayerSummary, "effects"> = { effects: [e] };
    expect(layer.effects[0]!.params.strength).toEqual({ mode: "Static", value: 8 });
  });
});
