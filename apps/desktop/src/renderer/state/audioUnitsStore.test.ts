// The audio-units display mode (ADR 0038): format, parse, round trip.
import { beforeEach, describe, expect, it } from "vitest";
import {
  AUDIO_UNITS_ORDER,
  audioUnits,
  cycleAudioUnits,
  formatAudioTime,
  parseAudioMs,
  parseAudioSamples,
  parseAudioTime,
  setAudioUnits,
} from "./audioUnitsStore";
import { AUDIO_GRID, frameGrid, gridIndex, timeUsAtGridIndex } from "../grid";

const FPS = { num: 30_000, den: 1001 };
const sample = (i: number) => timeUsAtGridIndex(i, AUDIO_GRID);
const frame = (i: number) => timeUsAtGridIndex(i, frameGrid(FPS));

describe("audio units store", () => {
  beforeEach(() => setAudioUnits("frames"));

  it("defaults to frames and cycles through every unit", () => {
    expect(audioUnits()).toBe("frames");
    const seen = [audioUnits()];
    for (let i = 1; i < AUDIO_UNITS_ORDER.length; i++) {
      cycleAudioUnits();
      seen.push(audioUnits());
    }
    expect(seen).toEqual([...AUDIO_UNITS_ORDER]);
    cycleAudioUnits();
    expect(audioUnits()).toBe("frames"); // wraps
  });

  it("formats samples as the MIXER's index, not a scaled µs value", () => {
    // The number on screen is the same integer the mixer places on and a nudge steps,
    // which is what makes "one sample later" mean something a user can verify.
    for (const i of [0, 1, 1601, 48_000, 1_234_567]) {
      expect(formatAudioTime(sample(i), "samples", FPS.num, FPS.den)).toBe(String(i));
    }
  });

  it("formats ms as wall clock and frames as SMPTE", () => {
    expect(formatAudioTime(3_603_600_000, "ms", FPS.num, FPS.den)).toBe("01:00:03.600");
    expect(formatAudioTime(frame(30), "frames", FPS.num, FPS.den)).toBe("00:00:01:00");
  });

  it("round-trips a sample-grid position through the samples field", () => {
    for (const i of [0, 1, 7, 1601, 1602, 48_000, 999_999]) {
      const us = sample(i);
      expect(parseAudioSamples(String(i))).toBe(us);
      expect(parseAudioTime(formatAudioTime(us, "samples", FPS.num, FPS.den), "samples", FPS.num, FPS.den)).toBe(us);
    }
  });

  it("rejects junk in the samples field rather than coercing it", () => {
    for (const bad of ["", " ", "-1", "1.5", "1e3", "abc", "12a"]) {
      expect(parseAudioSamples(bad), bad).toBeNull();
    }
  });

  it("snaps a typed millisecond to the nearest SAMPLE, so the field cannot store an off-grid time", () => {
    // A typed millisecond is generally not a sample boundary; storing it raw would
    // fail the grid backstop on commit.
    const parsed = parseAudioMs("00:00:01.001")!;
    expect(parsed).toBe(timeUsAtGridIndex(gridIndex(1_001_000, AUDIO_GRID), AUDIO_GRID));
    expect(timeUsAtGridIndex(gridIndex(parsed, AUDIO_GRID), AUDIO_GRID)).toBe(parsed);
  });

  it("accepts the short ms forms and rejects malformed ones", () => {
    expect(parseAudioMs("2")).toBe(sample(gridIndex(2_000_000, AUDIO_GRID)));
    expect(parseAudioMs("1:02.500")).toBe(sample(gridIndex(62_500_000, AUDIO_GRID)));
    expect(parseAudioMs("01:00:00.000")).toBe(sample(gridIndex(3_600_000_000, AUDIO_GRID)));
    for (const bad of ["", "1:60.000", "1:02:60.000", "abc", "1.2345", ":", "1:"]) {
      expect(parseAudioMs(bad), bad).toBeNull();
    }
  });

  it("frames entry resolves to a COMPOSITION boundary, which the mutation then snaps", () => {
    // Deliberate: the user asked for a frame. At 29.97 that is not a sample boundary,
    // so the actor's audio snap decides where it actually plays — and the file records
    // that, not the request.
    const typed = parseAudioTime("00:00:01:01", "frames", FPS.num, FPS.den)!;
    expect(typed).toBe(frame(31));
    expect(gridIndex(typed, AUDIO_GRID)).toBe(gridIndex(frame(31), AUDIO_GRID));
  });
});
