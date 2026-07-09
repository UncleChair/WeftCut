import { save as saveDialog } from "@/bridge/dialog";
import { getCurrentWindow } from "@/bridge/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addColorLayer,
  addTextLayer,
  deleteLayer,
  importCancel,
  projectRedo,
  projectSave,
  projectSaveAs,
  projectSummary,
  projectUndo,
  type ProjectSummary,
} from "./ipc";
import { formatTimecode, frameDurUs, lastFrameAnchorUs } from "./frames";
import {
  playheadTimeUs,
  setPlayheadTimeUs,
} from "./state/playheadStore";
import { Timeline } from "./timeline/Timeline";
import { AgentMode } from "./agent/AgentMode";
import { RightPanel } from "./panels/RightPanel";
import { ConnectAgentPanel } from "./connect/ConnectAgentPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { MotifPicker } from "./motifs/MotifPicker";
import { tenBitExportCapable } from "./render/exportSettings";
import { AppDialog } from "./components/AppDialog";
import { AppTimecodeField } from "./components/AppTimecodeField";
import { WindowControls } from "./components/WindowControls";
import { Button } from "@/components/ui/button";
import { ImportProxyDialog } from "./panels/ImportProxyDialog";
import { MotifStaleDialog } from "./panels/MotifStaleDialog";
import { AppNotices } from "./components/AppNotices";
import { ExportSettingsDialog } from "./panels/ExportSettingsDialog";
import {
  PreviewSurface,
  type PreviewSurfaceHandle,
} from "./preview/PreviewSurface";
import { PlayheadTimecode } from "./preview/PlayheadTimecode";

import {
  Menu,
  MenuBar,
  MenuItem,
  MenuSeparator,
} from "./menu/Menu";
import { ViewMenu } from "./app/ViewMenu";
import { useAppWiring, useWindowTitle } from "./app/useAppWiring";
import { useExportFlow } from "./app/useExportFlow";
import { useImportReadiness } from "./app/useImportReadiness";
import { ExportPanel } from "./panels/ExportPanel";
import { MediaDropZone, MediaPool } from "./panels/MediaPool";
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "./i18n";
import {
  GlobeIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";
import {
  ShortcutBindingsProvider,
  useShortcuts,
  type HandlerMap,
  type OverrideMap,
} from "./shortcuts";
import { StatusBar } from "./logs/StatusBar";
import { LogConsole, type LogConsoleHandle } from "./logs/LogConsole";
import { useLogStore } from "./logs/store";
import {
  setMediaPoolDrawerOpen,
  toggleDisplayMode,
  useAppSettingsStore,
  useMediaPoolDrawerOpen,
} from "./settings/appSettingsStore";
import { logEmit } from "./ipc";

interface AppProps {
  /// Hop the root router back to the StartupScreen — wired by `main.tsx`.
  /// Called by File → Save and Close after a successful save flush.
  onCloseProject: () => void;
}

export function App({ onCloseProject }: AppProps) {
  const { t, i18n } = useTranslation();
  // MediaPool drawer state lives in the app-pref store (docs/data-model.md R.9).
  // Read through the atomic selector so a flip doesn't re-render anything that
  // doesn't depend on it.
  const mediaPoolDrawerOpen = useMediaPoolDrawerOpen();
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // Write-only: error text is surfaced through the status bar / log (see the
  // setError call sites), not rendered here, so we keep only the setter.
  const [, setError] = useState<string | null>(null);
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
  // Playhead time deliberately does NOT live in React state here: the engine
  // emits once per composition frame during playback, and routing that through
  // App-root state re-rendered the whole tree per frame (dev-mode memory
  // ratchet + prod CPU). It lives in playheadStore; consumers pick their tier
  // (transient / throttled / imperative) — see playheadStore.ts.
  const [paused, setPaused] = useState<boolean>(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logConsoleOpen, setLogConsoleOpen] = useState(false);
  const logConsoleRef = useRef<LogConsoleHandle | null>(null);
  const [motifPickerOpen, setMotifPickerOpen] = useState(false);
  // Timecode-edit state doubles as the field's seed value: capturing the
  // playhead at the moment editing opens (instead of live-updating the field
  // from a React-subscribed time) keeps the edit box stable during playback.
  const [tcEditUs, setTcEditUs] = useState<number | null>(null);
  // The project preview is a DOM `<video>` driven by `<PreviewSurface>`
  // (docs/data-model.md Q10). The transport buttons here delegate to its
  // imperative handle (play / pause / seek); playhead state flows back up via callbacks.
  const previewRef = useRef<PreviewSurfaceHandle | null>(null);

  // Fresh project session → playhead 0. The store is module-global and would
  // otherwise carry the previous project's position across a close/open
  // (the pre-store `useState(0)` reset with the App mount).
  useEffect(() => {
    setPlayheadTimeUs(0);
  }, []);

  // Centralised playhead clamp — Q5 of the frame-anchor playhead spec.
  // Every UI seek funnels through here so callers can pass raw boundary
  // values (`duration_us`, `playheadTimeUs() + step`, parsed timecode) and
  // the upper bound is enforced once. Lower bound at 0; upper at
  // `lastFrameAnchorUs` so the playhead can never sit on the
  // post-last-frame slot.
  const seekTo = useCallback((tUs: number) => {
    const fpsNum = summary?.composition.fps_num ?? 30;
    const fpsDen = summary?.composition.fps_den ?? 1;
    const durationUs = summary?.duration_us ?? 0;
    const upper = lastFrameAnchorUs(durationUs, fpsNum, fpsDen);
    const clamped = Math.max(0, Math.min(tUs, upper));
    // Optimistic store write: with no preview mounted (empty composition)
    // there is no engine emit, yet the playhead UI must still move.
    setPlayheadTimeUs(clamped);
    previewRef.current?.seekTo(clamped);
  }, [summary?.composition.fps_num, summary?.composition.fps_den, summary?.duration_us]);

  // R.7: click on a peek item → reveal that hidden track inline at its
  // natural accretion slot AND select the clicked layer. Single-track
  // exclusive (later peek-click replaces).
  const revealTrack = useCallback((trackId: string, layerId: string) => {
    setRevealedTrackId(trackId);
    setSelectedLayerId(layerId);
  }, []);

  // "New Motif" auto-places the fresh draft (MotifPicker.onDraftPlaced) and
  // should land the user on its property panel with the layer visible. The
  // owner track is only knowable from the refreshed summary (the layer sits
  // on a just-created, role-null Overlay track the AB view hides), so the
  // select + reveal is deferred here until the summary contains the layer.
  const [pendingRevealLayerId, setPendingRevealLayerId] = useState<string | null>(null);
  useEffect(() => {
    if (pendingRevealLayerId === null) return;
    const owner = (summary?.tracks ?? []).find((t) =>
      t.layers.some((l) => l.id === pendingRevealLayerId),
    );
    if (owner) {
      revealTrack(owner.id, pendingRevealLayerId);
      setPendingRevealLayerId(null);
    }
  }, [pendingRevealLayerId, summary, revealTrack]);

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

  const {
    pong,
    keybindings,
    setKeybindings,
    agentSession,
    exitAgentMode,
    staleMotifs,
    setStaleMotifs,
  } = useAppWiring({ refresh });
  useWindowTitle(summary?.name);

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
        // The user-facing error path is the status bar, not inline chrome. Push
        // every caught UI error into the log so the bar's error counter +
        // sticky-latest behavior surfaces it.
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

  // Import queue, per-media proxy/decodability readiness, and the import-proxy
  // dialog live in useImportReadiness; it takes `run` (defined above) so its
  // import callbacks route through the busy guard + refresh.
  const {
    importingMediaIds,
    proxyState,
    proxyStateRef,
    decodeProbeMemo,
    previewDecodableMediaIds,
    dialogItems,
    dialogHasAttention,
    clearDialogBatch,
    importMediaFiles,
  } = useImportReadiness({ summary, run, previewRef });
  // Export lifecycle (state, close guard, taskbar/notification mirrors, the
  // pipeline itself) lives in useExportFlow; the refs it takes as deps come
  // from useImportReadiness (other consumers below read them too).
  const {
    exportState,
    setExportState,
    exportDialogOpen,
    setExportDialogOpen,
    closeConfirmOpen,
    setCloseConfirmOpen,
    runExportWithSettings,
    openRenderPlayPopup,
  } = useExportFlow({ previewRef, proxyStateRef, decodeProbeMemo });

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

  // E2E-only: expose `window.__weftcutTest.exportClip`, wired to the real
  // export path. Stripped from prod (static `VITE_WEFTCUT_E2E` check).
  useEffect(() => {
    if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
    void import("./testhook/e2eHook").then(({ installExportHook }) =>
      installExportHook(runExportWithSettings, setPendingRevealLayerId),
    );
  }, [runExportWithSettings]);

  // No React-side preview init: the Rust `preview::PreviewRenderer` task
  // subscribes to actor commits and writes `<workspace>/Cache/preview/<hash>.mp4`;
  // PreviewSurface listens for the resulting events and swaps its `<video src>`.

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
    export: () => setExportDialogOpen(true),
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
      void seekTo(playheadTimeUs() - step);
    },
    seekFrameForward: () => {
      const fps = summary?.composition;
      const step = frameDurUs(fps?.fps_num ?? 30, fps?.fps_den ?? 1);
      void seekTo(playheadTimeUs() + step);
    },
    seekSecondBack: () => {
      void seekTo(playheadTimeUs() - 1_000_000);
    },
    seekSecondForward: () => {
      void seekTo(playheadTimeUs() + 1_000_000);
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
    // panel can still consume bound actions if it grows any (it has none
    // today). Floating editor panels (export, settings, motif-picker) are
    // deliberately suppressed — the user is
    // watching the agent, not driving the editor.
    return (
      <ShortcutBindingsProvider overrides={shortcutOverrides}>
        <AgentMode
          ref={previewRef}
          session={agentSession}
          summary={summary}
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
      {/* Frameless window: the header doubles as the title bar. The
          drag-region attribute only fires when the mousedown target IS
          the carrying element, so it sits on the header AND its
          non-interactive children — menus and buttons stay clickable. */}
      <header className="app-header" data-drag-region>
        <div className="header-left" data-drag-region>
          <h1 data-drag-region>{t("app.title")}</h1>
          <MenuBar>
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
              <MenuItem
                label={t("actions.add_color_layer")}
                onSelect={async () => {
                  const layerId = await addColorLayer({ tStartUs: playheadTimeUs() });
                  setPendingRevealLayerId(layerId);
                  await refresh();
                }}
              />
              <MenuItem
                label={t("actions.add_text_layer")}
                onSelect={async () => {
                  const layerId = await addTextLayer({ tStartUs: playheadTimeUs() });
                  setPendingRevealLayerId(layerId);
                  await refresh();
                }}
              />
              <MenuItem
                label={t("actions.motifs")}
                hint={t("actions.motifs_hint")}
                onSelect={() => setMotifPickerOpen(true)}
              />
            </Menu>

            <Menu label={t("menu.export")}>
              <MenuItem
                actionId="export"
                label={t("actions.export")}
                onSelect={() => setExportDialogOpen(true)}
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
          </MenuBar>
        </div>
        <div className="header-right" data-drag-region>
          {pong !== "ok" && pong !== "…" && (
            <span className="ping" data-drag-region>
              {t("app.core_status", { status: pong })}
            </span>
          )}
          <button
            className="locale-toggle"
            onClick={cycleLocale}
            title={t("language.switch_label")}
            aria-label={t("language.switch_label")}
          >
            <GlobeIcon className="globe-icon" size={14} aria-hidden />
            <span className="locale-toggle-label">
              {LOCALE_LABELS[(i18n.resolvedLanguage ?? "en-US") as Locale] ??
                "English"}
            </span>
          </button>
          <WindowControls />
        </div>
      </header>

      <main className={`app-main ${mediaPoolDrawerOpen ? "drawer-open" : ""}`}>
        <section className="preview">
          <div id="video-surface" className="video-surface">
            <PreviewSurface
              ref={previewRef}
              hasContent={(summary?.layer_count ?? 0) > 0}
              onTimeUpdate={setPlayheadTimeUs}
              onPausedChange={setPaused}
              previewDecodableOf={(id) => decodeProbeMemo.current.get(id) === "ok"}
            />
          </div>
          <div className="preview-transport" role="toolbar" aria-label="Preview transport">
            {tcEditUs !== null ? (
              <AppTimecodeField
                className="preview-timecode"
                valueUs={tcEditUs}
                fpsNum={summary?.composition.fps_num ?? 30}
                fpsDen={summary?.composition.fps_den ?? 1}
                autoFocus
                ariaLabel={t("transport.timecode_label")}
                onCommit={(us) => {
                  setTcEditUs(null);
                  void seekTo(us);
                }}
                onCancel={() => setTcEditUs(null)}
              />
            ) : (
              <PlayheadTimecode
                fpsNum={summary?.composition.fps_num ?? 30}
                fpsDen={summary?.composition.fps_den ?? 1}
                editHint={t("transport.timecode_edit_hint")}
                onActivate={() => setTcEditUs(playheadTimeUs())}
              />
            )}
            <div className="transport-buttons">
              <button
                onClick={() => seekTo(0)}
                title={t("transport.to_start_hint")}
                aria-label={t("transport.to_start_hint")}
              >
                <SkipBackIcon size={16} aria-hidden />
              </button>
              <button
                onClick={togglePlay}
                title={t("transport.play_pause_hint")}
                aria-label={t("transport.play_pause_hint")}
                disabled={(summary?.layer_count ?? 0) === 0}
              >
                {paused ? (
                  <PlayIcon size={16} aria-hidden />
                ) : (
                  <PauseIcon size={16} aria-hidden />
                )}
              </button>
              <button
                onClick={() => seekTo(summary?.duration_us ?? 0)}
                title={t("transport.to_end_hint")}
                aria-label={t("transport.to_end_hint")}
                disabled={!summary || summary.duration_us === 0}
              >
                <SkipForwardIcon size={16} aria-hidden />
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
            selectedLayerId={selectedLayerId}
            revealedTrackId={revealedTrackId}
            keybindings={keybindings}
            fpsNum={summary?.composition.fps_num ?? 30}
            fpsDen={summary?.composition.fps_den ?? 1}
            bladeMode={bladeMode}
            media={summary?.media ?? []}
            importing={importingMediaIds}
            proxyState={proxyState}
            previewDecodable={previewDecodableMediaIds}
            onExitBlade={() => setBladeMode(false)}
            onSelect={setSelectedLayerId}
            onSeek={seekTo}
            onMutated={refresh}
          />
        </section>

        <MediaDropZone>
          <MediaPool
            media={summary?.media ?? []}
            importing={importingMediaIds}
            proxyState={proxyState}
            previewDecodable={previewDecodableMediaIds}
            fpsNum={summary?.composition.fps_num ?? 30}
            fpsDen={summary?.composition.fps_den ?? 1}
            onCancelImport={async (id) => {
              await importCancel(id).catch(() => false);
            }}
          />
        </MediaDropZone>

        <section className="properties">
          <RightPanel
            tracks={summary?.tracks ?? []}
            groups={summary?.groups ?? []}
            selectedLayerId={selectedLayerId}
            onSelect={setSelectedLayerId}
            onMutated={refresh}
            fpsNum={summary?.composition.fps_num ?? 30}
            fpsDen={summary?.composition.fps_den ?? 1}
            onRevealTrack={revealTrack}
          />
        </section>
      </main>

      {/* One modal overlay: the settings form while idle, the progress panel
          once an export is running (exportState set). Keeping the dialog open
          through the export means progress shows in the same popup and blocks
          UI interaction until the user dismisses on complete/error. */}
      {exportDialogOpen && summary && exportState == null && (
        <ExportSettingsDialog
          comp={summary.composition}
          // Render-time snapshot: the dialog opens via a state flip, so this
          // reads the playhead at open — a live-updating default is pointless.
          currentTimeUs={playheadTimeUs()}
          durationUs={summary.duration_us}
          hasTenBitSource={summary.media.some(
            (m) => m.kind === "Video" && tenBitExportCapable(m),
          )}
          onCancel={() => setExportDialogOpen(false)}
          onConfirm={(settings, path, range) => {
            // Don't close — the progress panel takes over the same overlay.
            void runExportWithSettings(settings, path, range);
          }}
        />
      )}
      {exportState && (
        <ExportPanel
          state={exportState}
          onClose={() => {
            setExportState(null);
            setExportDialogOpen(false);
          }}
          onPlay={openRenderPlayPopup}
        />
      )}
      {closeConfirmOpen && (
        <AppDialog
          title={t("close_guard.title")}
          onClose={() => setCloseConfirmOpen(false)}
          closeLabel={t("close_guard.stay")}
          panelClassName="settings-panel"
        >
          <div className="settings-body">
            <div className="settings-card">
              <p className="settings-blurb">{t("close_guard.body")}</p>
              <div className="export-actions">
                <Button size="lg" onClick={() => setCloseConfirmOpen(false)}>
                  {t("close_guard.stay")}
                </Button>
                <Button
                  variant="destructive"
                  size="lg"
                  onClick={() => void getCurrentWindow().destroy()}
                >
                  {t("close_guard.quit")}
                </Button>
              </div>
            </div>
          </div>
        </AppDialog>
      )}
      {dialogHasAttention && (
        <ImportProxyDialog
          items={dialogItems}
          onDismiss={clearDialogBatch}
        />
      )}
      {staleMotifs.length > 0 && (
        <MotifStaleDialog
          entries={staleMotifs}
          onDone={() => setStaleMotifs([])}
        />
      )}
      <AppNotices />
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
      {motifPickerOpen && (
        <MotifPicker
          onClose={() => setMotifPickerOpen(false)}
          onAdded={refresh}
          onDraftPlaced={setPendingRevealLayerId}
          currentTimeUs={playheadTimeUs()}
          tracks={summary?.tracks ?? []}
          fpsNum={summary?.composition.fps_num ?? 30}
          fpsDen={summary?.composition.fps_den ?? 1}
          compWidth={summary?.composition.width ?? 1920}
          compHeight={summary?.composition.height ?? 1080}
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
