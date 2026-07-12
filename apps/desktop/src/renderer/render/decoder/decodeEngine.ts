// The decode-engine overlay's resolution module (see docs/preview.md §Decode
// engine, ADR 0030). PURE — a function of (setting × component availability ×
// resolve inputs × read-only route); no store reads, no probes, no hidden
// state (any state added here re-grows the preset maze). Callers
// gather inputs (PixiPreview) and act on the output (Compositor ensureClip).

export type DecodeEngineSetting = "auto" | "ffmpeg" | "webcodecs";

// --- Collapsed decode model (2026-07-12). ---
export type DecodeEngine = "ffmpeg" | "webcodecs";
export type DecodeSource = "original" | "proxy";
/// PRIVATE to FfmpegSource — declared here only so the module shares one vocabulary.
/// Never surfaced in a resolver input/output.
export type FfmpegLane = "hardware" | "software";
export type WebcodecsOriginalVerdict = "ok" | "fail" | "untested";

export interface DecodeResolveInputs {
  setting: DecodeEngineSetting;
  /// FFmpeg native-decode component DLLs loaded on this machine.
  componentAvailable: boolean;
  /// User opt-in to decode the proxy instead of the original (per media). No
  /// activation path in this bite — PixiPreview passes false; the Generate-proxy
  /// follow-up wires it.
  useProxySource: boolean;
  proxyReady: boolean;
  proxyUrl: string | null;
  originalPath: string;
  originalUrl: string;
  /// Consulted ONLY on webcodecs × original. FFmpeg decodes any original.
  webcodecsCanDecodeOriginal: WebcodecsOriginalVerdict;
  /// false once the ffmpeg engine has terminally failed for this source this
  /// session — a runtime signal, gathered by the caller; the resolver stays pure.
  ffmpegUsable: boolean;
}

export interface DecodeResolution {
  engine: DecodeEngine;
  source: DecodeSource;
  /// Decode target: for `engine: "ffmpeg"` + `source: "original"` this is the
  /// original file PATH; for `engine: "webcodecs"` it is a convertFileSrc URL.
  /// The `source: "proxy"` branch always returns the proxy URL today (only
  /// webcodecs×proxy is live; ffmpeg×proxy — which would need a proxy PATH — is
  /// deferred with `useProxySource`). null = pending/unsupported.
  target: string | null;
  /// Swap identity `${engine}:${source}:${target}`; null when nothing acquirable.
  key: string | null;
  status: "ok" | "pending" | "unsupported";
  reason: string;
}

export function resolveDecodeEngine(i: DecodeResolveInputs): DecodeResolution {
  const source: DecodeSource = i.useProxySource ? "proxy" : "original";

  const done = (
    engine: DecodeEngine,
    status: DecodeResolution["status"],
    target: string | null,
    reason: string,
  ): DecodeResolution => ({
    engine, source, target, status, reason,
    key: target ? `${engine}:${source}:${target}` : null,
  });

  // source/proxy handling shared by every setting once an engine is picked.
  const forEngine = (engine: DecodeEngine): DecodeResolution => {
    if (source === "proxy") {
      return i.proxyReady
        ? done(engine, "ok", i.proxyUrl, `${engine} on proxy`)
        : done(engine, "pending", null, "proxy building");
    }
    // source === "original"
    if (engine === "ffmpeg") return done(engine, "ok", i.originalPath, "ffmpeg on original");
    // webcodecs × original
    switch (i.webcodecsCanDecodeOriginal) {
      case "ok": return done(engine, "ok", i.originalUrl, "webcodecs on original");
      case "fail": return done(engine, "unsupported", null, "webcodecs cannot decode this original");
      default: return done(engine, "pending", null, "webcodecs decodability untested");
    }
  };

  if (i.setting === "webcodecs") return forEngine("webcodecs");

  if (i.setting === "ffmpeg") {
    // A pinned Standard (ffmpeg) engine with no component loaded is genuinely
    // unusable — report it unsupported rather than optimistically "ok" (the
    // settings UI grays out Standard when the component is absent, so this is
    // only reachable via a stale/migrated persisted setting or a DLL load
    // failure). These engine-level gates return BEFORE the source/proxy
    // handling — a pinned-but-unusable engine is unsupported regardless of
    // source.
    if (!i.componentAvailable) {
      return done("ffmpeg", "unsupported", null, "Standard (ffmpeg) engine unavailable — component not loaded");
    }
    // `ffmpegUsable` is the runtime "terminally failed for this source this
    // session" signal (gathered by the caller); a pinned Standard engine that
    // has already failed for this source is unsupported, not retried.
    if (!i.ffmpegUsable) {
      return done("ffmpeg", "unsupported", null, "Standard (ffmpeg) engine failed for this source");
    }
    return forEngine("ffmpeg");
  }

  // auto: prefer ffmpeg, fall back to webcodecs when the component is absent
  // OR ffmpeg has already failed for this source this session.
  const engine: DecodeEngine = i.componentAvailable && i.ffmpegUsable ? "ffmpeg" : "webcodecs";
  return forEngine(engine);
}
