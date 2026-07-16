// Export-side decode-engine resolution (the export mirror of
// decoder/decodeEngine.ts; spec 2026-07-16-export-decode-engine-design.md,
// decisions 2/3/8). PURE — a function of (setting × component availability ×
// composite bit depth × per-media decode route); no store reads, no probes.
// Resolution runs ONCE, at export start, on the renderer main thread
// (useExportFlow), BEFORE the readiness gate — native-routed media never enter
// the probe / full-proxy machinery. The table then rides the init protocol
// into the export Worker and nothing re-resolves mid-run.
import type { MediaSummary } from "../ipc";
import type { ExportDecodeEngine } from "./exportSettings";

/// CPU transport format for native-decoded frames crossing the relay. Follows
/// the export's COMPOSITE bit depth (one export composites at one depth), not
/// any per-source depth.
export type ExportTransportFormat = "NV12" | "I420P10";

export type ExportMediaRoute =
  | { engine: "webcodecs" }
  | { engine: "native"; sourcePath: string };

export interface ExportDecodeRouting {
  /// The setting after the capability defense: an `ffmpeg` pin degrades to
  /// `auto` (decision 3) when the native path is unusable on this export —
  /// the component isn't loaded. Merge-time validation can't do this — intent
  /// persists, capability re-resolves per machine (ADR 0030).
  effectiveSetting: ExportDecodeEngine;
  /// Transport format implied by the composite bit depth, table-wide.
  outFormat: ExportTransportFormat;
  /// media_id → route, VIDEO media only. A missing id means the WebCodecs
  /// path (consumers treat absence as `{ engine: "webcodecs" }`).
  routes: Record<string, ExportMediaRoute>;
}

export type ExportRoutingMedia = Pick<
  MediaSummary,
  "id" | "kind" | "path" | "decode_route"
>;

export interface ExportRoutingInputs {
  setting: ExportDecodeEngine;
  /// FFmpeg native-decode component DLLs loaded on this machine.
  componentAvailable: boolean;
  /// `compositeBitDepth(settings)` — the depth frames are composited at.
  bitDepth: 8 | 10;
  media: readonly ExportRoutingMedia[];
}

export function resolveExportDecodeRouting(
  i: ExportRoutingInputs,
): ExportDecodeRouting {
  const outFormat: ExportTransportFormat =
    i.bitDepth === 10 ? "I420P10" : "NV12";
  const nativeUsable = i.componentAvailable;
  const effectiveSetting: ExportDecodeEngine =
    i.setting === "ffmpeg" && !nativeUsable ? "auto" : i.setting;
  const routes: Record<string, ExportMediaRoute> = {};
  for (const m of i.media) {
    if (m.kind !== "Video") continue;
    routes[m.id] = routeFor(m, effectiveSetting, nativeUsable);
  }
  return { effectiveSetting, outFormat, routes };
}

function routeFor(
  m: ExportRoutingMedia,
  setting: ExportDecodeEngine,
  nativeUsable: boolean,
): ExportMediaRoute {
  // `webcodecs` pin = today's behavior exactly: decodable originals decode
  // in-worker, blind spots via their full proxy (the readiness gate's
  // probe/wait machinery applies unchanged).
  if (setting === "webcodecs") return { engine: "webcodecs" };
  if (!nativeUsable || !m.path) return { engine: "webcodecs" };
  // `ffmpeg` pin: EVERY source decodes native on its original, including
  // routes WebCodecs could take. A source ffmpeg cannot open fails the export
  // at session open — the pin is an explicit fidelity promise, not a
  // preference with fallbacks.
  if (setting === "ffmpeg") {
    return { engine: "native", sourcePath: m.path };
  }
  // auto: decodable sources keep the zero-transport in-worker WebCodecs path;
  // WebCodecs-blind sources decode native on the original — no full-proxy
  // wait; sources neither engine opens ("proxied") fall back to their full
  // proxy. "Blind-spot" here is the PERSISTED import-time verdict
  // ("native-sw"), not the gate's runtime probe: a source that fails its
  // probe on this machine is route-corrected to "proxied" by the readiness
  // gate (which runs after this resolve) and exports via proxy, exactly as
  // before this resolver existed. Feeding runtime probe verdicts in — so
  // machine-local blind spots could also go native — is a possible follow-up,
  // not a v1 promise.
  return m.decode_route.route === "native-sw"
    ? { engine: "native", sourcePath: m.path }
    : { engine: "webcodecs" };
}

/// The readiness gate's scope: media the WEBCODECS path will decode — the
/// decodability probe and full-proxy wait apply to these only. Native-routed
/// media are excluded because the session opens the ORIGINAL directly
/// (decision 8: they skip the pre-export full-proxy wait entirely).
export function proxyWaitScope(
  media: readonly MediaSummary[],
  routing: ExportDecodeRouting,
): MediaSummary[] {
  return media.filter((m) => routing.routes[m.id]?.engine !== "native");
}
