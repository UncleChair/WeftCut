/// Sample-precision audio authoring: the pure half. Nudge steps and the derived
/// group sync offset (ADR 0038 / spec R2-D6, R2-D7), with no React and no IPC, so
/// every acceptance property is a unit test rather than a UI walkthrough.
import { AUDIO_GRID, AUDIO_SAMPLES_PER_MS, gridIndex, stepOnGrid } from "../grid";

/** The two nudge tiers. One sample is the finest the mix lattice has; 1 ms = 48
 *  samples is the coarse tier, because a single sample (~21 µs) is far below the
 *  threshold of an audible sync fix and holding a key for 48 presses is not a UI. */
export const NUDGE_SAMPLE = 1;
export const NUDGE_MS = AUDIO_SAMPLES_PER_MS;

/** Minimum layer geometry the slip helpers need — structurally satisfied by
 *  `LayerSummary` (whose top-level `kind` IS `params.kind`; see
 *  `summary.ts::layerKind`), so callers pass summary rows straight in. */
export interface SlipLayer {
  id: string;
  t_start_us: number;
  t_end_us: number;
  kind: string;
}

/** Where a nudge should move an audio layer's start, stepped by `steps` SAMPLES.
 *
 *  Resolved through the sample index, never by adding a sample's width in µs — 48 kHz
 *  spacing alternates 20/21 µs, so a µs-additive step drifts and nudging out and back
 *  10 000 times would not return to the original sample. That is precisely how the
 *  video frame-step bug looked. Clamped at 0 by `stepOnGrid`. */
export function nudgedStartUs(layer: SlipLayer, steps: number): number {
  return stepOnGrid(layer.t_start_us, steps, AUDIO_GRID);
}

/** The audio layers in `selection` that a nudge should move.
 *
 *  Audio-only by design: the nudges exist because audio has a finer lattice, and
 *  applying them to a visual layer would either do nothing (its grid has no sample
 *  step) or silently move it by a whole frame. A mixed selection nudges only its
 *  audio members, which is also what makes the command safe to fire on a
 *  whole-group selection — the video member stays put. */
export function slippableAudioLayers(
  selection: ReadonlySet<string>,
  layers: readonly SlipLayer[],
): SlipLayer[] {
  return layers.filter((l) => selection.has(l.id) && l.kind === "Audio");
}

/** The sync offset of a grouped audio layer, in SAMPLES, or `null` when the layer is
 *  not in a group with a visual member to measure against.
 *
 *  DERIVED, never stored (R2-D7), so no field can ever disagree with the geometry.
 *
 *  Measured as a difference of SAMPLE INDICES rather than raw µs, and that is not a
 *  cosmetic choice: at 29.97 / 59.94 a frame boundary is not a sample boundary, so an
 *  un-slipped A/V pair — one requested time resolved on two lattices — already sits
 *  up to ~10 µs apart. A raw-µs offset would report that grid residue as a slip and
 *  the badge would light up on every freshly dropped clip. Both members' indices round
 *  to the same sample when nothing has been slipped, so this reads exactly 0 there and
 *  exactly N after N nudges.
 *
 *  The reference is the group's visual member whose start is CLOSEST to the audio's —
 *  "the clip this is paired with". For the auto-paired A/V case (the only one that can
 *  currently produce a slip) that is the single visual member. */
export function syncOffsetSamples(
  audio: SlipLayer,
  groupMembers: readonly SlipLayer[],
): number | null {
  const visual = groupMembers.filter((l) => l.id !== audio.id && l.kind !== "Audio");
  if (visual.length === 0) return null;
  let ref = visual[0]!;
  for (const v of visual) {
    if (Math.abs(v.t_start_us - audio.t_start_us) < Math.abs(ref.t_start_us - audio.t_start_us)) ref = v;
  }
  return gridIndex(audio.t_start_us, AUDIO_GRID) - gridIndex(ref.t_start_us, AUDIO_GRID);
}

/** Where a "re-sync to video" should move an audio layer: onto the sample boundary
 *  nearest its visual partner, i.e. offset zero. `null` when there is nothing to
 *  re-sync to, or when it is already synced (so the command can no-op rather than
 *  mint a history entry). */
export function resyncStartUs(
  audio: SlipLayer,
  groupMembers: readonly SlipLayer[],
): number | null {
  const offset = syncOffsetSamples(audio, groupMembers);
  if (offset === null || offset === 0) return null;
  return nudgedStartUs(audio, -offset);
}

/** Human-readable slip for the clip badge. `null` when there is nothing to show —
 *  either no visual partner or a genuinely zero offset (a badge that always shows
 *  "0 ms" is a badge nobody reads).
 *
 *  Sub-millisecond slips read in samples because "0.0 ms" is not information; at 1 ms
 *  and above milliseconds are what a user reasons about. Sign is explicit: a positive
 *  offset means the audio is LATE relative to its video. */
export function formatSyncOffset(offsetSamples: number | null): string | null {
  if (offsetSamples === null || offsetSamples === 0) return null;
  const sign = offsetSamples > 0 ? "+" : "−";
  const mag = Math.abs(offsetSamples);
  if (mag < AUDIO_SAMPLES_PER_MS) return `${sign}${mag} smp`;
  return `${sign}${(mag / AUDIO_SAMPLES_PER_MS).toFixed(mag < AUDIO_SAMPLES_PER_MS * 10 ? 2 : 1)} ms`;
}
