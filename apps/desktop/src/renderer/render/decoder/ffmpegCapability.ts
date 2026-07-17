// FFmpeg-engine capability machinery: the sticky per-media unusable markers,
// the seek-validated HW codec allow-list, and `pickInitialLane` — the async
// lane-selection entry point `FfmpegSource` calls so it owns lane selection
// itself and the pure resolver never sees a lane. SESSION state — resets on
// reload; the persisted machine truth is main's capability cache, never these
// maps/sets.
import type { FfmpegLane } from "./decodeEngine";

/// TWIN of main's `classKeyOf` (src/main/decode-capability.ts) — MUST produce a
/// BYTE-IDENTICAL format string so a renderer-derived key hits the exact cache
/// entry main's HW probe writes/reads. Same shape `codec::pixFmt:res` with the
/// resolution class bucketed on `px = max(w, h)` (sd/hd/uhd/huge) and a null
/// pixFmt interpolated as "unknown". Returns null when `codec` is null
/// (audio/image — no HW video lane). Keep in lockstep with `classKeyOf` if
/// either side's string form ever changes.
export function classKeyOfMedia(m: {
  codec: string | null;
  pix_fmt: string | null;
  width?: number | null;
  height?: number | null;
}): string | null {
  if (!m.codec) return null;
  const px = Math.max(m.width ?? 0, m.height ?? 0);
  const res = px <= 1024 ? "sd" : px <= 2048 ? "hd" : px <= 4096 ? "uhd" : "huge";
  return `${m.codec}::${m.pix_fmt ?? "unknown"}:${res}`;
}

/// HW-lane codec allow-list — the seek-safety dimension the one-frame HW probe
/// CANNOT test. Main's `decode_first_d3d11_frame` decodes a single FORWARD
/// frame: if the GPU driver HW-decodes it the probe returns ok, so the probe is
/// NECESSARY BUT NOT SUFFICIENT — it proves decode-VIABILITY, not
/// SEEK-SURVIVAL. A codec can decode forward cleanly yet HANG the D3D11 preview
/// session indefinitely on a backward seek (observed: MPEG-2 on an RTX 3050 —
/// the driver HW-decodes it, the one-frame probe says ok, then playback wedges
/// on a backward seek with no recovery). This list encodes the seek-VALIDATED
/// HW scope (via decode-bench: 8-bit H.264 / HEVC / VP9),
/// gating which codecs are even PROBE-ELIGIBLE for tier 1 (spec P1: "lists may
/// seed or short-circuit probes"). It NARROWS what's eligible; it never
/// overrules a probe's negative verdict. Eligible = codec ∈ {h264, hevc, vp9}
/// AND an 8-bit pixel format — anything carrying a 10-bit tag ("10le" / "p010",
/// case-insensitive) is excluded. Callers gate the HW-probe kick on this
/// (PixiPreview.resolveSource) so an ineligible codec never lights the HW lane;
/// the pure resolver stays untouched.
export function hwEligibleCodec(codec: string | null, pixFmt: string | null): boolean {
  if (codec !== "h264" && codec !== "hevc" && codec !== "vp9") return false;
  const pf = (pixFmt ?? "").toLowerCase();
  if (pf.includes("10le") || pf.includes("p010")) return false;
  return true;
}

/// Sticky per-media "never try HW again this session" marker. Set when a
/// native-HW transport dies at runtime (device loss, driver reset, session
/// crash); gates `pickInitialLane`, so a subsequent `FfmpegSource` open for
/// this media skips straight to the software lane.
const hwUnusable = new Set<string>();

export function markHwUnusable(mediaId: string, _reason: string): void {
  hwUnusable.add(mediaId);
}

/// Sticky per-media "ffmpeg engine terminally failed this session" marker —
/// the runtime signal behind `DecodeResolveInputs.ffmpegUsable` (decodeEngine.ts).
/// Consumed by `Compositor.ts` (calls `markFfmpegUnusable` on total FfmpegSource
/// failure) and `PixiPreview.tsx` (calls `isFfmpegUnusable` to feed the resolver's
/// `ffmpegUsable` input), keeping the pure resolver untouched.
const ffmpegUnusable = new Set<string>();

export function markFfmpegUnusable(mediaId: string, _reason: string): void {
  ffmpegUnusable.add(mediaId);
}

export function isFfmpegUnusable(mediaId: string): boolean {
  return ffmpegUnusable.has(mediaId);
}

/// Async lane-selection entry point for `FfmpegSource`: consults the sticky
/// `markHwUnusable` marker and the seek-validated HW codec allow-list. An
/// HW-eligible codec with a valid classKey AND a path is probed; missing
/// classKey or path → `"software"` (no probe). Returns `"hardware"` only if the
/// probe succeeds (ok: true); all other failures (unavailable, marked unusable,
/// ineligible codec, probe rejection/exception) also return `"software"`.
export async function pickInitialLane(
  input: {
    mediaId: string;
    codec: string | null;
    pixFmt: string | null;
    /// Media dimensions for the classKey's resolution bucket — omitting
    /// these collapses `classKeyOfMedia` to the "sd" bucket for every source,
    /// mismatching main's probe cache key.
    width?: number | null;
    height?: number | null;
    componentAvailable: boolean;
  },
  probeFn: (path: string, classKey: string) => Promise<{ ok: boolean }> = (p, k) =>
    window.api.decodeCap.probeHw(p, k),
  path?: string,
): Promise<FfmpegLane> {
  if (!input.componentAvailable) return "software"; // caller shouldn't ask, but be safe
  if (hwUnusable.has(input.mediaId)) return "software";
  if (!hwEligibleCodec(input.codec, input.pixFmt)) return "software";
  // Conditional spread, not `width: input.width` — exactOptionalPropertyTypes
  // rejects assigning `number | null | undefined` to the optional `width?:
  // number | null` field when the key is present with an `undefined` value.
  const classKey = classKeyOfMedia({
    codec: input.codec,
    pix_fmt: input.pixFmt,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
  });
  if (classKey === null || !path) return "software";
  try {
    const r = await probeFn(path, classKey);
    return r.ok ? "hardware" : "software";
  } catch {
    return "software";
  }
}

/// Test/e2e hook: forget session verdicts (used by ffmpegCapability.test.ts).
export function resetFfmpegCapabilitySession(): void {
  hwUnusable.clear();
  ffmpegUnusable.clear();
}
