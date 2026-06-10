// Pure scheduling math for the buffer-scheduled preview mixer
// (docs/audio.md §Preview mixer). The AudioMixer is the thin Web-Audio
// shell around these functions; keeping the math pure keeps it unit-
// testable without an AudioContext.
//
// Axes: "comp" is composition time in µs; "source" is the conform file's
// 48 kHz frame grid. Chunks are aligned to CHUNK_FRAMES on the SOURCE
// axis so chunk identity is stable across re-anchors.

export const SAMPLE_RATE = 48_000;
export const CHUNK_FRAMES = 48_000; // 1 s
export const LOOKAHEAD_S = 3;
export const MAX_LIVE_CHUNKS = 8;
export const REANCHOR_THRESHOLD_S = 0.04;
export const MICRO_FADE_S = 0.005;

export interface ChunkPlanInput {
  /// Playhead in composition µs and the play anchor pair.
  masterUs: number;
  anchorCompUs: number;
  anchorCtxTime: number;
  ctxNow: number;
  /// Layer placement (composition µs) and source trim (conform frames).
  layerTStartUs: number;
  layerTEndUs: number;
  srcInFrame: number;
  srcOutFrame: number;
  /// Source start frames of chunks already scheduled and still live.
  liveChunkStarts: number[];
}

export interface PlannedChunk {
  srcStartFrame: number;
  frames: number;
  /// AudioContext time to start at; if the ideal start is already past,
  /// `when` is ctxNow and `bufferOffsetFrames` skips into the buffer so
  /// the source clock stays aligned.
  when: number;
  bufferOffsetFrames: number;
}

function usToFrames(us: number): number {
  return Math.round((us * 48) / 1000);
}

function framesToUs(frames: number): number {
  return (frames * 1000) / 48;
}

/// Plan the chunks to schedule right now: source-grid-aligned, within the
/// lookahead window, clamped to the source span, not already live, capped
/// at MAX_LIVE_CHUNKS total.
export function planChunks(input: ChunkPlanInput): PlannedChunk[] {
  const live = new Set(input.liveChunkStarts);
  const budget = MAX_LIVE_CHUNKS - live.size;
  if (budget <= 0) return [];

  // Current + lookahead positions on the source frame axis.
  const playSrc =
    input.srcInFrame + usToFrames(input.masterUs - input.layerTStartUs);
  const aheadUs = Math.min(
    input.masterUs + LOOKAHEAD_S * 1_000_000,
    input.layerTEndUs,
  );
  const aheadSrc = input.srcInFrame + usToFrames(aheadUs - input.layerTStartUs);

  const windowStart = Math.max(playSrc, input.srcInFrame);
  const windowEnd = Math.min(aheadSrc, input.srcOutFrame);
  if (windowEnd <= windowStart) return [];

  const out: PlannedChunk[] = [];
  const firstChunk = Math.floor(windowStart / CHUNK_FRAMES);
  const lastChunk = Math.floor((windowEnd - 1) / CHUNK_FRAMES);
  for (let k = firstChunk; k <= lastChunk && out.length < budget; k++) {
    const srcStartFrame = Math.max(k * CHUNK_FRAMES, input.srcInFrame);
    if (live.has(srcStartFrame)) continue;
    const srcEnd = Math.min((k + 1) * CHUNK_FRAMES, input.srcOutFrame);
    const frames = srcEnd - srcStartFrame;
    if (frames <= 0) continue;

    const chunkCompUs =
      input.layerTStartUs + framesToUs(srcStartFrame - input.srcInFrame);
    const whenIdeal =
      input.anchorCtxTime + (chunkCompUs - input.anchorCompUs) / 1_000_000;
    const lateBy = input.ctxNow - whenIdeal;
    if (lateBy <= 0) {
      out.push({ srcStartFrame, frames, when: whenIdeal, bufferOffsetFrames: 0 });
    } else {
      const offset = Math.round(lateBy * SAMPLE_RATE);
      if (offset >= frames) continue; // entirely in the past — skip, no replay
      out.push({
        srcStartFrame,
        frames,
        when: input.ctxNow,
        bufferOffsetFrames: offset,
      });
    }
  }
  return out;
}

/// Cross-clock drift gate: the audio clock's predicted composition position
/// vs the engine's. Within the threshold the schedule stands; past it the
/// mixer re-anchors (cancel + reschedule with a micro-fade).
export function shouldReanchor(
  predictedCompUs: number,
  engineCompUs: number,
): boolean {
  return (
    Math.abs(predictedCompUs - engineCompUs) > REANCHOR_THRESHOLD_S * 1_000_000
  );
}
