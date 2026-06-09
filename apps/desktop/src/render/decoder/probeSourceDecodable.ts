// Lazy decodability probe (Piece B). Confirms THIS machine's WebCodecs can
// decode a source by actually configuring a decoder and decoding one key
// packet, racing the outcome against the decoder's error callback AND a
// deadline — because an unsupported codec does not always fire a clean error
// (WebCodecs can silently stall: no output, no error). See
// docs/render.md#export-source-resolution and docs/data-model.md#mediaitem.

import { openMediaInput, type OpenedMedia } from "./mediaInput";

type DecoderLike = Pick<VideoDecoder, "configure" | "decode" | "close" | "flush">;

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
  // Capture into a const so the non-null narrowing survives into the Promise
  // executor below — TS resets property-access narrowing (`args.keyChunk`)
  // across the closure boundary, but a const local holds.
  const keyChunk = args.keyChunk;
  if (!keyChunk) return false;
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
      decoder.decode(keyChunk);
      // Drain the reorder buffer. A lone keyframe from a B-frame stream (almost
      // every real-world H.264 — phones, OBS, x264 defaults) stays parked in
      // the decoder's reorder buffer: with no following packet to bump it out
      // and no flush, the output callback never fires, so the race below loses
      // to the deadline and falsely judges a decodable source undecodable.
      // Floated, never awaited — output()/error()/the deadline still settle the
      // race, and a flush rejection is irrelevant. Mirrors the export decoder's
      // own end-of-stream drain (ExportDecoderPool.issueEosFlush).
      try {
        void Promise.resolve(decoder.flush()).catch(() => {});
      } catch {
        // flush() threw synchronously (bad decoder state); the race still
        // settles via the error callback or the deadline.
      }
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
    // First key packet. `getKeyPacket(0)` looks for the keyframe at-or-before
    // t=0s, which is NULL when the first keyframe has a non-zero start timestamp
    // (trimmed clips, edit-list mp4s) — that would wrongly judge an otherwise
    // decodable source undecodable. Fall back to `getFirstPacket()` (the track's
    // first packet — always a keyframe for video). Mirrors the decoder pool's
    // own getKeyPacket→getFirstPacket fallback.
    let keyPacket = await opened.packetSink.getKeyPacket(0);
    if (!keyPacket) {
      keyPacket = await opened.packetSink.getFirstPacket();
    }
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
