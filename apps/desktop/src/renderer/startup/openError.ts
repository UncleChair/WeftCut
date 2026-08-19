// The launch surface's refusal → copy map. Covers both lifecycle calls it can
// make: `project_open` (Open… and every Recent row) and
// `project_new_workspace` (the New project dialog).
//
// Main raises these as `WorkspaceFailure`, whose message IS the serialized
// `WorkspaceError` — see shared/workspaceErrors.ts for why the structure has to
// live in `message` rather than on a custom Error prop.

import type { TFunction } from "i18next";

import {
  WORKSPACE_ERROR_CODES,
  type WorkspaceError,
} from "../../shared/workspaceErrors";

/// Codes as a runtime set, not an `in` check: `in` also answers true for
/// `toString` and the rest of Object's prototype.
const CODES = new Set<string>(Object.keys(WORKSPACE_ERROR_CODES));

/// Recover the structured refusal from an IPC rejection.
///
/// Same tail-parse as errors/parseCommandError.ts and for the same reason:
/// Electron only ever PREFIXES the message —
///
///   Error invoking remote method 'backend:invoke': Error: {"error":…}
///
/// — so reading from the first `{` is independent of that prefix's wording.
///
/// Unlike the command parser, this one DOES check the code against the
/// vocabulary: the two unions share a wire shape (`{ error: string, … }`), and
/// a CommandError that reached this surface must fall through to the generic
/// path rather than be rendered as a workspace refusal it isn't.
export function parseWorkspaceError(err: unknown): WorkspaceError | null {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : null;
  if (raw === null) return null;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const code = (parsed as { error?: unknown }).error;
  if (typeof code !== "string" || !CODES.has(code)) return null;
  return parsed as WorkspaceError;
}

/// Strip Electron's IPC framing off an unrecognized rejection so the fallback
/// lines carry the failure itself, not the plumbing that delivered it. Only
/// ever shows what main could not translate — a napi throw, an fs errno — which
/// stays English by the same rule the status log applies to plumbing errors.
export function cleanIpcDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const unwrapped = /Error invoking remote method '[^']*':\s*([\s\S]*)$/.exec(raw);
  const tail = (unwrapped?.[1] ?? raw).replace(/^\w*Error:\s*/, "").trim();
  return tail === "" ? raw : tail;
}

interface CopyContext {
  t: TFunction;
  /// The folder the caller acted on — picked, clicked, or composed from the
  /// New-project fields. Never on the wire: the caller already holds it.
  path: string;
}

type WorkspaceCode = WorkspaceError["error"];
type WorkspaceOf<C extends WorkspaceCode> = Extract<
  WorkspaceError,
  { error: C }
>;

/// One line of copy per code. A map over the union rather than a switch so that
/// adding a variant to the vocabulary without deciding what the user reads
/// fails to compile — the completeness lock formatCommandError uses.
const COPY: { [C in WorkspaceCode]: (err: WorkspaceOf<C>, ctx: CopyContext) => string } = {
  ProjectFolderMissing: (_e, { t, path }) =>
    t("startup.project_folder_missing", { path }),
  NotProjectFolder: (_e, { t, path }) =>
    t("startup.not_project_folder", { path }),
  ProjectSchemaUnreadable: (_e, { t }) => t("startup.project_schema_unreadable"),
  ProjectSchemaTooNew: (e, { t }) =>
    t("startup.project_schema_too_new", {
      found: e.found,
      supported: e.supported,
    }),
  ProjectFileUnreadable: (e, { t }) =>
    t("startup.project_file_unreadable", { detail: e.detail }),
  // `err.detail` is the serialized CommandError. Deliberately not interpolated:
  // it names uuids this surface has no mirror to resolve, so it belongs in the
  // log entry's disclosure, not in the sentence the user reads.
  ProjectInvalid: (_e, { t }) => t("startup.project_invalid"),
  ProjectFolderExists: (_e, { t }) => t("new_project.folder_exists"),
  ProjectNameRequired: (_e, { t }) => t("new_project.validation_empty"),
  InvalidCanvasPreset: (_e, { t }) => t("new_project.invalid_preset"),
};

function render(err: WorkspaceError, ctx: CopyContext): string {
  return (COPY[err.error] as (e: WorkspaceError, c: CopyContext) => string)(err, ctx);
}

/// Localize a `projectOpen` rejection. Anything main could not classify falls
/// back to the generic line — which is where a napi or fs throw lands, since
/// neither has copy of its own.
export function describeOpenError(
  err: unknown,
  path: string,
  t: TFunction,
): string {
  const parsed = parseWorkspaceError(err);
  if (parsed) return render(parsed, { t, path });
  return t("startup.recent_open_failed", { detail: cleanIpcDetail(err) });
}

/// Localize a `projectNewWorkspace` rejection. `path` is the composed target
/// (parent + name), the same string the dialog previews under the name field.
export function describeCreateError(
  err: unknown,
  path: string,
  t: TFunction,
): string {
  const parsed = parseWorkspaceError(err);
  if (parsed) return render(parsed, { t, path });
  return t("new_project.create_failed", { detail: cleanIpcDetail(err) });
}

/// True when the error means the recents entry is permanently dead — the
/// folder is gone, or it exists but is no longer a WeftCut project — and
/// should be dropped from the list rather than offered again.
///
/// A project this build is too old to READ is pointedly NOT dead: the entry is
/// exactly what the user needs the day they run a build that can open it.
export function isDeadRecentError(err: unknown): boolean {
  const code = parseWorkspaceError(err)?.error;
  return code === "ProjectFolderMissing" || code === "NotProjectFolder";
}
