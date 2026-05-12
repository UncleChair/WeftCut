import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
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
  importMedia,
  mpvClosePreview,
  mpvPlayMedia,
  mpvPreviewProject,
  mpvSeek,
  mpvSetPaused,
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

  const seekTo = useCallback(async (tUs: number) => {
    setCurrentTimeUs(tUs);
    try {
      await mpvSeek(tUs);
    } catch (err) {
      console.warn("seek failed:", err);
    }
  }, []);

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
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

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
      </section>

      <section className="actions">
        <button onClick={() => run(addVideoTrack)} disabled={busy}>
          {t("actions.add_track")}
        </button>
        <button onClick={() => run(addDemoColorLayer)} disabled={busy}>
          {t("actions.add_color_layer")}
        </button>
        <button onClick={() => run(addDemoTextLayer)} disabled={busy}>
          {t("actions.add_text_layer")}
        </button>
        <button
          onClick={() => run(splitFirstLayer)}
          disabled={busy || !summary || summary.layer_count === 0}
        >
          {t("actions.split_first")}
        </button>
        <button
          onClick={() => run(async () => setCompiled(await compileProject()))}
          disabled={busy}
        >
          {t("actions.compile")}
        </button>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as ExportPreset)}
          title={t("export.preset_hint")}
          className="export-preset-select"
        >
          {EXPORT_PRESETS.map((p) => (
            <option key={p} value={p}>
              {t(`export.preset.${p}`, { defaultValue: p })}
            </option>
          ))}
        </select>
        <button
          onClick={async () => {
            const ext = presetExtension(preset);
            const path = await saveDialog({
              title: t("dialogs.export_title"),
              defaultPath: `videtor-export.${ext}`,
              filters: [
                {
                  name: t("dialogs.export_filter"),
                  extensions: [ext],
                },
              ],
            });
            if (typeof path !== "string") return;
            setExportState({ kind: "starting" });
            try {
              await exportProject(path, preset);
            } catch (e) {
              setExportState({ kind: "error", detail: String(e) });
            }
          }}
          disabled={
            busy ||
            (exportState?.kind === "starting" || exportState?.kind === "progress")
          }
        >
          {t("actions.export")}
        </button>
        <button
          onClick={async () => {
            const ext = presetExtension(preset);
            const path = await saveDialog({
              title: t("dialogs.export_queue_title"),
              defaultPath: `videtor-export-queue.${ext}`,
              filters: [
                {
                  name: t("dialogs.export_filter"),
                  extensions: [ext],
                },
              ],
            });
            if (typeof path !== "string") return;
            try {
              await exportQueueEnqueue(path, preset);
              setQueue(await exportQueueList());
            } catch (e) {
              console.warn("queue enqueue failed:", e);
            }
          }}
          disabled={busy}
          title={t("actions.queue_export_hint")}
        >
          {t("actions.queue_export")}
        </button>
        <span className="separator" />
        <button
          onClick={async () => {
            const picked = await openDialog({
              title: t("dialogs.import_title"),
              multiple: true,
              filters: [
                {
                  name: t("dialogs.media_filter"),
                  extensions: [
                    "mp4",
                    "mov",
                    "mkv",
                    "webm",
                    "avi",
                    "wav",
                    "mp3",
                    "flac",
                    "aac",
                    "m4a",
                    "ogg",
                    "png",
                    "jpg",
                    "jpeg",
                    "gif",
                    "webp",
                    "srt",
                    "ass",
                    "vtt",
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
          }}
          disabled={busy}
        >
          {t("actions.import_media")}
        </button>
        <span className="separator" />
        <button
          onClick={async () => {
            const path = await saveDialog({
              title: t("dialogs.save_title"),
              defaultPath: t("dialogs.save_default_name"),
              filters: [
                {
                  name: t("dialogs.project_filter"),
                  extensions: ["vproj"],
                },
              ],
            });
            if (typeof path === "string") {
              await run(() => projectSaveAs(path));
            }
          }}
          disabled={busy}
        >
          {t("actions.save_as")}
        </button>
        <button
          onClick={async () => {
            const path = await openDialog({
              title: t("dialogs.open_title"),
              directory: true,
              multiple: false,
            });
            if (typeof path === "string") {
              await run(() => projectOpen(path));
            }
          }}
          disabled={busy}
        >
          {t("actions.open")}
        </button>
        <span className="separator" />
        <button
          onClick={async () => {
            try {
              await mpvPreviewProject();
              setPaused(false);
            } catch (err) {
              setError(t("errors.preview_failed", { detail: String(err) }));
            }
          }}
          disabled={busy}
          title={t("transport.preview_project_hint")}
        >
          {t("transport.preview_project")}
        </button>
        <button
          onClick={async () => {
            try {
              await mpvClosePreview();
              setPaused(true);
            } catch (err) {
              console.warn("close preview failed:", err);
            }
          }}
          title={t("transport.close_preview_hint")}
        >
          {t("transport.close_preview")}
        </button>
        <button onClick={togglePlay} title={t("transport.play_pause_hint")}>
          {paused ? t("transport.play") : t("transport.pause")}
        </button>
        <span className="separator" />
        <button
          onClick={() => run(projectUndo)}
          disabled={busy || !summary?.history.can_undo}
        >
          {t("actions.undo")}
        </button>
        <button
          onClick={() => run(projectRedo)}
          disabled={busy || !summary?.history.can_redo}
        >
          {t("actions.redo")}
        </button>
        <span className="separator" />
        <button
          onClick={() => setTemplatePickerOpen(true)}
          title={t("actions.templates_hint")}
        >
          {t("actions.templates")}
        </button>
        <button
          onClick={() => setConnectOpen(true)}
          title={t("actions.connect_agent_hint")}
        >
          {t("actions.connect_agent")}
        </button>
        <button
          onClick={() => setActivityOpen(true)}
          title={t("actions.activity_hint")}
        >
          {t("actions.activity")}
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          title={t("actions.settings_hint")}
        >
          {t("actions.settings")}
        </button>
        {error && <span className="error">{error}</span>}
      </section>

      <main className="app-main">
        <section className="preview">
          <div id="video-surface" className="video-surface">
            <span className="placeholder">
              {t("preview.surface_placeholder")}
            </span>
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
          <MediaPool media={summary?.media ?? []} />
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

function MediaPool({ media }: { media: MediaSummary[] }) {
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
        {media.map((m) => (
          <li
            key={m.id}
            className="media-item"
            draggable
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
          </li>
        ))}
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

