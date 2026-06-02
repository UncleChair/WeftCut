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
// Tagged sources are left untouched — an explicit matrix always wins. Only the
// fields the source omits are filled, so a partial tag (e.g. primaries present,
// matrix absent) keeps what it has.

/// Return `config` with a default `colorSpace.matrix` (and the primaries /
/// transfer / range fields it omits) filled in when the source provides no
/// matrix. A source that already declares a matrix is returned unchanged.
export function withDefaultColorSpace(
  config: VideoDecoderConfig,
): VideoDecoderConfig {
  const cs = config.colorSpace;
  // An explicit matrix is authoritative — respect the source's tag.
  if (cs && cs.matrix != null) return config;

  const hd = (config.codedHeight ?? 0) >= 720;
  const filled: VideoColorSpaceInit = {
    primaries: cs?.primaries ?? (hd ? "bt709" : "smpte170m"),
    transfer: cs?.transfer ?? (hd ? "bt709" : "smpte170m"),
    matrix: hd ? "bt709" : "smpte170m",
    fullRange: cs?.fullRange ?? false,
  };
  return { ...config, colorSpace: filled };
}
