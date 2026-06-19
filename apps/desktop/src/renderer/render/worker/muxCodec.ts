// Maps a WebCodecs codec string (the `codec` field of a VideoEncoderConfig,
// e.g. "avc1.640028") to the bare mediabunny VideoCodec ("avc") that
// `EncodedVideoPacketSource` is constructed with. The export encoder emits
// H.264 today; the others are mapped for completeness + a clear throw on
// anything we don't support, rather than a confusing failure deep in the mux.

import type { VideoCodec } from "mediabunny";

export function webCodecsToMediabunnyVideoCodec(codec: string): VideoCodec {
  const c = codec.toLowerCase();
  if (c.startsWith("avc1") || c.startsWith("avc3")) return "avc";
  if (c.startsWith("hev1") || c.startsWith("hvc1")) return "hevc";
  if (c.startsWith("av01")) return "av1";
  if (c.startsWith("vp09") || c === "vp9") return "vp9";
  if (c.startsWith("vp08") || c === "vp8") return "vp8";
  throw new Error(`muxCodec: unsupported video codec "${codec}"`);
}
