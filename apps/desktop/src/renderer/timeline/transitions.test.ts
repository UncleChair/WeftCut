import { describe, expect, it } from "vitest";
import type { LayerSummary, TrackSummary, TransitionSummary } from "../ipc";
import {
  buildTransitionKindArgs,
  chipSliceSlot,
  defaultTransitionDurationUs,
  findCutNear,
  findNearestCut,
  presetTransitionDurationUs,
  transitionChipsForTrack,
  transitionDirectionOf,
  transitionDirectionUpdateArgs,
  transitionDurationUpdateArgs,
  transitionKindUpdateArgs,
  transitionLeftEdgeClampUs,
  transitionLeftEdgeDragArgs,
  transitionRightEdgeClampUs,
  transitionRightEdgeDragArgs,
  transitionTailHandleUs,
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
    extended_us: 0,
  };
}

// The intended duration every eligibility check below runs against — the
// kernels take it as a required arg (`d ≤ min(len_A, len_B)`, ADR 0048).
const DUR_1S = 1_000_000;

// ── findCutNear — cut-detection geometry ─────────────────────────────────────

describe("findCutNear", () => {
  const a = visualLayer("a", 0, 2_000_000);
  const b = visualLayer("b", 2_000_000, 4_000_000);

  it("finds the cut when the click lands within tolerance of the seam", () => {
    expect(findCutNear([a, b], 2_010_000, 50_000, DUR_1S)).toEqual({
      fromLayerId: "a",
      toLayerId: "b",
      cutUs: 2_000_000,
    });
    // Approaching from the left of the seam works too.
    expect(findCutNear([a, b], 1_960_000, 50_000, DUR_1S)?.fromLayerId).toBe(
      "a",
    );
  });

  it("returns null outside the tolerance band", () => {
    expect(findCutNear([a, b], 2_100_000, 50_000, DUR_1S)).toBeNull();
  });

  it("tolerance boundary is inclusive", () => {
    expect(findCutNear([a, b], 2_050_000, 50_000, DUR_1S)).not.toBeNull();
  });

  it("requires EXACT adjacency — gaps and overlaps are not cuts", () => {
    const gapped = visualLayer("g", 2_033_333, 4_000_000);
    expect(findCutNear([a, gapped], 2_000_000, 50_000, DUR_1S)).toBeNull();
    // A pair already overlapped (authorized transition) no longer shares a
    // boundary, so it stops matching — the add menu disappears naturally.
    const overlapped = visualLayer("o", 1_500_000, 4_000_000);
    expect(findCutNear([a, overlapped], 2_000_000, 50_000, DUR_1S)).toBeNull();
  });

  it("rejects audio participants on either side", () => {
    const audioTail = audioLayer("aud", 2_000_000, 4_000_000);
    expect(findCutNear([a, audioTail], 2_000_000, 50_000, DUR_1S)).toBeNull();
    const audioHead = audioLayer("aud", 0, 2_000_000);
    expect(findCutNear([audioHead, b], 2_000_000, 50_000, DUR_1S)).toBeNull();
  });

  it("a cut whose participant is shorter than the intended duration is not offered", () => {
    // Prevention first (#18): the surface never dangles an add the mutation
    // would refuse with TransitionDurationOutOfRange.
    const shortOutgoing = visualLayer("a", 1_500_000, 2_000_000); // 0.5 s
    expect(
      findCutNear([shortOutgoing, b], 2_000_000, 50_000, DUR_1S),
    ).toBeNull();
    const shortIncoming = visualLayer("b", 2_000_000, 2_500_000); // 0.5 s
    expect(
      findCutNear([a, shortIncoming], 2_000_000, 50_000, DUR_1S),
    ).toBeNull();
  });

  it("a participant exactly as long as the duration is still offered (d ≤ min, inclusive)", () => {
    const exact = visualLayer("x", 2_000_000, 3_000_000); // exactly 1 s
    expect(findCutNear([a, exact], 2_000_000, 50_000, DUR_1S)).toEqual({
      fromLayerId: "a",
      toLayerId: "x",
      cutUs: 2_000_000,
    });
  });

  it("picks the nearest cut when several are inside tolerance", () => {
    const c = visualLayer("c", 4_000_000, 6_000_000);
    // Cuts at 2s and 4s; click at 3.9s with a huge tolerance → 4s wins.
    expect(findCutNear([a, b, c], 3_900_000, 3_000_000, DUR_1S)).toEqual({
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
    expect(findCutNear([a, bShifted, c], 2_400_000, 2_000_000, DUR_1S)).toEqual(
      {
        fromLayerId: "b",
        toLayerId: "c",
        cutUs: 4_000_000,
      },
    );
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
    expect(findNearestCut(tracks, 30_000_000, DUR_1S)).toEqual({
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
    expect(findNearestCut(tracks, 4_200_000, DUR_1S)?.cutUs).toBe(5_000_000);
  });

  it("equidistant cuts on two tracks tie-break to the lower track index", () => {
    const d = visualLayer("d", 1_000_000, 3_000_000);
    const e = visualLayer("e", 3_000_000, 5_000_000);
    // Cuts at 2s (t1) and 3s (t2); playhead at 2.5s is equidistant.
    const tracks = [track([a, b], "t1"), track([d, e], "t2")];
    expect(findNearestCut(tracks, 2_500_000, DUR_1S)).toMatchObject({
      fromLayerId: "a",
      toLayerId: "b",
    });
  });

  it("equidistant cuts on ONE track tie-break to the earlier cut", () => {
    // Cuts at 2s and 4s; playhead dead-center at 3s.
    const tracks = [track([a, b, c], "t1")];
    expect(findNearestCut(tracks, 3_000_000, DUR_1S)?.cutUs).toBe(2_000_000);
  });

  it("a too-short pair is skipped even when it is the nearest cut", () => {
    // t2's cut at 3.1s is nearer to the playhead, but its outgoing layer is
    // only 0.2 s long — ineligible for the 1 s duration, so t1's cut wins.
    const d = visualLayer("d", 2_900_000, 3_100_000);
    const e = visualLayer("e", 3_100_000, 5_000_000);
    const tracks = [track([a, b], "t1"), track([d, e], "t2")];
    expect(findNearestCut(tracks, 3_100_000, DUR_1S)?.cutUs).toBe(2_000_000);
  });

  it("returns null when the only cut's participants are too short for the duration", () => {
    const shortA = visualLayer("sa", 0, 500_000);
    const shortB = visualLayer("sb", 500_000, 1_000_000);
    expect(findNearestCut([track([shortA, shortB], "t1")], 0, DUR_1S)).toBeNull();
  });

  it("participants exactly as long as the duration stay eligible (d ≤ min, inclusive)", () => {
    const x = visualLayer("x", 0, 1_000_000);
    const y = visualLayer("y", 1_000_000, 2_000_000);
    expect(findNearestCut([track([x, y], "t1")], 0, DUR_1S)?.cutUs).toBe(
      1_000_000,
    );
  });

  it("a selected layer's cut outranks a nearer unselected cut", () => {
    const d = visualLayer("d", 2_100_000, 3_100_000);
    const e = visualLayer("e", 3_100_000, 5_000_000);
    // Playhead at 3.1s sits ON t2's cut, but the user selected `a`.
    const tracks = [track([a, b], "t1"), track([d, e], "t2")];
    expect(
      findNearestCut(tracks, 3_100_000, DUR_1S, new Set(["a"]))?.fromLayerId,
    ).toBe("a");
    // Either participant counts — selecting the incoming layer works too.
    expect(
      findNearestCut(tracks, 3_100_000, DUR_1S, new Set(["b"]))?.fromLayerId,
    ).toBe("a");
  });

  it("a selection touching no cut falls back to the global nearest", () => {
    const lone = visualLayer("lone", 10_000_000, 12_000_000);
    const tracks = [track([a, b], "t1"), track([lone], "t2")];
    expect(findNearestCut(tracks, 0, DUR_1S, new Set(["lone"]))?.cutUs).toBe(
      2_000_000,
    );
  });

  it("an empty selection set behaves like no selection", () => {
    const tracks = [track([a, b], "t1")];
    expect(findNearestCut(tracks, 0, DUR_1S, new Set())?.cutUs).toBe(2_000_000);
  });

  it("returns null when no eligible cut exists anywhere", () => {
    expect(findNearestCut([], 0, DUR_1S)).toBeNull();
    // Gap on one track, audio adjacency on the other: neither is a cut.
    const gapped = visualLayer("g", 2_100_000, 4_000_000);
    const audioTracks = [
      track([a, gapped], "t1"),
      track([audioLayer("x", 0, 1_000_000), audioLayer("y", 1_000_000, 2_000_000)], "t2"),
    ];
    expect(findNearestCut(audioTracks, 1_000_000, DUR_1S)).toBeNull();
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

// ── presetTransitionDurationUs — the chip menu's duration ladder ─────────────

describe("presetTransitionDurationUs", () => {
  it("integer-frame presets land exactly at 30 fps", () => {
    expect(presetTransitionDurationUs(0.5, 30, 1)).toBe(500_000);
    expect(presetTransitionDurationUs(2, 30, 1)).toBe(2_000_000);
  });

  it("29.97 fps floors to whole frames, matching the default's rule", () => {
    // floor(0.5 * 30000/1001) = 14 frames.
    expect(presetTransitionDurationUs(0.5, 30000, 1001)).toBe(
      Math.floor((14 * 1_000_000 * 1001) / 30000),
    );
    // The 1 s preset IS the default.
    expect(presetTransitionDurationUs(1, 30000, 1001)).toBe(
      defaultTransitionDurationUs(30000, 1001),
    );
  });

  it("clamps to the 1-frame minimum", () => {
    // 0.5 s at 1 fps: floor(0.5) = 0 → min 1 frame = 1 s.
    expect(presetTransitionDurationUs(0.5, 1, 1)).toBe(1_000_000);
  });

  it("degenerate fps falls back to raw seconds", () => {
    expect(presetTransitionDurationUs(0.5, 0, 1)).toBe(500_000);
  });
});

// ── chip geometry ────────────────────────────────────────────────────────────

describe("transitionChipsForTrack", () => {
  const a = visualLayer("a", 0, 2_500_000); // extended by the 0.5s overlap
  const b = visualLayer("b", 2_000_000, 4_000_000);
  const tr = crossfade("tr-1", "a", "b", 500_000);

  it("chip window starts at the incoming layer's head and spans duration_us", () => {
    const chips = transitionChipsForTrack(track([a, b]), [tr]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      startUs: 2_000_000,
      endUs: 2_500_000,
    });
    expect(chips[0]!.fromLayer.id).toBe("a"); // edge drags read A's spans/tail
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

// ── chip edge-drag kernels (spec D6) ─────────────────────────────────────────
// Cross-leg parity with the mutation lives in transitionEdgeClamp.golden.test.ts
// (fixture-driven); this suite pins the kernel-local behaviors — destination
// snapping and all four clamp ends — on the extend-fixture geometry:
// A [0, 2.5M], B [2M, 4M], window [2M, 2.5M], e = 500k, 30 fps.

describe("transition edge clamp kernels", () => {
  const FPS = { fpsNum: 30, fpsDen: 1 };
  const left = (targetUs: number, extendedUs = 0) =>
    transitionLeftEdgeClampUs({
      targetUs,
      aStartUs: 0,
      aEndUs: 2_500_000,
      bStartUs: 2_000_000,
      bEndUs: 4_000_000,
      extendedUs,
      ...FPS,
    });
  const right = (targetUs: number, tailHandleUs: number) =>
    transitionRightEdgeClampUs({
      targetUs,
      bStartUs: 2_000_000,
      bEndUs: 4_000_000,
      aEndUs: 2_500_000,
      tailHandleUs,
      ...FPS,
    });

  it("snaps the DESTINATION to the frame grid (never the delta)", () => {
    // 1.7M + 9µs is off-grid; the destination rounds to frame 51 = 1.7M.
    expect(left(1_700_009)).toBe(1_700_000);
    expect(right(2_866_660, Infinity)).toBe(2_866_667); // frame 86
  });

  it("left edge clamps between min(len_A, len_B) and 1 frame", () => {
    // min(len_A 2.5M, len_B 2M) = 2M = 60 frames → floor L = A.end − 2M.
    expect(left(-5_000_000)).toBe(500_000);
    // Ceiling: d′ ≥ 1 frame → L ≤ A.end − 1 frame.
    expect(left(9_000_000)).toBe(2_466_667); // frame 74
  });

  it("left edge with a live borrow floors d′ at e — the commit's e′ ≤ d′ gate seen from this edge", () => {
    // e = 500k (15 frames), S = 2M: the drag sends extendedUs = e explicitly,
    // so shrinking past d′ = e would commit e′ > d′; the ghost stops at L = S.
    expect(left(9_000_000, 500_000)).toBe(2_000_000); // frame 60 = S
    // Growth is unaffected by the floor.
    expect(left(1_000_000, 500_000)).toBe(1_000_000);
  });

  it("right edge clamps between B.start + 1 frame and min(A.end + tail handle, B.end)", () => {
    expect(right(-5_000_000, Infinity)).toBe(2_033_333); // frame 61
    // Finite tail floors onto the canonical grid (raw media µs, not a boundary).
    expect(right(9_000_000, 250_000)).toBe(2_733_333); // ≤ 2.75M → frame 82
    // Free-duration outgoing: no tail cap — in-range targets snap freely...
    expect(right(3_500_000, Infinity)).toBe(3_500_000); // frame 105
    // ...but B.end still binds (validate's d′ ≤ len_B seen from this edge).
    expect(right(9_000_000, Infinity)).toBe(4_000_000); // frame 120 = B.end
  });

  it("transitionTailHandleUs mirrors the mutation's tailHandleUs", () => {
    expect(transitionTailHandleUs("VideoClip", 2_000_000, 2_500_000)).toBe(500_000);
    expect(transitionTailHandleUs("VideoClip", 2_000_000, 1_500_000)).toBe(0); // saturates
    expect(transitionTailHandleUs("VideoClip", 2_000_000, null)).toBe(Infinity); // unknowable
    expect(transitionTailHandleUs("Audio", 1_000_000, undefined)).toBe(Infinity);
    expect(transitionTailHandleUs("Color", 0, 123)).toBe(Infinity); // free-duration
    expect(transitionTailHandleUs("Text", 0, null)).toBe(Infinity);
  });
});

describe("edge-drag commit args", () => {
  const tr = crossfade("tr-1", "a", "b", 500_000);
  tr.extended_us = 500_000; // extend-fixture provenance: S = 2.5M − 0.5M = 2M

  it("left edge pins A.end by sending the CURRENT extended_us explicitly", () => {
    expect(transitionLeftEdgeDragArgs(tr, 2_500_000, 1_500_000)).toEqual({
      transitionId: "tr-1",
      durationUs: 1_000_000,
      extendedUs: 500_000,
    });
  });

  it("right edge derives (d′, e′) from one formula: borrow above S, return below, NEGATIVE past it", () => {
    // Grow the borrow: R = 3M > S.
    expect(transitionRightEdgeDragArgs(tr, 2_500_000, 2_000_000, 3_000_000)).toEqual({
      transitionId: "tr-1",
      durationUs: 1_000_000,
      extendedUs: 1_000_000,
    });
    // Genuine trim on a pure-placement window (e = 0, S = A.end): R < S goes
    // negative — A's real tail rides the same commit.
    const pure = crossfade("tr-2", "a", "b", 1_000_000); // B.start 1M, A.end 2M
    expect(transitionRightEdgeDragArgs(pure, 2_000_000, 1_000_000, 1_700_000)).toEqual({
      transitionId: "tr-2",
      durationUs: 700_000,
      extendedUs: -300_000,
    });
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

// ── chip-menu pick semantics ─────────────────────────────────────────────────
// The chip menu's submenus commit through these; Base UI's hover-intent
// submenu-open can't be driven in jsdom, so the contract is pinned here and
// TransitionUi.test.tsx only asserts what the menu shows.

describe("chip-menu update args", () => {
  const wipeLeft = crossfade("tr-1", "a", "b", 500_000);
  wipeLeft.kind = { kind: "Wipe", direction: "left" };
  const xfade = crossfade("tr-2", "a", "b", 500_000);

  describe("transitionKindUpdateArgs", () => {
    it("Wipe→Slide keeps the current direction", () => {
      expect(transitionKindUpdateArgs(wipeLeft, "Slide")).toEqual({
        transitionId: "tr-1",
        kind: "Slide",
        direction: "left",
      });
    });

    it("switching to Crossfade drops the direction from the wire args", () => {
      expect(transitionKindUpdateArgs(wipeLeft, "Crossfade")).toEqual({
        transitionId: "tr-1",
        kind: "Crossfade",
      });
    });

    it("switching out of Crossfade takes the 'left' default", () => {
      expect(transitionKindUpdateArgs(xfade, "Wipe")).toEqual({
        transitionId: "tr-2",
        kind: "Wipe",
        direction: "left",
      });
    });

    it("picking the current kind is a no-op", () => {
      expect(transitionKindUpdateArgs(wipeLeft, "Wipe")).toBeNull();
    });
  });

  describe("transitionDirectionUpdateArgs", () => {
    it("dispatches kind + direction together (the wire contract pairs them)", () => {
      expect(transitionDirectionUpdateArgs(wipeLeft, "up")).toEqual({
        transitionId: "tr-1",
        kind: "Wipe",
        direction: "up",
      });
    });

    it("picking the current direction is a no-op", () => {
      expect(transitionDirectionUpdateArgs(wipeLeft, "left")).toBeNull();
    });

    it("refuses a direction on Crossfade — belt to the hidden-submenu suspender", () => {
      expect(transitionDirectionUpdateArgs(xfade, "up")).toBeNull();
    });
  });

  describe("transitionDurationUpdateArgs", () => {
    it("dispatches the preset µs", () => {
      expect(transitionDurationUpdateArgs(wipeLeft, 2_000_000)).toEqual({
        transitionId: "tr-1",
        durationUs: 2_000_000,
      });
    });

    it("carries duration ONLY — no extendedUs key, so the preset rides the mutation's sanctity-preferring routing (D5)", () => {
      // `toEqual` ignores undefined-valued keys, so pin the key set itself:
      // a stray `extendedUs` here would silently turn every preset pick into
      // an explicit borrow request.
      const args = transitionDurationUpdateArgs(wipeLeft, 2_000_000)!;
      expect(Object.keys(args).sort()).toEqual(["durationUs", "transitionId"]);
    });

    it("picking the matching (checkmarked) preset is a no-op", () => {
      expect(transitionDurationUpdateArgs(wipeLeft, 500_000)).toBeNull();
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
