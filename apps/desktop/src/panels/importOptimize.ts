// Per-clip "will this need optimizing before export?" classification + the
// codec-named reason shown in the import notification dialog. Pure; the dialog
// (ImportProxyDialog) is presentational and App does the classification.
//
// See docs/superpowers/specs/2026-06-01-import-proxy-notification-design.md

import type { MediaSummary } from "../ipc";
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
  if (m.proxy_path) return "ready";
  if (m.proxy_bypassed) return "direct";
  // DirectExport whose preview proxy has landed: optimization is complete
  // (export reads the original, preview reads the quick proxy), so settle to
  // silent — otherwise a decodable DirectExport source would be terminally
  // "bridged" and keep the import dialog open forever. The FULL-proxy path
  // (QuickThenFull / 10-bit) still waits for `proxy_path` (handled above), so
  // it correctly stays "bridged" until its export master lands.
  if (m.export_uses_original && m.quick_proxy_path) return "direct";
  const decodable = deps.memo.get(m.id) === "ok";
  const ps = deps.proxyStateOf(m.id);
  if (ps === "failed") return "failed";
  // This machine decoded it → the bridge previews the original now; whatever
  // proxy is building is a background scroll/export upgrade.
  if (decodable) return "bridged";
  // DirectExport whose probe hasn't resolved yet.
  if (m.export_uses_original) return "checking";
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

/// A classified clip for the dialog. App builds these; the dialog renders them.
export interface ImportItem {
  id: string;
  label: string;
  status: OptimizeStatus;
  reason: OptimizeReason;
}

export interface Partitioned {
  listed: ImportItem[]; // bridged + transcoding + failed (shown in the list)
  checkingCount: number; // shown as "checking N…"
  hasAttention: boolean; // gates dialog visibility + auto-close in App
}

export function partitionImportItems(items: ImportItem[]): Partitioned {
  const listed = items.filter(
    (i) => i.status === "bridged" || i.status === "transcoding" || i.status === "failed",
  );
  const checkingCount = items.filter((i) => i.status === "checking").length;
  return { listed, checkingCount, hasAttention: listed.length > 0 || checkingCount > 0 };
}
