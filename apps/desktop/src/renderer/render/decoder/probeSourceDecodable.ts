// Lazy decodability probe. Confirms THIS machine's WebCodecs can
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

/// Three-valued WebCodecs decodability verdict for an ORIGINAL. "ok" = a frame
/// decoded this session. "unsupported" = a DEFINITIVE codec/config-unsupported
/// verdict (no WebCodecs codec mapping for the track, or `isConfigSupported`
/// declines BOTH the hardware and software config) — the codec itself is
/// undecodable, so the caller may sticky-mark it (`markWebcodecsUnusable`).
/// "unknown" = a NON-definitive failure (open/read error, silent-stall
/// deadline, or a config the browser CLAIMS to support that still produced no
/// frame) — never markable, so a transient stall / buffer-pool contention can't
/// wrongly condemn a decodable source.
export type WebcodecsDecodeVerdict = "ok" | "unsupported" | "unknown";

/// Open `assetUrl` via mediabunny, read its decoder config + first key packet,
/// and race a real decode, distinguishing a DEFINITIVE unsupported-codec
/// verdict from a transient/unknown failure. See `WebcodecsDecodeVerdict`.
export async function classifyWebcodecsDecodability(
  assetUrl: string,
  deadlineMs = 2500,
): Promise<WebcodecsDecodeVerdict> {
  let opened: OpenedMedia | null = null;
  try {
    opened = await openMediaInput(assetUrl);
    const config = await opened.videoTrack.getDecoderConfig();
    // No WebCodecs codec mapping for this track — WebCodecs fundamentally has no
    // decoder for this codec (e.g. ProRes). DEFINITIVE, never a transient stall.
    if (!config) return "unsupported";
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
    const attempt = (cfg: VideoDecoderConfig): Promise<boolean> =>
      raceFirstDecode({
        config: cfg,
        keyChunk,
        makeDecoder: (handlers) => new VideoDecoder(handlers),
        deadlineMs,
      });
    // First try mediabunny's native config (no `hardwareAcceleration` →
    // Chromium's default, usually hardware). If that fails, retry forcing
    // software before judging the source undecodable: on some machines a codec's
    // HARDWARE decode errors outright while software decodes fine (observed:
    // 8-bit AV1 on an Intel iGPU + NVIDIA stack — the hardware decoder fires
    // "Decoding error" and produces no frame; `prefer-software` decodes cleanly).
    // The real preview/export lanes already recover from exactly this — the
    // source pool downgrades prefer-hardware→prefer-software on a decode error
    // (SourceDecoderPool), and the export lane forces software. Matching that
    // here keeps the probe's verdict aligned with what the pipeline can actually
    // decode, instead of route-correcting a WebCodecs-decodable source to a proxy.
    if (await attempt(config)) return "ok";
    const swConfig: VideoDecoderConfig = { ...config, hardwareAcceleration: "prefer-software" };
    if (await attempt(swConfig)) return "ok";
    // Neither lane produced a frame. Only condemn the codec when the browser
    // ITSELF declines BOTH configs (`isConfigSupported.supported === false`) —
    // that is a DEFINITIVE unsupported-codec verdict. A config the browser
    // claims to support that still yielded no frame is a transient stall
    // (deadline, buffer-pool contention); leave it "unknown" so it's re-probed
    // rather than stickied. A rejected/absent `isConfigSupported` is treated as
    // non-definitive too.
    const [hw, sw] = await Promise.all([
      VideoDecoder.isConfigSupported(config).catch(() => null),
      VideoDecoder.isConfigSupported(swConfig).catch(() => null),
    ]);
    if (hw?.supported === false && sw?.supported === false) return "unsupported";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    opened?.dispose();
  }
}

/// Boolean convenience over `classifyWebcodecsDecodability`: true iff a frame
/// decoded ("ok"). Both "unsupported" and "unknown" collapse to false, so the
/// export-readiness gate + import sweep keep their existing decodable/not
/// contract; the sweep additionally reads the three-valued verdict directly to
/// drive the sticky `markWebcodecsUnusable` marker.
export async function probeSourceDecodable(
  assetUrl: string,
  deadlineMs = 2500,
): Promise<boolean> {
  return (await classifyWebcodecsDecodability(assetUrl, deadlineMs)) === "ok";
}
