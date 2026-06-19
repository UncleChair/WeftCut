// Map ffprobe color tag names (color_space/range/primaries/transfer) to the
// WebCodecs VideoColorSpaceInit enums. Only known names map; unknown/null are
// omitted so the caller's default fills them. Returns undefined if nothing maps.
export interface FfprobeColor {
  color_matrix?: string | null;
  color_range?: string | null;
  color_primaries?: string | null;
  color_transfer?: string | null;
}

// SDR-only mapping. HDR/wide-gamut ffprobe values (bt2020nc, bt2020, smpte432,
// smpte2084/pq, arib-std-b67/hlg, bt2020-10) are intentionally NOT mapped: this
// color fix targets 8-bit SDR sources (BT.601/709, limited/full), and TS's
// lib.dom WebCodecs unions don't include the HDR enum values anyway. Such
// sources are 10-bit and take WeftCut's proxy path. Mapping them would require
// widening past the DOM types + casting at the VideoColorSpaceInit boundary —
// a separate slice. Unmapped values fall through to the resolution default.
const MATRIX: Record<string, VideoMatrixCoefficients> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470bg",
  rgb: "rgb",
  gbr: "rgb",
};
const PRIMARIES: Record<string, VideoColorPrimaries> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470bg",
};
const TRANSFER: Record<string, VideoTransferCharacteristics> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  "iec61966-2-1": "iec61966-2-1",
};

export function ffprobeColorToWebCodecs(c: FfprobeColor): VideoColorSpaceInit | undefined {
  const out: VideoColorSpaceInit = {};
  const m = c.color_matrix ? MATRIX[c.color_matrix] : undefined;
  if (m) out.matrix = m;
  const p = c.color_primaries ? PRIMARIES[c.color_primaries] : undefined;
  if (p) out.primaries = p;
  const t = c.color_transfer ? TRANSFER[c.color_transfer] : undefined;
  if (t) out.transfer = t;
  if (c.color_range === "tv") out.fullRange = false;
  else if (c.color_range === "pc") out.fullRange = true;
  return Object.keys(out).length > 0 ? out : undefined;
}
