// WebCodecs-engine capability machinery: the sticky per-media
// "WebCodecs-confirmed-unusable" marker. SESSION state — resets on reload; the
// persisted machine truth is main's capability cache, never this set. Sibling
// of ffmpegCapability.ts (the ffmpeg-engine markers + lane selection), kept
// separate so each engine owns its own capability vocabulary rather than
// crowding the ffmpeg module with a webcodecs concern.

/// Sticky per-media "WebCodecs cannot decode this original this session"
/// marker. Set ONLY on a DEFINITIVE codec/config-unsupported verdict from the
/// import-time decodability sweep (`classifyWebcodecsDecodability` →
/// "unsupported": no WebCodecs codec mapping for the track, or
/// `isConfigSupported` declines BOTH the hardware and software config) — NEVER
/// on a transient stall/deadline, so a genuinely decodable source is never
/// wrongly condemned. Consumed by `PixiPreview.resolveSource`, which owns what
/// the mark means for source resolution. Mirrors ffmpegCapability's
/// `markFfmpegUnusable`/`isFfmpegUnusable`.
const webcodecsUnusable = new Set<string>();

export function markWebcodecsUnusable(mediaId: string, _reason: string): void {
  webcodecsUnusable.add(mediaId);
}

export function isWebcodecsUnusable(mediaId: string): boolean {
  return webcodecsUnusable.has(mediaId);
}

/// Test/e2e hook: forget session verdicts (used by webcodecsCapability.test.ts).
export function resetWebcodecsCapabilitySession(): void {
  webcodecsUnusable.clear();
}
