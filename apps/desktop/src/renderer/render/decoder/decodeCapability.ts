// Session-scoped lane knowledge feeding the pure resolver: probe verdicts
// (WebCodecs tier-2 today; native SW/HW capability arrive in D3/D4), sticky
// runtime downgrades (P3), and once-per-change LogBus resolution logging.
// SESSION state — resets on reload; the persisted machine truth is main's
// capability cache (D3), never this map. Distinct from the (retiring)
// "session bridge" term — see CONTEXT.md.
import { logEmit, type LogEntryInput } from "../../ipc";
import type { EngineTier, LaneState, ResolvedSource } from "./decodeEngine";

const downgradedByMedia = new Map<string, Set<EngineTier>>();
const swLaneByMedia = new Map<string, LaneState>(); // D3 wires probe results
const hwLaneByMedia = new Map<string, LaneState>(); // D4 wires probe results
const lastLoggedKey = new Map<string, string>();

/// Shared immutable empty set so `laneStatesFor` allocates nothing per tick when
/// a media has no runtime downgrades (this runs on the per-frame acquire path).
const NO_DOWNGRADES: ReadonlySet<EngineTier> = new Set<EngineTier>();

/// One-line LogBus emit for the decode-engine category. Category/source are the
/// verified `LogCategory`/`LogSource` variants; `level` is the lowercase
/// `LogLevel` union.
function emit(level: LogEntryInput["level"], message: string): void {
  void logEmit({
    level,
    category: { kind: "Other", name: "decode-engine" },
    source: { kind: "System" },
    message,
  });
}

export function laneStatesFor(
  mediaId: string,
  media: { decode_route?: { route: string } | null },
  /// True where the native-decode component loaded — i.e. its DLLs exist, so
  /// HW decode is *possible* on this machine (Windows v1). Defaults false so
  /// callers that don't know (older tests) keep HW "unavailable".
  componentAvailable = false,
): {
  webcodecsOriginal: LaneState;
  nativeHw: LaneState;
  nativeSw: LaneState;
  downgraded: ReadonlySet<EngineTier>;
} {
  return {
    // Tier 2 comes from the caller's probe memo (PixiPreview passes it in);
    // this placeholder is overridden there — kept so D3/D4 callers can use
    // laneStatesFor alone.
    webcodecsOriginal: "untested",
    // D4: HW is probe-driven. Where the component loaded, default "untested" so
    // PixiPreview kicks the GPU probe; where it's absent, "unavailable" so the
    // resolver skips tier 1 outright. `componentAvailable` (not navigator.platform)
    // is the sufficient HW-possible proxy — the component only loads where its
    // DLLs exist.
    nativeHw: hwLaneByMedia.get(mediaId) ?? (componentAvailable ? "untested" : "unavailable"),
    nativeSw:
      swLaneByMedia.get(mediaId) ??
      (media.decode_route?.route === "native-sw" ? "ok" : "untested"), // list seeds the probe (P1)
    downgraded: downgradedByMedia.get(mediaId) ?? NO_DOWNGRADES,
  };
}

export function markDowngraded(mediaId: string, tier: EngineTier, reason: string): void {
  let set = downgradedByMedia.get(mediaId);
  if (!set) {
    set = new Set();
    downgradedByMedia.set(mediaId, set);
  }
  if (set.has(tier)) return;
  set.add(tier);
  emit("warn", `decode downgrade: media ${mediaId} tier ${tier} — ${reason}`);
}

/// LogBus trail: one entry per (media, resolved key) change — P3's
/// "every step logged" without per-frame spam.
export function noteResolution(mediaId: string, r: ResolvedSource): void {
  const k = r.key ?? `${r.tier}:pending`;
  if (lastLoggedKey.get(mediaId) === k) return;
  lastLoggedKey.set(mediaId, k);
  emit("info", `decode resolution: media ${mediaId} → ${r.reason}`);
}

export function setSwLane(mediaId: string, s: LaneState): void {
  swLaneByMedia.set(mediaId, s);
}
export function setHwLane(mediaId: string, s: LaneState): void {
  hwLaneByMedia.set(mediaId, s);
}

const swProbeInFlight = new Set<string>();

/// Kick the SW-lane machine-capability probe (D3's `decodeCap:probeSw`) for a
/// source whose tier-3 lane is still "untested" — i.e. NOT pre-passed by the
/// static blind-spot route seed (P1). Single-flight per media: a second kick
/// while one is outstanding, or once `swLaneByMedia` already holds a verdict,
/// is a no-op. The verdict lands via `setSwLane`; `onSettled` then nudges the
/// caller (PixiPreview's local `refreshSources`) so the next `ensureClip`
/// re-runs `resolveEngineTier` against the fresh lane and the no-flash swap
/// upgrades the clip off proxy — the same probe→nudge rhythm the import
/// decodability sweep already uses (useImportReadiness.ts).
export function kickSwProbe(
  mediaId: string,
  path: string,
  onSettled: () => void,
  probeFn: (p: string) => Promise<{ ok: boolean }> = (p) => window.api.decodeCap.probeSw(p),
): void {
  if (swProbeInFlight.has(mediaId) || swLaneByMedia.has(mediaId)) return;
  swProbeInFlight.add(mediaId);
  void probeFn(path)
    .then((r) => setSwLane(mediaId, r.ok ? "ok" : "fail"))
    .catch(() => setSwLane(mediaId, "fail"))
    .finally(() => {
      swProbeInFlight.delete(mediaId);
      onSettled();
    });
}

const hwProbeInFlight = new Set<string>();

/// Kick the HW-lane GPU capability probe (D4's `decodeCap:probeHw`) for a
/// source whose tier-1 lane is still "untested". Single-flight per media: a
/// second kick while one is outstanding, or once `hwLaneByMedia` already holds
/// a verdict, is a no-op. Unlike `kickSwProbe`, the HW probe takes the caller-
/// derived `classKey` too (the GPU probe is comparatively expensive, so main
/// consults its GPU-keyed cache under that format class BEFORE deciding to
/// actually decode). The verdict lands via `setHwLane`; `onSettled` then nudges
/// the caller (PixiPreview's `refreshSources`) so the next `ensureClip` re-runs
/// `resolveEngineTier` against the fresh lane and the no-flash swap upgrades the
/// clip to native-hw — the same probe→nudge rhythm `kickSwProbe` uses.
export function kickHwProbe(
  mediaId: string,
  path: string,
  classKey: string,
  onSettled: () => void,
  probeFn: (p: string, k: string) => Promise<{ ok: boolean }> = (p, k) =>
    window.api.decodeCap.probeHw(p, k),
): void {
  if (hwProbeInFlight.has(mediaId) || hwLaneByMedia.has(mediaId)) return;
  hwProbeInFlight.add(mediaId);
  void probeFn(path, classKey)
    .then((r) => setHwLane(mediaId, r.ok ? "ok" : "fail"))
    .catch(() => setHwLane(mediaId, "fail"))
    .finally(() => {
      hwProbeInFlight.delete(mediaId);
      onSettled();
    });
}

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
/// HW scope (decode-bench Stage-2, measured today: 8-bit H.264 / HEVC / VP9),
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

/// Test/e2e hook: forget session verdicts (used by decode-engine.spec.ts).
export function resetDecodeCapabilitySession(): void {
  downgradedByMedia.clear();
  swLaneByMedia.clear();
  hwLaneByMedia.clear();
  lastLoggedKey.clear();
  swProbeInFlight.clear();
  hwProbeInFlight.clear();
}
