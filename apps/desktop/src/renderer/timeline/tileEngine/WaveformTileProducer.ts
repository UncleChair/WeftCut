import {
  getWaveformLevels,
  getWaveformTile,
  type WaveformLevels,
} from "../../ipc";
import { tileEngine, type TileEngine, type TileKey } from "./TileEngine";

export const WAVEFORM_KIND = "waveform";
/// One fetched tile = this many (min,max,rms) windows. Bounds IPC payload size.
export const TILE_PEAKS = 2048;
/// Aim for ~1.5 timeline px per peak window at the chosen LOD.
export const PX_PER_PEAK_TARGET = 1.5;
/// Engine-side budget for waveform tiles (~48 KB each -> ~680 tiles, far
/// above what the viewport-bounded fetch can request at once).
export const WAVEFORM_TILE_BUDGET_BYTES = 32 * 1024 * 1024;

/// Index of the coarsest level whose density still meets the on-screen demand,
/// so we ship the least data that looks crisp. Levels are finest-first.
export function chooseLevel(
  levels: WaveformLevels["levels"],
  pxPerSec: number,
): number {
  const desired = pxPerSec / PX_PER_PEAK_TARGET;
  let chosen = 0; // finest fallback
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i]!.peaksPerSecond >= desired) { chosen = i; break; }
  }
  return chosen;
}

export function tileRangeForWindow(
  peaksPerSecond: number,
  srcInUs: number,
  srcOutUs: number,
): { firstTile: number; lastTile: number; startPeak: number; endPeak: number } {
  const lo = Math.min(srcInUs, srcOutUs);
  const hi = Math.max(srcInUs, srcOutUs);
  const startPeak = Math.max(0, Math.floor((lo / 1_000_000) * peaksPerSecond));
  const endPeak = Math.max(startPeak + 1, Math.ceil((hi / 1_000_000) * peaksPerSecond));
  return {
    startPeak,
    endPeak,
    firstTile: Math.floor(startPeak / TILE_PEAKS),
    lastTile: Math.floor((endPeak - 1) / TILE_PEAKS),
  };
}

export interface WaveformWindow {
  peaksPerSecond: number;
  startPeak: number;
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

interface TileValue {
  peaksPerSecond: number;
  min: number[];
  max: number[];
  rms: number[];
}

// Level tables are cheap and stable per generated waveform file; cache them so
// we don't re-read the header on every window assembly. NOT immutable forever:
// a regenerated waveform (media:job_complete) gets a fresh table, so the
// producer's `invalidate` hook below must drop the entry.
const levelsCache = new Map<string, Promise<WaveformLevels>>();
function fetchLevels(mediaId: string): Promise<WaveformLevels> {
  let p = levelsCache.get(mediaId);
  if (!p) {
    p = getWaveformLevels(mediaId).catch((e) => { levelsCache.delete(mediaId); throw e; });
    levelsCache.set(mediaId, p);
  }
  return p;
}

let registered = false;
export function registerWaveformProducer(engine: TileEngine = tileEngine): void {
  if (registered) return;
  registered = true;
  engine.register<TileValue>({
    kind: WAVEFORM_KIND,
    budgetBytes: WAVEFORM_TILE_BUDGET_BYTES,
    // `lod` encodes level; `index` encodes channel*BIG + tileIndex.
    fetch: async (key: TileKey) => {
      const channel = Math.floor(key.index / 1_000_000);
      const tileIndex = key.index % 1_000_000;
      const tile = await getWaveformTile(
        key.mediaId, key.lod, channel, tileIndex * TILE_PEAKS, TILE_PEAKS,
      );
      return { peaksPerSecond: tile.peaksPerSecond, min: tile.min, max: tile.max, rms: tile.rms };
    },
    bytes: (v) => (v.min.length + v.max.length + v.rms.length) * 8,
    invalidate: (mediaId) => { levelsCache.delete(mediaId); },
  });
}

function tileKey(mediaId: string, level: number, channel: number, tileIndex: number): TileKey {
  return { mediaId, kind: WAVEFORM_KIND, lod: level, index: channel * 1_000_000 + tileIndex };
}

/// Request + assemble the min/max/rms envelope for a src window at the LOD that
/// suits `pxPerSec`. Returns "pending" until every covering tile is ready, or
/// "not_ready" if the waveform file isn't generated yet.
export async function ensureWaveformWindow(
  mediaId: string,
  channel: number,
  srcInUs: number,
  srcOutUs: number,
  pxPerSec: number,
  engine: TileEngine = tileEngine,
): Promise<WaveformWindow | "pending" | "not_ready"> {
  let levels: WaveformLevels;
  try {
    levels = await fetchLevels(mediaId);
  } catch (e) {
    return typeof e === "string" && e.includes("not_ready") ? "not_ready" : "pending";
  }
  if (levels.levels.length === 0) return "not_ready";

  const level = chooseLevel(levels.levels, pxPerSec);
  const pps = levels.levels[level]!.peaksPerSecond;
  const { firstTile, lastTile, startPeak, endPeak } = tileRangeForWindow(pps, srcInUs, srcOutUs);

  // Request all covering tiles; collect ready ones.
  const tiles: (TileValue | null)[] = [];
  let anyMissing = false;
  let notReady = false;
  for (let t = firstTile; t <= lastTile; t++) {
    const key = tileKey(mediaId, level, channel, t);
    const entry = engine.get<TileValue>(key);
    if (!entry) { engine.request(key); anyMissing = true; tiles.push(null); continue; }
    if (entry.state === "ready") { tiles.push(entry.value); continue; }
    if (entry.state === "not_ready") { notReady = true; tiles.push(null); continue; }
    if (entry.state === "error") { engine.request(key); anyMissing = true; tiles.push(null); continue; }
    // pending -> treat as missing
    anyMissing = true;
    tiles.push(null);
  }
  if (notReady) return "not_ready";
  if (anyMissing || tiles.some((x) => x === null)) return "pending";

  // Assemble the [startPeak, endPeak) slice.
  const total = endPeak - startPeak;
  const min = new Float32Array(total);
  const max = new Float32Array(total);
  const rms = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const globalPeak = startPeak + i;
    const t = Math.floor(globalPeak / TILE_PEAKS);
    const within = globalPeak % TILE_PEAKS;
    const tile = tiles[t - firstTile]!;
    min[i] = tile.min[within] ?? 0;
    max[i] = tile.max[within] ?? 0;
    rms[i] = tile.rms[within] ?? 0;
  }
  return { peaksPerSecond: pps, startPeak, min, max, rms };
}

/// Channel count for a media's waveform, shared with `ensureWaveformWindow`'s
/// level-table cache (and therefore its invalidation on regeneration).
export async function getWaveformChannelCount(mediaId: string): Promise<number> {
  return (await fetchLevels(mediaId)).channels;
}
