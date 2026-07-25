import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  playbackRenderResolution,
  playbackScaleDiv,
} from "./playbackResolution";

describe("playbackScaleDiv", () => {
  it("maps each fraction to the native ship-stage divisor", () => {
    expect(playbackScaleDiv("full")).toBe(1);
    expect(playbackScaleDiv("half")).toBe(2);
    expect(playbackScaleDiv("quarter")).toBe(4);
  });

  it("resolves an absent setting to full resolution", () => {
    // An additive field loads as `undefined` from a settings file written
    // before it existed; full res (divisor 1) is byte-identical to today.
    expect(playbackScaleDiv(undefined)).toBe(1);
  });

  it("resolves an unrecognized value to full resolution", () => {
    // Hand-edited app_settings.json. Never throw, never ship a fraction the
    // user didn't ask for.
    expect(playbackScaleDiv("eighth" as never)).toBe(1);
  });
});

describe("playbackRenderResolution", () => {
  it("maps each fraction to the Pixi renderer resolution", () => {
    expect(playbackRenderResolution("full")).toBe(1);
    expect(playbackRenderResolution("half")).toBe(0.5);
    expect(playbackRenderResolution("quarter")).toBe(0.25);
  });

  it("stays the exact reciprocal of the ship-stage divisor", () => {
    // The two halves of one user-facing control: a preview whose raster and
    // decode fractions disagreed would resample every frame for nothing.
    for (const r of ["full", "half", "quarter", undefined] as const) {
      expect(playbackRenderResolution(r) * playbackScaleDiv(r)).toBe(1);
    }
  });

  it("resolves an absent or unrecognized setting to 1", () => {
    // Exactly 1 is the contract that keeps a default-settings canvas
    // byte-identical to no throttle at all.
    expect(playbackRenderResolution(undefined)).toBe(1);
    expect(playbackRenderResolution("eighth" as never)).toBe(1);
  });
});

describe("export ignores the playback-resolution setting", () => {
  // A silently half-resolution export would be a data-loss bug, so pin the
  // absence rather than trusting convention: the export Worker builds its own
  // Application at output resolution and must never read this preference.
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("the export Worker never reads it", () => {
    const src = read("../worker/exportWorker.ts");
    expect(src).not.toContain("playback_resolution");
    expect(src).not.toContain("playbackResolution");
    expect(src).not.toContain("playbackScaleDiv");
  });

  it("neither does the export launcher", () => {
    const src = read("../worker/runExport.ts");
    expect(src).not.toContain("playback_resolution");
    expect(src).not.toContain("playbackResolution");
    expect(src).not.toContain("playbackScaleDiv");
  });
});
