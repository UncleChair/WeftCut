// Fill a decode-time color matrix for sources that carry none.
//
// Many sources are untagged (screen recordings, testsrc, older/SD clips). For
// those, mediabunny's `getDecoderConfig()` returns no `colorSpace.matrix`, and
// the WebCodecs decoder then picks an implementation-defined matrix — which can
// disagree with how ffmpeg and other players interpret the SAME bytes. The
// media-conformance harness caught exactly this: an untagged BT.601 clip that
// WeftCut's WebView2 decoder read as BT.709, shifting every color, while ffmpeg
// read it as 601. Filling an explicit, resolution-keyed default makes decode
// deterministic and aligned with the rest of the ecosystem (the same heuristic
// ffmpeg/libavcodec use): BT.709 for HD (>=720 lines), BT.601 (smpte170m) for
// SD, limited range.
//
// Three-layer priority per field (highest to lowest):
//   1. mediabunny's tag — read from the container's `colr` atom (mediabunny
//      NEVER parses the bitstream SPS VUI). The decode target's own
//      declaration, authoritative when present.
//   2. An explicit `sourceColor` from ffprobe (which DOES read the VUI),
//      supplied by `ffprobeColorSpace()` — for original and proxy decodes
//      alike (a proxy preserves the source's colorimetry). Beats the
//      resolution default, loses to the target's own colr tag.
//   3. The resolution-keyed default (HD→bt709, SD→smpte170m, limited range).
// Only the fields each layer omits fall through to the next, so a partial tag
// keeps what it has and only fills what is missing. NOTE: the WebCodecs
// decoder follows this config over the bitstream VUI (verified in WebView2),
// so getting these layers right is load-bearing, not cosmetic — see ADR 0014.

/// Return `config` with `colorSpace` fields filled from `sourceColor` (ffprobe)
/// and/or the resolution-keyed default, in that priority order. mediabunny's
/// own tag wins over both; the ffprobe `sourceColor` wins over the resolution
/// default; untagged sources fall back to the resolution default.
export function withDefaultColorSpace(
  config: VideoDecoderConfig,
  sourceColor?: VideoColorSpaceInit,
): VideoDecoderConfig {
  const cs = config.colorSpace;
  const hd = (config.codedHeight ?? 0) >= 720;
  // Per field: mediabunny's tag wins, then the source's ffprobe tag, then the
  // resolution default. (mediabunny only provides what the container colr atom
  // declares; ffprobe adds the bitstream VUI tags that colr-less files carry.)
  const matrix = cs?.matrix ?? sourceColor?.matrix ?? (hd ? "bt709" : "smpte170m");
  const primaries = cs?.primaries ?? sourceColor?.primaries ?? (hd ? "bt709" : "smpte170m");
  const transfer = cs?.transfer ?? sourceColor?.transfer ?? (hd ? "bt709" : "smpte170m");
  const fullRange = cs?.fullRange ?? sourceColor?.fullRange ?? false;
  return { ...config, colorSpace: { primaries, transfer, matrix, fullRange } };
}
