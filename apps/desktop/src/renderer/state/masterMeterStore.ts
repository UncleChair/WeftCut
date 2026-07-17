import { create } from "zustand";

export interface MasterMeterSnapshot {
  /** Combined master output in dBFS. Silence is represented as -120. */
  rmsDb: number;
  peakDb: number;
  /** Monotonic sample time. Null until the preview audio graph publishes. */
  sampledAtMs: number | null;
}

const SILENCE_DB = -120;

export const useMasterMeterStore = create<MasterMeterSnapshot>(() => ({
  rmsDb: SILENCE_DB,
  peakDb: SILENCE_DB,
  sampledAtMs: null,
}));

function jsonSafeDb(value: number): number {
  return Number.isFinite(value) ? value : SILENCE_DB;
}

/** The single renderer publication seam for the real preview master analyser. */
export function publishMasterMeter(
  sample: Pick<MasterMeterSnapshot, "rmsDb" | "peakDb">,
  sampledAtMs = performance.now(),
): void {
  useMasterMeterStore.setState({
    rmsDb: jsonSafeDb(sample.rmsDb),
    peakDb: jsonSafeDb(sample.peakDb),
    sampledAtMs,
  });
}

/** Clear a disposed preview's stale reading without coupling consumers to it. */
export function clearMasterMeter(): void {
  useMasterMeterStore.setState({
    rmsDb: SILENCE_DB,
    peakDb: SILENCE_DB,
    sampledAtMs: null,
  });
}

export const useMasterRmsDb = (): number =>
  useMasterMeterStore((state) => state.rmsDb);

export const useMasterPeakDb = (): number =>
  useMasterMeterStore((state) => state.peakDb);
