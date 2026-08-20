import { describe, expect, it } from "vitest";
import type { LayerSummary, TrackSummary, TransitionSummary } from "../ipc";
import {
  buildTransitionKindArgs,
  chipSliceSlot,
  defaultTransitionDurationUs,
  findCutNear,
  findNearestCut,
  transitionChipsForTrack,
  transitionDirectionOf,
} from "./transitions";

const staticNum = (value: number) => ({ mode: "Static" as const, value });

function visualLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: "Color",
    color_hint: "#4488cc",
    enabled: true,
    locked: false,
    params: {
      kind: "Color",
      color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 255 } },
      width: 1920,
      height: 1080,
    },
    effects: [],
  };
}

function audioLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
): LayerSummary {
  return {
    ...visualLayer(id, tStartUs, tEndUs),
    kind: "Audio",
    params: {
      kind: "Audio",
      media_id: "m1",
      media_label: "m1.wav",
      src_in_us: 0,
      src_out_us: tEndUs - tStartUs,
      gain_db: staticNum(0),
      pan: staticNum(0),
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "music",
    },
  };
}

function track(layers: LayerSummary[], id = "track-1"): TrackSummary {
  return {
    id,
    kind: "Video",
    label: id,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

function crossfade(
  id: string,
  fromLayer: string,
  toLayer: string,
  durationUs: number,
): TransitionSummary {
  return {
    id,
    from_layer: fromLayer,
    to_layer: toLayer,
    duration_us: durationUs,
    kind: { kind: "Crossfade" },
  };
}

// ── findCutNear — cut-detection geometry ─────────────────────────────────────

describe("findCutNear", () => {
  const a = visualLayer("a", 0, 2_000_000);
  const b = visualLayer("b", 2_000_000, 4_000_000);

  it("finds the cut when the click lands within tolerance of the seam", () => {
    expect(findCutNear([a, b], 2_010_000, 50_000)).toEqual({
      fromLayerId: "a",
      toLayerId: "b",
      cutUs: 2_000_000,
    });
    // Approaching from the left of the seam works too.
    expect(findCutNear([a, b], 1_960_000, 50_000)?.fromLayerId).toBe("a");
  });

  it("returns null outside the tolerance band", () => {
    expect(findCutNear([a, b], 2_100_000, 50_000)).toBeNull();
  });

  it("tolerance boundary is inclusive", () => {
    expect(findCutNear([a, b], 2_050_000, 50_000)).not.toBeNull();
  });

  it("requires EXACT adjacency — gaps and overlaps are not cuts", () => {
    const gapped = visualLayer("g", 2_033_333, 4_000_000);
    expect(findCutNear([a, gapped], 2_000_000, 50_000)).toBeNull();
    // A pair already overlapped (authorized transition) no longer shares a
    // boundary, so it stops matching — the add menu disappears naturally.
    const overlapped = visualLayer("o", 1_500_000, 4_000_000);
    expect(findCutNear([a, overlapped], 2_000_000, 50_000)).toBeNull();
  });

  it("rejects audio participants on either side", () => {
    const audioTail = audioLayer("aud", 2_000_000, 4_000_000);
    expect(findCutNear([a, audioTail], 2_000_000, 50_000)).toBeNull();
    const audioHead = audioLayer("aud", 0, 2_000_000);
    expect(findCutNear([audioHead, b], 2_000_000, 50_000)).toBeNull();
  });

  it("picks the nearest cut when several are inside tolerance", () => {
    const c = visualLayer("c", 4_000_000, 6_000_000);
    // Cuts at 2s and 4s; click at 3.9s with a huge tolerance → 4s wins.
    expect(findCutNear([a, b, c], 3_900_000, 3_000_000)).toEqual({
      fromLayerId: "b",
      toLayerId: "c",
      cutUs: 4_000_000,
    });
  });

  it("skips a near non-cut edge but still finds a farther real cut", () => {
    // `a` ends at 2s with nothing adjacent; real cut b|c at 4s. Click at
    // 2.5s with tolerance covering both: only the real cut matches.
    const bShifted = visualLayer("b", 2_500_000, 4_000_000);
    const c = visualLayer("c", 4_000_000, 6_000_000);
    expect(findCutNear([a, bShifted, c], 2_400_000, 2_000_000)).toEqual({
      fromLayerId: "b",
      toLayerId: "c",
      cutUs: 4_000_000,
    });
  });
});

// ── findNearestCut — the argumentless-apply target kernel ────────────────────

describe("findNearestCut", () => {
  const a = visualLayer("a", 0, 2_000_000);
  const b = visualLayer("b", 2_000_000, 4_000_000);
  const c = visualLayer("c", 4_000_000, 6_000_000);

  it("finds the nearest cut across all tracks with no distance limit", () => {
    // Playhead parked 26 s past the only cut — a tolerance search would
    // refuse; the command semantics say apply anyway.
    const tracks = [track([a, b], "t1")];
    expect(findNearestCut(tracks, 30_000_000)).toEqual({
      fromLayerId: "a",
      toLayerId: "b",
      cutUs: 2_000_000,
    });
  });

  it("nearer cut wins across tracks", () => {
    const d = visualLayer("d", 3_000_000, 5_000_000);
    const e = visualLayer("e", 5_000_000, 7_000_000);
    // Cuts: t1 at 2s, t2 at 5s; playhead at 4.2s → 5s is nearer.
    const tracks = [track([a, b], "t1"), track([d, e], "t2")];
    expect(findNearestCut(tracks, 4_200_000)?.cutUs).toBe(5_000_000);
  });

  it("equidistant cuts on two tracks tie-break to the lower track index", () => {
    const d = visualLayer("d", 1_000_000, 3_000_000);
    const e = visualLayer("e", 3_000_000, 5_000_000);
    // Cuts at 2s (t1) and 3s (t2); playhead at 2.5s is equidistant.
    const tracks = [track([a, b], "t1"), track([d, e], "t2")];
    expect(findNearestCut(tracks, 2_500_000)).toMatchObject({
      fromLayerId: "a",
      toLayerId: "b",
    });
  });

  it("equidistant cuts on ONE track tie-break to the earlier cut", () => {
    // Cuts at 2s and 4s; playhead dead-center at 3s.
    const tracks = [track([a, b, c], "t1")];
    expect(findNearestCut(tracks, 3_000_000)?.cutUs).toBe(2_000_000);
  });

  it("a selected layer's cut outranks a nearer unselected cut", () => {
    const d = visualLayer("d", 2_900_000, 3_100_000);
    const e = visualLayer("e", 3_100_000, 5_000_000);
    // Playhead at 3.1s sits ON t2's cut, but the user selected `a`.
    const tracks = [track([a, b], "t1"), track([d, e], "t2")];
    expect(
      findNearestCut(tracks, 3_100_000, new Set(["a"]))?.fromLayerId,
    ).toBe("a");
    // Either participant counts — selecting the incoming layer works too.
    expect(
      findNearestCut(tracks, 3_100_000, new Set(["b"]))?.fromLayerId,
    ).toBe("a");
  });

  it("a selection touching no cut falls back to the global nearest", () => {
    const lone = visualLayer("lone", 10_000_000, 12_000_000);
    const tracks = [track([a, b], "t1"), track([lone], "t2")];
    expect(findNearestCut(tracks, 0, new Set(["lone"]))?.cutUs).toBe(
      2_000_000,
    );
  });

  it("an empty selection set behaves like no selection", () => {
    const tracks = [track([a, b], "t1")];
    expect(findNearestCut(tracks, 0, new Set())?.cutUs).toBe(2_000_000);
  });

  it("returns null when no eligible cut exists anywhere", () => {
    expect(findNearestCut([], 0)).toBeNull();
    // Gap on one track, audio adjacency on the other: neither is a cut.
    const gapped = visualLayer("g", 2_100_000, 4_000_000);
    const audioTracks = [
      track([a, gapped], "t1"),
      track([audioLayer("x", 0, 1_000_000), audioLayer("y", 1_000_000, 2_000_000)], "t2"),
    ];
    expect(findNearestCut(audioTracks, 1_000_000)).toBeNull();
  });
});

// ── defaultTransitionDurationUs — 1 s snapped DOWN to whole frames ───────────

describe("defaultTransitionDurationUs", () => {
  it("30 fps → exactly 1 s (30 whole frames)", () => {
    expect(defaultTransitionDurationUs(30, 1)).toBe(1_000_000);
  });

  it("60 fps → exactly 1 s (60 whole frames)", () => {
    expect(defaultTransitionDurationUs(60, 1)).toBe(1_000_000);
  });

  it("29.97 fps → snapped DOWN to 29 whole frames, not silently 1 s", () => {
    // floor(30000/1001) = 29 frames; 29 * 1e6 * 1001 / 30000 ≈ 967_633.33.
    expect(defaultTransitionDurationUs(30000, 1001)).toBe(967_633);
  });

  it("sub-1fps comps clamp to the 1-frame minimum", () => {
    // 0.5 fps: floor(0.5) = 0 → min 1 frame = 2 s.
    expect(defaultTransitionDurationUs(1, 2)).toBe(2_000_000);
  });

  it("degenerate fps falls back to 1 s", () => {
    expect(defaultTransitionDurationUs(0, 1)).toBe(1_000_000);
  });
});

// ── chip geometry ────────────────────────────────────────────────────────────

describe("transitionChipsForTrack", () => {
  const a = visualLayer("a", 0, 2_500_000); // extended by the 0.5s overlap
  const b = visualLayer("b", 2_000_000, 4_000_000);
  const tr = crossfade("tr-1", "a", "b", 500_000);

  it("chip window starts at the cut (incoming layer's head) and spans duration_us", () => {
    const chips = transitionChipsForTrack(track([a, b]), [tr]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      startUs: 2_000_000,
      endUs: 2_500_000,
    });
    expect(chips[0]!.toLayer.id).toBe("b");
    expect(chips[0]!.transition.id).toBe("tr-1");
  });

  it("drops transitions whose participants are not both on the track", () => {
    expect(transitionChipsForTrack(track([b]), [tr])).toEqual([]);
    expect(transitionChipsForTrack(track([a]), [tr])).toEqual([]);
  });

  it("treats an absent transitions field as empty", () => {
    expect(transitionChipsForTrack(track([a, b]), undefined)).toEqual([]);
  });
});

describe("chipSliceSlot", () => {
  it("full slice mirrors LayerBlock's interior box", () => {
    // laneHeight 56: interior = 48, top = 4.
    expect(chipSliceSlot(56, "full")).toEqual({ top: 4, height: 48 });
  });

  it("top/bottom slices split at the midline with a 1px gap", () => {
    // interior 48 → half = floor(47/2) = 23; bottom = 48 - 23 - 1 = 24.
    expect(chipSliceSlot(56, "top")).toEqual({ top: 4, height: 23 });
    expect(chipSliceSlot(56, "bottom")).toEqual({ top: 28, height: 24 });
  });
});

// ── kind→direction wire pairing ──────────────────────────────────────────────

describe("buildTransitionKindArgs", () => {
  it("Crossfade omits direction entirely (backend rejects one)", () => {
    expect(buildTransitionKindArgs("Crossfade")).toEqual({ kind: "Crossfade" });
    expect(buildTransitionKindArgs("Crossfade", "left")).toEqual({
      kind: "Crossfade",
    });
  });

  it("Wipe/Slide keep the given direction", () => {
    expect(buildTransitionKindArgs("Wipe", "up")).toEqual({
      kind: "Wipe",
      direction: "up",
    });
    expect(buildTransitionKindArgs("Slide", "down")).toEqual({
      kind: "Slide",
      direction: "down",
    });
  });

  it("Wipe/Slide default to 'left' when the caller has no direction (kind change from Crossfade)", () => {
    expect(buildTransitionKindArgs("Wipe")).toEqual({
      kind: "Wipe",
      direction: "left",
    });
    expect(buildTransitionKindArgs("Slide", null)).toEqual({
      kind: "Slide",
      direction: "left",
    });
  });
});

describe("transitionDirectionOf", () => {
  it("reads the direction from Wipe/Slide and null from Crossfade", () => {
    expect(transitionDirectionOf({ kind: "Crossfade" })).toBeNull();
    expect(transitionDirectionOf({ kind: "Wipe", direction: "right" })).toBe(
      "right",
    );
    expect(transitionDirectionOf({ kind: "Slide", direction: "up" })).toBe(
      "up",
    );
  });
});

// Structured-error extraction moved to the app-wide parser; its coverage
// (Electron-wrapped, bare, unstructured) lives in
// errors/parseCommandError.test.ts.
