// Container-PTS ↔ normalized source-content-time conversions.
//
// The edit model (`src_in_us` / `src_out_us`, durations, trims) speaks
// NORMALIZED source-content time, where 0 is the first visible sample of the
// source. The demuxer (mediabunny packets) and WebCodecs frames speak CONTAINER
// PTS, which for edit-list / trimmed / encoder-priming sources begins at a
// positive value. `startPtsUs` is the container PTS that maps to content-time 0.
//
// Preview (PacketPump / SourceDecoderPool) and export (ExportSourceHandle) MUST
// apply the identical transform — otherwise a frame lands at a different
// timeline position in the two paths, a WYSIWYG break. Single-sourced here so
// the two decoder pools cannot drift (this codebase has a history of
// copy-pasted "twin" math silently diverging; see feedback_snap_math_drift).

/** Normalized source-content time (µs) → container PTS (µs). Used when seeking. */
export function sourceToContainerUs(sourceUs: number, startPtsUs: number): number {
  return sourceUs + startPtsUs;
}

/**
 * mediabunny packet timestamp (SECONDS, as `EncodedPacket.timestamp` reports)
 * → normalized source-content time (µs).
 */
export function packetToSourceUs(packetTimestampSeconds: number, startPtsUs: number): number {
  return Math.round(packetTimestampSeconds * 1e6) - startPtsUs;
}

/**
 * WebCodecs `VideoFrame` / `TenBitFrame` timestamp (already µs) → normalized
 * source-content time (µs). Used when storing a decoded frame in the ring.
 */
export function frameToSourceUs(frameTimestampUs: number, startPtsUs: number): number {
  return frameTimestampUs - startPtsUs;
}
