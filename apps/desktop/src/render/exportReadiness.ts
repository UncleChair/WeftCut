// Export-readiness gate. Decides, for the video sources an export will decode,
// which are ready, which need a proxy that is still encoding (wait), and which
// have failed. Shares its probe memo with the import-time sweep so a capable
// machine probes each source at most once per session.
//
// See docs/data-model.md#mediaitem and docs/render.md#export-source-resolution.

import type { MediaSummary } from "../ipc";

/// Session probe memo value. "ok" = decoded a key frame this session (cache
/// hit, skip re-probe). "pending" = a probe is in flight (avoid double-probe).
export type ProbeState = "ok" | "pending";

/// Proxy lifecycle state mirrored from `media:job_*` events (App `proxyState`).
export type ProxyJobState = "pending" | "ready" | "failed";

export class ExportCancelled extends Error {
  constructor() {
    super("export cancelled");
    this.name = "ExportCancelled";
  }
}
export class ExportProxyFailed extends Error {
  constructor(public readonly mediaId: string) {
    super(`proxy generation failed for ${mediaId}`);
    this.name = "ExportProxyFailed";
  }
}

/// Video sources whose export path is the ORIGINAL via DirectExport
/// (export_uses_original, no full proxy yet). DirectBoth (proxy_bypassed) is
/// H.264 and universally decodable, so it is skipped. Used by BOTH the import
/// sweep (whole pool) and the export gate (referenced-scoped via filtering).
export function sourcesNeedingPreflight(
  mediaById: ReadonlyMap<string, MediaSummary>,
): MediaSummary[] {
  return [...mediaById.values()].filter(
    (m) => m.kind === "Video" && m.export_uses_original && !m.proxy_path,
  );
}

/// Video sources that would show a BLANK preview right now (no quick proxy, no
/// full proxy, not bypassed) — candidates for the preview-from-original bridge.
/// A SUPERSET of `sourcesNeedingPreflight`: it also includes full-proxy/10-bit
/// sources, so a decodable Hi10P/HEVC gets a verdict in the shared memo and can
/// bridge while its proxy builds. The import sweep probes these; the export gate
/// keeps using the narrower `sourcesNeedingPreflight`.
export function sourcesNeedingPreviewProbe(
  mediaById: ReadonlyMap<string, MediaSummary>,
): MediaSummary[] {
  return [...mediaById.values()].filter(
    (m) =>
      m.kind === "Video" &&
      m.available &&
      !m.quick_proxy_path &&
      !m.proxy_path &&
      !m.proxy_bypassed,
  );
}

export interface PrepareDeps {
  /// Decode one key frame; true = decodable on this machine.
  probe: (assetUrl: string) => Promise<boolean>;
  /// Route-correct + enqueue the full proxy (Tauri `ensure_full_proxy`).
  ensureFullProxy: (mediaId: string) => Promise<void>;
  /// Session proxy-job state for a media id (App `proxyState`).
  proxyStateOf: (mediaId: string) => ProxyJobState | undefined;
  /// asset:// URL for a source's ORIGINAL file.
  urlForOriginal: (m: MediaSummary) => string;
  /// Shared session probe memo (App-owned ref).
  memo: Map<string, ProbeState>;
}

export interface PrepareResult {
  /// Referenced sources whose full proxy is in flight — export must wait.
  waiting: string[];
  /// Referenced sources whose proxy generation has failed — export errors.
  failed: string[];
}

/// For each referenced VIDEO source, confirm an export-decode path exists.
/// Mirrors `exportPlaybackPathFor`: proxy_path / proxy_bypassed are ready;
/// export_uses_original is "ready" only if it actually decodes (probe);
/// otherwise the source is mid-proxy (wait) or failed.
export async function prepareExportMedia(
  referencedMedia: MediaSummary[],
  deps: PrepareDeps,
): Promise<PrepareResult> {
  const waiting: string[] = [];
  const failed: string[] = [];
  // Sequential: keeps the probe from competing with preview/quick-proxy
  // decoders for the WebCodecs buffer pool (see webcodecs-buffer-pool).
  for (const m of referencedMedia) {
    if (m.kind !== "Video") continue;
    if (m.proxy_path || m.proxy_bypassed) continue; // export path ready
    if (m.export_uses_original) {
      // DirectExport: exportPlaybackPathFor returns the original — confirm it
      // actually decodes before committing.
      if (deps.memo.get(m.id) === "ok") continue; // cached decodable
      if (deps.memo.get(m.id) === "pending") {
        // The import sweep is already probing this source. Opening a SECOND
        // decoder here would collide with that probe AND with the preview
        // decoder on the WebCodecs buffer pool (ADR 0004): all three contend
        // for the ~13 slots, the probe never gets a frame before its deadline,
        // and a decodable source gets a false-negative → needless route-
        // correction → "no export-ready source". Defer to the sweep's verdict
        // instead of re-probing. `export_uses_original` is still true here, so
        // `exportPlaybackPathFor` returns the original and `waitForProxies`
        // resolves on its first check; the export's own decoder is the real
        // backstop. If the sweep later route-corrects this source, a subsequent
        // export sees the proxy.
        waiting.push(m.id);
        continue;
      }
      deps.memo.set(m.id, "pending");
      const ok = await deps.probe(deps.urlForOriginal(m));
      if (ok) {
        deps.memo.set(m.id, "ok");
        continue;
      }
      deps.memo.delete(m.id);
      await deps.ensureFullProxy(m.id);
      waiting.push(m.id);
      continue;
    }
    // No proxy, not bypassed, not DirectExport ⇒ exportPlaybackPathFor null:
    // the source was route-corrected and its proxy is in flight, or failed.
    if (deps.proxyStateOf(m.id) === "failed") failed.push(m.id);
    else waiting.push(m.id);
  }
  return { waiting, failed };
}

export interface WaitDeps {
  /// True once the DURABLE store shows a usable export path for this id
  /// (i.e. `exportPlaybackPathFor(store.mediaById.get(id)) != null`). Keying
  /// off the store — not the media:job_complete event — guarantees the store
  /// runExport reads is already fresh when the wait resolves.
  pathReady: (mediaId: string) => boolean;
  /// Subscribe to store changes; returns an unsubscribe fn.
  subscribeStore: (cb: () => void) => () => void;
  /// Subscribe to proxy-job errors by media id; returns an unsubscribe fn.
  onProxyError: (cb: (mediaId: string) => void) => () => void;
  signal: AbortSignal;
}

/// Resolves when every id has a ready export path in the store; rejects with
/// ExportProxyFailed if a still-pending id's proxy errors, or ExportCancelled
/// if the signal aborts.
export function waitForProxies(ids: string[], deps: WaitDeps): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pending = new Set(ids);
    let unsubStore = () => {};
    let unsubErr = () => {};
    const cleanup = () => {
      unsubStore();
      unsubErr();
      deps.signal.removeEventListener("abort", onAbort);
    };
    const check = () => {
      for (const id of [...pending]) if (deps.pathReady(id)) pending.delete(id);
      if (pending.size === 0) {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new ExportCancelled());
    };
    if (deps.signal.aborted) {
      reject(new ExportCancelled());
      return;
    }
    deps.signal.addEventListener("abort", onAbort);
    unsubErr = deps.onProxyError((id) => {
      if (pending.has(id) && !deps.pathReady(id)) {
        cleanup();
        reject(new ExportProxyFailed(id));
      }
    });
    unsubStore = deps.subscribeStore(check);
    check(); // initial snapshot — a proxy may have finished before we subscribed
  });
}
