// Per-clip "will this need optimizing before export?" classification + the
// codec-named reason shown on the media-pool badge tooltip. Pure;
// `useImportReadiness` runs it over the whole pool and MediaPool renders the
// result.
//
// See docs/data-model.md#mediaitem.

import type { MediaSummary } from "../ipc";
import { resolveDecode } from "../render/decodeRoute";
import type { ProbeState, ProxyJobState } from "../render/exportReadiness";

export type OptimizeStatus =
  | "ready" // export proxy already on disk
  | "direct" // exports without a proxy (H.264 bypass); not shown
  | "checking" // probe in flight, or routing not yet decided
  | "bridged" // decodable here → previewable NOW; a proxy builds in the background
  | "transcoding" // NOT decodable here → blank until the proxy lands
  | "failed"; // the proxy job failed

export interface OptimizeDeps {
  /// Session decodability memo (App `decodeProbeMemo`).
  memo: ReadonlyMap<string, ProbeState>;
  /// Session proxy-job state (App `proxyState`).
  proxyStateOf: (id: string) => ProxyJobState | undefined;
  /// Ids the import sweep route-corrected because this machine can't decode them.
  routeCorrected: ReadonlySet<string>;
}

export function importOptimizeStatus(m: MediaSummary, deps: OptimizeDeps): OptimizeStatus {
  if (m.kind !== "Video") return "direct";
  const { route, exportPath } = resolveDecode(m);
  // Bypass: the H.264 original decodes everywhere — nothing to optimize.
  if (route === "bypass") return "direct";
  // Full export master on disk: optimization is complete. `native-sw` resolves
  // identically to `proxied` (see resolveDecode) and must settle the same way —
  // omitting it strands ProRes/10-bit sources on the terminal `checking` fall-
  // through below, where no later branch can ever release them.
  if ((route === "proxied" || route === "native-sw") && exportPath) return "ready";
  // DirectExport whose preview (quick) proxy has landed: optimization is
  // complete (export reads the original, preview reads the quick proxy), so
  // settle to silent — otherwise a decodable DirectExport source would be
  // terminally "bridged" and keep the import dialog open forever. The FULL
  // export master (Proxied) still waits for `exportPath` (handled above), so it
  // correctly stays "bridged" until its master lands.
  if (route === "direct-export" && resolveDecode(m).previewPath) return "direct";
  const decodable = deps.memo.get(m.id) === "ok";
  const ps = deps.proxyStateOf(m.id);
  if (ps === "failed") return "failed";
  // This machine decoded it → the bridge previews the original now; whatever
  // proxy is building is a background scroll/export upgrade.
  if (decodable) return "bridged";
  // DirectExport whose probe hasn't resolved yet.
  if (route === "direct-export") return "checking";
  // Confirmed undecodable here (or route-corrected); blank until the proxy.
  if (ps === "pending") return "transcoding";
  return "checking"; // pre-decision window — resolves shortly
}

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  avc1: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  hvc1: "HEVC",
  av1: "AV1",
  av01: "AV1",
  vp9: "VP9",
  vp09: "VP9",
  vp8: "VP8",
  prores: "ProRes",
  mpeg2video: "MPEG-2",
  dnxhd: "DNxHD",
};

export function codecDisplayName(codec: string | null): string {
  if (!codec) return "未知";
  const key = codec.toLowerCase();
  return CODEC_NAMES[key] ?? codec.toUpperCase();
}

export function is10bit(pixFmt: string | null): boolean {
  return pixFmt != null && /1[02]/.test(pixFmt);
}

export interface OptimizeReason {
  key: "reason_bridged" | "reason_undecodable" | "reason_transcode" | "reason_10bit";
  codec: string;
}

/// Why this clip appears, given its classification. A bridged clip is already
/// previewable; everything else is waiting on a proxy.
export function optimizeReason(m: MediaSummary, deps: OptimizeDeps): OptimizeReason {
  const codec = codecDisplayName(m.codec);
  if (deps.memo.get(m.id) === "ok") return { key: "reason_bridged", codec };
  if (deps.routeCorrected.has(m.id)) return { key: "reason_undecodable", codec };
  if (is10bit(m.pix_fmt)) return { key: "reason_10bit", codec };
  return { key: "reason_transcode", codec };
}

/// One pool entry's optimization verdict. `useImportReadiness` builds a
/// `Map<mediaId, OptimizeInfo>` over the whole pool; MediaPool looks each card
/// up to decide whether to show the background-optimizing dot and what reason
/// to put in the badge tooltip.
export interface OptimizeInfo {
  status: OptimizeStatus;
  reason: OptimizeReason;
}

/// Is background optimization work still running for this clip? True for every
/// unsettled state, so the pool's corner dot covers the probe window too.
/// `failed` is settled — it gets the failure badge instead.
///
/// LANDMINE: the dot this gates is only rendered for cards `mediaReadiness`
/// calls ready. That is what keeps it from ever stacking on top of the centred
/// blocking badges — an unusable clip shows "Preparing…", a usable-but-busy one
/// shows the dot, never both.
export function isOptimizing(status: OptimizeStatus): boolean {
  return status === "bridged" || status === "transcoding" || status === "checking";
}
