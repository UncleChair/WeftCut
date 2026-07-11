// The decode-engine overlay's resolution module (dual-engine spec §"Decode
// engine", ADR 0030). PURE — a function of (setting × component availability ×
// lane states × read-only route); no store reads, no probes, no hidden state
// (spec Risk 4: any state added here re-grows the preset maze). Callers gather
// inputs (PixiPreview) and act on the output (Compositor ensureClip).
import type { DecodeRoute } from "../../../shared/decode-route";

export type DecodeEngineSetting = "auto" | "native" | "ffmpeg" | "webcodecs";
export type LaneState = "ok" | "fail" | "untested" | "unavailable";
export type EngineTier = "native-hw" | "webcodecs-original" | "native-sw" | "proxy";

export interface EngineInputs {
  setting: DecodeEngineSetting;
  componentAvailable: boolean;
  media: { path: string; decode_route: DecodeRoute };
  /// Session probe verdict for WebCodecs-decoding the ORIGINAL (tier 2).
  webcodecsOriginal: LaneState;
  /// Machine capability verdicts (capability cache). D2 seeds nativeSw from
  /// the persisted route and pins nativeHw "unavailable"; D3/D4 wire probes.
  nativeHw: LaneState;
  nativeSw: LaneState;
  /// Tiers knocked out this session by runtime failure (P3 sticky downgrade).
  downgraded?: ReadonlySet<EngineTier>;
  /// resolveDecode(media).previewPath — tier 4's decode target (null = building).
  proxyPreviewPath: string | null;
}

export interface ResolvedSource {
  tier: EngineTier;
  /// SourceDecoderPool strategy; undefined = WebCodecs.
  forceStrategy?: "native" | "software";
  /// Original file path for the native lanes (the pool decodes this, not url).
  sourcePath?: string;
  /// WebCodecs decode FILE PATH (original or proxy); caller convertFileSrc's it.
  url: string | null;
  /// Swap identity: `${tier}:${target}`; null when nothing is acquirable yet.
  key: string | null;
  /// Human-readable decision trail (LogBus).
  reason: string;
}

/// The per-setting tier order — the SINGLE source of truth (spec: auto =
/// 1→2→3→4; native = 1→3→2→4; webcodecs = 2→4). `resolveEngineTier` walks it,
/// and PixiPreview's preempt checks (the SW- and HW-probe kicks) index into it
/// rather than re-declaring the table, so a probe kick can never drift from the
/// resolver's actual order. Always ends in "proxy" (the guaranteed floor).
export function orderFor(setting: DecodeEngineSetting): EngineTier[] {
  return setting === "native"
    ? ["native-hw", "native-sw", "webcodecs-original", "proxy"]
    : setting === "webcodecs"
      ? ["webcodecs-original", "proxy"]
      : ["native-hw", "webcodecs-original", "native-sw", "proxy"];
}

export function resolveEngineTier(i: EngineInputs): ResolvedSource {
  const down = i.downgraded ?? new Set<EngineTier>();
  const trail: string[] = [];
  const usable = (tier: EngineTier, lane: LaneState): boolean => {
    if (down.has(tier)) { trail.push(`${tier}: downgraded`); return false; }
    if (lane !== "ok") { trail.push(`${tier}: ${lane}`); return false; }
    return true;
  };

  const nativeAllowed = i.setting !== "webcodecs";
  const componentOk = i.componentAvailable;
  if (nativeAllowed && !componentOk) trail.push("native tiers: component unavailable");

  // Tier order per setting — from the shared `orderFor` table (above).
  const order = orderFor(i.setting);

  for (const tier of order) {
    switch (tier) {
      case "native-hw":
        if (componentOk && usable("native-hw", i.nativeHw)) {
          return done("native-hw", { forceStrategy: "native", sourcePath: i.media.path, url: null });
        }
        break;
      case "webcodecs-original":
        if (usable("webcodecs-original", i.webcodecsOriginal)) {
          return done("webcodecs-original", { url: i.media.path });
        }
        break;
      case "native-sw":
        if (componentOk && usable("native-sw", i.nativeSw)) {
          return done("native-sw", { forceStrategy: "software", sourcePath: i.media.path, url: null });
        }
        break;
      case "proxy":
        return done("proxy", { url: i.proxyPreviewPath });
    }
  }
  // order always ends in "proxy" — unreachable, but keep TS satisfied.
  return done("proxy", { url: i.proxyPreviewPath });

  function done(
    tier: EngineTier,
    t: { forceStrategy?: "native" | "software"; sourcePath?: string; url: string | null },
  ): ResolvedSource {
    const target = t.sourcePath ?? t.url;
    return {
      tier,
      ...t,
      key: target ? `${tier}:${target}` : null,
      reason: trail.length ? `${tier} (skipped: ${trail.join("; ")})` : tier,
    };
  }
}

// --- Collapsed decode model (2026-07-12). Coexists with the legacy EngineTier
// resolver until Task 9 removes the old one; both are pure. ---
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
}

export interface DecodeResolution {
  engine: DecodeEngine;
  source: DecodeSource;
  /// File path (ffmpeg) or convertFileSrc URL (webcodecs); null = pending/unsupported.
  target: string | null;
  /// Swap identity `${engine}:${source}:${target}`; null when nothing acquirable.
  key: string | null;
  status: "ok" | "pending" | "unsupported";
  reason: string;
}

export function resolveDecodeEngine(i: DecodeResolveInputs): DecodeResolution {
  const engine: DecodeEngine =
    i.setting === "webcodecs" ? "webcodecs"
    : i.setting === "ffmpeg" ? "ffmpeg"
    : i.componentAvailable ? "ffmpeg" : "webcodecs"; // auto
  const source: DecodeSource = i.useProxySource ? "proxy" : "original";

  const done = (
    status: DecodeResolution["status"],
    target: string | null,
    reason: string,
  ): DecodeResolution => ({
    engine, source, target, status, reason,
    key: target ? `${engine}:${source}:${target}` : null,
  });

  if (source === "proxy") {
    return i.proxyReady
      ? done("ok", i.proxyUrl, `${engine} on proxy`)
      : done("pending", null, "proxy building");
  }
  // source === "original"
  if (engine === "ffmpeg") return done("ok", i.originalPath, "ffmpeg on original");
  // webcodecs × original
  switch (i.webcodecsCanDecodeOriginal) {
    case "ok": return done("ok", i.originalUrl, "webcodecs on original");
    case "fail": return done("unsupported", null, "webcodecs cannot decode this original");
    default: return done("pending", null, "webcodecs decodability untested");
  }
}
