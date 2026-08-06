// Export-side decode-engine resolution (the export mirror of
// decoder/decodeEngine.ts; ADR 0033 + docs/render.md §Export source
// resolution). PURE — a function of (setting × component availability ×
// composite bit depth × per-media decode route); no store reads, no probes.
// Resolution runs ONCE, at export start, on the renderer main thread
// (useExportFlow), BEFORE the readiness gate — native-routed media never enter
// the probe / full-proxy machinery. The table then rides the init protocol
// into the export Worker and nothing re-resolves mid-run.
import type { MediaSummary } from "../ipc";
import type { RendererOS } from "../platform";
import { resolveDecode } from "./decodeRoute";
import type { ExportDecodeEngine } from "./exportSettings";

/// May the 8-bit WebCodecs EXPORT decode lane configure prefer-hardware on
/// this OS? The lane otherwise pins prefer-software as the black-frame
/// workaround: on Linux/NVIDIA a HARDWARE-decoded VideoFrame is an opaque GPU
/// handle NO JS import path can read (drawImage / createImageBitmap /
/// texImage2D / copyTo all return zeros — importProbe.ts), with no decoder
/// error to trip the HW→SW fallback, so every exported frame goes silently
/// black. Windows is hardware-verified faithful (Chromium's ANGLE→D3D11
/// backend composites GPU-backed frames correctly); macOS likewise (Apple
/// Silicon: HW frames arrive NV12, every JS import path reads real pixels —
/// issue #7 §5). Explicit ALLOWLIST, not a blocklist —
/// unknown platforms take the safe software path. Resolved once on the
/// renderer main thread at export start (the Worker has no OS signal) and
/// rides the init protocol as `allowHwExportDecode`. The 10-bit lane's own
/// preferSoftware pin is a separate correctness requirement (Hi10P has no HW
/// path; AV1-10 HW emits opaque format=null frames) and ignores this verdict.
export function hwExportDecodeAllowed(os: RendererOS): boolean {
  return os === "windows" || os === "mac";
}

/// CPU transport format for native-decoded frames crossing the relay. Follows
/// the export's COMPOSITE bit depth (one export composites at one depth), not
/// any per-source depth.
export type ExportTransportFormat = "NV12" | "I420P10";

export type ExportMediaRoute =
  | { engine: "webcodecs" }
  | { engine: "native"; sourcePath: string };

export interface ExportDecodeRouting {
  /// The setting after the capability defense: an `ffmpeg` pin degrades to
  /// `auto` when the native path is unusable on this export —
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
  // gate (which runs after this resolve) and exports via proxy.
  return m.decode_route.route === "native-sw"
    ? { engine: "native", sourcePath: m.path }
    : { engine: "webcodecs" };
}

export interface RoutingSourceCounts {
  originals: number;
  proxy: number;
}

/// The export dialog's honesty line: how many video sources
/// this table sends off their originals vs their lossy full proxy. Derived
/// from the resolved table the run freezes, so dialog and export can't
/// disagree. Proxy-fed = not native-routed AND the persisted export path is
/// not the original (`resolveDecode` — the one route→path authority). The
/// readiness gate's runtime probe can still route-correct a direct-export
/// source to proxied AFTER resolution; the resolver shares that blind spot by
/// design (persisted verdicts only), so the counts stay honest to the table.
export function routingSourceCounts(
  media: readonly ExportRoutingMedia[],
  routing: ExportDecodeRouting,
): RoutingSourceCounts {
  const counts: RoutingSourceCounts = { originals: 0, proxy: 0 };
  for (const m of media) {
    if (m.kind !== "Video") continue;
    const proxyFed =
      routing.routes[m.id]?.engine !== "native" &&
      resolveDecode(m).exportPath !== m.path;
    counts[proxyFed ? "proxy" : "originals"] += 1;
  }
  return counts;
}

/// The readiness gate's scope: media the WEBCODECS path will decode — the
/// decodability probe and full-proxy wait apply to these only. Native-routed
/// media are excluded because the session opens the ORIGINAL directly — they
/// skip the pre-export full-proxy wait entirely.
export function proxyWaitScope(
  media: readonly MediaSummary[],
  routing: ExportDecodeRouting,
): MediaSummary[] {
  return media.filter((m) => routing.routes[m.id]?.engine !== "native");
}
