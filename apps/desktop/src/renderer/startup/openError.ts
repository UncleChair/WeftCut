import type { TFunction } from "i18next";

/// Sentinel error strings returned by `project_open`. Mirror the literals
/// thrown by `openProject` in `main/state/workspace-orchestrator.ts`.
///
/// The workspace folder itself is gone — typically a recents entry whose
/// folder was moved or deleted after the fact. Checked before the
/// project.json probe so the user sees "folder is gone" rather than
/// "isn't a WeftCut project".
export const PROJECT_FOLDER_MISSING_SENTINEL = "PROJECT_FOLDER_MISSING";

/// The folder exists but has no `project.json`.
export const NOT_PROJECT_FOLDER_SENTINEL = "NOT_PROJECT_FOLDER";

/// Localize a `projectOpen` rejection so the user sees something readable
/// instead of the raw anyhow chain (which on Windows-CN renders the OS
/// error in Chinese system locale, e.g. "系统找不到指定的文件。"). The
/// path is what the user picked / clicked, so we re-attach it here rather
/// than parsing it back out of the error string.
export function describeOpenError(
  err: unknown,
  path: string,
  t: TFunction,
): string {
  const detail = String(err);
  if (detail.includes(PROJECT_FOLDER_MISSING_SENTINEL)) {
    return t("startup.project_folder_missing", { path });
  }
  if (detail.includes(NOT_PROJECT_FOLDER_SENTINEL)) {
    return t("startup.not_project_folder", { path });
  }
  return t("startup.recent_open_failed", { detail });
}

/// True when the error means the recents entry is permanently dead — the
/// folder is gone, or it exists but is no longer a WeftCut project — and
/// should be dropped from the list rather than offered again.
export function isDeadRecentError(err: unknown): boolean {
  const detail = String(err);
  return (
    detail.includes(PROJECT_FOLDER_MISSING_SENTINEL) ||
    detail.includes(NOT_PROJECT_FOLDER_SENTINEL)
  );
}
