# 09 — Manage named Workspaces and saved baselines

**What to build:** Let editors create and manage task-specific app-level Workspaces with separate auto-saved current layouts and explicit reset baselines, while keeping built-in Editing immutable and always recoverable.

**Blocked by:** 08 — Persist and recover the current Editing Workspace.

**Status:** completed

- [x] View lists Editing and custom Workspaces and exposes switch, save, save-as, rename, delete, and reset operations.
- [x] Switching flushes the current profile and restores the destination without a save prompt.
- [x] Save promotes current to the custom profile's baseline; Reset restores that baseline.
- [x] Editing cannot be renamed, deleted, or overwritten.
- [x] Deleting the active custom Workspace first activates Editing.
- [x] Store, menu, IPC, and Electron tests cover profile CRUD, active selection, baselines, and restart.

## Validation

- **Document schema (shared):** `src/shared/workspace.ts` grows the persisted
  document from ticket 08's single `{current, saved}` to a versioned set of named
  profiles: `{version:2, activeId, profiles:[{id,name,current,saved}]}`. The
  built-in `editing` profile is always present + first + immutable (`saved`
  forced null → Reset falls to the code baseline; name fixed). `normalizeWorkspaceDocument`
  runs on every read/write to hold those invariants, migrate a v1 document into
  the Editing profile's current, and repair an invalid `activeId`. Helpers:
  `activeWorkspaceProfile`, `isBuiltinWorkspace`, `normalizeWorkspaceName`.
- **Store (main):** `src/main/workspace.ts` keeps ticket 08's atomic temp+rename
  + debounced autosave for `setCurrent` (now targets the ACTIVE profile) and adds
  immediate-commit profile ops: `setActive` (folds the buffered outgoing current
  onto the old profile before switching — no lost autosave, no save prompt),
  `saveBaseline` (current → saved; no-op on Editing), `createProfile` (Save As:
  seeds current + saved from the live arrangement, activates it), `renameProfile`
  / `deleteProfile` (no-op on Editing; deleting the active profile activates
  Editing). Injected `newId` seam for deterministic ids in tests.
- **Wiring:** five new opaque channels (`workspace_set_active` /
  `_save_baseline` / `_create_profile` / `_rename_profile` / `_delete_profile`)
  routed `{kind:'workspace'}` in `router.ts` (+ partition-gate manifest), handled
  in `ts-actor-host.ts` (never touches the Project actor), exposed in
  `renderer/ipc`. `resolveWorkspaceLayout` now takes a profile's `{current,saved}`
  slot pair. `useWorkspacePersistence` returns a `WorkspaceProfilesApi`
  (switch/save/saveAs/rename/remove/reset) that sequences serialize/restore under
  an `applying` guard so programmatic restores aren't autosaved back;
  switch/delete-active fold the outgoing current, restore the destination, and
  repair the stored current. `ViewMenu` gains a Workspaces section (list + the six
  ops; Save/Rename/Delete disabled on Editing); `WorkspaceNameDialog` collects the
  Save As / Rename name; `App` owns that dialog's open state. i18n en-US + zh-CN.
- **Tests:** `main/workspace.test.ts` (defaults, corrupt/v1-migration/activeId
  repair + Editing immutability, autosave debounce, full profile CRUD, restart
  read-back); `ts-actor-host.test.ts` (channel CRUD + baseline + restart + no
  Project/history mutation); `router.test.ts` (all seven workspace channels +
  partition gate); `workspaceLayout.test.ts` (slot-pair resolve); renderer hook
  `useWorkspacePersistence.test.tsx` (mount restore, switch flush→restore, Save As
  no-restore, Save baseline, Reset saved-only, delete-active→Editing, autosave);
  `ViewMenu.test.tsx` (lists + drives all six ops, Editing disables Save/Rename/
  Delete); Electron `dock-workspace.spec.ts` (View-menu Save As + switch without
  prompt; profile CRUD + active selection + baselines survive a real restart via a
  fixed `--user-data-dir`).
- **Full run:** renderer + shared + main TypeScript pass with no new errors (only
  the pre-existing `@weftcut/native-decode` component-not-built errors in
  `exportSw.ts` / `export-decode-native.integration.test.ts` remain). Vitest: 272
  files passed, 1 skipped; 2,199 tests passed. `electron-vite build` passed.
  Playwright `dock-workspace.spec.ts`: 5/5 passed.
