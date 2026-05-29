// Per-machine WebCodecs decode capability probe. Runs at startup, asks
// `VideoDecoder.isConfigSupported` for the codecs we'd want to DirectExport,
// and reports the result to Rust (`report_decode_caps`). H.264 is assumed
// universal and not probed.
//
// v1 is isConfigSupported-only (no trial-decode): on Windows, HEVC/AV1
// report supported exactly when the platform decoder is installed, which is
// when hardware decode works. See the Plan 2 doc for the rationale.

import { reportDecodeCaps, type DecodeCaps } from "../ipc";

/// codec string → which DecodeCaps field it proves. Codec strings are the
/// canonical WebCodecs ids at a representative profile/level/resolution.
export const PROBE_CONFIGS: ReadonlyArray<{
  key: keyof DecodeCaps;
  config: VideoDecoderConfig;
}> = [
  {
    key: "hevc",
    // HEVC Main, Level 5.1 (4K capable), 8-bit.
    config: { codec: "hev1.1.6.L153.B0", codedWidth: 3840, codedHeight: 2160 },
  },
  {
    key: "av1",
    // AV1 Main profile, level 5.1, 8-bit.
    config: { codec: "av01.0.12M.08", codedWidth: 3840, codedHeight: 2160 },
  },
  {
    key: "vp9",
    // VP9 profile 0, level 5.1, 8-bit.
    config: { codec: "vp09.00.51.08", codedWidth: 3840, codedHeight: 2160 },
  },
];

/// Pure: fold an array of (key, supported) probe results into a DecodeCaps.
/// Unit-testable without a real `VideoDecoder`.
export function summarizeProbe(
  results: ReadonlyArray<{ key: keyof DecodeCaps; supported: boolean }>,
): DecodeCaps {
  const caps: DecodeCaps = { hevc: false, av1: false, vp9: false };
  for (const r of results) caps[r.key] = r.supported;
  return caps;
}

/// Impure: run the probe and report to Rust. Best-effort — any failure
/// leaves the persisted caps untouched (Rust treats absence as
/// H.264-only). Never throws into the caller.
export async function probeAndReportDecodeCaps(): Promise<void> {
  // WebCodecs may be absent (SSR/test). Bail to a conservative report.
  if (typeof VideoDecoder === "undefined" || !VideoDecoder.isConfigSupported) {
    return;
  }
  const results: { key: keyof DecodeCaps; supported: boolean }[] = [];
  for (const { key, config } of PROBE_CONFIGS) {
    try {
      const res = await VideoDecoder.isConfigSupported(config);
      results.push({ key, supported: res.supported === true });
    } catch {
      results.push({ key, supported: false });
    }
  }
  const caps = summarizeProbe(results);
  try {
    await reportDecodeCaps(caps);
  } catch (e) {
    console.warn("reportDecodeCaps failed:", e);
  }
}
