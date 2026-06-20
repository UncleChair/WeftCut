// Master bus pure parts over a mocked AudioContext — dB conversion, silent
// meter snapshot, mute toggling. Graph topology against a real context is
// covered by the e2e phase.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioGraph, linearToDb } from "./AudioGraph";

function mockAudioContext(): void {
  class FakeNode {
    gain = { value: 1 };
    threshold = { value: 0 };
    ratio = { value: 0 };
    attack = { value: 0 };
    release = { value: 0 };
    knee = { value: 0 };
    fftSize = 0;
    smoothingTimeConstant = 0;
    connect = vi.fn();
    disconnect = vi.fn();
    getFloatTimeDomainData = (arr: Float32Array): void => {
      arr.fill(0);
    };
  }
  class FakeAudioContext {
    state = "running";
    destination = {};
    createGain = (): FakeNode => new FakeNode();
    createAnalyser = (): FakeNode => new FakeNode();
    createDynamicsCompressor = (): FakeNode => new FakeNode();
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("linearToDb", () => {
  it("maps silence to -Infinity and unity to 0 dB", () => {
    expect(linearToDb(0)).toBe(-Infinity);
    expect(linearToDb(1)).toBeCloseTo(0, 9);
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 3);
  });
});

describe("AudioGraph", () => {
  it("reports -Infinity meter levels over silence", () => {
    mockAudioContext();
    const g = new AudioGraph();
    const snap = g.meterSnapshot();
    expect(snap.rmsDb).toBe(-Infinity);
    expect(snap.peakDb).toBe(-Infinity);
  });

  it("master mute toggles the input gain", () => {
    mockAudioContext();
    const g = new AudioGraph();
    g.setMasterMute(true);
    expect(g.input.gain.value).toBe(0);
    g.setMasterMute(false);
    expect(g.input.gain.value).toBe(1);
  });
});
