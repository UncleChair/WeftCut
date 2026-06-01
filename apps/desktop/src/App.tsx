import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { join, tempDir } from "@tauri-apps/api/path";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { remove, writeFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AGENT_SESSION_EVENTS,
  agentSessionEnd,
  agentSessionGet,
  deleteLayer,
  ensureFullProxy,
  keybindingsGet,
  type AgentSession,
  type KeybindingsMap,
  exportProjectAudioOnly,
  muxExport,
  IMPORT_EVENTS,
  importCancel,
  importMedia,
  importQueueList,
  MEDIA_JOB_EVENTS,
  type MediaJobEvent,
  ping,
  projectRedo,
  projectSave,
  projectSaveAs,
  projectSummary,
  projectUndo,
  type ImportEntry,
  type MediaSummary,
  type ProjectSummary,
} from "./ipc";
import { formatTimecode, frameDurUs, lastFrameAnchorUs, parseTimecode } from "./frames";
import { Timeline } from "./timeline/Timeline";
import { AgentMode } from "./agent/AgentMode";
import { RightPanel } from "./panels/RightPanel";
import { ConnectAgentPanel } from "./connect/ConnectAgentPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { TemplatePicker } from "./templates/TemplatePicker";
import { MediaThumbnail } from "./panels/MediaThumbnail";
import { mediaReadiness, type ProxyState } from "./panels/mediaReadiness";
import { probeSourceDecodable } from "./render/decoder/probeSourceDecodable";
import { referencedVideoMediaIds } from "./render/activeVideoLayers";
import {
  sourcesNeedingPreviewProbe,
  prepareExportMedia,
  waitForProxies,
  ExportCancelled,
  ExportProxyFailed,
  type ProbeState,
} from "./render/exportReadiness";
import {
  importOptimizeStatus,
  optimizeReason,
  partitionImportItems,
  type OptimizeDeps,
  type ImportItem,
} from "./panels/importOptimize";
import { ImportProxyDialog } from "./panels/ImportProxyDialog";
import {
  PreviewSurface,
  type PreviewSurfaceHandle,
} from "./preview/PreviewSurface";

import {
  Menu,
  MenuHeading,
  MenuItem,
  MenuSeparator,
} from "./menu/Menu";
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "./i18n";
import { GlobeIcon } from "./i18n/GlobeIcon";
import {
  ShortcutBindingsProvider,
  useShortcuts,
  type HandlerMap,
  type OverrideMap,
} from "./shortcuts";
import { StatusBar } from "./logs/StatusBar";
import { LogConsole, type LogConsoleHandle } from "./logs/LogConsole";
import { wireLogStream, useLogStore } from "./logs/store";
import {
  exportPlaybackPathFor,
  useProjectStore,
  wireProjectStore,
} from "./state/projectStore";
import {
  setMediaPoolDrawerOpen,
  toggleDisplayMode,
  useAppSettingsStore,
  useDisplayMode,
  useMediaPoolDrawerOpen,
  wireAppSettingsStream,
} from "./settings/appSettingsStore";
import { logEmit } from "./ipc";

interface AppProps {
  /// Hop the root router back to the StartupScreen — wired by `main.tsx`.
  /// Called by File → Save and Close after a successful save flush.
  onCloseProject: () => void;
}

export function App({ onCloseProject }: AppProps) {
  const { t, i18n } = useTranslation();
  // R.9 — MediaPool drawer state lives in the app-pref store. Reading
  // through the atomic selector so a flip doesn't re-render anything
  // that doesn't depend on it.
  const mediaPoolDrawerOpen = useMediaPoolDrawerOpen();
  const [pong, setPong] = useState<string>("…");
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  // Blade-tool mode: pressing `C` toggles it; clicks on layers in the
  // timeline split the layer at the click point instead of selecting it.
  // Exits on a second `C` press or `Esc`. Living at App level so the
  // shortcut handler and the Timeline both see the same flag.
  const [bladeMode, setBladeMode] = useState<boolean>(false);
  // R.7 inline-reveal: track id the user surfaced from the right-panel peek
  // list. Single-track exclusive; persists across scrubs. Cleared by Esc, by
  // selecting a layer on a different track, or by clicking another peek
  // item (which replaces the value).
  const [revealedTrackId, setRevealedTrackId] = useState<string | null>(null);
  const [currentTimeUs, setCurrentTimeUs] = useState<number>(0);
  const [paused, setPaused] = useState<boolean>(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logConsoleOpen, setLogConsoleOpen] = useState(false);
  const logConsoleRef = useRef<LogConsoleHandle | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [editingTimecode, setEditingTimecode] = useState<string | null>(null);
  // User shortcut overrides. Loaded once on mount; refreshed when the
  // Settings → Keyboard panel writes (it calls back via the
  // `onKeybindingsChanged` prop). The map is `Record<string, string[]>`
  // on the wire; we widen-cast into `OverrideMap` since the frontend
  // catalogue (`ACTION_DEFS`) is the validator. Unknown action ids in
  // the file are silently ignored at dispatch time.
  const [keybindings, setKeybindings] = useState<KeybindingsMap>({});
  // Active agent session (null = editor mode). Set by the
  // `agent_session:changed` event the backend emits whenever an MCP
  // client calls `begin_agent_session` or any path clears the slot
  // (workspace change, user-side exit). Always seeded by an explicit
  // get on mount so the UI never blinks through the wrong mode on
  // app start.
  const [agentSession, setAgentSession] = useState<AgentSession | null>(null);
  // Phase D — workspace-redesign.md Q10: the project preview is a DOM
  // `<video>` element driven by `<PreviewSurface>`. The transport buttons
  // here delegate to its imperative handle (play / pause / seek), and
  // playhead state flows back up via callbacks. The previous
  // libmpv-embed "previewInit" state machine is gone.
  const previewRef = useRef<PreviewSurfaceHandle | null>(null);
  const [importQueue, setImportQueue] = useState<ImportEntry[]>([]);

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
  // timeline. `MediaSummary.proxy_path` from the next summary refresh is
  // the durable source of truth; this map is the fast, session-scoped
  // reflection so the UI flips the moment the event fires instead of
  // waiting on the project:changed round-trip.
  const [proxyState, setProxyState] = useState<Map<string, ProxyState>>(
    () => new Map(),
  );
  // Session decodability probe memo, shared by the import-time sweep and the
  // export-readiness gate. id → "ok" (decoded a key frame this session) /
  // "pending" (probe in flight). A decodable DirectExport source stays
  // export_uses_original forever, so this memo is what stops re-probing it.
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
  // Completed import media_ids already routed into a dialog batch (session).
  const notifiedImportIds = useRef<Set<string>>(new Set());
  // The current import-proxy dialog batch (media_ids); empty = closed.
  const [dialogBatch, setDialogBatch] = useState<string[]>([]);
  const timecodeInputRef = useRef<HTMLInputElement | null>(null);

  // Centralised playhead clamp — Q5 of the frame-anchor playhead spec.
  // Every UI seek funnels through here so callers can pass raw boundary
  // values (`duration_us`, `currentTimeUs + step`, parsed timecode) and
  // the upper bound is enforced once. Lower bound at 0; upper at
  // `lastFrameAnchorUs` so the playhead can never sit on the
  // post-last-frame slot.
  const seekTo = useCallback((tUs: number) => {
    const fpsNum = summary?.composition.fps_num ?? 30;
    const fpsDen = summary?.composition.fps_den ?? 1;
    const durationUs = summary?.duration_us ?? 0;
    const upper = lastFrameAnchorUs(durationUs, fpsNum, fpsDen);
    const clamped = Math.max(0, Math.min(tUs, upper));
    setCurrentTimeUs(clamped);
    previewRef.current?.seekTo(clamped);
  }, [summary?.composition.fps_num, summary?.composition.fps_den, summary?.duration_us]);

  // R.7: click on a peek item → reveal that hidden track inline at its
  // natural accretion slot AND select the clicked layer. Single-track
  // exclusive (later peek-click replaces).
  const revealTrack = useCallback((trackId: string, layerId: string) => {
    setRevealedTrackId(trackId);
    setSelectedLayerId(layerId);
  }, []);

  // R.7: Esc collapses the inline reveal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRevealedTrackId((cur) => (cur === null ? cur : null));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // R.7: when the user clicks a layer on a DIFFERENT track from the
  // revealed one, collapse the reveal. Plain deselect (selectedLayerId
  // becomes null) does NOT collapse — the user might still want to peek
  // back at that hidden layer's track. Only an active selection on a
  // foreign track clears the reveal.
  useEffect(() => {
    if (revealedTrackId === null || selectedLayerId === null) return;
    const owner = (summary?.tracks ?? []).find((t) =>
      t.layers.some((l) => l.id === selectedLayerId),
    );
    if (owner && owner.id !== revealedTrackId) {
      setRevealedTrackId(null);
    }
  }, [selectedLayerId, summary, revealedTrackId]);

  const commitTimecode = useCallback(() => {
    if (editingTimecode === null) return;
    const fpsNum = summary?.composition.fps_num ?? 30;
    const fpsDen = summary?.composition.fps_den ?? 1;
    const us = parseTimecode(editingTimecode, fpsNum, fpsDen);
    setEditingTimecode(null);
    if (us !== null) void seekTo(us);
  }, [editingTimecode, seekTo, summary?.composition.fps_num, summary?.composition.fps_den]);

  // Focus + select the timecode input the moment edit mode opens so the user
  // can immediately type to replace the current value.
  useEffect(() => {
    if (editingTimecode !== null && timecodeInputRef.current) {
      timecodeInputRef.current.focus();
      timecodeInputRef.current.select();
    }
  }, [editingTimecode]);

  const togglePlay = useCallback(() => {
    const handle = previewRef.current;
    if (!handle) return;
    if (handle.paused()) {
      handle.play();
    } else {
      handle.pause();
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSummary(await projectSummary());
    } catch (e) {
      setError(t("errors.refresh_failed", { detail: String(e) }));
    }
  }, [t]);

  useEffect(() => {
    ping().then(setPong).catch((e) => setPong(`error: ${String(e)}`));
    refresh();
    keybindingsGet().then(setKeybindings).catch(() => {});
    // Seed agent-session mode explicitly so the UI never flashes through
    // editor mode on a fresh app start when an MCP client has already
    // begun a session (e.g., on app re-launch via deeplink in the
    // future). Subsequent flips arrive via the agent_session:changed
    // event below.
    agentSessionGet().then(setAgentSession).catch(() => {});
  }, [refresh]);

  // Subscribe to agent_session:changed — payload is `AgentSession | null`.
  // Begin / replace / end all flow through here so the conditional render
  // below stays in sync with the backend slot.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<AgentSession | null>(
        AGENT_SESSION_EVENTS.changed,
        (e) => setAgentSession(e.payload),
      );
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

  // Bind the OS window title to the project name (AE-style: the
  // project's identity lives in the window chrome, not in an in-app
  // bar). Falls back to the bare app title when no project is loaded
  // yet. Re-runs on locale flip so the dash / phrasing follows the
  // user's language preference. Resets to the bare title on unmount
  // (Save and Close) so the StartupScreen doesn't inherit a stale
  // project name in the OS title bar.
  useEffect(() => {
    const win = getCurrentWindow();
    const next = summary?.name
      ? t("app.window_title", { name: summary.name })
      : t("app.title");
    void win.setTitle(next).catch(() => {});
  }, [summary?.name, i18n.resolvedLanguage, t]);
  useEffect(() => {
    return () => {
      void getCurrentWindow().setTitle("WeftCut").catch(() => {});
    };
  }, []);

  const exitAgentMode = useCallback(async () => {
    try {
      await agentSessionEnd();
    } catch (e) {
      console.warn("agent_session_end failed:", e);
    }
  }, []);

  // Wire the status-log stream: seed from `log_list`, then subscribe to
  // `log:entry` events. Pre-workspace this is a no-op (backend bus is
  // None). The Zustand store backs the status bar's selectors.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await wireLogStream();
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

  // Project state mirror for the DOM preview (`docs/preview-dom.md` Phase A).
  // Coexists with the local-state fetches further down — both subscribe to
  // `project:changed`, both re-fetch, no cross-talk. The DOM preview engine
  // reads from `useProjectStore`; App.tsx's existing fetches stay until
  // Phase F cutover.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await wireProjectStore();
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

  // App-level settings stream (`docs/ab-roll-redesign`). Seeds the store
  // from the current value, then subscribes to `app_settings:changed`
  // so any pill/menu/shortcut flip propagates to every consumer (the
  // timeline filter, the right panel's peek-window width, the
  // MediaPool drawer chevron, …).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await wireAppSettingsStream();
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

  // Import queue subscription (Phase C.1 — workspace-redesign.md Q6). The
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

  // Per-media preview-readiness job tracking — proxy / quick_proxy /
  // proxy_bypass only. We do NOT gate the UI on thumbnails / waveform;
  // those are decorations.
  // The listener owns transitions started → pending, complete → ready,
  // error → failed. `MediaSummary.proxy_path` from the next summary
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

  // Import-time decodability sweep. For every DirectExport video source not yet
  // probed this session, decode one key frame in the background; on failure
  // route-correct it (ensureFullProxy clears export_uses_original + enqueues a
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
          // A paused clip already on the timeline won't re-run ensureClip on
          // its own; nudge the compositor to re-resolve now that the bridge is
          // live for this source.
          previewRef.current?.refreshSources();
        } else {
          memo.delete(m.id);
          // Only DirectExport sources need route-correction (they were
          // pointing export at an original this machine can't decode). A
          // full-proxy source that fails the probe already routes correctly;
          // it just gets no bridge — preview waits for its proxy as before.
          if (m.export_uses_original) {
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

  // Project-change subscription — fired by the actor whenever a commit lands,
  // regardless of source (UI command, MCP tool call, undo/redo, checkpoint
  // restore). Without this, MCP-driven edits land in state but the panels
  // stay frozen until the user clicks something.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<unknown>("project:changed", () => {
        refresh();
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
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (e) {
        const msg = String(e);
        setError(msg);
        // Phase 4 deletion of the inline menu-bar error span — the
        // user-facing error path now lives in the status bar. Push
        // every caught UI error into the log so the bar's error
        // counter + sticky-latest behavior surfaces it.
        void logEmit({
          level: "error",
          category: { kind: "System" },
          source: { kind: "User" },
          message: msg,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  // ---- Menu-bar action handlers (extracted from former inline onClicks). ----

  const saveProjectNow = useCallback(async () => {
    await run(() => projectSave());
  }, [run]);

  const saveAndClose = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await projectSave();
      onCloseProject();
    } catch (e) {
      const msg = String(e);
      setError(msg);
      void logEmit({
        level: "error",
        category: { kind: "System" },
        source: { kind: "User" },
        message: `Save and close failed: ${msg}`,
      });
    } finally {
      setBusy(false);
    }
  }, [busy, onCloseProject]);

  const saveProject = useCallback(async () => {
    const path = await saveDialog({
      title: t("dialogs.save_title"),
      defaultPath: t("dialogs.save_default_name"),
      filters: [
        { name: t("dialogs.project_filter"), extensions: ["vproj"] },
      ],
    });
    if (typeof path === "string") {
      await run(() => projectSaveAs(path));
    }
  }, [run, t]);

  const importMediaFiles = useCallback(async () => {
    const picked = await openDialog({
      title: t("dialogs.import_title"),
      multiple: true,
      filters: [
        {
          name: t("dialogs.media_filter"),
          extensions: [
            "mp4", "mov", "mkv", "webm", "avi",
            "wav", "mp3", "flac", "aac", "m4a", "ogg",
            "png", "jpg", "jpeg", "gif", "webp",
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
    if (paths.length === 0) return;
    await run(async () => {
      for (const p of paths) {
        await importMedia(p);
      }
    });
  }, [run, t]);

  // Pixi/WebCodecs export. Three-stage pipeline:
  //
  //   1. PreviewSurface handle suspends the preview compositor,
  //      drives the Worker, returns video-only MP4 bytes.
  //   2. Rust audio-only export produces a sibling .m4a.
  //   3. Rust stream-copy mux joins the two into the user-chosen path.
  //
  // The Worker emits progress on every encoded frame; that maps to
  // the encode phase of ExportPanel. Audio + mux run silently in
  // the "finalizing" tail (panel stays at progress=1.0 with the
  // last Worker fps numbers) — they should be sub-2-second for any
  // typical project.
  //
  // Temp files live under the OS temp dir with UUIDs; cleaned in
  // a finally block. If cleanup itself fails the user's output is
  // still good — we just leave the temps for the next reboot to
  // clear.
  const runPixiExport = useCallback(async () => {
    const path = await saveDialog({
      title: t("dialogs.export_title"),
      defaultPath: "weftcut-pixi-export.mp4",
      filters: [
        { name: t("dialogs.export_filter"), extensions: ["mp4"] },
      ],
    });
    if (typeof path !== "string") return;

    // ---- Export-readiness gate -------------------------------------------
    // Confirm every video source the export will decode is ready. Undecodable
    // DirectExport sources are route-corrected here; sources whose proxy is
    // still encoding put the panel into "preparing" and auto-start when ready.
    {
      const store = useProjectStore.getState();
      const proj = store.summary; // block-scoped; avoids shadowing App `summary`
      if (!proj) {
        setExportState({ kind: "error", detail: "No project loaded." });
        return;
      }
      const startUs = 0;
      const endUs = proj.duration_us;
      const referencedIds = referencedVideoMediaIds(proj, startUs, endUs);
      const referencedMedia = [...referencedIds]
        .map((id) => store.mediaById.get(id))
        .filter((m): m is MediaSummary => !!m);

      setExportState({ kind: "starting" });
      const prep = await prepareExportMedia(referencedMedia, {
        probe: (url) => probeSourceDecodable(url),
        ensureFullProxy: (id) => ensureFullProxy(id),
        proxyStateOf: (id) => proxyStateRef.current.get(id),
        urlForOriginal: (m) => convertFileSrc(m.path),
        memo: decodeProbeMemo.current,
      });

      if (prep.failed.length > 0) {
        const labels = prep.failed
          .map((id) => store.mediaById.get(id)?.label ?? id)
          .join(", ");
        setExportState({
          kind: "error",
          detail: t("export.failed_prepare", { labels }),
        });
        return;
      }

      if (prep.waiting.length > 0) {
        const ctrl = new AbortController();
        const labels = prep.waiting.map(
          (id) => store.mediaById.get(id)?.label ?? id,
        );
        setExportState({
          kind: "preparing",
          labels,
          onCancel: () => ctrl.abort(),
        });
        try {
          await waitForProxies(prep.waiting, {
            pathReady: (id) =>
              exportPlaybackPathFor(
                useProjectStore.getState().mediaById.get(id),
              ) != null,
            subscribeStore: (cb) => useProjectStore.subscribe(cb),
            onProxyError: (cb) => {
              // `listen` is async; guard against it resolving after cleanup
              // (which would leak the listener).
              let off: (() => void) | null = null;
              let disposed = false;
              void listen<MediaJobEvent>(MEDIA_JOB_EVENTS.error, (e) => {
                if (e.payload.kind === "proxy") cb(e.payload.media_id);
              }).then((u) => {
                if (disposed) u();
                else off = u;
              });
              return () => {
                disposed = true;
                off?.();
              };
            },
            signal: ctrl.signal,
          });
        } catch (e) {
          if (e instanceof ExportCancelled) {
            setExportState(null);
            return;
          }
          const id = e instanceof ExportProxyFailed ? e.mediaId : "";
          const label = store.mediaById.get(id)?.label ?? id;
          setExportState({
            kind: "error",
            detail: t("export.failed_prepare", { labels: label }),
          });
          return;
        }
      }
    }
    // ---- end gate --------------------------------------------------------

    // Allocate unique temp paths up-front so cleanup in `finally`
    // can hit them whether or not the respective stage completed.
    const tempBase = await tempDir();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempVideoPath = await join(tempBase, `weftcut-pixi-${stamp}.mp4`);
    const tempAudioPath = await join(tempBase, `weftcut-pixi-${stamp}.m4a`);

    setExportState({ kind: "starting" });
    const startedAtMs = performance.now();
    let result;
    try {
      result = await previewRef.current?.runPixiExport({
        onProgress: (encoded, total) => {
          if (total <= 0) return;
          const elapsedSec = (performance.now() - startedAtMs) / 1000;
          const fps = elapsedSec > 0 ? encoded / elapsedSec : 0;
          const summary = useProjectStore.getState().summary;
          const fpsNum = summary?.composition.fps_num ?? 30;
          const fpsDen = summary?.composition.fps_den ?? 1;
          const frameDurUs = Math.round((1_000_000 * fpsDen) / fpsNum);
          const currentTimeUs = encoded * frameDurUs;
          const speed = elapsedSec > 0 ? currentTimeUs / 1e6 / elapsedSec : 0;
          setExportState({
            kind: "progress",
            progress: {
              progress: encoded / total,
              currentTimeUs,
              frame: encoded,
              fps,
              speed,
            },
          });
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[weftcut/pixi] export failed:", e);
      setExportState({ kind: "error", detail: msg });
      return;
    }
    if (!result) {
      setExportState({
        kind: "error",
        detail: "Preview not initialized.",
      });
      return;
    }

    try {
      // (1) Write Worker bytes to temp video.mp4.
      await writeFile(tempVideoPath, new Uint8Array(result.videoBytes));

      // (2) Audio-only Rust export → temp audio.m4a. Awaitable;
      // emits no `export:*` events so the panel state stays where
      // the Worker progress left it.
      await exportProjectAudioOnly(tempAudioPath);

      // (3) Stream-copy mux → user-chosen path. ~100 ms.
      await muxExport(tempVideoPath, tempAudioPath, path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[weftcut/pixi] finalize failed:", e);
      setExportState({
        kind: "error",
        detail: `Finalize failed: ${msg}`,
      });
      return;
    } finally {
      // Best-effort cleanup. Failures here are intentionally
      // swallowed — the user's MP4 is already at `path`.
      void remove(tempVideoPath).catch(() => {});
      void remove(tempAudioPath).catch(() => {});
    }

    const durationUs = Math.round(
      (result.totalFrames * 1_000_000 * result.fpsDen) / result.fpsNum,
    );
    setExportState({
      kind: "complete",
      payload: { outputPath: path, durationUs },
    });
  }, [t]);

  // Render & Play: open a Tauri webview popup pointing at the
  // exported MP4 via the asset protocol. The popup HTML lives at
  // /render-play.html (vite copies from public/); URL hash carries
  // the asset URL + display path. Each invocation gets a unique
  // label so multiple plays can coexist (and so the capability
  // pattern `render-play-*` matches every variant).
  const openRenderPlayPopup = useCallback(async (path: string) => {
    const src = convertFileSrc(path);
    const label = `render-play-${Date.now()}`;
    const url =
      `/render-play.html#src=${encodeURIComponent(src)}` +
      `&path=${encodeURIComponent(path)}`;
    try {
      const win = new WebviewWindow(label, {
        url,
        title: "WeftCut — Render & Play",
        width: 960,
        height: 600,
        resizable: true,
      });
      // Surface webview-create errors so silent failures (CSP /
      // capability misconfig) don't look like a no-op click.
      win.once("tauri://error", (e) => {
        console.error("[weftcut/render-play] webview error:", e);
      });
    } catch (e) {
      console.error("[weftcut/render-play] failed to open popup:", e);
    }
  }, []);

  // Phase D: no React-side preview init step is needed. The Rust
  // `preview::PreviewRenderer` task subscribes to actor commits and
  // produces `<workspace>/Cache/preview/<hash>.mp4` on its own; the
  // PreviewSurface component listens for the resulting events and swaps
  // its `<video src>`. The transport buttons here just drive that
  // element's play/pause/seek state.

  // Delete the currently-selected layer. Previously a local keydown
  // effect inside `Timeline.tsx`; lifted here so the shortcuts
  // registry owns every app-level binding. No-ops when nothing is
  // selected — the `useShortcuts` dispatcher fires the handler
  // regardless and we cheaply ignore.
  const deleteSelected = useCallback(async () => {
    if (!selectedLayerId) return;
    try {
      await deleteLayer(selectedLayerId);
      setSelectedLayerId(null);
      await refresh();
    } catch (err) {
      console.error("delete failed:", err);
    }
  }, [selectedLayerId, refresh]);

  // Wire all v1 shortcut bindings. The handler map is rebuilt each
  // render — fine, because `useShortcuts` reads through a ref so the
  // window listener never reattaches just because handler identities
  // changed. The listener only reattaches when the resolved binding
  // entries change (i.e. when user overrides land later).
  const toggleLogConsole = useCallback(() => {
    setLogConsoleOpen((v) => {
      const next = !v;
      // Acknowledge any 10-s-sticky error in the bar — toggle = "I've
      // seen it". Idempotent on already-acknowledged state.
      useLogStore.getState().acknowledgeErrorSticky();
      return next;
    });
  }, []);

  const focusLogSearch = useCallback(() => {
    setLogConsoleOpen(true);
    // Defer focus to after the console mounts.
    setTimeout(() => {
      logConsoleRef.current?.focusSearch();
    }, 0);
  }, []);

  const shortcutHandlers: HandlerMap = {
    save: saveProjectNow,
    saveAs: saveProject,
    closeProject: saveAndClose,
    undo: () => run(projectUndo),
    redo: () => run(projectRedo),
    togglePlay,
    deleteSelected,
    importMedia: importMediaFiles,
    export: runPixiExport,
    toggleBladeMode: () => setBladeMode((v) => !v),
    toggleLog: toggleLogConsole,
    focusLogSearch,
    // R.8: T flips the AB / Show-All display_mode at the app level.
    // Mutates the same app-pref store the inline pill writes to;
    // every subscriber re-renders via `app_settings:changed`.
    toggleDisplayMode: () => {
      void toggleDisplayMode();
    },
    // R.9: M toggles the MediaPool left drawer. Read current state via
    // `getState()` instead of the hook (hooks can't run in a callback)
    // and flip it. R.9's drawer wires up the visual changes.
    toggleMediaPool: () => {
      const current = useAppSettingsStore.getState().settings.media_pool_drawer_open;
      void setMediaPoolDrawerOpen(!current);
    },
    // Playhead movement. The clock's setPosition snap (clock.ts) absorbs
    // any sub-frame drift back to the canonical frame; `seekTo` clamps
    // to [0, lastFrameAnchorUs]. Callers just hand it raw deltas.
    seekFrameBack: () => {
      const fps = summary?.composition;
      const step = frameDurUs(fps?.fps_num ?? 30, fps?.fps_den ?? 1);
      void seekTo(currentTimeUs - step);
    },
    seekFrameForward: () => {
      const fps = summary?.composition;
      const step = frameDurUs(fps?.fps_num ?? 30, fps?.fps_den ?? 1);
      void seekTo(currentTimeUs + step);
    },
    seekSecondBack: () => {
      void seekTo(currentTimeUs - 1_000_000);
    },
    seekSecondForward: () => {
      void seekTo(currentTimeUs + 1_000_000);
    },
    seekStart: () => {
      void seekTo(0);
    },
    seekEnd: () => {
      void seekTo(summary?.duration_us ?? 0);
    },
  };
  // Memoised so `useShortcuts`'s `useMemo(entries)` doesn't churn each
  // render. The backend's `Record<string, string[]>` is structurally
  // compatible with `OverrideMap`; the cast is purely a type assertion.
  const shortcutOverrides = useMemo<OverrideMap>(
    () => keybindings as OverrideMap,
    [keybindings],
  );
  useShortcuts({
    handlers: shortcutHandlers,
    overrides: shortcutOverrides,
  });

  const cycleLocale = useCallback(() => {
    const current = i18n.language as Locale;
    const idx = SUPPORTED_LOCALES.indexOf(current);
    const next =
      SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length] ?? "en-US";
    i18n.changeLanguage(next);
  }, [i18n]);

  const fpsLabel =
    summary &&
    (summary.composition.fps_den === 1
      ? t("project.fps_simple", { fps: summary.composition.fps_num })
      : t("project.fps_rational", {
          fps: (
            summary.composition.fps_num / summary.composition.fps_den
          ).toFixed(2),
        }));

  if (agentSession) {
    // Agent mode swap: backend's `agent_session:changed` event flipped
    // the slot to Some(...). Render the simplified shell instead of the
    // editor body. ShortcutBindingsProvider stays so the agent-mode
    // panel can still consume bound actions if it grows any (none in
    // Phase 5). Floating editor panels (export, compile, settings,
    // template-picker) are deliberately suppressed — the user is
    // watching the agent, not driving the editor.
    return (
      <ShortcutBindingsProvider overrides={shortcutOverrides}>
        <AgentMode
          ref={previewRef}
          session={agentSession}
          summary={summary}
          currentTimeUs={currentTimeUs}
          onTimeUpdate={setCurrentTimeUs}
          onPausedChange={setPaused}
          onSeek={seekTo}
          onExit={exitAgentMode}
        />
      </ShortcutBindingsProvider>
    );
  }

  return (
    <ShortcutBindingsProvider overrides={shortcutOverrides}>
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>{t("app.title")}</h1>
          <section className="menu-bar">
            <Menu label={t("menu.file")}>
              <MenuItem
                actionId="importMedia"
                label={t("actions.import_media")}
                onSelect={importMediaFiles}
                disabled={busy}
              />
              <MenuSeparator />
              <MenuItem
                actionId="save"
                label={t("actions.save")}
                onSelect={saveProjectNow}
                disabled={busy}
              />
              <MenuItem
                actionId="saveAs"
                label={t("actions.save_as")}
                onSelect={saveProject}
                disabled={busy}
              />
              <MenuSeparator />
              <MenuItem
                actionId="closeProject"
                label={t("actions.save_and_close")}
                hint={t("actions.save_and_close_hint")}
                onSelect={saveAndClose}
                disabled={busy}
              />
            </Menu>

            <Menu label={t("menu.edit")}>
              <MenuItem
                actionId="undo"
                label={t("actions.undo")}
                onSelect={() => run(projectUndo)}
                disabled={busy || !summary?.history.can_undo}
              />
              <MenuItem
                actionId="redo"
                label={t("actions.redo")}
                onSelect={() => run(projectRedo)}
                disabled={busy || !summary?.history.can_redo}
              />
              <MenuSeparator />
              <MenuItem
                actionId="toggleBladeMode"
                label={t("actions.toggle_blade_mode")}
                onSelect={() => setBladeMode((v) => !v)}
                disabled={busy || !summary || summary.layer_count === 0}
              />
            </Menu>

            <ViewMenu />


            <Menu label={t("menu.insert")}>
              {/* R.10 + 2026-05-16 import revert: "Import Media" moved to
                  the File menu (it's a file-operation, not a timeline
                  insert). "Add Track" / "Add color layer" / "Add text
                  layer" are gone. Only Templates remain as a true
                  timeline-insert affordance. */}
              <MenuItem
                label={t("actions.templates")}
                hint={t("actions.templates_hint")}
                onSelect={() => setTemplatePickerOpen(true)}
              />
            </Menu>

            <Menu label={t("menu.export")}>
              <MenuItem
                actionId="export"
                label={t("actions.export")}
                onSelect={runPixiExport}
                disabled={
                  busy ||
                  exportState?.kind === "starting" ||
                  exportState?.kind === "progress"
                }
              />
            </Menu>

            <Menu label={t("menu.tools")}>
              <MenuItem
                label={t("actions.connect_agent")}
                hint={t("actions.connect_agent_hint")}
                onSelect={() => setConnectOpen(true)}
              />
              <MenuSeparator />
              <MenuItem
                label={t("actions.settings")}
                hint={t("actions.settings_hint")}
                onSelect={() => setSettingsOpen(true)}
              />
            </Menu>
          </section>
        </div>
        <div className="header-right">
          {pong !== "ok" && pong !== "…" && (
            <span className="ping">
              {t("app.core_status", { status: pong })}
            </span>
          )}
          <button
            className="locale-toggle"
            onClick={cycleLocale}
            title={t("language.switch_label")}
            aria-label={t("language.switch_label")}
          >
            <GlobeIcon />
            <span className="locale-toggle-label">
              {LOCALE_LABELS[(i18n.resolvedLanguage ?? "en-US") as Locale] ??
                "English"}
            </span>
          </button>
        </div>
      </header>

      <main className={`app-main ${mediaPoolDrawerOpen ? "drawer-open" : ""}`}>
        <section className="preview">
          <div id="video-surface" className="video-surface">
            <PreviewSurface
              ref={previewRef}
              hasContent={(summary?.layer_count ?? 0) > 0}
              onTimeUpdate={setCurrentTimeUs}
              onPausedChange={setPaused}
              previewDecodableOf={(id) => decodeProbeMemo.current.get(id) === "ok"}
            />
          </div>
          <div className="preview-transport" role="toolbar" aria-label="Preview transport">
            {editingTimecode !== null ? (
              <input
                ref={timecodeInputRef}
                className="preview-timecode"
                type="text"
                value={editingTimecode}
                onChange={(e) => setEditingTimecode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitTimecode();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingTimecode(null);
                  }
                }}
                onBlur={commitTimecode}
                aria-label={t("transport.timecode_label")}
                spellCheck={false}
              />
            ) : (
              <span
                className="preview-timecode"
                aria-live="polite"
                role="button"
                tabIndex={0}
                title={t("transport.timecode_edit_hint")}
                onClick={() => setEditingTimecode(formatTimecode(currentTimeUs, summary?.composition.fps_num ?? 30, summary?.composition.fps_den ?? 1))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setEditingTimecode(formatTimecode(currentTimeUs, summary?.composition.fps_num ?? 30, summary?.composition.fps_den ?? 1));
                  }
                }}
              >
                {formatTimecode(currentTimeUs, summary?.composition.fps_num ?? 30, summary?.composition.fps_den ?? 1)}
              </span>
            )}
            <div className="transport-buttons">
              <button
                onClick={() => seekTo(0)}
                title={t("transport.to_start_hint")}
                aria-label={t("transport.to_start_hint")}
              >
                {t("transport.to_start")}
              </button>
              <button
                onClick={togglePlay}
                title={t("transport.play_pause_hint")}
                aria-label={t("transport.play_pause_hint")}
                disabled={(summary?.layer_count ?? 0) === 0}
              >
                {paused ? t("transport.play") : t("transport.pause")}
              </button>
              <button
                onClick={() => seekTo(summary?.duration_us ?? 0)}
                title={t("transport.to_end_hint")}
                aria-label={t("transport.to_end_hint")}
                disabled={!summary || summary.duration_us === 0}
              >
                {t("transport.to_end")}
              </button>
            </div>
            <span className="preview-meta" aria-hidden="true">
              {summary && (
                <>
                  {t("project.canvas", {
                    width: summary.composition.width,
                    height: summary.composition.height,
                    fps: fpsLabel,
                  })}
                  {" · "}
                  {t("project.duration", {
                    value: formatTimecode(summary.duration_us, summary.composition.fps_num, summary.composition.fps_den),
                  })}
                </>
              )}
            </span>
          </div>
        </section>

        <section className="timeline">
          <Timeline
            tracks={summary?.tracks ?? []}
            groups={summary?.groups ?? []}
            durationUs={summary?.duration_us ?? 0}
            currentTimeUs={currentTimeUs}
            selectedLayerId={selectedLayerId}
            revealedTrackId={revealedTrackId}
            keybindings={keybindings}
            fpsNum={summary?.composition.fps_num ?? 30}
            fpsDen={summary?.composition.fps_den ?? 1}
            bladeMode={bladeMode}
            media={summary?.media ?? []}
            importing={importingMediaIds}
            proxyState={proxyState}
            onExitBlade={() => setBladeMode(false)}
            onSelect={setSelectedLayerId}
            onSeek={seekTo}
            onMutated={refresh}
          />
        </section>

        <section className="media-pool">
          <MediaPool
            media={summary?.media ?? []}
            importing={importingMediaIds}
            proxyState={proxyState}
            fpsNum={summary?.composition.fps_num ?? 30}
            fpsDen={summary?.composition.fps_den ?? 1}
            onCancelImport={async (id) => {
              await importCancel(id).catch(() => false);
            }}
          />
        </section>

        <section className="properties">
          <RightPanel
            tracks={summary?.tracks ?? []}
            groups={summary?.groups ?? []}
            selectedLayerId={selectedLayerId}
            currentTimeUs={currentTimeUs}
            onSelect={setSelectedLayerId}
            onMutated={refresh}
            fpsNum={summary?.composition.fps_num ?? 30}
            fpsDen={summary?.composition.fps_den ?? 1}
            onRevealTrack={revealTrack}
          />
        </section>
      </main>

      {exportState && (
        <ExportPanel
          state={exportState}
          onClose={() => setExportState(null)}
          onPlay={openRenderPlayPopup}
        />
      )}
      {dialogHasAttention && (
        <ImportProxyDialog
          items={dialogItems}
          onDismiss={() => setDialogBatch([])}
        />
      )}
      {connectOpen && (
        <ConnectAgentPanel onClose={() => setConnectOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          keybindings={keybindings}
          onKeybindingsChanged={setKeybindings}
          composition={
            summary
              ? {
                  durationUs: summary.duration_us,
                  durationPinned: summary.composition.duration_pinned,
                  // The floor for a user-set duration: `max(layer.t_end_us)`
                  // across every track/layer. Mirrors the Rust-side
                  // `apply_duration_autofit` overflow guard so the UI can
                  // pre-validate before invoking `set_composition`.
                  layersMaxEndUs: summary.tracks
                    .flatMap((t) => t.layers.map((l) => l.t_end_us))
                    .reduce((a, b) => Math.max(a, b), 0),
                  fpsNum: summary.composition.fps_num,
                  fpsDen: summary.composition.fps_den,
                }
              : null
          }
          onCompositionChanged={refresh}
        />
      )}
      {templatePickerOpen && (
        <TemplatePicker
          onClose={() => setTemplatePickerOpen(false)}
          onAdded={refresh}
          currentTimeUs={currentTimeUs}
          tracks={summary?.tracks ?? []}
          fpsNum={summary?.composition.fps_num ?? 30}
          fpsDen={summary?.composition.fps_den ?? 1}
        />
      )}
      {logConsoleOpen && (
        <LogConsole
          ref={logConsoleRef}
          onClose={() => setLogConsoleOpen(false)}
        />
      )}
      <StatusBar onToggleLogs={toggleLogConsole} />
    </div>
    </ShortcutBindingsProvider>
  );
}


/// `docs/ab-roll-redesign` R.8: View menu — radio between A/B-roll and
/// Show-All. Same setting the inline pill + `T` shortcut drive. Reads
/// the current value from the app-pref store so the checkmark stays in
/// sync regardless of how it changed.
function ViewMenu() {
  const { t } = useTranslation();
  const mode = useDisplayMode();
  const isDrawerOpen = useMediaPoolDrawerOpen();
  return (
    <Menu label={t("menu.view", { defaultValue: "View" })}>
      <MenuHeading
        label={t("view.display_mode_heading", {
          defaultValue: "Track display",
        })}
      />
      <MenuItem
        actionId="toggleDisplayMode"
        label={t("view.display_ab", {
          defaultValue: "Display: A/B Roll only",
        })}
        checked={mode === "AbRoll"}
        onSelect={() => {
          if (mode !== "AbRoll") void toggleDisplayMode();
        }}
      />
      <MenuItem
        label={t("view.display_all", {
          defaultValue: "Display: Show all tracks",
        })}
        checked={mode === "ShowAll"}
        onSelect={() => {
          if (mode !== "ShowAll") void toggleDisplayMode();
        }}
      />
      <MenuSeparator />
      <MenuItem
        actionId="toggleMediaPool"
        label={
          isDrawerOpen
            ? t("view.close_media_pool", {
                defaultValue: "Close Media Pool drawer",
              })
            : t("view.open_media_pool", {
                defaultValue: "Open Media Pool drawer",
              })
        }
        onSelect={() => {
          void setMediaPoolDrawerOpen(!isDrawerOpen);
        }}
      />
    </Menu>
  );
}


interface ExportProgress {
  progress: number;
  currentTimeUs: number;
  frame: number;
  fps: number;
  speed: number;
}

interface ExportComplete {
  outputPath: string;
  durationUs: number;
}

type ExportState =
  | { kind: "starting" }
  | { kind: "preparing"; labels: string[]; onCancel: () => void }
  | { kind: "progress"; progress: ExportProgress }
  | { kind: "complete"; payload: ExportComplete }
  | { kind: "error"; detail: string };

function ExportPanel({
  state,
  onClose,
  onPlay,
}: {
  state: ExportState;
  onClose: () => void;
  /// When set, the panel renders a "Play" button next to the dismiss
  /// button on the complete state. Clicking opens a popup window
  /// playing the just-exported file.
  onPlay?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const inProgress = state.kind === "starting" || state.kind === "progress";

  let body: React.ReactNode;
  let percent = 0;
  switch (state.kind) {
    case "starting":
      body = <span>{t("export.starting")}</span>;
      break;
    case "preparing":
      body = (
        <span>
          {t("export.preparing", {
            labels: state.labels.join(", "),
            count: state.labels.length,
          })}
        </span>
      );
      break;
    case "progress": {
      percent = Math.round(state.progress.progress * 100);
      body = (
        <span>
          {t("export.progress_label", {
            percent,
            frame: state.progress.frame,
            fps: state.progress.fps.toFixed(1),
            speed: state.progress.speed.toFixed(2),
          })}
        </span>
      );
      break;
    }
    case "complete":
      percent = 100;
      body = (
        <span>{t("export.complete", { path: state.payload.outputPath })}</span>
      );
      break;
    case "error":
      body = (
        <span className="error">
          {t("export.failed", { detail: state.detail })}
        </span>
      );
      break;
  }

  return (
    <aside className="export-panel">
      <header>
        {body}
        {state.kind === "complete" && onPlay && (
          <button
            onClick={() => onPlay(state.payload.outputPath)}
            title={t("export.play_hint", {
              defaultValue: "Open the exported MP4 in a Render & Play popup.",
            })}
          >
            {t("export.play", { defaultValue: "Play" })}
          </button>
        )}
        {state.kind === "preparing" && (
          <button onClick={state.onCancel}>
            {t("export.preparing_cancel")}
          </button>
        )}
        {!inProgress && state.kind !== "preparing" && (
          <button onClick={onClose}>{t("export.dismiss")}</button>
        )}
      </header>
      <div
        className={`progress-track ${state.kind === "error" ? "is-error" : ""}`}
      >
        <div
          className="progress-fill"
          style={{
            width: `${state.kind === "error" ? 100 : percent}%`,
          }}
        />
      </div>
    </aside>
  );
}

function MediaPool({
  media,
  importing,
  proxyState,
  fpsNum,
  fpsDen,
  onCancelImport,
}: {
  media: MediaSummary[];
  importing: ReadonlySet<string>;
  proxyState: ReadonlyMap<string, ProxyState>;
  fpsNum: number;
  fpsDen: number;
  onCancelImport: (mediaId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  if (media.length === 0) {
    return (
      <div className="media-pool-inner">
        <h2>{t("media_pool.heading")}</h2>
        <p className="placeholder">{t("media_pool.empty")}</p>
      </div>
    );
  }

  // Case-insensitive substring match on the human-facing label. Trim
  // so trailing whitespace from a paste doesn't kill all matches.
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const filtered = needle
    ? media.filter((m) => m.label.toLowerCase().includes(needle))
    : media;

  return (
    <div className="media-pool-inner">
      <h2>
        {t("media_pool.heading")} (
        {trimmed ? `${filtered.length}/${media.length}` : media.length})
      </h2>
      <div className="media-pool-search">
        <input
          type="text"
          className="media-pool-search-input"
          placeholder={t("media_pool.search_placeholder")}
          aria-label={t("media_pool.search_placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query !== "") {
              e.preventDefault();
              setQuery("");
            }
          }}
        />
        {query !== "" && (
          <button
            type="button"
            className="media-pool-search-clear"
            onClick={() => setQuery("")}
            title={t("media_pool.clear_search")}
            aria-label={t("media_pool.clear_search")}
          >
            ×
          </button>
        )}
      </div>
      {filtered.length === 0 ? (
        <p className="placeholder">
          {t("media_pool.no_matches", { query: trimmed })}
        </p>
      ) : (
        <ul className="media-list">
          {filtered.map((m) => {
          const readiness = mediaReadiness(m, importing, proxyState);
          const interactive = readiness.ready;
          const reason = readiness.ready ? null : readiness.reason;
          return (
            <li
              key={m.id}
              className={[
                "media-item",
                reason === "importing" ? "is-importing" : "",
                reason === "missing" ? "is-missing" : "",
                reason === "proxy_pending" ? "is-proxy-pending" : "",
                reason === "proxy_failed" ? "is-proxy-failed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              draggable={interactive}
              aria-disabled={!interactive}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/x-weftcut-media",
                  JSON.stringify({ mediaId: m.id, kind: m.kind }),
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
              title={
                interactive
                  ? t("media_pool.drag_hint", {
                      defaultValue: "Drag onto a track to add",
                    })
                  : reason === "missing"
                    ? t("media_pool.missing_hint", { path: m.path })
                    : reason === "proxy_pending"
                      ? t("media_pool.proxy_pending_hint", {
                          defaultValue: "Preview is being prepared…",
                        })
                      : reason === "proxy_failed"
                        ? t("media_pool.proxy_failed_hint", {
                            defaultValue:
                              "Preview could not be prepared. Re-import to retry.",
                          })
                        : t("media_pool.importing")
              }
            >
              <div className="media-item-thumb">
                <MediaThumbnail mediaId={m.id} mediaKind={m.kind} />
                {/* Hover-revealed details overlay. Shows kind, duration,
                    dimensions, size. Hidden by default; opacity-faded
                    in on hover so the card stays calm in the resting
                    state. Importing / missing states swap in a pinned
                    status badge instead. */}
                <div className="media-item-details" aria-hidden="true">
                  <span
                    className={`media-kind kind-${m.kind.toLowerCase()}`}
                  >
                    {t(`kinds.${m.kind.toLowerCase()}`, {
                      defaultValue: m.kind,
                    })}
                  </span>
                  <span className="media-meta">
                    {m.duration_us !== null
                      ? t("media_pool.duration", {
                          value: formatTimecode(m.duration_us, fpsNum, fpsDen),
                        })
                      : t("media_pool.no_duration")}
                  </span>
                  {m.width !== null && m.height !== null && (
                    <span className="media-meta">
                      {m.width}×{m.height}
                    </span>
                  )}
                  <span className="media-meta">
                    {formatBytes(m.size_bytes, t)}
                  </span>
                </div>
                {reason === "importing" && (
                  <button
                    className="media-import-cancel"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await onCancelImport(m.id);
                    }}
                    title={t("media_pool.importing_cancel_hint")}
                  >
                    {t("media_pool.importing")}
                  </button>
                )}
                {reason === "missing" && (
                  <span
                    className="media-missing-badge"
                    title={t("media_pool.missing_hint", { path: m.path })}
                  >
                    {t("media_pool.missing")}
                  </span>
                )}
                {reason === "proxy_pending" && (
                  <span
                    className="media-proxy-pending-badge"
                    title={t("media_pool.proxy_pending_hint", {
                      defaultValue: "Preview is being prepared…",
                    })}
                  >
                    {t("media_pool.proxy_pending", {
                      defaultValue: "Preparing…",
                    })}
                  </span>
                )}
                {reason === "proxy_failed" && (
                  <span
                    className="media-proxy-failed-badge"
                    title={t("media_pool.proxy_failed_hint", {
                      defaultValue:
                        "Preview could not be prepared. Re-import to retry.",
                    })}
                  >
                    {t("media_pool.proxy_failed", {
                      defaultValue: "Preview failed",
                    })}
                  </span>
                )}
              </div>
              <span
                className="media-item-name"
                title={m.label}
              >
                {m.label}
              </span>
            </li>
          );
        })}
        </ul>
      )}
    </div>
  );
}

function formatBytes(
  bytes: number,
  t: (k: string, v: Record<string, unknown>) => string,
): string {
  const KIB = 1024;
  const MIB = KIB * 1024;
  const GIB = MIB * 1024;
  if (bytes >= GIB) {
    return t("media_pool.size_gib", { value: (bytes / GIB).toFixed(2) });
  }
  if (bytes >= MIB) {
    return t("media_pool.size_mib", { value: (bytes / MIB).toFixed(2) });
  }
  if (bytes >= KIB) {
    return t("media_pool.size_kib", { value: (bytes / KIB).toFixed(0) });
  }
  return t("media_pool.size_bytes", { bytes });
}
