// The app-level Workspace document — a set of named Dock-arrangement PROFILES
// plus the active selection, with the normalizer that keeps it canonical. Main
// owns persistence (src/main/workspace.ts); the renderer owns the layout schema
// inside the opaque `current` / `saved` slots
// (renderer/workspace/workspaceLayout.ts).
//
// Strict app-level scope: one document across every project. It deliberately
// does NOT reuse app settings, Project data, Project view state, or Project
// history — a Workspace mutation must never dirty the Project or enter undo.

/** Envelope schema version, distinct from the renderer-owned layout version.
 *  Unsupported documents degrade to defaults unless an explicit migration exists. */
export const WORKSPACE_DOC_VERSION = 2;

/** Reserved id of the immutable, code-owned built-in Workspace. */
export const EDITING_WORKSPACE_ID = "editing";

/** One Workspace profile: a named Dock arrangement with an auto-saved current
 *  layout and an explicit reset baseline. Both layout slots are opaque WeftCut
 *  snapshots (the renderer owns the schema); null means "fall back". */
export interface WorkspaceProfile {
  id: string;
  name: string;
  /** The auto-saved current Dock arrangement (opaque), or null when nothing has
   *  been persisted yet. */
  current: unknown | null;
  /** The explicit reset baseline (opaque snapshot), or null when Reset should
   *  fall back to the built-in Editing baseline. Always null for the built-in
   *  Editing profile, whose baseline is code-owned. */
  saved: unknown | null;
}

export interface WorkspaceDocument {
  version: number;
  /** Id of the active profile. Points at an existing profile; falls back to the
   *  built-in Editing profile after normalization if it doesn't. */
  activeId: string;
  /** Every Workspace profile. The built-in Editing profile is always present and
   *  always first after normalization. */
  profiles: WorkspaceProfile[];
}

/** True for the immutable, code-owned built-in Workspace, which can never be
 *  renamed, deleted, or overwritten (Save promotes current → saved). */
export function isBuiltinWorkspace(id: string): boolean {
  return id === EDITING_WORKSPACE_ID;
}

/** The immutable built-in Editing profile: fixed id + name, no saved baseline
 *  (its reset baseline is the built-in code layout). Its `current` slot still
 *  auto-saves so the arrangement survives restart. */
export function editingProfile(): WorkspaceProfile {
  return { id: EDITING_WORKSPACE_ID, name: "Editing", current: null, saved: null };
}

export function workspaceDocumentDefaults(): WorkspaceDocument {
  return {
    version: WORKSPACE_DOC_VERSION,
    activeId: EDITING_WORKSPACE_ID,
    profiles: [editingProfile()],
  };
}

/** The active profile, or the built-in Editing profile as a last resort (an
 *  already-normalized document always has the active profile present). */
export function activeWorkspaceProfile(doc: WorkspaceDocument): WorkspaceProfile {
  return (
    doc.profiles.find((profile) => profile.id === doc.activeId) ??
    doc.profiles.find((profile) => profile.id === EDITING_WORKSPACE_ID) ??
    editingProfile()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim a profile name; fall back when it is missing/blank. Shared by the store's
 *  create/rename ops and the on-read normalizer so the rules can't drift. */
export function normalizeWorkspaceName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * Turn an untrusted persisted value into a canonical WorkspaceDocument. The
 * store calls this on every read AND before every write, so the invariants
 * (built-in Editing present + first + immutable, unique ids, valid activeId)
 * hold regardless of how the document got there. Known legacy envelopes retain
 * their current layout; unsupported versions and non-object values degrade to
 * defaults.
 */
export function normalizeWorkspaceDocument(raw: unknown): WorkspaceDocument {
  if (!isRecord(raw)) return workspaceDocumentDefaults();

  // Editing's reset baseline is code-owned, so migration retains only current.
  if (raw.version === 1) {
    return {
      version: WORKSPACE_DOC_VERSION,
      activeId: EDITING_WORKSPACE_ID,
      profiles: [{ ...editingProfile(), current: raw.current ?? null }],
    };
  }
  if (raw.version !== WORKSPACE_DOC_VERSION) return workspaceDocumentDefaults();

  const rawProfiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  const custom: WorkspaceProfile[] = [];
  const seen = new Set<string>();
  let editing = editingProfile();

  for (const entry of rawProfiles) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const current = "current" in entry ? (entry.current ?? null) : null;
    if (id === EDITING_WORKSPACE_ID) {
      editing = { ...editingProfile(), current };
      continue;
    }
    custom.push({
      id,
      name: normalizeWorkspaceName(entry.name, id),
      current,
      saved: "saved" in entry ? (entry.saved ?? null) : null,
    });
  }

  const profiles = [editing, ...custom];
  const activeId =
    typeof raw.activeId === "string" &&
    profiles.some((profile) => profile.id === raw.activeId)
      ? raw.activeId
      : EDITING_WORKSPACE_ID;

  return { version: WORKSPACE_DOC_VERSION, activeId, profiles };
}
