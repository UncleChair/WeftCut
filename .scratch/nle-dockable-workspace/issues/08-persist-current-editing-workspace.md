# 08 — Persist and recover the current Editing Workspace

**What to build:** Persist the current app-level Dock arrangement in an atomic versioned Electron document, restore it after restart, and repair invalid data through current, saved, and built-in Editing fallbacks without touching Project state or history.

**Blocked by:** 05 — Complete Panel controls, focus, maximize, and recovery.

**Status:** completed

- [x] Main owns an atomic versioned Workspace document and debounced disk writes with a quit-time flush.
- [x] Renderer sends validated WeftCut layout snapshots and restores through existing-Panel reuse.
- [x] Selected tabs, split proportions, open/closed state, tab order, and closed-Panel placement survive restart.
- [x] Unknown Panel kinds are dropped, duplicate singletons are normalized, and successful fallback repairs current storage.
- [x] An intentionally empty Workspace is valid and distinct from missing or corrupt layout data.
- [x] Workspace mutations never dirty the Project or enter Project undo history.
- [x] Store, adapter, IPC, restart, fallback, and empty-layout tests cover the full path.

## Validation

- **Store (main):** `src/main/workspace.ts` (`createWorkspaceStore`) owns
  `<userData>/workspaces.json` as a versioned envelope `{version, current, saved}`,
  written temp+rename (atomic promote). Writes are debounced (buffered in memory,
  one scheduled disk write; `get()` reads the buffer ahead of disk so the renderer
  sees its own writes); `flush()` forces the pending write and is called
  synchronously from `index.ts` `before-quit`. Missing / empty / corrupt / non-object
  files degrade to all-null defaults. The `current`/`saved` layout slots stay opaque
  in main — the renderer owns the schema (same pattern as the export-settings store).
- **Layout schema + fallback (renderer):** `src/renderer/workspace/workspaceLayout.ts`
  defines the versioned `WeftCutLayout` snapshot, `normalizeLayout` (drops unknown
  Panel kinds, reduces a duplicated singleton to its first placement, prunes empty
  leaves + collapses single-child branches, regenerates the `panels` record from the
  registry, repairs a dropped `activeView`, validates closed-Panel `placements`,
  keeps an intentionally-empty layout as a distinct valid state, and rejects a
  non-empty layout that loses every Panel as corrupt), and `resolveWorkspaceLayout`
  (ordered current → saved candidates; built-in Editing is the implicit final
  fallback).
- **Adapter (renderer):** `dockWorkspaceAdapter.ts` gains `serialize()` (versioned
  snapshot from `api.toJSON()` + the closed-Panel placement map; all-closed →
  intentionally-empty; maximize is a runtime overlay and never lands in the tree)
  and `restore()` (`api.clear()` for empty, else `api.fromJSON(tree, {
  reuseExistingPanels: true })` so open Panel resources survive; seeds the placement
  map before re-capturing open ones; returns `false` on failure so callers fall
  through).
- **Wiring:** `workspace_get` / `workspace_set_current` routed in `router.ts`
  (`{kind:'workspace'}`, added to the partition-gate manifest), handled in
  `ts-actor-host.ts` (opaque pass-through; never touches the Project actor), exposed
  as `workspaceGet` / `workspaceSetCurrent` in `renderer/ipc`, and sequenced by
  `useWorkspacePersistence` (fetch → restore first applying candidate → clean
  built-in only if every candidate failed → repair stored current when the source
  wasn't `current` → subscribe for debounced persistence). Store created + flushed
  on quit in `main/index.ts`.
- **Tests:** `main/workspace.test.ts` (defaults/missing/empty/corrupt/array,
  atomic temp+rename, debounce coalescing, timer-driven + explicit flush, restart
  read-back, empty-vs-missing, opaque slots, `setCurrent(null)`);
  `workspaceLayout.test.ts` (normalize: unknown-drop, dedup, prune/collapse,
  activeView repair, corrupt→null, empty-valid, placement validation; resolve:
  order, corrupt-current fallthrough, empty-current candidate);
  `dockWorkspaceAdapter.test.ts` (serialize non-empty/empty, restore reuse/clear,
  serialize→restore round-trip, failed restore, closed-Panel placement survives a
  simulated restart); `ts-actor-host.test.ts` (persist + restart read-back; no
  Project/history mutation); `router.test.ts` (routing + partition gate).
- **Full run:** renderer TypeScript (`tsc -b tsconfig.shared.json tsconfig.web.json`)
  and main (`tsconfig.main.json`) pass with no new errors (the only main errors are
  the pre-existing `@weftcut/native-decode` component-not-built ones in
  `exportSw.ts` / `export-decode-native.integration.test.ts`). Vitest: 271 files
  passed, 2 skipped; 2,181 tests passed. `electron-vite build` passed.
