import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { documentDir } from "@tauri-apps/api/path";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "../i18n";
import {
  projectNewWorkspace,
  projectOpen,
  recentsLastNewProjectParent,
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
  const { t, i18n } = useTranslation();
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // A first-launch user on a foreign locale needs a way to switch *before*
  // they can read any of the buttons. Mirrors the editor's header toggle.
  const cycleLocale = useCallback(() => {
    const current = i18n.language as Locale;
    const idx = SUPPORTED_LOCALES.indexOf(current);
    const next =
      SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length] ?? "en-US";
    i18n.changeLanguage(next);
  }, [i18n]);

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
      <button
        className="startup-locale-toggle"
        onClick={cycleLocale}
        title={t("language.switch_label")}
        aria-label={t("language.switch_label")}
      >
        {LOCALE_LABELS[(i18n.resolvedLanguage ?? "en-US") as Locale] ?? "EN"}
      </button>
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

/// Reserved file/folder names that are illegal on Windows regardless of
/// extension. We block the full set so projects stay portable. NUL and
/// CON show up in real systems; the LPT/COM band is rarer but cheap to
/// guard against.
const RESERVED_NAMES = new Set<string>([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

const INVALID_CHARS = /[\\/:*?"<>|]/;

/// Validate a project name for filesystem compatibility. Returns either
/// an i18n key for the failure mode, or `null` when valid. Checks the
/// union of Windows + POSIX rules so projects round-trip across OSes
/// without surprises.
function validateProjectName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "new_project.validation_empty";
  if (trimmed !== raw) return "new_project.validation_whitespace";
  if (INVALID_CHARS.test(trimmed)) return "new_project.validation_invalid_chars";
  if (trimmed.endsWith(".")) return "new_project.validation_trailing_dot";
  // Windows reserved-names check is case-insensitive and ignores any
  // extension suffix — `con.txt` is also reserved. We compare on the
  // pre-dot prefix uppercased.
  const stem = trimmed.split(".")[0]!.toUpperCase();
  if (RESERVED_NAMES.has(stem)) return "new_project.validation_reserved";
  return null;
}

/// Join a parent folder + project name into a full path. Picks the
/// separator from whatever the parent uses (`\` if it contains one,
/// else `/`); defaults to `\` since Tauri's primary target is Windows.
function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") ? "\\" : parent.includes("/") ? "/" : "\\";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}

function NewProjectForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [parentFolder, setParentFolder] = useState<string>("");
  const [presetKey, setPresetKey] = useState<string>(CANVAS_PRESETS[0]!.key);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const preset = CANVAS_PRESETS.find((p) => p.key === presetKey)!.preset;

  // First-launch: ask the backend for the last-used parent. If the
  // user never created a project before, fall back to the OS Documents
  // directory so they don't start at `C:\Users\<name>\`.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const last = await recentsLastNewProjectParent();
        if (cancelled) return;
        if (last) {
          setParentFolder(last);
          return;
        }
        const docs = await documentDir();
        if (cancelled) return;
        if (docs) setParentFolder(docs);
      } catch {
        // Leave parentFolder empty; the picker still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pickParent = useCallback(async () => {
    const picked = await openDialog({
      title: t("new_project.pick_parent_title"),
      directory: true,
      multiple: false,
      ...(parentFolder ? { defaultPath: parentFolder } : {}),
    });
    if (typeof picked === "string") {
      setParentFolder(picked);
      setSubmitError(null);
    }
  }, [t, parentFolder]);

  const nameValidationKey = validateProjectName(name);
  const canCreate = !busy && !nameValidationKey && parentFolder.length > 0;
  const previewPath = name.trim() && parentFolder
    ? joinPath(parentFolder, name.trim())
    : null;

  const submit = useCallback(async () => {
    if (!canCreate) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await projectNewWorkspace({
        parentFolder,
        name: name.trim(),
        canvas: preset,
      });
      onCreated();
    } catch (e) {
      setSubmitError(String(e));
      setBusy(false);
    }
  }, [canCreate, parentFolder, name, preset, onCreated]);

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
            placeholder={t("new_project.name_placeholder")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) {
                e.preventDefault();
                void submit();
              }
            }}
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
          {nameValidationKey && name.length > 0 && (
            <span className="new-project-validation">
              {t(nameValidationKey)}
            </span>
          )}
        </label>

        <div className="new-project-row">
          <span>{t("new_project.parent_folder")}</span>
          <div className="new-project-folder">
            <span
              className="new-project-folder-path"
              title={parentFolder}
            >
              {parentFolder || t("new_project.parent_folder_placeholder")}
            </span>
            <button onClick={pickParent} disabled={busy}>
              {t("new_project.choose_folder")}
            </button>
          </div>
        </div>

        {previewPath && (
          <p className="new-project-preview" title={previewPath}>
            <span aria-hidden="true">→ </span>
            {previewPath}
          </p>
        )}

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

        {submitError && (
          <p className="new-project-error">{submitError}</p>
        )}

        <footer className="new-project-actions">
          <button onClick={onCancel} disabled={busy}>
            {t("new_project.cancel")}
          </button>
          <button
            className="primary"
            onClick={submit}
            disabled={!canCreate}
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
