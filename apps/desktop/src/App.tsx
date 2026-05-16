import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AGENT_SESSION_EVENTS,
  agentSessionEnd,
  agentSessionGet,
  compileProject,
  deleteLayer,
  EXPORT_EVENTS,
  keybindingsGet,
  type AgentSession,
  type KeybindingsMap,
  EXPORT_PRESETS,
  exportProject,
  exportQueueClearFinished,
  exportQueueEnqueue,
  exportQueueList,
  exportQueueRemove,
  hwEncoderProbe,
  IMPORT_EVENTS,
  importCancel,
  importMedia,
  importQueueList,
  MEDIA_JOB_EVENTS,
  mpvPlayMedia,
  ping,
  presetExtension,
  projectRedo,
  projectSave,
  projectSaveAs,
  projectSummary,
  projectUndo,
  splitFirstLayer,
  type CompiledGraph,
  type ExportComplete,
  type ExportPreset,
  type ExportProgress,
  type ExportQueueItem,
  type HwEncoderProbe,
  type ImportEntry,
  type MediaSummary,
  type ProjectSummary,
} from "./ipc";
import { Timeline } from "./timeline/Timeline";
import { AgentMode } from "./agent/AgentMode";
import { RightPanel } from "./panels/RightPanel";
import { ConnectAgentPanel } from "./connect/ConnectAgentPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { TemplatePicker } from "./templates/TemplatePicker";
import { MediaThumbnail } from "./panels/MediaThumbnail";
import {
  PreviewSurface,
  type PreviewSurfaceHandle,
} from "./preview/PreviewSurface";
import { SegmentStatusBar } from "./preview/SegmentStatusBar";
import { RealtimePreview } from "./preview/webcodecs/RealtimePreview";
import { isRealtimeDevMode } from "./preview/webcodecs/devMode";
import { probeRealtimeCapability } from "./preview/webcodecs/capability";
import { useSetPreviewModeCapability } from "./preview/webcodecs/previewModeStore";

// Phase B1 dev-mode toggle: evaluated once at module load. See
// `preview/webcodecs/devMode.ts` for activation paths.
const REALTIME_DEV_MODE = isRealtimeDevMode();
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
  const [compiled, setCompiled] = useState<CompiledGraph | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  // R.7 inline-reveal: track id the user surfaced from the right-panel peek
  // list. Single-track exclusive; persists across scrubs. Cleared by Esc, by
  // selecting a layer on a different track, or by clicking another peek
  // item (which replaces the value).
  const [revealedTrackId, setRevealedTrackId] = useState<string | null>(null);
  const [currentTimeUs, setCurrentTimeUs] = useState<number>(0);
  const [paused, setPaused] = useState<boolean>(true);
  const [preset, setPreset] = useState<ExportPreset>("H264Mp4_1080p");
  const [queue, setQueue] = useState<ExportQueueItem[]>([]);
  const [hwProbe, setHwProbe] = useState<HwEncoderProbe | null>(null);
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
  // Phase C.3 derivative-job tracker. Background proxy / thumbnails /
  // waveform jobs emit `media:job_started` and `media:job_complete` /
  // `media:job_error` — we keep a tiny counter to render a "Generating
  // derivatives (N)…" pill while anything's in flight.
  const [pendingDerivatives, setPendingDerivatives] = useState<number>(0);

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
  const timecodeInputRef = useRef<HTMLInputElement | null>(null);

  const seekTo = useCallback((tUs: number) => {
    setCurrentTimeUs(tUs);
    previewRef.current?.seekTo(tUs);
  }, []);

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
    const us = parseTimecode(editingTimecode);
    setEditingTimecode(null);
    if (us !== null) void seekTo(us);
  }, [editingTimecode, seekTo]);

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

  // Phase B4: run the WebCodecs+WebGL2 probe once at mount and seed
  // the preview-mode store. Settings panel + dev-mode harness both
  // read from the same store via atomic selectors.
  const setPreviewCapability = useSetPreviewModeCapability();

  useEffect(() => {
    ping().then(setPong).catch((e) => setPong(`error: ${String(e)}`));
    refresh();
    exportQueueList().then(setQueue).catch(() => {});
    hwEncoderProbe().then(setHwProbe).catch(() => {});
    keybindingsGet().then(setKeybindings).catch(() => {});
    void probeRealtimeCapability().then(setPreviewCapability);
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

  // Queue subscription — backend pushes a fresh list on every state change.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<ExportQueueItem[]>(EXPORT_EVENTS.queue, (e) => {
        setQueue(e.payload);
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

  // Derivative-job tracker (Phase C.3 — workspace-redesign.md). Each
  // `media:job_started` increments; `media:job_complete` / `error`
  // decrement. The total is shown as a small pill near the project bar
  // when > 0 so the user has a visible signal that proxies / thumbnails /
  // waveforms are still grinding in the background.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      const onStarted = await listen(MEDIA_JOB_EVENTS.started, () => {
        setPendingDerivatives((n) => n + 1);
      });
      const onComplete = await listen(MEDIA_JOB_EVENTS.complete, () => {
        setPendingDerivatives((n) => Math.max(0, n - 1));
      });
      const onError = await listen(MEDIA_JOB_EVENTS.error, () => {
        setPendingDerivatives((n) => Math.max(0, n - 1));
      });
      if (cancelled) {
        onStarted();
        onComplete();
        onError();
        return;
      }
      unlisteners.push(onStarted, onComplete, onError);
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
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

  // Export event subscriptions — kept up for the lifetime of the app so the
  // panel can show progress for any in-flight render.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      const onProgress = await listen<ExportProgress>(
        EXPORT_EVENTS.progress,
        (e) => {
          setExportState((prev) =>
            prev && prev.kind !== "complete" && prev.kind !== "error"
              ? { kind: "progress", progress: e.payload }
              : { kind: "progress", progress: e.payload },
          );
        },
      );
      const onComplete = await listen<ExportComplete>(
        EXPORT_EVENTS.complete,
        (e) => {
          setExportState({ kind: "complete", payload: e.payload });
          refresh();
        },
      );
      const onError = await listen<string>(EXPORT_EVENTS.error, (e) => {
        setExportState({ kind: "error", detail: e.payload });
      });
      if (cancelled) {
        onProgress();
        onComplete();
        onError();
        return;
      }
      unlisteners.push(onProgress, onComplete, onError);
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
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

  const showCompiledGraph = useCallback(() => {
    run(async () => setCompiled(await compileProject()));
  }, [run]);

  const exportNow = useCallback(async () => {
    const ext = presetExtension(preset);
    const path = await saveDialog({
      title: t("dialogs.export_title"),
      defaultPath: `weftcut-export.${ext}`,
      filters: [
        { name: t("dialogs.export_filter"), extensions: [ext] },
      ],
    });
    if (typeof path !== "string") return;
    setExportState({ kind: "starting" });
    try {
      await exportProject(path, preset);
    } catch (e) {
      setExportState({ kind: "error", detail: String(e) });
    }
  }, [preset, t]);

  const addToExportQueue = useCallback(async () => {
    const ext = presetExtension(preset);
    const path = await saveDialog({
      title: t("dialogs.export_queue_title"),
      defaultPath: `weftcut-export-queue.${ext}`,
      filters: [
        { name: t("dialogs.export_filter"), extensions: [ext] },
      ],
    });
    if (typeof path !== "string") return;
    try {
      await exportQueueEnqueue(path, preset);
      setQueue(await exportQueueList());
    } catch (e) {
      console.warn("queue enqueue failed:", e);
    }
  }, [preset, t]);

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
    export: exportNow,
    splitFirstLayer: () => run(splitFirstLayer),
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
        <h1>{t("app.title")}</h1>
        <div className="header-right">
          <span className="ping">{t("app.core_status", { status: pong })}</span>
          <button
            className="locale-toggle"
            onClick={cycleLocale}
            title={t("language.switch_label")}
          >
            {LOCALE_LABELS[(i18n.resolvedLanguage ?? "en-US") as Locale] ??
              "EN"}
          </button>
        </div>
      </header>

      <section className="project-bar">
        {summary ? (
          <>
            <span className="project-name">{summary.name}</span>
            <span className="meta">
              {t("project.canvas", {
                width: summary.composition.width,
                height: summary.composition.height,
                fps: fpsLabel,
              })}
            </span>
            <span className="meta">
              {t("project.tracks", { count: summary.track_count })} ·{" "}
              {t("project.layers", { count: summary.layer_count })}
            </span>
            <span className="meta">
              {t("project.duration_seconds", {
                value: (summary.duration_us / 1_000_000).toFixed(2),
              })}
            </span>
            <span className="meta">
              {t("project.history_position", {
                cursor: summary.history.cursor + 1,
                len: summary.history.len,
              })}
            </span>
          </>
        ) : (
          <span className="meta">{t("project.loading")}</span>
        )}
        {pendingDerivatives > 0 && (
          <span
            className="derivatives-pill"
            title={t("project.derivatives_pending_hint")}
          >
            <span className="derivatives-pill-spinner" aria-hidden="true" />
            {t("project.derivatives_pending", { count: pendingDerivatives })}
          </span>
        )}
        <AgentRunningPill />
      </section>

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
            actionId="splitFirstLayer"
            label={t("actions.split_first")}
            onSelect={() => run(splitFirstLayer)}
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

        <Menu label={t("menu.export")} hint={t("export.preset_hint")}>
          <MenuItem
            label={t("actions.compile")}
            onSelect={showCompiledGraph}
            disabled={busy}
          />
          <MenuSeparator />
          <MenuHeading label={t("menu.preset_heading")} />
          {EXPORT_PRESETS.map((p) => (
            <MenuItem
              key={p}
              label={t(`export.preset.${p}`, { defaultValue: p })}
              checked={p === preset}
              onSelect={() => setPreset(p)}
            />
          ))}
          <MenuSeparator />
          <MenuItem
            actionId="export"
            label={t("actions.export")}
            onSelect={exportNow}
            disabled={
              busy ||
              exportState?.kind === "starting" ||
              exportState?.kind === "progress"
            }
          />
          <MenuItem
            label={t("actions.queue_export")}
            hint={t("actions.queue_export_hint")}
            onSelect={addToExportQueue}
            disabled={busy}
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

      <main className={`app-main ${mediaPoolDrawerOpen ? "drawer-open" : ""}`}>
        <section className="preview">
          <div id="video-surface" className="video-surface">
            {REALTIME_DEV_MODE ? (
              <RealtimePreview />
            ) : (
              <PreviewSurface
                ref={previewRef}
                hasContent={(summary?.layer_count ?? 0) > 0}
                onTimeUpdate={setCurrentTimeUs}
                onPausedChange={setPaused}
              />
            )}
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
                onClick={() => setEditingTimecode(formatTimecode(currentTimeUs))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setEditingTimecode(formatTimecode(currentTimeUs));
                  }
                }}
              >
                {formatTimecode(currentTimeUs)}
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
            <span className="preview-timecode-spacer" aria-hidden="true" />
          </div>
        </section>

        <section className="timeline">
          <SegmentStatusBar />
          <Timeline
            tracks={summary?.tracks ?? []}
            groups={summary?.groups ?? []}
            durationUs={summary?.duration_us ?? 0}
            currentTimeUs={currentTimeUs}
            selectedLayerId={selectedLayerId}
            revealedTrackId={revealedTrackId}
            onSelect={setSelectedLayerId}
            onSeek={seekTo}
            onMutated={refresh}
          />
        </section>

        <section className="media-pool">
          <MediaPool
            media={summary?.media ?? []}
            importing={importingMediaIds}
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
            onRevealTrack={revealTrack}
          />
        </section>
      </main>

      {compiled && (
        <CompiledPanel
          graph={compiled}
          onClose={() => setCompiled(null)}
        />
      )}
      {exportState && (
        <ExportPanel
          state={exportState}
          onClose={() => setExportState(null)}
        />
      )}
      {queue.length > 0 && (
        <QueuePanel
          items={queue}
          hwProbe={hwProbe}
          onRemove={async (id) => {
            await exportQueueRemove(id);
          }}
          onClearFinished={async () => {
            await exportQueueClearFinished();
            setQueue(await exportQueueList());
          }}
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
        />
      )}
      {templatePickerOpen && (
        <TemplatePicker
          onClose={() => setTemplatePickerOpen(false)}
          onAdded={refresh}
          compositionDurationUs={summary?.duration_us ?? 0}
          tracks={summary?.tracks ?? []}
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


/// Project-bar pill that surfaces agent-attributed running ops while
/// the user is in editor mode. After exiting agent mode the user
/// otherwise has no signal that the agent is still working (Q4: ops
/// finish in the background). Selector walks runningOps + entries
/// once per store-update — O(running × entries) but `running` is
/// typically 0-3 in practice. Renders nothing when count is 0.
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


function AgentRunningPill() {
  const { t } = useTranslation();
  const count = useLogStore((s) => {
    let n = 0;
    for (const opId of Object.keys(s.runningOps)) {
      const e = s.entries.find((x) => x.op_id === opId);
      if (e?.source.kind === "Agent") n += 1;
    }
    return n;
  });
  if (count === 0) return null;
  return (
    <span
      className="agent-running-pill"
      title={t("agent_mode.running_pill_hint")}
    >
      <span className="agent-running-spinner" aria-hidden="true" />
      {t("agent_mode.running_pill", { count })}
    </span>
  );
}


function QueuePanel({
  items,
  hwProbe,
  onRemove,
  onClearFinished,
}: {
  items: ExportQueueItem[];
  hwProbe: HwEncoderProbe | null;
  onRemove: (id: string) => Promise<void>;
  onClearFinished: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const finishedCount = items.filter(
    (i) =>
      i.status.kind === "Completed" ||
      i.status.kind === "Failed" ||
      i.status.kind === "Cancelled",
  ).length;
  return (
    <aside className="queue-panel">
      <header>
        <strong>{t("queue.title", { count: items.length })}</strong>
        {hwProbe?.recommended && (
          <span className="queue-hw">
            {t("queue.hw_label")}: {hwProbe.recommended}
          </span>
        )}
        {finishedCount > 0 && (
          <button onClick={onClearFinished}>
            {t("queue.clear_finished")}
          </button>
        )}
      </header>
      <ul className="queue-list">
        {items.map((item) => (
          <li key={item.id} className={`queue-item status-${item.status.kind.toLowerCase()}`}>
            <span className={`queue-status status-${item.status.kind.toLowerCase()}`}>
              {t(`queue.status.${item.status.kind}`, {
                defaultValue: item.status.kind,
              })}
            </span>
            <span className="queue-preset">
              {t(`export.preset.${item.preset}`, { defaultValue: item.preset })}
            </span>
            <span className="queue-path truncate" title={item.output_path}>
              {item.output_path}
            </span>
            {item.status.kind === "Failed" && (
              <span className="error truncate" title={item.status.detail}>
                {item.status.detail}
              </span>
            )}
            <button
              className="queue-remove"
              onClick={() => onRemove(item.id)}
              title={t("queue.remove_hint")}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

type ExportState =
  | { kind: "starting" }
  | { kind: "progress"; progress: ExportProgress }
  | { kind: "complete"; payload: ExportComplete }
  | { kind: "error"; detail: string };

function ExportPanel({
  state,
  onClose,
}: {
  state: ExportState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inProgress = state.kind === "starting" || state.kind === "progress";

  let body: React.ReactNode;
  let percent = 0;
  switch (state.kind) {
    case "starting":
      body = <span>{t("export.starting")}</span>;
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
        {!inProgress && (
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
  onCancelImport,
}: {
  media: MediaSummary[];
  importing: Set<string>;
  onCancelImport: (mediaId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  if (media.length === 0) {
    return (
      <div className="media-pool-inner">
        <h2>{t("media_pool.heading")}</h2>
        <p className="placeholder">{t("media_pool.empty")}</p>
      </div>
    );
  }
  return (
    <div className="media-pool-inner">
      <h2>
        {t("media_pool.heading")} ({media.length})
      </h2>
      <ul className="media-list">
        {media.map((m) => {
          const isImporting = importing.has(m.id);
          const isMissing = !m.available && !isImporting;
          return (
            <li
              key={m.id}
              className={`media-item${isMissing ? " is-missing" : ""}${
                isImporting ? " is-importing" : ""
              }`}
              draggable={!isImporting && !isMissing}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/x-weftcut-media",
                  JSON.stringify({ mediaId: m.id, kind: m.kind }),
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
              title={t("media_pool.drag_hint", {
                defaultValue: "Drag onto a timeline track to add",
              })}
            >
              <MediaThumbnail mediaId={m.id} mediaKind={m.kind} />
              <span className={`media-kind kind-${m.kind.toLowerCase()}`}>
                {t(`kinds.${m.kind.toLowerCase()}`, { defaultValue: m.kind })}
              </span>
              <span className="media-label" title={m.path}>
                {m.label}
              </span>
              <span className="media-meta">
                {m.duration_us !== null
                  ? t("media_pool.duration", {
                      seconds: (m.duration_us / 1_000_000).toFixed(2),
                    })
                  : t("media_pool.no_duration")}
              </span>
              {m.width !== null && m.height !== null && (
                <span className="media-meta">
                  {m.width}×{m.height}
                </span>
              )}
              <span className="media-meta">{formatBytes(m.size_bytes, t)}</span>
              {isImporting ? (
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
              ) : isMissing ? (
                <span
                  className="media-missing-badge"
                  title={t("media_pool.missing_hint", { path: m.path })}
                >
                  {t("media_pool.missing")}
                </span>
              ) : (
                <button
                  className="media-preview-btn"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await mpvPlayMedia(m.id);
                    } catch (err) {
                      console.error("preview failed:", err);
                    }
                  }}
                  title={t("media_pool.preview")}
                >
                  ▶
                </button>
              )}
            </li>
          );
        })}
      </ul>
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

function formatTimecode(us: number): string {
  const totalMs = Math.max(0, Math.floor(us / 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

// Parse a flexible timecode string into microseconds, or null when invalid.
// Accepts: SS, SS.mmm, MM:SS(.mmm), HH:MM:SS(.mmm). Trailing milliseconds
// may be 1–3 digits and are padded right (e.g. "1.5" → 1500 ms).
function parseTimecode(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length > 3) return null;
  const tail = parts[parts.length - 1];
  const tailMatch = /^(\d+)(?:\.(\d{1,3}))?$/.exec(tail);
  if (!tailMatch) return null;
  const ss = Number(tailMatch[1]);
  const ms = tailMatch[2] ? Number(tailMatch[2].padEnd(3, "0")) : 0;
  let h = 0;
  let m = 0;
  if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
  } else if (parts.length === 2) {
    m = Number(parts[0]);
  }
  if (![h, m, ss, ms].every((n) => Number.isFinite(n) && n >= 0)) return null;
  if (parts.length >= 2 && (m >= 60 || ss >= 60)) return null;
  return (((h * 3600 + m * 60 + ss) * 1000) + ms) * 1000;
}

function CompiledPanel({
  graph,
  onClose,
}: {
  graph: CompiledGraph;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="compiler-panel">
      <header>
        <strong>{t("compiler.panel_title", { count: graph.node_count })}</strong>
        <button onClick={onClose}>{t("compiler.close")}</button>
      </header>
      <div className="compiler-meta">
        <span>
          {t("compiler.inputs_label")}:{" "}
          {graph.inputs.length === 0
            ? t("compiler.no_inputs")
            : graph.inputs.join(", ")}
        </span>
        <span>
          {t("compiler.maps_label")}: {graph.maps.join(" ")}
        </span>
      </div>
      <pre className="compiler-graph">{graph.filter_graph}</pre>
    </aside>
  );
}

