import { convertFileSrc } from "@/bridge/ipc";
import { listen } from "@/bridge/events";
import { open as openDialog } from "@/bridge/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ensureFullProxy,
  IMPORT_EVENTS,
  importMedia,
  importQueueList,
  MEDIA_JOB_EVENTS,
  type MediaJobEvent,
  type ImportEntry,
  type MediaSummary,
  type ProjectSummary,
} from "../ipc";
import { type ProxyState } from "../panels/mediaReadiness";
import { probeSourceDecodable } from "../render/decoder/probeSourceDecodable";
import {
  sourcesNeedingPreviewProbe,
  type ProbeState,
} from "../render/exportReadiness";
import {
  importOptimizeStatus,
  optimizeReason,
  partitionImportItems,
  type OptimizeDeps,
  type ImportItem,
} from "../panels/importOptimize";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import { useProjectStore } from "../state/projectStore";
import { resolveDecode } from "../render/decodeRoute";

/// Owns the import pipeline + per-media preview readiness: the import queue,
/// the copying/proxy lifecycle maps, the session decodability probe memo, the
/// import-time decodability sweep, and the import-proxy dialog batch. The
/// `proxyStateRef` + `decodeProbeMemo` refs it returns are also consumed by
/// useExportFlow; `summary`/`run`/`previewRef` arrive from App via `deps`.
export function useImportReadiness(deps: {
  summary: ProjectSummary | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
}): {
  importingMediaIds: Set<string>;
  proxyState: Map<string, ProxyState>;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
  previewDecodableMediaIds: Set<string>;
  dialogItems: ImportItem[];
  dialogHasAttention: boolean;
  clearDialogBatch: () => void;
  importMediaFiles: () => Promise<void>;
  importPaths: (paths: string[]) => Promise<void>;
} {
  const { t } = useTranslation();
  const { summary, run, previewRef } = deps;

  const [importQueue, setImportQueue] = useState<ImportEntry[]>([]);

  // Import queue subscription (docs/data-model.md Q6). The
  // background-copy worker pushes a fresh history list on every state
  // change. MediaPool reads the in-flight set out of this so pool items
  // can show a "Copying…" badge while their bytes are being moved into
  // `<workspace>/Media/`.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    importQueueList().then(setImportQueue).catch(() => {});
    (async () => {
      const u = await listen<ImportEntry[]>(IMPORT_EVENTS.queue, (e) => {
        setImportQueue(e.payload);
      });
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Set of media_ids currently being copied into <workspace>/Media/. The
  // pool item renders a "Copying…" badge for these. Items that have moved
  // past Pending/Copying (Completed/Failed/Cancelled) shouldn't show a
  // copying badge — the path_abs has either landed or never will.
  const importingMediaIds = useMemo(() => {
    const set = new Set<string>();
    for (const entry of importQueue) {
      if (entry.status.kind === "Pending" || entry.status.kind === "Copying") {
        set.add(entry.media_id);
      }
    }
    return set;
  }, [importQueue]);
  // Per-video proxy lifecycle for the current session. Filled by the
  // `media:job_*` listener below (proxy / quick_proxy / proxy_bypass)
  // and consulted by
  // `mediaReadiness` to decide whether a video clip is usable on the
  // timeline. `MediaSummary.decode_route` from the next summary refresh is
  // the durable source of truth; this map is the fast, session-scoped
  // reflection so the UI flips the moment the event fires instead of
  // waiting on the project:changed round-trip.
  const [proxyState, setProxyState] = useState<Map<string, ProxyState>>(
    () => new Map(),
  );

  // Per-media preview-readiness job tracking — proxy / quick_proxy /
  // proxy_bypass only. We do NOT gate the UI on thumbnails / waveform;
  // those are decorations.
  // The listener owns transitions started → pending, complete → ready,
  // error → failed. `MediaSummary.decode_route` from the next summary
  // refresh is the durable source of truth; this map is the fast,
  // session-scoped reflection so the UI flips the moment the event
  // fires instead of waiting on the project:changed round-trip.
  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      const set = (id: string, s: ProxyState) =>
        setProxyState((prev) => {
          const next = new Map(prev);
          next.set(id, s);
          return next;
        });
      const onStarted = await listen<MediaJobEvent>(
        MEDIA_JOB_EVENTS.started,
        (e) => {
          if (
            e.payload.kind === "proxy" ||
            e.payload.kind === "quick_proxy" ||
            e.payload.kind === "proxy_bypass"
          ) {
            set(e.payload.media_id, "pending");
          }
        },
      );
      const onComplete = await listen<MediaJobEvent>(
        MEDIA_JOB_EVENTS.complete,
        (e) => {
          if (
            e.payload.kind === "proxy" ||
            e.payload.kind === "quick_proxy" ||
            e.payload.kind === "proxy_bypass"
          ) {
            set(e.payload.media_id, "ready");
          }
        },
      );
      const onError = await listen<MediaJobEvent>(
        MEDIA_JOB_EVENTS.error,
        (e) => {
          if (
            e.payload.kind === "proxy" ||
            e.payload.kind === "quick_proxy" ||
            e.payload.kind === "proxy_bypass"
          ) {
            set(e.payload.media_id, "failed");
          }
        },
      );
      if (cancelled) {
        onStarted();
        onComplete();
        onError();
        return;
      }
      unlisteners = [onStarted, onComplete, onError];
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Session decodability probe memo, shared by the import-time sweep and the
  // export-readiness gate. id → "ok" (decoded a key frame this session) /
  // "pending" (probe in flight). A decodable DirectExport source keeps its
  // direct-export route forever, so this memo is what stops re-probing it.
  const decodeProbeMemo = useRef<Map<string, ProbeState>>(new Map());
  // Fast mirror of proxyState for use inside callbacks (stale-closure-proof).
  const proxyStateRef = useRef(proxyState);
  useEffect(() => {
    proxyStateRef.current = proxyState;
  }, [proxyState]);
  // Ids the sweep route-corrected (machine can't decode) — drives the import
  // dialog's "本机无法直接解码" reason vs the static "格式/10-bit" reasons.
  const routeCorrected = useRef<Set<string>>(new Set());
  // Bumped whenever the sweep mutates decodeProbeMemo/routeCorrected (refs, so
  // they don't re-render on their own) to force the dialog to reclassify.
  const [sweepTick, setSweepTick] = useState(0);
  const previewDecodableMediaIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, state] of decodeProbeMemo.current) {
      if (state === "ok") ids.add(id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepTick]);
  // Completed import media_ids already routed into a dialog batch (session).
  const notifiedImportIds = useRef<Set<string>>(new Set());
  // The current import-proxy dialog batch (media_ids); empty = closed.
  const [dialogBatch, setDialogBatch] = useState<string[]>([]);

  // Import-time decodability sweep. For every DirectExport video source not yet
  // probed this session, decode one key frame in the background; on failure
  // route-correct it (ensureFullProxy promotes the route to Proxied + enqueues a
  // full proxy). Capable machines pay one sub-second probe and generate no
  // master proxy. Sequential to avoid competing with preview decoders. Reads
  // the fresh Zustand pool; re-runs when `summary` changes (every project:changed).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const memo = decodeProbeMemo.current;
      const pool = useProjectStore.getState().mediaById;
      const candidates = sourcesNeedingPreviewProbe(pool).filter(
        (m) =>
          m.available &&
          memo.get(m.id) !== "ok" &&
          memo.get(m.id) !== "pending",
      );
      for (const m of candidates) {
        if (cancelled) return;
        memo.set(m.id, "pending");
        let ok = false;
        try {
          ok = await probeSourceDecodable(convertFileSrc(m.path));
        } catch {
          ok = false;
        }
        // Land the verdict even if the effect was cancelled mid-probe. A rapid
        // project:changed during a fast import (quick proxy lands in ~seconds)
        // re-runs this [summary] effect and flips `cancelled`; bailing here
        // would strand memo at "pending" forever — the next run filters out
        // "pending" (and a proxied source leaves `sourcesNeedingPreviewProbe`),
        // so it's never re-probed and stays stuck on "checking", never bridged.
        // `probeSourceDecodable` has no AbortSignal, so the await completes
        // regardless; recording its result is safe + idempotent. (The loop-top
        // `if (cancelled) return` still stops STARTING new probes after cancel.)
        if (ok) {
          memo.set(m.id, "ok");
          // A paused clip already on the timeline won't re-run ensureClip on its
          // own; nudge the compositor to re-run ENGINE resolution now that this
          // source's WebCodecs-original probe (tier 2) reads "ok" — the resolver
          // can promote it from the proxy to decoding the original.
          previewRef.current?.refreshSources();
        } else {
          memo.delete(m.id);
          // Only DirectExport sources need route-correction (they were
          // pointing export at an original this machine can't decode). A
          // full-proxy source that fails the probe already routes correctly;
          // it just gets no bridge — preview waits for its proxy as before.
          if (resolveDecode(m).route === "direct-export") {
            routeCorrected.current.add(m.id);
            try {
              await ensureFullProxy(m.id);
            } catch (e) {
              console.error("[weftcut] route-correct failed for", m.id, e);
            }
          }
        }
        // Force the import dialog to reclassify: memo/routeCorrected are refs
        // and the decodable ("ok") branch fires no store event, so without this
        // a now-decodable clip would stay stuck on "checking" in the dialog.
        setSweepTick((x) => x + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [summary]);

  // Open/extend the import-proxy dialog batch when an import batch completes.
  // Add ALL completed ids (audio/direct included); the classifier filters them
  // out, so non-attention imports never render the dialog.
  useEffect(() => {
    const completed = importQueue.filter((e) => e.status.kind === "Completed");
    const fresh = completed
      .map((e) => e.media_id)
      .filter((id) => !notifiedImportIds.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) notifiedImportIds.current.add(id);
    setDialogBatch((prev) => [...new Set([...prev, ...fresh])]);
  }, [importQueue]);

  // Deps recreated each render; they read `.current` refs so they're always
  // live. `sweepTick` is what forces re-eval when only a ref changed.
  const dialogDeps: OptimizeDeps = {
    memo: decodeProbeMemo.current,
    proxyStateOf: (id) => proxyStateRef.current.get(id),
    routeCorrected: routeCorrected.current,
  };

  // Live classification of the dialog batch.
  const dialogItems: ImportItem[] = useMemo(() => {
    const store = useProjectStore.getState();
    return dialogBatch
      .map((id) => store.mediaById.get(id))
      .filter((m): m is MediaSummary => !!m)
      .map((m) => ({
        id: m.id,
        label: m.label,
        status: importOptimizeStatus(m, dialogDeps),
        reason: optimizeReason(m, dialogDeps),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogBatch, summary, proxyState, sweepTick]);

  const dialogHasAttention = partitionImportItems(dialogItems).hasAttention;

  // Auto-close ONLY once every batch member is loaded in the store AND resolved
  // to direct/ready. Never clears while a member is still absent (the import
  // Completed event can beat the store update) or still needs attention — that
  // would close the dialog before the clips even appear.
  useEffect(() => {
    if (dialogBatch.length === 0) return;
    const store = useProjectStore.getState();
    const allSettledDirect = dialogBatch.every((id) => {
      const m = store.mediaById.get(id);
      if (!m) return false;
      const s = importOptimizeStatus(m, dialogDeps);
      return s === "direct" || s === "ready";
    });
    if (allSettledDirect) setDialogBatch([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogBatch, summary, proxyState, sweepTick]);

  // Shared tail of every import entry point (file picker, media-pool
  // file drop): feed absolute paths into the import pipeline.
  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      await run(async () => {
        for (const p of paths) {
          await importMedia(p);
        }
      });
    },
    [run],
  );

  const importMediaFiles = useCallback(async () => {
    const picked = await openDialog({
      title: t("dialogs.import_title"),
      multiple: true,
      filters: [
        {
          name: t("dialogs.media_filter"),
          // Mirrors the backend's extension fallback (io/probe.rs detect_kind)
          // EXCEPT tif/tiff: Electron/Chromium's createImageBitmap can't decode TIFF,
          // so offering it would import a layer that composites nothing.
          extensions: [
            "mp4", "mov", "mkv", "webm", "avi", "m4v",
            "wav", "mp3", "flac", "aac", "m4a", "ogg", "opus",
            "png", "jpg", "jpeg", "gif", "webp", "bmp",
            "srt", "ass", "vtt",
          ],
        },
      ],
    });
    const paths = Array.isArray(picked)
      ? picked
      : typeof picked === "string"
        ? [picked]
        : [];
    await importPaths(paths);
  }, [importPaths, t]);

  // Media-pool drag-to-import: the preload bridge recovers real filesystem
  // paths from HTML5 file drops (webUtils.getPathForFile → media:dropped) and
  // emits them here — same pipeline as the picker from this point on.
  useEffect(() => {
    const un = listen<string[]>("media:external-drop", (e) => {
      void importPaths(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [importPaths]);

  return {
    importingMediaIds,
    proxyState,
    proxyStateRef,
    decodeProbeMemo,
    previewDecodableMediaIds,
    dialogItems,
    dialogHasAttention,
    clearDialogBatch: () => setDialogBatch([]),
    importMediaFiles,
    importPaths,
  };
}
