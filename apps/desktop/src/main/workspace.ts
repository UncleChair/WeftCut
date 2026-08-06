// App-level Workspace document persisted at <userData>/workspaces.json, owned by
// the Electron main process. One document across every project — it does NOT
// touch app settings, Project data, Project view state, or Project history, so a
// layout mutation can never dirty the Project or enter undo.
//
// The document holds a set of named Workspace PROFILES (see src/shared/workspace.ts)
// plus the active selection. Every profile's `current` / `saved` layout slots are
// opaque values (the renderer owns the schema; see renderer/workspace/workspaceLayout.ts).
// This store only frames them in an atomic, versioned envelope written temp+rename
// so a crash mid-write can never truncate the live file. `normalizeWorkspaceDocument`
// runs on every read AND before every write, so the built-in Editing profile stays
// present + first + immutable regardless of how the document got there.
//
// Two write modes:
//   • setCurrent (autosave) is DEBOUNCED — it buffers the latest document in memory
//     and schedules one disk write; get() reads the buffered value ahead of disk so
//     the renderer sees its own writes. flush() forces the pending write and MUST be
//     called on application shutdown (index.ts before-quit), or an edit made inside
//     the debounce window would be lost.
//   • the explicit profile ops (setActive / saveBaseline / createProfile /
//     renameProfile / deleteProfile) COMMIT immediately — they fold any buffered
//     current edit into the document first (so a debounced autosave is never lost to
//     an explicit action) and write synchronously, returning the resulting document.
//
// The on-disk file path + envelope field names are a COMPATIBILITY SURFACE.

import { randomUUID } from "node:crypto";

import {
  EDITING_WORKSPACE_ID,
  isBuiltinWorkspace,
  normalizeWorkspaceDocument,
  normalizeWorkspaceName,
  workspaceDocumentDefaults,
  type WorkspaceDocument,
  type WorkspaceProfile,
} from "../shared/workspace";

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface WorkspaceFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  rename(from: string, to: string): void;
  mkdirp(dir: string): void;
}

export interface WorkspaceStore {
  /** The current document — the buffered value if a write is pending, else disk. */
  get(): WorkspaceDocument;
  /** Buffer a new current layout (opaque) for the ACTIVE profile and schedule a
   *  debounced disk write. */
  setCurrent(current: unknown | null): void;
  /** Activate a profile. Flushes any buffered current edit onto the previously
   *  active profile first, then commits. Unknown id → the built-in Editing
   *  profile. Returns the resulting document. */
  setActive(id: string): WorkspaceDocument;
  /** Save Workspace: promote the active profile's current layout to its saved
   *  reset baseline. No-op for the immutable built-in Editing profile. */
  saveBaseline(): WorkspaceDocument;
  /** Save Workspace As: create a new custom profile seeded with `current` as both
   *  its current layout and its reset baseline, and activate it. */
  createProfile(name: string, current: unknown | null): WorkspaceDocument;
  /** Rename a custom profile. No-op for the built-in Editing profile. */
  renameProfile(id: string, name: string): WorkspaceDocument;
  /** Delete a custom profile; if it was active, activate Editing. No-op for the
   *  built-in Editing profile. */
  deleteProfile(id: string): WorkspaceDocument;
  /** Force any pending debounced write to disk now (no-op when nothing pending). */
  flush(): void;
}

/** Injected timer seam — real setTimeout in production, controllable in tests. */
export interface WorkspaceTimer {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_DEBOUNCE_MS = 500;

const defaultTimer: WorkspaceTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createWorkspaceStore(deps: {
  fs: WorkspaceFs;
  path: string;
  dir: string;
  debounceMs?: number;
  timer?: WorkspaceTimer;
  /** Fresh unique profile id generator — injected for deterministic tests. */
  newId?: () => string;
}): WorkspaceStore {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const timer = deps.timer ?? defaultTimer;
  const newId = deps.newId ?? (() => randomUUID());

  // The latest document not yet on disk. null → disk is authoritative.
  let pending: WorkspaceDocument | null = null;
  let handle: unknown = null;

  function readDisk(): WorkspaceDocument {
    if (!deps.fs.exists(deps.path)) return workspaceDocumentDefaults();
    let body: string;
    try {
      body = deps.fs.readFile(deps.path);
    } catch (e) {
      console.warn(`[workspace] read ${deps.path}:`, e);
      return workspaceDocumentDefaults();
    }
    if (body.trim() === "") return workspaceDocumentDefaults();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      console.warn(`[workspace] parse ${deps.path}:`, e);
      return workspaceDocumentDefaults();
    }
    // The layout slots stay opaque — the renderer validates them. Only the
    // profile envelope (built-in presence/ordering/immutability, activeId) is
    // repaired here; a mismatched inner layout is caught downstream on restore.
    return normalizeWorkspaceDocument(parsed);
  }

  /** The authoritative document: the buffered value if pending, else disk. */
  function currentDoc(): WorkspaceDocument {
    return pending ?? readDisk();
  }

  function writeDisk(doc: WorkspaceDocument): void {
    deps.fs.mkdirp(deps.dir);
    const tmp = deps.path + ".tmp";
    const payload = normalizeWorkspaceDocument(doc);
    deps.fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    deps.fs.rename(tmp, deps.path); // atomic promote
  }

  function clearTimer(): void {
    if (handle !== null) {
      timer.clear(handle);
      handle = null;
    }
  }

  function flush(): void {
    clearTimer();
    if (pending === null) return;
    const doc = pending;
    pending = null;
    try {
      writeDisk(doc);
    } catch (e) {
      console.warn(`[workspace] write ${deps.path}:`, e);
    }
  }

  /** Explicit profile op: fold `next` onto disk immediately (dropping any pending
   *  autosave timer — `next` is derived from currentDoc() which already includes
   *  the buffered edit). Returns the normalized document the caller can act on. */
  function commit(next: WorkspaceDocument): WorkspaceDocument {
    clearTimer();
    pending = null;
    const normalized = normalizeWorkspaceDocument(next);
    try {
      writeDisk(normalized);
    } catch (e) {
      console.warn(`[workspace] write ${deps.path}:`, e);
    }
    return normalized;
  }

  function mapActive(
    doc: WorkspaceDocument,
    fn: (profile: WorkspaceProfile) => WorkspaceProfile,
  ): WorkspaceDocument {
    return {
      ...doc,
      profiles: doc.profiles.map((profile) =>
        profile.id === doc.activeId ? fn(profile) : profile,
      ),
    };
  }

  return {
    get: () => normalizeWorkspaceDocument(currentDoc()),

    setCurrent(current) {
      const next = mapActive(currentDoc(), (profile) => ({
        ...profile,
        current: current ?? null,
      }));
      pending = next;
      clearTimer();
      handle = timer.set(() => {
        handle = null;
        flush();
      }, debounceMs);
    },

    setActive(id) {
      const doc = currentDoc();
      const exists = doc.profiles.some((profile) => profile.id === id);
      return commit({ ...doc, activeId: exists ? id : EDITING_WORKSPACE_ID });
    },

    saveBaseline() {
      const doc = currentDoc();
      // The built-in Editing baseline is code-owned and immutable.
      if (isBuiltinWorkspace(doc.activeId)) return commit(doc);
      return commit(
        mapActive(doc, (profile) => ({ ...profile, saved: profile.current ?? null })),
      );
    },

    createProfile(name, current) {
      const doc = currentDoc();
      const profile: WorkspaceProfile = {
        id: newId(),
        name: normalizeWorkspaceName(name, "Workspace"),
        current: current ?? null,
        saved: current ?? null,
      };
      return commit({
        ...doc,
        profiles: [...doc.profiles, profile],
        activeId: profile.id,
      });
    },

    renameProfile(id, name) {
      const doc = currentDoc();
      if (isBuiltinWorkspace(id)) return commit(doc);
      return commit({
        ...doc,
        profiles: doc.profiles.map((profile) =>
          profile.id === id
            ? { ...profile, name: normalizeWorkspaceName(name, profile.name) }
            : profile,
        ),
      });
    },

    deleteProfile(id) {
      const doc = currentDoc();
      if (isBuiltinWorkspace(id)) return commit(doc);
      const profiles = doc.profiles.filter((profile) => profile.id !== id);
      // Deleting the active custom Workspace first activates Editing.
      const activeId = doc.activeId === id ? EDITING_WORKSPACE_ID : doc.activeId;
      return commit({ ...doc, profiles, activeId });
    },

    flush,
  };
}
