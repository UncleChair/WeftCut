import { describe, expect, it } from "vitest";
import {
  CHUNK_FRAMES,
  MAX_LIVE_CHUNKS,
  type ChunkPlanInput,
  planChunks,
  shouldReanchor,
} from "./chunkSchedule";

/// 10 s layer at comp 0, full source span, anchor at comp 0 == ctx 100 s,
/// playhead at comp 0, fresh (no live chunks).
function base(): ChunkPlanInput {
  return {
    masterUs: 0,
    anchorCompUs: 0,
    anchorCtxTime: 100,
    ctxNow: 100,
    layerTStartUs: 0,
    layerTEndUs: 10_000_000,
    srcInFrame: 0,
    srcOutFrame: 480_000,
    liveChunkStarts: [],
  };
}

describe("planChunks", () => {
  it("schedules lookahead chunks aligned to the source grid", () => {
    const chunks = planChunks(base());
    // 3 s lookahead at 1 s chunks from t=0 → chunks 0,1,2 (+3 boundary).
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.srcStartFrame % CHUNK_FRAMES).toBe(0);
      expect(c.bufferOffsetFrames).toBe(0);
    }
    expect(chunks[0]!.when).toBeCloseTo(100, 6);
    expect(chunks[1]!.when).toBeCloseTo(101, 6);
  });

  it("skips chunks that are already live", () => {
    const chunks = planChunks({ ...base(), liveChunkStarts: [0, CHUNK_FRAMES] });
    expect(chunks.some((c) => c.srcStartFrame === 0)).toBe(false);
    expect(chunks.some((c) => c.srcStartFrame === CHUNK_FRAMES)).toBe(false);
  });

  it("caps total live chunks", () => {
    const live = Array.from({ length: MAX_LIVE_CHUNKS }, (_, i) => i * CHUNK_FRAMES);
    expect(planChunks({ ...base(), liveChunkStarts: live })).toEqual([]);
  });

  it("starts a late chunk now with a compensating buffer offset", () => {
    // Playhead mid-chunk: ctxNow is 0.5 s past the chunk-0 ideal start.
    const chunks = planChunks({ ...base(), masterUs: 500_000, ctxNow: 100.5 });
    const c0 = chunks.find((c) => c.srcStartFrame === 0)!;
    expect(c0.when).toBeCloseTo(100.5, 6);
    expect(c0.bufferOffsetFrames).toBe(24_000); // 0.5 s × 48 kHz
  });

  it("skips chunks entirely in the past", () => {
    const chunks = planChunks({ ...base(), masterUs: 1_500_000, ctxNow: 101.5 });
    expect(chunks.some((c) => c.srcStartFrame === 0)).toBe(false);
    expect(chunks.some((c) => c.srcStartFrame === CHUNK_FRAMES)).toBe(true);
  });

  it("clamps to the source span and trims the partial tail chunk", () => {
    // src span [12000, 60000): first chunk starts AT srcIn (not grid 0),
    // tail chunk is short.
    const chunks = planChunks({
      ...base(),
      srcInFrame: 12_000,
      srcOutFrame: 60_000,
      layerTEndUs: 1_000_000,
    });
    expect(chunks[0]!.srcStartFrame).toBe(12_000);
    expect(chunks[0]!.frames).toBe(CHUNK_FRAMES - 12_000);
    const tail = chunks[chunks.length - 1]!;
    expect(tail.srcStartFrame).toBe(CHUNK_FRAMES);
    expect(tail.frames).toBe(12_000);
    for (const c of chunks) {
      expect(c.srcStartFrame + c.frames).toBeLessThanOrEqual(60_000);
    }
  });

  it("plans nothing before the layer window's lookahead or after its end", () => {
    // Playhead 5 s before the layer start, lookahead 3 s — nothing yet.
    const early = planChunks({
      ...base(),
      layerTStartUs: 5_000_000,
      layerTEndUs: 15_000_000,
      masterUs: 0,
    });
    expect(early).toEqual([]);
    // Playhead past the layer end — nothing.
    const past = planChunks({ ...base(), masterUs: 11_000_000, ctxNow: 111 });
    expect(past).toEqual([]);
  });
});

describe("shouldReanchor", () => {
  it("fires only past the 40 ms threshold", () => {
    expect(shouldReanchor(1_000_000, 1_030_000)).toBe(false);
    expect(shouldReanchor(1_000_000, 1_041_000)).toBe(true);
    expect(shouldReanchor(1_041_000, 1_000_000)).toBe(true);
  });
});
