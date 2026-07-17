// Session-scoped decode-resolution logging: once-per-change LogBus emits for
// the resolved decode key (see `noteResolution`). SESSION state — resets on
// reload; the persisted machine truth is main's capability cache, never this
// map. Distinct from the (retiring) "session bridge" term — see CONTEXT.md.
//
// HW/SW lane session state, the seek-validated codec allow-list, and the
// sticky per-media runtime-failure markers live in ffmpegCapability.ts —
// `FfmpegSource` owns lane selection there, and the Compositor calls
// `markFfmpegUnusable` directly on a total ffmpeg-engine failure.
import { logEmit, type LogEntryInput } from "../../ipc";

const lastLoggedKey = new Map<string, string>();

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

/// LogBus trail: one entry per (media, resolved key) change — "every step
/// logged" without per-frame spam. Falls back to `reason` (not a key) for the
/// dedupe key when nothing is acquirable yet, since "pending"/"unsupported"
/// carry no key in the collapsed `DecodeResolution` model.
export function noteResolution(mediaId: string, r: { key: string | null; reason: string }): void {
  const k = r.key ?? r.reason;
  if (lastLoggedKey.get(mediaId) === k) return;
  lastLoggedKey.set(mediaId, k);
  emit("info", `decode resolution: media ${mediaId} → ${r.reason}`);
}

/// Test/e2e hook: forget session verdicts.
export function resetDecodeCapabilitySession(): void {
  lastLoggedKey.clear();
}
