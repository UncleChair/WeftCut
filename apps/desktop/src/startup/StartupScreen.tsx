import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  projectNewWorkspace,
  projectOpen,
  recentsList,
  recentsRemove,
  type CanvasPreset,
  type RecentEntry,
} from "../ipc";

interface Props {
  /// Called once the user has successfully picked or created a workspace.
  /// The host (`main.tsx`) flips the rendered tree to `<App />`.
  onWorkspaceReady: () => void;
}

/// Top-level entry surface per workspace-redesign Q7. Every editor session
/// starts here; the user must pick Create / Open / Recent to advance into
/// the editor. There is no "blank-on-boot" editor surface anymore.
export function StartupScreen({ onWorkspaceReady }: Props) {
  const { t } = useTranslation();
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const refreshRecents = useCallback(async () => {
    try {
      setRecents(await recentsList());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  const runProtected = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const openWorkspaceFolder = useCallback(async () => {
    const picked = await openDialog({
      title: t("startup.open_dialog_title"),
      directory: true,
      multiple: false,
    });
    if (typeof picked !== "string") return;
    await runProtected(async () => {
      await projectOpen(picked);
      onWorkspaceReady();
    });
  }, [t, runProtected, onWorkspaceReady]);

  const openRecent = useCallback(
    async (entry: RecentEntry) => {
      await runProtected(async () => {
        try {
          await projectOpen(entry.path);
          onWorkspaceReady();
        } catch (e) {
          // Most likely the folder was moved or deleted on disk. Offer to
          // drop it from the list rather than leaving the user stuck.
          const detail = String(e);
          setError(t("startup.recent_open_failed", { detail }));
          await recentsRemove(entry.path).catch(() => {});
          await refreshRecents();
          throw e;
        }
      });
    },
    [t, runProtected, onWorkspaceReady, refreshRecents],
  );

  return (
    <div className="startup-screen">
      <div className="startup-panel">
        <header className="startup-header">
          <h1>{t("app.title")}</h1>
          <p className="startup-subtitle">{t("startup.subtitle")}</p>
        </header>

        <div className="startup-actions">
          <button
            className="startup-action primary"
            onClick={() => setNewProjectOpen(true)}
            disabled={busy}
          >
            <span className="startup-action-icon" aria-hidden="true">＋</span>
            <span className="startup-action-label">{t("startup.new_project")}</span>
          </button>
          <button
            className="startup-action"
            onClick={openWorkspaceFolder}
            disabled={busy}
          >
            <span className="startup-action-icon" aria-hidden="true">📂</span>
            <span className="startup-action-label">{t("startup.open_folder")}</span>
          </button>
        </div>

        {error && <p className="startup-error">{error}</p>}

        <section className="startup-recent">
          <h2>{t("startup.recent_heading")}</h2>
          {recents === null ? (
            <p className="startup-recent-empty">{t("startup.recent_loading")}</p>
          ) : recents.length === 0 ? (
            <p className="startup-recent-empty">{t("startup.recent_empty")}</p>
          ) : (
            <ul className="startup-recent-list">
              {recents.map((entry) => (
                <li key={entry.path}>
                  <button
                    className="startup-recent-item"
                    onClick={() => openRecent(entry)}
                    disabled={busy}
                    title={entry.path}
                  >
                    <span className="startup-recent-name">{entry.name}</span>
                    <span className="startup-recent-meta">
                      {formatLastOpened(entry.last_opened, t)}
                    </span>
                    <span className="startup-recent-path">{entry.path}</span>
                  </button>
                  <button
                    className="startup-recent-remove"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await recentsRemove(entry.path).catch(() => {});
                      await refreshRecents();
                    }}
                    title={t("startup.recent_remove_hint")}
                    aria-label={t("startup.recent_remove_hint")}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {newProjectOpen && (
        <NewProjectForm
          onCancel={() => setNewProjectOpen(false)}
          onCreated={() => {
            setNewProjectOpen(false);
            onWorkspaceReady();
          }}
        />
      )}
    </div>
  );
}

const CANVAS_PRESETS: { key: string; preset: CanvasPreset }[] = [
  { key: "hd1080p30", preset: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } },
  { key: "hd1080p60", preset: { width: 1920, height: 1080, fpsNum: 60, fpsDen: 1 } },
  { key: "uhd4k30", preset: { width: 3840, height: 2160, fpsNum: 30, fpsDen: 1 } },
  // 29.97 — broadcast-standard NTSC fractional rate. Rational handling
  // matters because 30000/1001 != 29.97 to ffmpeg.
  { key: "ntsc1080p", preset: { width: 1920, height: 1080, fpsNum: 30000, fpsDen: 1001 } },
];

function NewProjectForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("untitled");
  const [parentFolder, setParentFolder] = useState<string | null>(null);
  const [presetKey, setPresetKey] = useState<string>(CANVAS_PRESETS[0]!.key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = CANVAS_PRESETS.find((p) => p.key === presetKey)!.preset;

  const pickFolder = useCallback(async () => {
    const picked = await openDialog({
      title: t("new_project.pick_parent_title"),
      directory: true,
      multiple: false,
    });
    if (typeof picked === "string") {
      setParentFolder(picked);
    }
  }, [t]);

  const submit = useCallback(async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed || !parentFolder) return;
    setBusy(true);
    setError(null);
    try {
      await projectNewWorkspace({
        parentFolder,
        name: trimmed,
        canvas: preset,
      });
      onCreated();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [busy, name, parentFolder, preset, onCreated]);

  return (
    <div
      className="new-project-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="new-project-panel">
        <header>
          <h2>{t("new_project.title")}</h2>
        </header>

        <label className="new-project-row">
          <span>{t("new_project.name")}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
        </label>

        <div className="new-project-row">
          <span>{t("new_project.location")}</span>
          <div className="new-project-folder">
            <span className="new-project-folder-path" title={parentFolder ?? ""}>
              {parentFolder ?? t("new_project.location_placeholder")}
            </span>
            <button onClick={pickFolder} disabled={busy}>
              {t("new_project.choose_folder")}
            </button>
          </div>
        </div>

        <label className="new-project-row">
          <span>{t("new_project.canvas_preset")}</span>
          <select
            value={presetKey}
            onChange={(e) => setPresetKey(e.target.value)}
            disabled={busy}
          >
            {CANVAS_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {t(`new_project.preset.${p.key}`, {
                  defaultValue: p.key,
                })}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="new-project-error">{error}</p>}

        <footer className="new-project-actions">
          <button onClick={onCancel} disabled={busy}>
            {t("new_project.cancel")}
          </button>
          <button
            className="primary"
            onClick={submit}
            disabled={busy || !parentFolder || !name.trim()}
          >
            {busy ? t("new_project.creating") : t("new_project.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function formatLastOpened(iso: string, t: TFunction): string {
  const opened = new Date(iso);
  if (isNaN(opened.getTime())) return iso;
  const now = new Date();
  const diffMs = now.getTime() - opened.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return t("startup.time_just_now");
  if (diffMs < hour) {
    return t("startup.time_minutes_ago", {
      count: Math.floor(diffMs / minute),
    });
  }
  if (diffMs < day) {
    return t("startup.time_hours_ago", { count: Math.floor(diffMs / hour) });
  }
  if (diffMs < 7 * day) {
    return t("startup.time_days_ago", { count: Math.floor(diffMs / day) });
  }
  return opened.toLocaleDateString();
}
