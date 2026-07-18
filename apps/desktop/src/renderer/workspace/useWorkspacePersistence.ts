// Renderer boundary for the app-level Workspace document and named-profile
// commands. Main owns profile CRUD and disk I/O, the adapter owns live Dockview
// state, and workspaceLayout owns snapshot validation. Programmatic restores
// must not reach autosave, async results belong only to the controller that
// started them, and an invalid active profile is repaired from a valid fallback.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type DockWorkspaceController } from "./dockWorkspaceAdapter";
import { normalizeLayout, resolveWorkspaceLayout } from "./workspaceLayout";
import {
  workspaceGet,
  workspaceSetCurrent,
  workspaceSetActive,
  workspaceSaveBaseline,
  workspaceCreateProfile,
  workspaceRenameProfile,
  workspaceDeleteProfile,
} from "../ipc";
import {
  activeWorkspaceProfile,
  isBuiltinWorkspace,
  workspaceDocumentDefaults,
  type WorkspaceDocument,
  type WorkspaceProfile,
} from "../../shared/workspace";

/** Menu-facing view of one Workspace profile. */
export interface WorkspaceProfileInfo {
  id: string;
  name: string;
  /** True for the immutable built-in Editing profile (cannot rename/delete/save). */
  isBuiltin: boolean;
}

/** The View-menu Workspace controls, backed by the main-process store. */
export interface WorkspaceProfilesApi {
  profiles: WorkspaceProfileInfo[];
  activeId: string;
  activeIsBuiltin: boolean;
  /** Flush the current profile, activate `id`, and restore it — no save prompt. */
  switchTo(id: string): void;
  /** Save Workspace: promote the active profile's current layout to its baseline. */
  save(): void;
  /** Save Workspace As: create a custom profile from the current arrangement. */
  saveAs(name: string): void;
  /** Rename a custom profile. */
  rename(id: string, name: string): void;
  /** Delete a custom profile; if active, Editing takes over and is restored. */
  remove(id: string): void;
  /** Reset Workspace: restore the active profile's saved baseline (built-in for Editing). */
  reset(): void;
}

type RestoreSource = "current" | "saved" | "builtin" | "none";

export function useWorkspacePersistence(
  controller: DockWorkspaceController | null,
): WorkspaceProfilesApi | null {
  const [doc, setDocState] = useState<WorkspaceDocument | null>(null);
  const controllerRef = useRef<DockWorkspaceController | null>(null);
  const docRef = useRef<WorkspaceDocument | null>(null);
  const disposedRef = useRef(false);
  // While true, the autosave subscription no-ops — a programmatic restore must
  // not be written back as intermediate current edits.
  const applyingRef = useRef(false);

  const commitDoc = useCallback((next: WorkspaceDocument) => {
    docRef.current = next;
    setDocState(next);
  }, []);

  const persistCurrent = useCallback(() => {
    const active = controllerRef.current;
    if (!active || disposedRef.current || applyingRef.current) return;
    try {
      const layout = active.serialize();
      void workspaceSetCurrent(layout).catch((error) => {
        console.warn("[dock-workspace] persist failed:", error);
      });
    } catch (error) {
      console.warn("[dock-workspace] persist failed:", error);
    }
  }, []);

  // Restore a profile's layout: current → saved, else (on a runtime failure or
  // when `rebuildOnEmpty`) rebuild the built-in Editing baseline. Returns which
  // source applied so the caller can repair the stored current.
  const restoreProfile = useCallback(
    (profile: WorkspaceProfile, opts: { rebuildOnEmpty: boolean }): RestoreSource => {
      const active = controllerRef.current;
      if (!active) return "none";
      let attemptFailed = false;
      for (const candidate of resolveWorkspaceLayout(profile)) {
        if (active.restore(candidate.layout)) return candidate.source;
        attemptFailed = true;
      }
      if (attemptFailed || opts.rebuildOnEmpty) {
        active.resetWorkspace();
        return "builtin";
      }
      return "none";
    },
    [],
  );

  // Restore a profile under the `applying` guard (so the restore's own layout
  // events aren't autosaved back), then repair the stored current when the
  // restore came from a baseline/built-in rather than the profile's own current.
  // The repair is a direct write: the autosave listener no-ops while `applying`.
  const applyAndRepairProfile = useCallback(
    (profile: WorkspaceProfile, opts: { rebuildOnEmpty: boolean }): void => {
      const active = controllerRef.current;
      if (!active) return;
      applyingRef.current = true;
      try {
        const source = restoreProfile(profile, opts);
        if (source !== "current" && source !== "none") {
          try {
            const layout = active.serialize();
            void workspaceSetCurrent(layout).catch((error) => {
              console.warn("[dock-workspace] persist failed:", error);
            });
          } catch (error) {
            console.warn("[dock-workspace] persist failed:", error);
          }
        }
      } finally {
        applyingRef.current = false;
      }
    },
    [restoreProfile],
  );

  useEffect(() => {
    if (!controller) {
      controllerRef.current = null;
      docRef.current = null;
      disposedRef.current = true;
      setDocState(null);
      return;
    }
    controllerRef.current = controller;
    disposedRef.current = false;
    applyingRef.current = false;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      let next: WorkspaceDocument;
      try {
        next = await workspaceGet();
      } catch (error) {
        console.warn("[dock-workspace] workspace_get failed:", error);
        next = workspaceDocumentDefaults();
      }
      if (cancelled || controllerRef.current !== controller) return;
      commitDoc(next);

      const profile = activeWorkspaceProfile(next);
      const hasStoredLayout = profile.current !== null || profile.saved !== null;
      applyAndRepairProfile(profile, {
        // DockWorkspace already presents the built-in baseline on first mount.
        // Only an unusable stored value needs a rebuild + repair here.
        rebuildOnEmpty: hasStoredLayout || !isBuiltinWorkspace(profile.id),
      });
      if (cancelled || controllerRef.current !== controller) return;

      unsubscribe = controller.subscribe(persistCurrent);
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        disposedRef.current = true;
        applyingRef.current = false;
      }
    };
  }, [controller, commitDoc, persistCurrent, applyAndRepairProfile]);

  const switchTo = useCallback(
    (id: string) => {
      const active = controllerRef.current;
      const current = docRef.current;
      if (!active || !current || id === current.activeId) return;
      void (async () => {
        try {
          // Persist the outgoing profile's live arrangement (folded into the old
          // active by the store's setActive), switch, then restore the destination.
          await workspaceSetCurrent(active.serialize());
          const next = await workspaceSetActive(id);
          if (disposedRef.current || controllerRef.current !== active) return;
          commitDoc(next);
          applyAndRepairProfile(activeWorkspaceProfile(next), { rebuildOnEmpty: true });
        } catch (error) {
          console.warn("[dock-workspace] switch failed:", error);
        }
      })();
    },
    [commitDoc, applyAndRepairProfile],
  );

  const save = useCallback(() => {
    const active = controllerRef.current;
    const current = docRef.current;
    if (!active || !current || isBuiltinWorkspace(current.activeId)) return;
    void (async () => {
      try {
        await workspaceSetCurrent(active.serialize());
        const next = await workspaceSaveBaseline();
        if (!disposedRef.current && controllerRef.current === active) commitDoc(next);
      } catch (error) {
        console.warn("[dock-workspace] save failed:", error);
      }
    })();
  }, [commitDoc]);

  const saveAs = useCallback(
    (name: string) => {
      const active = controllerRef.current;
      if (!active) return;
      void (async () => {
        try {
          const layout = active.serialize();
          // Keep the outgoing profile's current fresh, then branch a new profile
          // from the same live arrangement (which stays mounted — no restore).
          await workspaceSetCurrent(layout);
          const next = await workspaceCreateProfile(name, layout);
          if (!disposedRef.current && controllerRef.current === active) commitDoc(next);
        } catch (error) {
          console.warn("[dock-workspace] save-as failed:", error);
        }
      })();
    },
    [commitDoc],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      const active = controllerRef.current;
      if (!active) return;
      void (async () => {
        try {
          const next = await workspaceRenameProfile(id, name);
          if (!disposedRef.current && controllerRef.current === active) commitDoc(next);
        } catch (error) {
          console.warn("[dock-workspace] rename failed:", error);
        }
      })();
    },
    [commitDoc],
  );

  const remove = useCallback(
    (id: string) => {
      const active = controllerRef.current;
      const current = docRef.current;
      if (!active || !current) return;
      const wasActive = id === current.activeId;
      void (async () => {
        try {
          const next = await workspaceDeleteProfile(id);
          if (disposedRef.current || controllerRef.current !== active) return;
          commitDoc(next);
          // Deleting the active profile activated Editing — restore it.
          if (wasActive) {
            applyAndRepairProfile(activeWorkspaceProfile(next), { rebuildOnEmpty: true });
          }
        } catch (error) {
          console.warn("[dock-workspace] delete failed:", error);
        }
      })();
    },
    [commitDoc, applyAndRepairProfile],
  );

  const reset = useCallback(() => {
    const active = controllerRef.current;
    const current = docRef.current;
    if (!active || !current) return;
    void (async () => {
      applyingRef.current = true;
      try {
        const profile = activeWorkspaceProfile(current);
        // Reset restores the SAVED baseline only; the built-in Editing profile
        // has none, so it falls to the code-owned baseline.
        const saved = normalizeLayout(profile.saved);
        if (!(saved && active.restore(saved))) active.resetWorkspace();
        await workspaceSetCurrent(active.serialize());
      } catch (error) {
        console.warn("[dock-workspace] reset failed:", error);
      } finally {
        applyingRef.current = false;
      }
    })();
  }, []);

  return useMemo<WorkspaceProfilesApi | null>(() => {
    if (!doc) return null;
    return {
      profiles: doc.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        isBuiltin: isBuiltinWorkspace(profile.id),
      })),
      activeId: doc.activeId,
      activeIsBuiltin: isBuiltinWorkspace(doc.activeId),
      switchTo,
      save,
      saveAs,
      rename,
      remove,
      reset,
    };
  }, [doc, switchTo, save, saveAs, rename, remove, reset]);
}
