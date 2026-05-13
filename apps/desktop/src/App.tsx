import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addDemoColorLayer,
  addDemoTextLayer,
  addVideoTrack,
  compileProject,
  EXPORT_EVENTS,
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
  mpvPreviewProject,
  mpvSeek,
  mpvSetPaused,
  mpvSetSurfaceRect,
  ping,
  presetExtension,
  projectOpen,
  projectRedo,
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
import { PropertyPanel } from "./properties/PropertyPanel";
import { ActivityPanel } from "./activity/ActivityPanel";
import { ConnectAgentPanel } from "./connect/ConnectAgentPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { TemplatePicker } from "./templates/TemplatePicker";
import { MediaThumbnail } from "./panels/MediaThumbnail";
import {
  Menu,
  MenuHeading,
  MenuItem,
  MenuSeparator,
} from "./menu/Menu";
import { useHideMpvHost } from "./mpv/useHideMpvHost";
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "./i18n";

export function App() {
  const { t, i18n } = useTranslation();
  const [pong, setPong] = useState<string>("…");
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [compiled, setCompiled] = useState<CompiledGraph | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [currentTimeUs, setCurrentTimeUs] = useState<number>(0);
  const [paused, setPaused] = useState<boolean>(true);
  const [preset, setPreset] = useState<ExportPreset>("H264Mp4_1080p");
  const [queue, setQueue] = useState<ExportQueueItem[]>([]);
  const [hwProbe, setHwProbe] = useState<HwEncoderProbe | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [editingTimecode, setEditingTimecode] = useState<string | null>(null);
  const [previewInit, setPreviewInit] = useState<PreviewInitState>("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);
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

  // Suppress incoming `mpv:time` updates for a short window after any user
  // seek so libmpv's lagged readings don't fight the user's scrub. Long
  // enough to absorb the seek round-trip + the next ~30 fps poller tick.
  const lastUserSeekAtRef = useRef<number>(0);

  const seekTo = useCallback(async (tUs: number) => {
    lastUserSeekAtRef.current = performance.now();
    setCurrentTimeUs(tUs);
    try {
      await mpvSeek(tUs);
    } catch (err) {
      console.warn("seek failed:", err);
    }
  }, []);

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

  const togglePlay = useCallback(async () => {
    const next = !paused;
    setPaused(next);
    try {
      await mpvSetPaused(next);
    } catch (err) {
      console.warn("set paused failed:", err);
    }
  }, [paused]);

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
    exportQueueList().then(setQueue).catch(() => {});
    hwEncoderProbe().then(setHwProbe).catch(() => {});
  }, [refresh]);

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

  // Playhead sync — backend polls libmpv's playback-time at ~30 fps and emits
  // on change. Drop incoming values briefly after a user seek so the UI
  // playhead follows the user's pointer, not libmpv's lagged read.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<{ t_us: number }>("mpv:time", (e) => {
        if (performance.now() - lastUserSeekAtRef.current < 250) return;
        setCurrentTimeUs(e.payload.t_us);
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

  // Embed-mode surface sync. The Rust side has a child HWND (Windows) that
  // hosts the libmpv VO; we stream the placeholder div's rect to it so the
  // native surface tracks layout. ResizeObserver catches element-size shifts;
  // window 'resize' catches everything else (window resize, DPR change after
  // monitor move). Physical pixels = CSS px × devicePixelRatio. Sent
  // unconditionally — non-Windows builds no-op in Rust. Mounting fires once
  // immediately so the surface has a real rect before the first preview.
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = videoSurfaceRef.current;
    if (!el) return;
    let cancelled = false;
    const sync = () => {
      if (cancelled) return;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(r.left * dpr);
      const y = Math.round(r.top * dpr);
      const w = Math.round(r.width * dpr);
      const h = Math.round(r.height * dpr);
      mpvSetSurfaceRect(x, y, w, h).catch((err) => {
        console.warn("set surface rect failed:", err);
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  // ---- Menu-bar action handlers (extracted from former inline onClicks). ----

  const openProject = useCallback(async () => {
    const path = await openDialog({
      title: t("dialogs.open_title"),
      directory: true,
      multiple: false,
    });
    if (typeof path === "string") {
      await run(() => projectOpen(path));
    }
  }, [run, t]);

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
      defaultPath: `videtor-export.${ext}`,
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
      defaultPath: `videtor-export-queue.${ext}`,
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

  // Compile the project graph and load it into libmpv. Called once
  // automatically when the project first becomes non-empty (see the
  // effect below), and reused by the in-surface retry button if init
  // rejects. After a successful call, every subsequent commit
  // hot-reloads the graph on the Rust side — no further init needed.
  // libmpv loads paused (set in `ensure_init`), so the user controls
  // playback start via the transport button.
  const initPreview = useCallback(async () => {
    setPreviewInit("initializing");
    setPreviewError(null);
    try {
      await mpvPreviewProject();
      setPreviewInit("ready");
    } catch (err) {
      setPreviewInit("error");
      setPreviewError(String(err));
    }
  }, []);

  // Auto-init preview the first time the project has content. App boots with
  // a blank `Project::new_blank("untitled")` (zero layers), so the natural
  // edge is `layer_count: 0 → ≥1` — fires on first import / first
  // demo-layer-add, or once when a non-empty `.vproj` is opened. The state
  // machine guards re-entry so a 10-file multi-select doesn't fire init ten
  // times; subsequent commits hot-reload the graph on the Rust side without
  // a second call.
  useEffect(() => {
    if (previewInit !== "idle") return;
    if (!summary || summary.layer_count === 0) return;
    void initPreview();
  }, [summary, previewInit, initPreview]);

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

  return (
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
      </section>

      <section className="menu-bar">
        <Menu label={t("menu.file")}>
          <MenuItem
            label={t("actions.open")}
            onSelect={openProject}
            disabled={busy}
          />
          <MenuItem
            label={t("actions.save_as")}
            onSelect={saveProject}
            disabled={busy}
          />
          <MenuSeparator />
          <MenuItem
            label={t("actions.import_media")}
            onSelect={importMediaFiles}
            disabled={busy}
          />
        </Menu>

        <Menu label={t("menu.edit")}>
          <MenuItem
            label={t("actions.undo")}
            onSelect={() => run(projectUndo)}
            disabled={busy || !summary?.history.can_undo}
          />
          <MenuItem
            label={t("actions.redo")}
            onSelect={() => run(projectRedo)}
            disabled={busy || !summary?.history.can_redo}
          />
          <MenuSeparator />
          <MenuItem
            label={t("actions.split_first")}
            onSelect={() => run(splitFirstLayer)}
            disabled={busy || !summary || summary.layer_count === 0}
          />
        </Menu>

        <Menu label={t("menu.insert")}>
          <MenuItem
            label={t("actions.add_track")}
            onSelect={() => run(addVideoTrack)}
            disabled={busy}
          />
          <MenuItem
            label={t("actions.add_color_layer")}
            onSelect={() => run(addDemoColorLayer)}
            disabled={busy}
          />
          <MenuItem
            label={t("actions.add_text_layer")}
            onSelect={() => run(addDemoTextLayer)}
            disabled={busy}
          />
          <MenuSeparator />
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
          <MenuItem
            label={t("actions.activity")}
            hint={t("actions.activity_hint")}
            onSelect={() => setActivityOpen(true)}
          />
          <MenuSeparator />
          <MenuItem
            label={t("actions.settings")}
            hint={t("actions.settings_hint")}
            onSelect={() => setSettingsOpen(true)}
          />
        </Menu>

        {error && <span className="error">{error}</span>}
      </section>

      <main className="app-main">
        <section className="preview">
          <div
            id="video-surface"
            className="video-surface"
            ref={videoSurfaceRef}
          >
            <PreviewSurfaceContent
              previewInit={previewInit}
              previewError={previewError}
              hasContent={(summary?.layer_count ?? 0) > 0}
              onRetry={initPreview}
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
                disabled={previewInit !== "ready"}
              >
                {previewInit === "initializing" ? (
                  <span className="preview-spinner-inline" aria-hidden="true" />
                ) : paused ? (
                  t("transport.play")
                ) : (
                  t("transport.pause")
                )}
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
          <Timeline
            tracks={summary?.tracks ?? []}
            durationUs={summary?.duration_us ?? 0}
            currentTimeUs={currentTimeUs}
            selectedLayerId={selectedLayerId}
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
          <PropertyPanel
            tracks={summary?.tracks ?? []}
            selectedLayerId={selectedLayerId}
            onMutated={refresh}
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
        <SettingsPanel onClose={() => setSettingsOpen(false)} />
      )}
      {activityOpen && (
        <ActivityPanel onClose={() => setActivityOpen(false)} />
      )}
      {templatePickerOpen && (
        <TemplatePicker
          onClose={() => setTemplatePickerOpen(false)}
          onAdded={refresh}
          compositionDurationUs={summary?.duration_us ?? 0}
          tracks={summary?.tracks ?? []}
        />
      )}
    </div>
  );
}

// Tri-state content rendered inside `#video-surface`. On Windows the libmpv
// host HWND sits above the WebView2 surface, so the `ready` branch returns
// `null` — libmpv covers whatever React would have drawn. On non-Windows /
// disabled-mpv builds the React content stays visible. Order matters: the
// error branch is checked before the empty branch because a failed init on
// a project with content should surface the failure, not the empty hint.
function PreviewSurfaceContent({
  previewInit,
  previewError,
  hasContent,
  onRetry,
}: {
  previewInit: PreviewInitState;
  previewError: string | null;
  hasContent: boolean;
  onRetry: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  if (previewInit === "error") {
    return (
      <div className="preview-error" role="alert">
        <span className="preview-error-title">
          {t("preview.init_failed")}
        </span>
        {previewError && (
          <span className="preview-error-detail">{previewError}</span>
        )}
        <button className="preview-retry" onClick={() => void onRetry()}>
          {t("preview.retry")}
        </button>
      </div>
    );
  }
  if (previewInit === "initializing") {
    return (
      <div className="preview-loading" aria-live="polite">
        <span className="preview-spinner" aria-hidden="true" />
        <span className="placeholder">{t("preview.preparing")}</span>
      </div>
    );
  }
  if (previewInit === "ready") {
    return null;
  }
  // idle: nothing has triggered init yet (project still empty).
  return (
    <span className="placeholder">
      {hasContent ? t("preview.preparing") : t("preview.empty_hint")}
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
  useHideMpvHost();
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

// Preview is "ignited" once per session via `mpvPreviewProject()`. After that
// the Rust hot-reload subscriber re-applies the compiled graph on every
// project commit, so we never call init twice. `error` is the recoverable
// terminal: the in-surface Retry button calls `initPreview()` again, which
// resets back through `initializing`.
type PreviewInitState = "idle" | "initializing" | "ready" | "error";

function ExportPanel({
  state,
  onClose,
}: {
  state: ExportState;
  onClose: () => void;
}) {
  useHideMpvHost();
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
                  "application/x-videtor-media",
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
  useHideMpvHost();
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

