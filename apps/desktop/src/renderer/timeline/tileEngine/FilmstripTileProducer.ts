import { getFilmstripTile } from "../../ipc";
import { convertFileSrc } from "@/bridge/ipc";
import { tileEngine, type TileEngine, type TileKey } from "./TileEngine";

export const FILMSTRIP_KIND = "filmstrip";
/// Canonical decode height — lane height / zoom never changes a cache key.
export const FILMSTRIP_TILE_HEIGHT_PX = 256;
/// Time-grid base spacing. Twin: native jobs/filmstrip.rs
/// FILMSTRIP_BASE_SPACING_US / spacing_us — both sides pin the same endpoints.
export const FILMSTRIP_BASE_SPACING_US = 250_000;
export const FILMSTRIP_MAX_LOD = 12;
/// Every miss spawns one ffmpeg on the native side — do not stampede.
export const FILMSTRIP_MAX_CONCURRENT_FETCHES = 4;
/// Proxy completion flips a Proxied source's not_ready tiles (proxy-wait rule).
export const FILMSTRIP_INVALIDATE_ON = ["proxy", "quick_proxy"];

export function spacingUs(lod: number): number {
  return FILMSTRIP_BASE_SPACING_US * 2 ** lod;
}

export function chooseFilmstripLod(thumbWidthPx: number, pxPerSec: number): number {
  if (thumbWidthPx <= 0 || pxPerSec <= 0) return FILMSTRIP_MAX_LOD;
  const desiredUs = (thumbWidthPx / pxPerSec) * 1e6;
  const lod = Math.round(Math.log2(desiredUs / FILMSTRIP_BASE_SPACING_US));
  return Math.max(0, Math.min(FILMSTRIP_MAX_LOD, lod));
}

export function filmstripThumbWidthPx(
  laneHeightPx: number,
  mediaWidth: number | null | undefined,
  mediaHeight: number | null | undefined,
): number {
  const aspect = mediaWidth && mediaHeight && mediaHeight > 0 ? mediaWidth / mediaHeight : 16 / 9;
  return laneHeightPx * aspect;
}

/// Indices whose tile box [t, t + thumbWidthUs) intersects [srcInUs, srcOutUs),
/// clamped to >= 0 and (when known) inside the source duration. Returns
/// first > last for an empty range.
export function visibleTileRange(
  srcInUs: number,
  srcOutUs: number,
  spacing: number,
  thumbWidthUs: number,
  durationUs: number | null | undefined,
): { first: number; last: number } {
  const lo = Math.min(srcInUs, srcOutUs);
  const hi = Math.max(srcInUs, srcOutUs);
  let first = Math.max(0, Math.floor((lo - thumbWidthUs) / spacing) + 1);
  let last = Math.ceil(hi / spacing) - 1;
  if (durationUs != null && durationUs > 0) {
    last = Math.min(last, Math.floor((durationUs - 1) / spacing));
  }
  return { first, last };
}

export interface FilmstripTileValue {
  bitmap: ImageBitmap;
  tUs: number;
}

export function filmstripTileKey(mediaId: string, lod: number, index: number): TileKey {
  return { mediaId, kind: FILMSTRIP_KIND, lod, index };
}

// Producer-side fetch gate: TileEngine issues fetches eagerly; this queue
// keeps at most FILMSTRIP_MAX_CONCURRENT_FETCHES ffmpeg extracts in flight.
let inFlight = 0;
const waiters: Array<() => void> = [];
async function acquireFetchSlot(): Promise<void> {
  if (inFlight < FILMSTRIP_MAX_CONCURRENT_FETCHES) { inFlight++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}
function releaseFetchSlot(): void {
  inFlight--;
  waiters.shift()?.();
}

let registered = false;
export function registerFilmstripProducer(engine: TileEngine = tileEngine): void {
  if (registered) return;
  registered = true;
  engine.register<FilmstripTileValue>({
    kind: FILMSTRIP_KIND,
    invalidateOn: FILMSTRIP_INVALIDATE_ON,
    fetch: async (key: TileKey) => {
      await acquireFetchSlot();
      try {
        const tile = await getFilmstripTile(key.mediaId, key.lod, key.index);
        const res = await fetch(convertFileSrc(tile.path));
        const bitmap = await createImageBitmap(await res.blob());
        return { bitmap, tUs: key.index * spacingUs(key.lod) };
      } finally {
        releaseFetchSlot();
      }
    },
    bytes: (v) => v.bitmap.width * v.bitmap.height * 4,
    dispose: (v) => v.bitmap.close(),
  });
}
