// Session-scoped LANE trail for the Standard engine: one LogBus row per clip
// per hardware↔software transition (see `noteLaneOpen`). SESSION state — resets
// on reload, and deliberately outlives any one `FfmpegSource` so a clip that
// falls to software and is later re-promoted logs BOTH trips.
//
// A channel of its own rather than a field on decodeCapability.ts's resolution
// trail: the lane is private to the Standard engine and absent from the resolved
// decode key (ADR 0030), so folding it into that trail would make it an
// engine-level fact. Lane SELECTION and the sticky capability verdicts live in
// ffmpegCapability.ts — this module only observes.
import { logEmit, type LogEntryInput } from "../../ipc";
import type { FfmpegLane } from "./decodeEngine";

/// Last lane each clip was seen to open on, keyed by layer AND media. Layer
/// alone would read a relink/replace as a transition (a new media's first open
/// is a first open); media alone would merge two layers that hold independent
/// sessions and can sit on different lanes.
const laneByClip = new Map<string, FfmpegLane>();

const clipKey = (layerId: string, mediaId: string): string => `${layerId}\0${mediaId}`;

/// One-line LogBus emit for the decode-lane category — its own `Other` name so
/// the console separates lane transitions from the resolution trail's
/// `decode-engine` rows. `level` is the lowercase `LogLevel` union.
function emit(level: LogEntryInput["level"], message: string): void {
  void logEmit({
    level,
    category: { kind: "Other", name: "decode-lane" },
    source: { kind: "System" },
    message,
  });
}

/// Record a successful transport open, and emit iff the lane CHANGED.
///
/// An explicit `from` (the two in-place HW→SW fallbacks) overrides the trail.
/// Load-bearing for the open-time budget throw: that hardware open THREW, so it
/// never recorded "hardware", and a trail-only comparison would read the
/// software open as the clip's first and stay silent on exactly the transition
/// worth logging.
export function noteLaneOpen(o: {
  layerId: string;
  mediaId: string;
  lane: FfmpegLane;
  from?: FfmpegLane;
  reason?: string;
}): void {
  const key = clipKey(o.layerId, o.mediaId);
  const prior = o.from ?? laneByClip.get(key);
  laneByClip.set(key, o.lane);
  if (prior === undefined || prior === o.lane) return;
  const why = o.reason ? ` (${o.reason})` : "";
  emit("info", `decode lane: layer ${o.layerId} media ${o.mediaId} ${prior} → ${o.lane}${why}`);
}

/// Test/e2e hook: forget session lane history.
export function resetFfmpegLaneTrail(): void {
  laneByClip.clear();
}
