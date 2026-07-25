// Premiere's "audio units" equivalent: which unit AUDIO-layer time readouts use.
// Scoped deliberately narrowly (ADR 0038):
//
//   - It applies to audio-layer readouts ONLY. The ruler, the playhead and every
//     visual layer stay frame-based, because a mode that flipped the whole timeline
//     would make a video edit unreadable to fix an audio one.
//   - There is NO sample ruler mode. One sample is 0.042 px at the 2000 px/s zoom
//     ceiling, so there is no zoom at which a sample ruler is legible — it would be a
//     second grid on screen, which is the thing this effort spent a round removing.
//   - Nothing persists it. It is a reading preference, not project data, so a stale
//     value can never disagree with the file.

import { create } from "zustand";
import { AUDIO_GRID, AUDIO_SAMPLES_PER_MS, gridIndex, timeUsAtGridIndex } from "../grid";
import { formatTimecode, formatWallClock, parseTimecode } from "../frames";

/// `frames` — SMPTE `HH:MM:SS:FF` against the composition rate (the default: it
/// matches everything else on screen). `ms` — `HH:MM:SS.mmm`, the unit a sync fix is
/// actually reasoned about in. `samples` — the raw mix-lattice index, for when the
/// exact sample matters.
export type AudioUnits = "frames" | "ms" | "samples";

export const AUDIO_UNITS_ORDER: readonly AudioUnits[] = ["frames", "ms", "samples"];

interface State {
  units: AudioUnits;
}

export const useAudioUnitsStore = create<State>(() => ({ units: "frames" }));

export function setAudioUnits(units: AudioUnits): void {
  if (useAudioUnitsStore.getState().units !== units) useAudioUnitsStore.setState({ units });
}

export function audioUnits(): AudioUnits {
  return useAudioUnitsStore.getState().units;
}

/// Atomic selector — the whole store is one primitive, so this cannot trip the
/// composite-selector loop (`feedback_zustand_composite_selector`).
export function useAudioUnits(): AudioUnits {
  return useAudioUnitsStore((s) => s.units);
}

/// Advance to the next unit — the toggle's click handler.
export function cycleAudioUnits(): void {
  const i = AUDIO_UNITS_ORDER.indexOf(audioUnits());
  setAudioUnits(AUDIO_UNITS_ORDER[(i + 1) % AUDIO_UNITS_ORDER.length]!);
}

/// Format an audio-layer time in the current unit.
///
/// `samples` prints the mix-lattice INDEX, not a scaled µs value, so the number a
/// user reads is the same integer the mixer places on and the same one a nudge steps.
/// `ms` is wall clock, which is exact here for the same reason: sample boundaries are
/// ~20.83 µs apart, so a millisecond figure is never ambiguous about which sample.
export function formatAudioTime(
  tUs: number,
  units: AudioUnits,
  fpsNum: number,
  fpsDen: number,
): string {
  switch (units) {
    case "samples":
      return `${gridIndex(tUs, AUDIO_GRID)}`;
    case "ms":
      return formatWallClock(tUs);
    default:
      return formatTimecode(tUs, fpsNum, fpsDen);
  }
}

/// Parse a string in `units` back to µs on the audio lattice, or null when invalid.
/// The inverse of `formatAudioTime` for the two sub-frame units; `frames` has no
/// inverse here because `parseTimecode` (composition grid) already owns it.
export function parseAudioSamples(input: string): number | null {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const i = Number(s);
  if (!Number.isSafeInteger(i)) return null;
  // Through the leaf, never `i * 1e6 / 48000` in TS: the index→µs policy has exactly
  // one implementation (ADR 0025) and a second one is how `snapFrameFloor` drifted.
  return timeUsAtGridIndex(i, AUDIO_GRID);
}

/// Parse `HH:MM:SS.mmm` / `MM:SS.mmm` / `SS.mmm` to the NEAREST sample boundary, or
/// null when invalid. Snapping to the lattice rather than returning raw µs is what
/// makes the field round-trip: a typed millisecond is not generally a sample
/// boundary, and storing it raw would fail the grid backstop.
export function parseAudioMs(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  const m = /^(?:(?:(\d+):)?(\d+):)?(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const sec = Number(m[3]);
  const ms = Number((m[4] ?? "0").padEnd(3, "0"));
  if (min >= 60 || (m[2] !== undefined && sec >= 60)) return null;
  const us = ((h * 3600 + min * 60 + sec) * 1000 + ms) * 1000;
  return timeUsAtGridIndex(gridIndex(us, AUDIO_GRID), AUDIO_GRID);
}

/// Parse an audio-layer time in `units` back to µs, or null when invalid — the
/// inverse of `formatAudioTime`, and the field's whole reason for existing: numeric
/// entry is one of only two ways to reach sample precision (a drag cannot).
///
/// `frames` delegates to `parseTimecode`, so a frame-typed value resolves to a
/// COMPOSITION frame boundary. At 29.97 that is not a sample boundary, and the
/// mutation's snap then pulls it to the nearest sample — which is the honest
/// outcome: the user asked for a frame, and the file records where it will play.
export function parseAudioTime(
  input: string,
  units: AudioUnits,
  fpsNum: number,
  fpsDen: number,
): number | null {
  switch (units) {
    case "samples":
      return parseAudioSamples(input);
    case "ms":
      return parseAudioMs(input);
    default:
      return parseTimecode(input, fpsNum, fpsDen);
  }
}

/// One sample expressed in ms — used by hints and the nudge labels.
export const SAMPLE_MS = 1 / AUDIO_SAMPLES_PER_MS;
