import { describe, expect, it } from "vitest";
import type { TransitionSummary } from "../../ipc";
import {
  selectActiveTransitions,
  transitionProgress,
  type ParticipantLayer,
} from "./activeTransitions";

// Window semantics: the window IS the overlap, [to.t_start, to.t_start +
// duration) — placement-independent (overlap or extend, ADR 0048). These
// tests pin the selection gates and the boundary inclusivity the shader's
// progress derives from.

const layer = (over: Partial<ParticipantLayer> = {}): ParticipantLayer => ({
  t_start_us: 0,
  t_end_us: 2_000_000,
  enabled: true,
  kind: "VideoClip",
  ...over,
});

const crossfade = (over: Partial<TransitionSummary> = {}): TransitionSummary => ({
  id: "tr-1",
  from_layer: "A",
  to_layer: "B",
  duration_us: 1_000_000,
  kind: { kind: "Crossfade" },
  extended_us: 0,
  ...over,
});

/// Standard fixture: A covers [0, 2s) (tail extended over the overlap),
/// B covers [1s, 3s), transition window [1s, 2s).
const layers: Record<string, ParticipantLayer> = {
  A: layer(),
  B: layer({ t_start_us: 1_000_000, t_end_us: 3_000_000 }),
};

const get = (id: string): ParticipantLayer | undefined => layers[id];
const allTracksOn = (): boolean => true;

describe("transitionProgress", () => {
  it("is linear (t − start) / duration", () => {
    expect(transitionProgress(1_500_000, 1_000_000, 1_000_000)).toBe(0.5);
    expect(transitionProgress(1_250_000, 1_000_000, 1_000_000)).toBe(0.25);
  });

  it("clamps to [0, 1]", () => {
    expect(transitionProgress(0, 1_000_000, 1_000_000)).toBe(0);
    expect(transitionProgress(9_000_000, 1_000_000, 1_000_000)).toBe(1);
  });

  it("degenerate duration reads as done", () => {
    expect(transitionProgress(1_000_000, 1_000_000, 0)).toBe(1);
  });
});

describe("selectActiveTransitions", () => {
  it("selects inside the window with the window's progress", () => {
    const out = selectActiveTransitions([crossfade()], 1_500_000, get, allTracksOn);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "tr-1",
      fromLayerId: "A",
      toLayerId: "B",
      startUs: 1_000_000,
      durationUs: 1_000_000,
      progress: 0.5,
    });
  });

  it("window start is inclusive (progress 0), end exclusive", () => {
    expect(selectActiveTransitions([crossfade()], 1_000_000, get, allTracksOn)).toHaveLength(1);
    expect(
      selectActiveTransitions([crossfade()], 1_000_000, get, allTracksOn)[0]!.progress,
    ).toBe(0);
    expect(selectActiveTransitions([crossfade()], 2_000_000, get, allTracksOn)).toHaveLength(0);
  });

  it("returns the shared empty array outside the window and for absent lists", () => {
    const before = selectActiveTransitions([crossfade()], 500_000, get, allTracksOn);
    expect(before).toHaveLength(0);
    // No-allocation contract for the per-frame no-transitions call.
    expect(selectActiveTransitions(undefined, 0, get, allTracksOn)).toBe(
      selectActiveTransitions([], 0, get, allTracksOn),
    );
  });

  it("skips when a participant is missing, disabled, or its track is off", () => {
    expect(
      selectActiveTransitions([crossfade({ from_layer: "ghost" })], 1_500_000, get, allTracksOn),
    ).toHaveLength(0);
    const disabledA = (id: string): ParticipantLayer | undefined =>
      id === "A" ? layer({ enabled: false }) : layers[id];
    expect(selectActiveTransitions([crossfade()], 1_500_000, disabledA, allTracksOn)).toHaveLength(0);
    const trackOffForB = (id: string): boolean => id !== "B";
    expect(selectActiveTransitions([crossfade()], 1_500_000, get, trackOffForB)).toHaveLength(0);
  });

  it("rejects non-visual participants (Audio backstop)", () => {
    const audioB = (id: string): ParticipantLayer | undefined =>
      id === "B" ? layer({ t_start_us: 1_000_000, t_end_us: 3_000_000, kind: "Audio" }) : layers[id];
    expect(selectActiveTransitions([crossfade()], 1_500_000, audioB, allTracksOn)).toHaveLength(0);
  });

  it("skips a window the outgoing layer no longer covers (stale snapshot)", () => {
    const shortA = (id: string): ParticipantLayer | undefined =>
      id === "A" ? layer({ t_end_us: 1_200_000 }) : layers[id];
    expect(selectActiveTransitions([crossfade()], 1_500_000, shortA, allTracksOn)).toHaveLength(0);
    // Still active while A covers t.
    expect(selectActiveTransitions([crossfade()], 1_100_000, shortA, allTracksOn)).toHaveLength(1);
  });

  it("skips non-positive durations", () => {
    expect(
      selectActiveTransitions([crossfade({ duration_us: 0 })], 1_000_000, get, allTracksOn),
    ).toHaveLength(0);
  });

  it("a layer joins at most one node per frame — first transition claims it", () => {
    const second = crossfade({ id: "tr-2", from_layer: "B", to_layer: "C" });
    const withC = (id: string): ParticipantLayer | undefined =>
      id === "C" ? layer({ t_start_us: 1_200_000, t_end_us: 4_000_000 }) : layers[id];
    const out = selectActiveTransitions([crossfade(), second], 1_500_000, withC, allTracksOn);
    expect(out.map((t) => t.id)).toEqual(["tr-1"]);
  });
});
