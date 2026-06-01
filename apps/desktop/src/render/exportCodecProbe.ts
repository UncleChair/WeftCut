// Runtime encoder feasibility. WebView2's VideoEncoder.isConfigSupported is
// optimistic (it can report `supported: true` for codecs that then fail or
// stall at real encode — same hazard documented for decode in
// reference_webcodecs_hi10p). So the dropdown is populated by
// isConfigSupported, but selecting AV1/HEVC runs a one-frame real-encode
// smoke, and a thrown error during the actual export falls back to H.264.

import { type CodecId, codecString } from "./exportSettings";

/// Fast feasibility check used to populate the codec dropdown. H.264 is the
/// guaranteed baseline. AV1/HEVC delegate to isConfigSupported.
export async function probeEncoderSupported(
  codec: CodecId,
  width: number,
  height: number,
  fps: number,
): Promise<boolean> {
  if (codec === "h264") return true;
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder })
    .VideoEncoder;
  if (!VE || typeof VE.isConfigSupported !== "function") return false;
  try {
    const res = await VE.isConfigSupported({
      codec: codecString(codec),
      width,
      height,
      bitrate: 2_000_000,
      framerate: fps,
    });
    return !!res.supported;
  } catch {
    return false;
  }
}

/// One-frame real-encode smoke. Configures a VideoEncoder, encodes a single
/// blank frame, and resolves true iff an encoded chunk arrives before the
/// deadline or an error. Mirrors raceFirstDecode (probeSourceDecodable.ts).
/// Catches WebView2's "isConfigSupported lied" case for AV1/HEVC.
export async function smokeEncode(
  codec: CodecId,
  width: number,
  height: number,
  fps: number,
  deadlineMs = 4000,
): Promise<boolean> {
  if (codec === "h264") return true;
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder })
    .VideoEncoder;
  if (!VE) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let encoder: VideoEncoder | null = null;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        encoder?.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), deadlineMs);
    try {
      encoder = new VE({
        output: () => finish(true),
        error: () => finish(false),
      });
      encoder.configure({
        codec: codecString(codec),
        width,
        height,
        bitrate: 2_000_000,
        framerate: fps,
        // No hardwareAcceleration hint. WebView2/Edge treats "prefer-hardware"
        // as MANDATORY (a documented Chromium-on-Windows quirk) and rejects
        // codecs with no HW encoder — e.g. AV1, which then fails here even
        // though the libaom SOFTWARE encoder works. Letting the browser pick
        // exercises the same path the real export uses (see buildConfig).
      });
      // A blank frame at full size keeps the smoke representative without a
      // real composite; the export re-probes nothing, it just encodes.
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        finish(false);
        return;
      }
      const frame = new VideoFrame(canvas, { timestamp: 0 });
      encoder.encode(frame, { keyFrame: true });
      frame.close();
      void encoder.flush().catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

export type EncodePath = "webcodecs" | "ffmpeg";

/// Decide the export path for a codec: if a one-frame WebCodecs encode
/// succeeds (hardware or software — no hw hint is forced), the browser
/// encodes it directly; otherwise ffmpeg transcodes a mezzanine. H.264 is
/// always WebCodecs (smokeEncode short-circuits true).
export async function resolveEncodePath(
  codec: CodecId,
  width: number,
  height: number,
  fps: number,
): Promise<EncodePath> {
  const ok = await smokeEncode(codec, width, height, fps);
  return ok ? "webcodecs" : "ffmpeg";
}
