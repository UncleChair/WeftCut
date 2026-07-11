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
    nativeHw: hwLaneByMedia.get(mediaId) ?? "unavailable", // D4 flips to probe-driven
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

/// Test/e2e hook: forget session verdicts (used by decode-engine.spec.ts).
export function resetDecodeCapabilitySession(): void {
  downgradedByMedia.clear();
  swLaneByMedia.clear();
  hwLaneByMedia.clear();
  lastLoggedKey.clear();
}
