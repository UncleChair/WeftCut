// Fill a decode-time color matrix for sources that carry none.
//
// Many sources are untagged (screen recordings, testsrc, older/SD clips). For
// those, mediabunny's `getDecoderConfig()` returns no `colorSpace.matrix`, and
// the WebCodecs decoder then picks an implementation-defined matrix — which can
// disagree with how ffmpeg and other players interpret the SAME bytes. The
// media-conformance harness caught exactly this: an untagged BT.601 clip that
// WeftCut's Chromium/Electron decoder read as BT.709, shifting every color, while ffmpeg
// read it as 601. Filling an explicit, resolution-keyed default makes decode
// deterministic and aligned with the rest of the ecosystem (the same heuristic
// ffmpeg/libavcodec use). Layer priority: `withDefaultColorSpace`. ADR 0014.

/// Return `config` with `colorSpace` fields filled per-field by a three-layer
/// priority (highest first):
///   1. mediabunny's tag — read from the container's `colr` atom (mediabunny
///      NEVER parses the bitstream SPS VUI). The decode target's own
///      declaration, authoritative when present.
///   2. An explicit `sourceColor` from ffprobe (which DOES read the VUI),
///      supplied by `ffprobeColorSpace()` — for original and proxy decodes
///      alike (a proxy preserves the source's colorimetry).
///   3. The resolution-keyed default: HD (>= 720 lines) → bt709, SD →
///      smpte170m, limited range.
/// Only the fields a layer omits fall through to the next, so a partial tag
/// keeps what it has and only fills what's missing. The WebCodecs decoder
/// follows this config over the bitstream VUI (verified in Chromium/Electron),
/// so these layers are load-bearing, not cosmetic.
export function withDefaultColorSpace(
  config: VideoDecoderConfig,
  sourceColor?: VideoColorSpaceInit,
): VideoDecoderConfig {
  const cs = config.colorSpace;
  const hd = (config.codedHeight ?? 0) >= 720;
  const matrix = cs?.matrix ?? sourceColor?.matrix ?? (hd ? "bt709" : "smpte170m");
  const primaries = cs?.primaries ?? sourceColor?.primaries ?? (hd ? "bt709" : "smpte170m");
  const transfer = cs?.transfer ?? sourceColor?.transfer ?? (hd ? "bt709" : "smpte170m");
  const fullRange = cs?.fullRange ?? sourceColor?.fullRange ?? false;
  return { ...config, colorSpace: { primaries, transfer, matrix, fullRange } };
}
