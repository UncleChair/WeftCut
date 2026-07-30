// LANE-AWARE HW decode eligibility — the seek-validated allow-list, per lane
// (issue #10 ticket 03). One shared home consulted from BOTH sides of the
// probe: the renderer's probe-kick gate (`hwEligibleCodec`,
// renderer/render/decoder/ffmpegCapability.ts) and main's advertisement-gated
// lane walk (`resolveHwLane`, main/decode-capability.ts) — so the two can
// never disagree about which lane may host which format.
//
// Why a static list at all (and not the probe alone): the one-frame HW probe
// tests decode-VIABILITY, not SEEK-SURVIVAL. A codec can decode one forward
// frame cleanly yet hang the session on a backward seek (observed: MPEG-2 on
// an RTX 3050 d3d11va). The list encodes what decode-bench seek-validated; it
// NARROWS what is probe-eligible and never overrules a probe's negative
// verdict.
//
// Why per-LANE: the macOS VideoToolbox copy-back lane exists FOR ProRes —
// nearly all of it 10-bit — so the lane-blind 8-bit h264/hevc/vp9 gate would
// exclude the lane's whole prize. VideoToolbox is a single OS media engine
// (seek behavior validated with the lane's conformance e2e), so it carries its
// own set; every other lane keeps the historical gate EXACTLY.

/// The four HW decode lanes the native component can advertise
/// (`capabilities()`): `d3d11va` is Windows, `nvdec`/`vaapi` are Linux,
/// `videotoolbox` is macOS. Order is NOT priority (that lives in main's
/// `HW_LANE_PRIORITY`); this is the eligibility vocabulary only.
export const HW_DECODE_LANES = ["nvdec", "vaapi", "d3d11va", "videotoolbox"] as const;

export function isHwDecodeLane(lane: string): boolean {
  return (HW_DECODE_LANES as readonly string[]).includes(lane);
}

/// True for a pixel-format tag naming >8-bit samples this machinery treats as
/// 10-bit ("10le" — yuv420p10le/yuv422p10le/…; "p010" — the biplanar HW
/// transfer format), case-insensitive. A null/unknown pix_fmt is NOT a known
/// 10-bit tag and returns false — the format-class probe still guards the
/// actual open.
export function isTenBitPixFmt(pixFmt: string | null): boolean {
  const pf = (pixFmt ?? "").toLowerCase();
  return pf.includes("10le") || pf.includes("p010");
}

/// The historical seek-validated gate every lane except videotoolbox keeps:
/// codec ∈ {h264, hevc, vp9} AND an 8-bit pixel format.
function eligibleEightBitInterframe(codec: string | null, pixFmt: string | null): boolean {
  if (codec !== "h264" && codec !== "hevc" && codec !== "vp9") return false;
  return !isTenBitPixFmt(pixFmt);
}

/// Per-lane HW eligibility:
/// - `videotoolbox`: the interframe trio PLUS ProRes, with 10-bit pixel
///   formats allowed (ProRes 422 is yuv422p10le; 10-bit HEVC/VP9 decode on the
///   same OS engine). The preview session ships such sources as I420P10.
/// - `nvdec` / `vaapi` / `d3d11va`: today's gate, unchanged — 8-bit
///   h264/hevc/vp9 only.
/// - anything else (software, unknown): false — not a HW lane to be eligible on.
export function hwEligibleOnLane(
  lane: string,
  codec: string | null,
  pixFmt: string | null,
): boolean {
  if (lane === "videotoolbox") {
    return codec === "h264" || codec === "hevc" || codec === "vp9" || codec === "prores";
  }
  if (lane === "nvdec" || lane === "vaapi" || lane === "d3d11va") {
    return eligibleEightBitInterframe(codec, pixFmt);
  }
  return false;
}

/// True when at least one HW lane could host this format — the renderer's
/// probe-kick gate. Deliberately platform-blind: on a host whose advertised
/// lanes all reject the format, main's lane walk (which filters per lane)
/// finds no candidate and resolves software without probing, so the per-lane
/// gates hold everywhere while the renderer needs no platform knowledge.
export function hwEligibleOnAnyLane(codec: string | null, pixFmt: string | null): boolean {
  return HW_DECODE_LANES.some((lane) => hwEligibleOnLane(lane, codec, pixFmt));
}
