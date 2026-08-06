// Ticket 11's acceptance, as properties of the pure slip logic. The UI wiring around
// these (shortcut dispatch, IPC, badge render) is thin by design precisely so the
// load-bearing behaviour is testable here rather than through a driven app.
import { describe, expect, it } from "vitest";
import {
  NUDGE_MS,
  NUDGE_SAMPLE,
  formatSyncOffset,
  nudgedStartUs,
  resyncStartUs,
  slippableAudioLayers,
  syncOffsetSamples,
  type SlipLayer,
} from "./audioSlip";
import { AUDIO_GRID, frameGrid, gridIndex, timeUsAtGridIndex } from "../grid";
import {
  deriveAudioSyncOffsets,
  selectAudioSyncOffset,
} from "./audioSyncOffsetStore";

// 29.97, where the two lattices genuinely differ (48000 × 1001/30000 = 1601.6 samples
// per frame). At the six nesting rates a frame boundary IS a sample boundary, so a
// test there could not tell a sample step from a frame step.
const FPS = { num: 30_000, den: 1001 };
const frame = (i: number) => timeUsAtGridIndex(i, frameGrid(FPS));
const sample = (i: number) => timeUsAtGridIndex(i, AUDIO_GRID);

const audio = (id: string, startUs: number, lenUs = 2_000_000): SlipLayer => ({
  id,
  t_start_us: startUs,
  t_end_us: startUs + lenUs,
  kind: "Audio",
});
const video = (id: string, startUs: number, lenUs = 2_000_000): SlipLayer => ({
  id,
  t_start_us: startUs,
  t_end_us: startUs + lenUs,
  kind: "VideoClip",
});

describe("audio nudge", () => {
  it("moves exactly one sample at 29.97", () => {
    const start = sample(50_000);
    const l = audio("a", start);
    const next = nudgedStartUs(l, NUDGE_SAMPLE);
    expect(gridIndex(next, AUDIO_GRID)).toBe(50_001);
    expect(next).toBe(sample(50_001));
    // …and one sample is NOT one frame — the whole reason this exists.
    expect(Math.abs(next - start)).toBeLessThan(Math.abs(frame(1) - frame(0)));
  });

  it("the coarse tier is exactly 1 ms = 48 samples", () => {
    expect(NUDGE_MS).toBe(48);
    const l = audio("a", sample(1000));
    expect(gridIndex(nudgedStartUs(l, NUDGE_MS), AUDIO_GRID)).toBe(1048);
    expect(nudgedStartUs(l, NUDGE_MS) - l.t_start_us).toBe(1000); // exactly 1 ms in µs
  });

  it("does not drift over 10 000 nudges out and back", () => {
    // THE property that catches a rounded step: out and back must land on the
    // original sample exactly (why: `nudgedStartUs` in audioSlip.ts).
    const start = sample(123_457);
    let l = audio("a", start);
    for (let i = 0; i < 10_000; i++) l = { ...l, t_start_us: nudgedStartUs(l, NUDGE_SAMPLE) };
    expect(gridIndex(l.t_start_us, AUDIO_GRID)).toBe(123_457 + 10_000);
    for (let i = 0; i < 10_000; i++) l = { ...l, t_start_us: nudgedStartUs(l, -NUDGE_SAMPLE) };
    expect(l.t_start_us).toBe(start);
    expect(gridIndex(l.t_start_us, AUDIO_GRID)).toBe(123_457);
  });

  it("clamps at zero instead of going negative", () => {
    const l = audio("a", sample(2));
    expect(nudgedStartUs(l, -10)).toBe(0);
  });

  it("selects only audio layers, so a whole-group selection leaves the video alone", () => {
    const layers = [audio("a", sample(100)), video("v", frame(3)), audio("b", sample(200))];
    const sel = new Set(["a", "v"]);
    expect(slippableAudioLayers(sel, layers).map((l) => l.id)).toEqual(["a"]);
    expect(slippableAudioLayers(new Set(["v"]), layers)).toEqual([]);
  });
});

describe("derived group sync offset", () => {
  it("reads ZERO for a freshly paired A/V clip, despite the two lattices differing", () => {
    // THE case a raw-µs offset would get wrong: one requested time resolved on two
    // lattices leaves the members up to ~10 µs apart at 29.97, and a µs-based badge
    // would light up on every clip anyone drops.
    const requested = frame(31);
    const v = video("v", requested);
    const a = audio("a", sample(gridIndex(requested, AUDIO_GRID)));
    expect(a.t_start_us).not.toBe(v.t_start_us); // the grid residue is real…
    expect(syncOffsetSamples(a, [v, a])).toBe(0); // …and is not a slip.
    expect(formatSyncOffset(syncOffsetSamples(a, [v, a]))).toBeNull();
  });

  it("reads exactly N after N nudges, in both directions", () => {
    const requested = frame(31);
    const v = video("v", requested);
    let a = audio("a", sample(gridIndex(requested, AUDIO_GRID)));
    for (let i = 1; i <= 5; i++) {
      a = { ...a, t_start_us: nudgedStartUs(a, NUDGE_SAMPLE) };
      expect(syncOffsetSamples(a, [v, a])).toBe(i);
    }
    for (let i = 4; i >= -3; i--) {
      a = { ...a, t_start_us: nudgedStartUs(a, -NUDGE_SAMPLE) };
      expect(syncOffsetSamples(a, [v, a])).toBe(i);
    }
  });

  it("is null with no visual partner — an audio-only group has nothing to measure against", () => {
    const a = audio("a", sample(100));
    const b = audio("b", sample(500));
    expect(syncOffsetSamples(a, [a, b])).toBeNull();
    expect(syncOffsetSamples(a, [a])).toBeNull();
  });

  it("measures against the CLOSEST visual member when a group holds several", () => {
    const a = audio("a", sample(gridIndex(frame(31), AUDIO_GRID) + 3));
    const near = video("near", frame(31));
    const far = video("far", frame(600));
    expect(syncOffsetSamples(a, [a, far, near])).toBe(3);
    expect(syncOffsetSamples(a, [a, near, far])).toBe(3);
  });

  it("resync zeroes the offset and no-ops when already synced", () => {
    const v = video("v", frame(31));
    const synced = audio("a", sample(gridIndex(frame(31), AUDIO_GRID)));
    expect(resyncStartUs(synced, [v, synced])).toBeNull();

    const slipped = { ...synced, t_start_us: nudgedStartUs(synced, 7) };
    const back = resyncStartUs(slipped, [v, slipped])!;
    expect(back).toBe(synced.t_start_us);
    expect(syncOffsetSamples({ ...slipped, t_start_us: back }, [v, slipped])).toBe(0);
  });
});

describe("sync-offset badge text", () => {
  it("shows nothing for zero or absent, samples below 1 ms, milliseconds above", () => {
    expect(formatSyncOffset(null)).toBeNull();
    expect(formatSyncOffset(0)).toBeNull();
    expect(formatSyncOffset(1)).toBe("+1 smp");
    expect(formatSyncOffset(-7)).toBe("−7 smp");
    expect(formatSyncOffset(48)).toBe("+1.00 ms");
    expect(formatSyncOffset(-96)).toBe("−2.00 ms");
    expect(formatSyncOffset(4800)).toBe("+100.0 ms");
  });
});

describe("deriveAudioSyncOffsets", () => {
  // Built inside each test, not at module level: every grid primitive is wasm-backed
  // and `initEval()` runs in the suite's beforeAll.
  const fixtures = () => {
    const v = video("v", frame(31));
    const inSync = audio("a", sample(gridIndex(frame(31), AUDIO_GRID)));
    const slipped = { ...inSync, id: "b", t_start_us: nudgedStartUs(inSync, 5) };
    return { v, inSync, slipped };
  };

  it("stores only NON-ZERO offsets, so an in-sync project maps to nothing", () => {
    const { v, inSync } = fixtures();
    const out = deriveAudioSyncOffsets([v, inSync], [{ id: "g", layer_ids: ["v", "a"] }]);
    expect(out).toEqual({});
    expect(selectAudioSyncOffset(out, "a")).toBeNull();
  });

  it("keys the slipped member by id", () => {
    const { v, slipped } = fixtures();
    const out = deriveAudioSyncOffsets([v, slipped], [{ id: "g", layer_ids: ["v", "b"] }]);
    expect(out).toEqual({ b: 5 });
    expect(selectAudioSyncOffset(out, "b")).toBe(5);
    expect(selectAudioSyncOffset(out, "v")).toBeNull();
  });

  it("ignores ungrouped layers and a group whose member ids no longer resolve", () => {
    const { v, slipped } = fixtures();
    expect(deriveAudioSyncOffsets([v, slipped], [])).toEqual({});
    expect(deriveAudioSyncOffsets([slipped], [{ id: "g", layer_ids: ["v", "b"] }])).toEqual({});
  });
});
