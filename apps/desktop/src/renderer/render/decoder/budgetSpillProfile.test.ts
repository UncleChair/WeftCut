import { describe, expect, it } from "vitest";
import { resolveBudgetSpillProfile } from "./budgetSpillProfile";

describe("resolveBudgetSpillProfile", () => {
  it("keeps the requested resolution and full cadence when no budget spill occurred", () => {
    expect(resolveBudgetSpillProfile({
      budgetExceeded: false,
      codedWidth: 3840,
      codedHeight: 2160,
      playbackScaleDiv: 2,
    })).toEqual({ scaleDiv: 2, cadenceDiv: 1 });
  });

  it("keeps sources at or below 1080p full cadence even after a budget refusal", () => {
    expect(resolveBudgetSpillProfile({
      budgetExceeded: true,
      codedWidth: 1920,
      codedHeight: 1080,
      playbackScaleDiv: 1,
    })).toEqual({ scaleDiv: 1, cadenceDiv: 1 });
  });

  it("spills a 4K budget refusal to quarter resolution and half cadence", () => {
    expect(resolveBudgetSpillProfile({
      budgetExceeded: true,
      codedWidth: 3840,
      codedHeight: 2160,
      playbackScaleDiv: 1,
    })).toEqual({ scaleDiv: 4, cadenceDiv: 2 });
  });

  it("chooses the smallest supported divisor near a 960x540 pixel-area target", () => {
    expect(resolveBudgetSpillProfile({
      budgetExceeded: true,
      codedWidth: 2560,
      codedHeight: 1080,
      playbackScaleDiv: 1,
    })).toEqual({ scaleDiv: 4, cadenceDiv: 2 });
    expect(resolveBudgetSpillProfile({
      budgetExceeded: true,
      codedWidth: 1921,
      codedHeight: 1080,
      playbackScaleDiv: 1,
    })).toEqual({ scaleDiv: 4, cadenceDiv: 2 });
  });

  it("never weakens a more aggressive user-selected scale", () => {
    expect(resolveBudgetSpillProfile({
      budgetExceeded: true,
      codedWidth: 2560,
      codedHeight: 1080,
      playbackScaleDiv: 4,
    })).toEqual({ scaleDiv: 4, cadenceDiv: 2 });
  });

  it("fails safe to the user's profile when coded dimensions are missing or invalid", () => {
    for (const [codedWidth, codedHeight] of [
      [undefined, 2160],
      [3840, null],
      [0, 2160],
      [3840.5, 2160],
      [Number.POSITIVE_INFINITY, 2160],
    ] as const) {
      expect(resolveBudgetSpillProfile({
        budgetExceeded: true,
        codedWidth,
        codedHeight,
        playbackScaleDiv: 2,
      })).toEqual({ scaleDiv: 2, cadenceDiv: 1 });
    }
  });
});
