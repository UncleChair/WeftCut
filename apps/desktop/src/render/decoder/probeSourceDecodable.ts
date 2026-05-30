// Lazy decodability probe (Piece B). Confirms THIS machine's WebCodecs can
// decode a source by actually configuring a decoder and decoding one key
// packet, racing the outcome against the decoder's error callback AND a
// deadline — because an unsupported codec does not always fire a clean error
// (WebCodecs can silently stall: no output, no error). See
// docs/superpowers/specs/2026-05-30-import-oracle-removal-design.md.

import { openMediaInput, type OpenedMedia } from "./mediaInput";

type DecoderLike = Pick<VideoDecoder, "configure" | "decode" | "close">;

export interface RaceFirstDecodeArgs {
  config: VideoDecoderConfig;
  keyChunk: EncodedVideoChunk | null;
  makeDecoder: (handlers: {
    output: (frame: VideoFrame) => void;
    error: (e: unknown) => void;
  }) => DecoderLike;
  deadlineMs: number;
}

/// Resolves true iff a frame is produced before the decoder errors or the
/// deadline elapses. A synchronous `configure` throw, a `null` keyChunk, an
/// `error` callback, or the timeout all resolve false. Pure of mediabunny —
/// the testable core.
export async function raceFirstDecode(args: RaceFirstDecodeArgs): Promise<boolean> {
  if (!args.keyChunk) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let decoder: DecoderLike | null = null;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        decoder?.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), args.deadlineMs);
    try {
      decoder = args.makeDecoder({
        output: (frame) => {
          frame.close();
          finish(true);
        },
        error: () => finish(false),
      });
      decoder.configure(args.config);
      decoder.decode(args.keyChunk);
    } catch {
      finish(false);
    }
  });
}

/// Open `assetUrl` via mediabunny, read its decoder config + first key packet,
/// and race a real decode. Returns false on any open/config/decode failure.
export async function probeSourceDecodable(
  assetUrl: string,
  deadlineMs = 2500,
): Promise<boolean> {
  let opened: OpenedMedia | null = null;
  try {
    opened = await openMediaInput(assetUrl);
    const config = await opened.videoTrack.getDecoderConfig();
    if (!config) return false;
    const keyPacket = await opened.packetSink.getKeyPacket(0);
    const keyChunk = keyPacket ? keyPacket.toEncodedVideoChunk() : null;
    return await raceFirstDecode({
      config,
      keyChunk,
      makeDecoder: (handlers) => new VideoDecoder(handlers),
      deadlineMs,
    });
  } catch {
    return false;
  } finally {
    opened?.dispose();
  }
}
