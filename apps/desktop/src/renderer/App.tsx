import { save as saveDialog } from "@/bridge/dialog";
import { getCurrentWindow } from "@/bridge/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addColorLayer,
  addTextLayer,
  deleteLayer,
  importCancel,
  pasteLayer,
  projectRedo,
  projectSave,
  projectSaveAs,
  projectSummary,
  projectUndo,
  type ProjectSummary,
} from "./ipc";
import { frameDurUs } from "./frames";
import {
  playheadTimeUs,
  setPlayheadTimeUs,
} from "./state/playheadStore";
import { setSelectedLayerId, useSelectedLayerId } from "./state/selectionStore";
import { clampSeekUs, registerRevealTrack } from "./state/navigation";
import { Timeline } from "./timeline/Timeline";
import { AgentMode } from "./agent/AgentMode";
import { RightPanel } from "./panels/RightPanel";
import { ConnectAgentPanel } from "./connect/ConnectAgentPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { MotifPicker } from "./motifs/MotifPicker";
import { tenBitExportCapable } from "./render/exportSettings";
import { AppDialog } from "./components/AppDialog";
import { Button } from "@/components/ui/button";
import { ImportProxyDialog } from "./panels/ImportProxyDialog";
import { MotifStaleDialog } from "./panels/MotifStaleDialog";
import { useAppNotices } from "./components/useAppNotices";
import { SystemStatusPanel } from "./components/SystemStatusPanel";
import {
  systemNoticeLogMessage,
  type SystemSettingsTarget,
} from "./components/systemStatus";
import { PickOverlayHost } from "./colorpick/PickOverlayHost";
import { ExportSettingsDialog } from "./panels/ExportSettingsDialog";
import { type PreviewSurfaceHandle } from "./preview/PreviewSurface";
import { SearchPalette } from "./search/SearchPalette";

import { AppMenuBar } from "./app/AppMenuBar";
import { PreviewSection } from "./app/PreviewSection";
import { useAppWiring, useWindowTitle } from "./app/useAppWiring";
import { useExportFlow } from "./app/useExportFlow";
import { useImportReadiness } from "./app/useImportReadiness";
import { ExportPanel } from "./panels/ExportPanel";
import { MediaDropZone, MediaPool } from "./panels/MediaPool";
import { ShortcutBindingsProvider } from "./shortcuts/bindings-context";
import {
  useShortcuts,
  type HandlerMap,
  type OverrideMap,
} from "./shortcuts/useShortcuts";
import { StatusBar } from "./logs/StatusBar";
import { LogConsole, type LogConsoleHandle } from "./logs/LogConsole";
import { useLogStore } from "./logs/store";
import { useCommandProvider } from "./commands/registry";
import { buildAppCommands } from "./commands/appCommands";
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
  const { t } = useTranslation();
  // MediaPool drawer state lives in the app-pref store (docs/data-model.md R.9).
  // Read through the atomic selector so a flip doesn't re-render anything that
  // doesn't depend on it.
  const mediaPoolDrawerOpen = useMediaPoolDrawerOpen();
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // Write-only: error text is surfaced through the status bar / log (see the
  // setError call sites), not rendered here, so we keep only the setter.
  const [, setError] = useState<string | null>(null);
  const selectedLayerId = useSelectedLayerId();
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
  const [settingsCategory, setSettingsCategory] =
    useState<SystemSettingsTarget>("general");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [logConsoleOpen, setLogConsoleOpen] = useState(false);
  const [systemStatusOpen, setSystemStatusOpen] = useState(false);
  const logConsoleRef = useRef<LogConsoleHandle | null>(null);
  const [motifPickerOpen, setMotifPickerOpen] = useState(false);
  const systemNotices = useAppNotices();
  const logReady = useLogStore((state) => state.ready);
  const loggedSystemNoticeCodes = useRef(new Set<string>());
  // The project preview is a DOM `<video>` driven by `<PreviewSurface>`
  // (docs/data-model.md Q10). The transport buttons here delegate to its
  // imperative handle (play / pause / seek); playhead state flows back up via callbacks.
  const previewRef = useRef<PreviewSurfaceHandle | null>(null);
  // Timeline-local clipboard. It intentionally remembers the copied layer,
  // independent of later selection changes; App remounts for each project.
  const copiedLayerIdRef = useRef<string | null>(null);

  // Fresh project session → playhead 0. The store is module-global and would
  // otherwise carry the previous project's position across a close/open
  // (the pre-store `useState(0)` reset with the App mount).
  useEffect(() => {
    setPlayheadTimeUs(0);
    setSelectedLayerId(null);
  }, []);

  // Centralised playhead clamp — Q5 of the frame-anchor playhead spec.
  // Every UI seek funnels through here so callers can pass raw boundary
  // values (`duration_us`, `playheadTimeUs() + step`, parsed timecode) and
  // the upper bound is enforced once. Lower bound at 0; upper at
  // `lastFrameAnchorUs` so the playhead can never sit on the
  // post-last-frame slot.
  const seekTo = useCallback((tUs: number) => {
    const clamped = clampSeekUs(tUs);
    // Optimistic store write: with no preview mounted (empty composition)
    // there is no engine emit, yet the playhead UI must still move.
    setPlayheadTimeUs(clamped);
    previewRef.current?.seekTo(clamped);
  }, []);

  // R.7: click on a peek item → reveal that hidden track inline at its
  // natural accretion slot AND select the clicked layer. Single-track
  // exclusive (later peek-click replaces).
  const revealTrack = useCallback((trackId: string, layerId: string) => {
    setRevealedTrackId(trackId);
    setSelectedLayerId(layerId);
  }, []);

  // Palette navigation reaches R.7 reveal-track through the module-level
  // registry (state/navigation.ts) — App owns the revealedTrackId state.
  useEffect(() => registerRevealTrack(revealTrack), [revealTrack]);

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

  const openSettings = useCallback((category: SystemSettingsTarget = "general") => {
    setSettingsCategory(category);
    setSettingsOpen(true);
  }, []);

  // Capability notices are current state first, but they also belong in the
  // workspace's System log as an auditable session event. The backend log bus
  // does not exist before a workspace opens, so mirror them once it is ready.
  useEffect(() => {
    if (!logReady) return;
    for (const notice of systemNotices) {
      if (loggedSystemNoticeCodes.current.has(notice.code)) continue;
      loggedSystemNoticeCodes.current.add(notice.code);
      void logEmit({
        level: notice.level,
        category: { kind: "System" },
        source: { kind: "System" },
        message: systemNoticeLogMessage(notice),
        details: { notice_code: notice.code },
      }).catch(() => {
        loggedSystemNoticeCodes.current.delete(notice.code);
      });
    }
  }, [logReady, systemNotices]);

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

  const copySelected = useCallback(() => {
    if (selectedLayerId) copiedLayerIdRef.current = selectedLayerId;
  }, [selectedLayerId]);

  const pasteAtPlayhead = useCallback(async () => {
    const sourceLayerId = copiedLayerIdRef.current;
    if (!sourceLayerId) return;
    try {
      const pastedLayerId = await pasteLayer(sourceLayerId, playheadTimeUs());
      setPendingRevealLayerId(pastedLayerId);
      await refresh();
    } catch (err) {
      console.error("paste failed:", err);
    }
  }, [refresh]);

  // Wire all v1 shortcut bindings. The handler map is rebuilt each
  // render — fine, because `useShortcuts` reads through a ref so the
  // window listener never reattaches just because handler identities
  // changed. The listener only reattaches when the resolved binding
  // entries change (i.e. when user overrides land later).
  const toggleLogConsole = useCallback(() => {
    setSystemStatusOpen(false);
    setLogConsoleOpen((open) => !open);
    useLogStore.getState().acknowledgeErrorSticky();
  }, []);

  const focusLogSearch = useCallback(() => {
    setSystemStatusOpen(false);
    setLogConsoleOpen(true);
    // Defer focus to after the console mounts.
    setTimeout(() => {
      logConsoleRef.current?.focusSearch();
    }, 0);
  }, []);

  const toggleSystemStatus = useCallback(() => {
    setLogConsoleOpen(false);
    setSystemStatusOpen((open) => !open);
  }, []);

  const openSystemSettings = useCallback(
    (category: SystemSettingsTarget) => {
      setLogConsoleOpen(false);
      setSystemStatusOpen(false);
      openSettings(category);
    },
    [openSettings],
  );

  const shortcutHandlers: HandlerMap = {
    save: saveProjectNow,
    saveAs: saveProject,
    closeProject: saveAndClose,
    undo: () => run(projectUndo),
    redo: () => run(projectRedo),
    togglePlay,
    deleteSelected,
    copySelected,
    pasteAtPlayhead,
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
    openSearchPalette: () => {
      // Agent mode doesn't mount the palette — setting the flag would sit
      // latent and pop the palette open when the session ends.
      if (!agentSession) setPaletteOpen(true);
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

  // Shared by the Insert menu and the search palette — one implementation,
  // two entry points.
  const handleAddColorLayer = useCallback(async () => {
    const layerId = await addColorLayer({ tStartUs: playheadTimeUs() });
    setPendingRevealLayerId(layerId);
    await refresh();
  }, [refresh]);

  const handleAddTextLayer = useCallback(async () => {
    const layerId = await addTextLayer({ tStartUs: playheadTimeUs() });
    setPendingRevealLayerId(layerId);
    await refresh();
  }, [refresh]);

  useCommandProvider(() =>
    buildAppCommands(
      shortcutHandlers,
      {
        addColorLayer: handleAddColorLayer,
        addTextLayer: handleAddTextLayer,
        openMotifPicker: () => setMotifPickerOpen(true),
        openConnect: () => setConnectOpen(true),
        openSettings: () => setSettingsOpen(true),
      },
      {
        busy,
        canUndo: !!summary?.history.can_undo,
        canRedo: !!summary?.history.can_redo,
        canBlade: !!summary && summary.layer_count > 0,
        exportLocked:
          busy || exportState?.kind === "starting" || exportState?.kind === "progress",
      },
    ),
  );

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
      <div className="app-top-chrome">
        <AppMenuBar
          busy={busy}
          pong={pong}
          canUndo={!!summary?.history.can_undo}
          canRedo={!!summary?.history.can_redo}
          canBlade={!!summary && summary.layer_count > 0}
          exportLocked={
            busy ||
            exportState?.kind === "starting" ||
            exportState?.kind === "progress"
          }
          onImportMedia={importMediaFiles}
          onSave={saveProjectNow}
          onSaveAs={saveProject}
          onSaveAndClose={saveAndClose}
          onUndo={() => run(projectUndo)}
          onRedo={() => run(projectRedo)}
          onToggleBladeMode={() => setBladeMode((v) => !v)}
          onAddColorLayer={handleAddColorLayer}
          onAddTextLayer={handleAddTextLayer}
          onOpenMotifPicker={() => setMotifPickerOpen(true)}
          onOpenExport={() => setExportDialogOpen(true)}
          onOpenConnect={() => setConnectOpen(true)}
          onOpenSettings={() => openSettings("general")}
          onOpenSearch={() => setPaletteOpen(true)}
        />
      </div>

      <main className={`app-main ${mediaPoolDrawerOpen ? "drawer-open" : ""}`}>
        <PreviewSection
          previewRef={previewRef}
          summary={summary}
          paused={paused}
          onPausedChange={setPaused}
          onSeek={seekTo}
          onTogglePlay={togglePlay}
          previewDecodableOf={(id) => decodeProbeMemo.current.get(id) === "ok"}
        />

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
      <PickOverlayHost />
      {connectOpen && (
        <ConnectAgentPanel onClose={() => setConnectOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          initialCategory={settingsCategory}
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
      {systemStatusOpen && (
        <SystemStatusPanel
          notices={systemNotices}
          onClose={() => setSystemStatusOpen(false)}
          onOpenSettings={openSystemSettings}
        />
      )}
      {paletteOpen && <SearchPalette onClose={() => setPaletteOpen(false)} />}
      <StatusBar
        notices={systemNotices}
        onOpenSystemStatus={toggleSystemStatus}
        onToggleLogs={toggleLogConsole}
      />
    </div>
    </ShortcutBindingsProvider>
  );
}
