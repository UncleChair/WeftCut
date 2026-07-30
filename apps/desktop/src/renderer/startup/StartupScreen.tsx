import { open as openDialog } from "@/bridge/dialog";
import { documentDir } from "@/bridge/path";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "../i18n";
import { setLocale, wireAppSettingsStream } from "../settings/appSettingsStore";
import { useNativeMenu } from "../menu/nativeMenu";
import type { OverrideMap } from "../shortcuts/useShortcuts";
import { wireDecodeComponent } from "../settings/decodeComponentStore";
import { SettingsPanel } from "../settings/SettingsPanel";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { WindowControls } from "../components/WindowControls";
import { Button } from "@/components/ui/button";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FolderOpenIcon,
  GlobeIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import {
  keybindingsGet,
  projectNewWorkspace,
  projectOpen,
  recentsLastNewProjectParent,
  recentsList,
  recentsRemove,
  type KeybindingsMap,
  type RecentEntry,
} from "../ipc";
import { CANVAS_PRESETS } from "./canvasPresets";
import { LogoPulsePaths } from "./LogoPulsePaths";
import { describeOpenError, isDeadRecentError } from "./openError";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keybindings, setKeybindings] = useState<KeybindingsMap>({});
  // Recents collapses to the most-recent COLLAPSED_RECENT_COUNT entries on
  // mount. After Save-and-Close lands the user back here, the just-closed
  // project is #1 in the list, so the collapsed view is almost always more
  // useful than restoring a stale expansion. Deliberately not persisted.
  const [recentsExpanded, setRecentsExpanded] = useState(false);

  // The macOS App menu's Settings item — the only action this surface can run,
  // so it is the only one it projects (the editor projects File as well). Cmd+,
  // must work before any project exists, which is exactly where a Mac user
  // reaches for preferences. Inert off macOS. See menu/nativeMenu.ts.
  useNativeMenu({
    handlers: { openSettings: () => setSettingsOpen(true) },
    overrides: keybindings as OverrideMap,
  });

  // A first-launch user on a foreign locale needs a way to switch *before*
  // they can read any of the buttons. Mirrors the editor's header toggle.
  const cycleLocale = useCallback(() => {
    const current = i18n.language as Locale;
    const idx = SUPPORTED_LOCALES.indexOf(current);
    const next =
      SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length] ?? "en-US";
    // Persists to app_settings.json AND switches i18next (see setLocale).
    setLocale(next);
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

  // The settings panel reads app-level stores that are otherwise only wired
  // inside the editor (`useAppWiring`). Hydrate them for the dialog's
  // lifetime so its panes show the persisted values, not the boot defaults.
  useEffect(() => {
    if (!settingsOpen) return;
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
    void wireDecodeComponent();
    keybindingsGet()
      .then(setKeybindings)
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [settingsOpen]);

  const runProtected = useCallback(
    async (
      action: () => Promise<void>,
      formatError?: (err: unknown) => string,
    ) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (e) {
        setError(formatError ? formatError(e) : String(e));
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
    await runProtected(
      async () => {
        await projectOpen(picked);
        onWorkspaceReady();
      },
      (e) => describeOpenError(e, picked, t),
    );
  }, [t, runProtected, onWorkspaceReady]);

  const openRecent = useCallback(
    async (entry: RecentEntry) => {
      await runProtected(
        async () => {
          try {
            await projectOpen(entry.path);
            onWorkspaceReady();
          } catch (e) {
            // Folder was moved/deleted (PROJECT_FOLDER_MISSING) or stopped
            // being a project (NOT_PROJECT_FOLDER). Either way the entry is
            // permanently dead — drop it so the list doesn't keep offering
            // it. Transient errors keep the entry for a retry.
            if (isDeadRecentError(e)) {
              await recentsRemove(entry.path).catch(() => {});
              await refreshRecents();
            }
            throw e;
          }
        },
        (e) => describeOpenError(e, entry.path, t),
      );
    },
    [t, runProtected, onWorkspaceReady, refreshRecents],
  );

  return (
    <div className="startup-screen">
      {/* Frameless window: the startup screen has no app header, so a
          slim strip along the top carries the drag region + caption
          buttons (and the locale toggle, which used to float here). */}
      <div className="startup-titlebar" data-drag-region>
        {/* Top-left app-level affordances: settings apply below-project
            scope, so they're reachable before a workspace exists. The
            locale toggle + caption buttons stay on the right. */}
        <button
          type="button"
          className="startup-settings-toggle"
          onClick={() => setSettingsOpen(true)}
          title={t("settings.heading")}
          aria-label={t("settings.heading")}
        >
          <SettingsIcon size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button
          type="button"
          className="startup-locale-toggle"
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
      <div className="startup-panel">
        <header className="startup-header">
          {/* Decorative: the <h1> already announces the product name, so the
              mark is aria-hidden to avoid a duplicate read-out. Served from
              renderer/public — the same SVG the window favicon uses. */}
          <span className="startup-logo-mark" aria-hidden="true">
            <img
              className="startup-logo"
              src="./icons/icon.svg"
              alt=""
              width={44}
              height={44}
            />
            <svg
              className="startup-logo-pulse-trace"
              viewBox="0 0 440 440"
              fill="none"
              focusable="false"
            >
              <defs>
                <clipPath id="startup-logo-w-clip">
                  <path d="M200.117 167.417L151.477 239.378C149.409 242.438 144.851 242.276 143.004 239.078L95.331 156.5C92.6515 151.859 87.6995 149 82.3404 149H10.0005C4.47764 149 0.000488281 153.477 0.000488281 159V183C0.000488281 188.523 4.47764 193 10.0005 193H57.3059C62.6835 193 67.6496 195.879 70.3222 200.545L124.679 295.455C127.352 300.121 132.318 303 137.696 303H154.024C159.011 303 163.672 300.522 166.461 296.387L220.001 217L273.541 296.387C276.329 300.522 280.99 303 285.977 303H302.306C307.683 303 312.649 300.121 315.322 295.455L369.679 200.545C372.352 195.879 377.318 193 382.696 193H430C435.523 193 440 188.523 440 183V159C440 153.477 435.523 149 430 149L357.661 149C352.302 149 347.35 151.859 344.671 156.5L296.997 239.078C295.151 242.276 290.593 242.438 288.525 239.378L239.885 167.417C230.368 153.337 209.634 153.337 200.117 167.417Z" />
                </clipPath>
              </defs>
              <g clipPath="url(#startup-logo-w-clip)">
                <LogoPulsePaths />
              </g>
            </svg>
          </span>
          <div className="startup-heading-text">
            <h1>{t("app.title")}</h1>
            <p className="startup-subtitle">{t("startup.subtitle")}</p>
          </div>
        </header>

        <div className="startup-actions">
          <button
            type="button"
            className="startup-action primary"
            onClick={() => setNewProjectOpen(true)}
            disabled={busy}
          >
            <PlusIcon size={22} strokeWidth={1.5} aria-hidden />
            <span className="startup-action-label">{t("startup.new_project")}</span>
          </button>
          <button
            type="button"
            className="startup-action"
            onClick={openWorkspaceFolder}
            disabled={busy}
          >
            <FolderOpenIcon size={22} strokeWidth={1.5} aria-hidden />
            <span className="startup-action-label">{t("startup.open_project")}</span>
          </button>
        </div>

        {error && <p className="startup-error">{error}</p>}

        <section className="startup-recent">
          <div className="startup-recent-header">
            <h2>{t("startup.recent_heading")}</h2>
            {recents !== null && recents.length > COLLAPSED_RECENT_COUNT && (
              <button
                type="button"
                className="startup-recent-toggle"
                onClick={() => setRecentsExpanded((v) => !v)}
                aria-expanded={recentsExpanded}
              >
                <span
                  className="startup-recent-toggle-chevron"
                  aria-hidden="true"
                >
                  {recentsExpanded ? (
                    <ChevronUpIcon size={12} />
                  ) : (
                    <ChevronDownIcon size={12} />
                  )}
                </span>
                {recentsExpanded
                  ? t("startup.recent_show_less")
                  : t("startup.recent_show_all", { count: recents.length })}
              </button>
            )}
          </div>
          {recents === null ? (
            <p className="startup-recent-empty">{t("startup.recent_loading")}</p>
          ) : recents.length === 0 ? (
            <p className="startup-recent-empty">{t("startup.recent_empty")}</p>
          ) : (
            <ul className="startup-recent-list">
              {(recentsExpanded
                ? recents
                : recents.slice(0, COLLAPSED_RECENT_COUNT)
              ).map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
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
                    type="button"
                    className="startup-recent-remove"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await recentsRemove(entry.path).catch(() => {});
                      await refreshRecents();
                    }}
                    title={t("startup.recent_remove_hint")}
                    aria-label={t("startup.recent_remove_hint")}
                  >
                    <XIcon size={14} aria-hidden />
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
      {settingsOpen && (
        // No composition props: there is no open project here, so the
        // project-scoped "Project" category hides itself (see SettingsPanel).
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          keybindings={keybindings}
          onKeybindingsChanged={setKeybindings}
        />
      )}
    </div>
  );
}

/// How many recents to show before the disclosure toggle appears. The
/// backend caps the store at 10 (see `recents.rs::MAX_RECENTS`), so the
/// "expanded" view reveals at most 7 additional entries.
const COLLAPSED_RECENT_COUNT = 3;


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
/// else `/`); defaults to `\` since the primary target is Windows.
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
    <AppDialog
      title={t("new_project.title")}
      onClose={busy ? undefined : onCancel}
      panelClassName="new-project-panel"
    >
        <label className="new-project-row">
          <span>{t("new_project.name")}</span>
          <AppInput
            value={name}
            placeholder={t("new_project.name_placeholder")}
            ariaLabel={t("new_project.name")}
            onValueChange={setName}
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
            <Button onClick={pickParent} disabled={busy}>
              {t("new_project.choose_folder")}
            </Button>
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
          <AppSelect
            value={presetKey}
            onValueChange={setPresetKey}
            disabled={busy}
            ariaLabel={t("new_project.canvas_preset")}
            options={CANVAS_PRESETS.map((p) => ({
              value: p.key,
              label: t(`new_project.preset.${p.key}`, { defaultValue: p.key }),
            }))}
          />
        </label>

        {submitError && (
          <p className="new-project-error">{submitError}</p>
        )}

        <footer className="new-project-actions">
          <Button size="lg" onClick={onCancel} disabled={busy}>
            {t("new_project.cancel")}
          </Button>
          <Button
            variant="default"
            size="lg"
            onClick={submit}
            disabled={!canCreate}
          >
            {busy ? t("new_project.creating") : t("new_project.create")}
          </Button>
        </footer>
    </AppDialog>
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
