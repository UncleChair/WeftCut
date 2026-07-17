# 04 — Introduce the Dock Tree and built-in Editing layout

**What to build:** Replace the fixed editor grid with a WeftCut-owned Dock Workspace using the accepted Dockview version, eight singleton Panel kinds, recursive splits, tab groups, and the built-in NLE Editing arrangement while preserving every existing editing surface.

**Blocked by:** 02 — Extract five semantic tool Panel boundaries.

**Status:** completed

- [x] The built-in layout places Media Pool, Preview, and the contextual tool group above a full-width Timeline at the agreed proportions.
- [x] Attribute, Effect, and Nearby open in the contextual group; Caption and Role Mixer start closed.
- [x] Every Panel kind is a singleton and Panel components receive business data through WeftCut contracts rather than Dockview objects.
- [x] Splitters and Panel constraints enforce the agreed main-window and per-Panel minimum sizes.
- [x] Single groups use the zero-height native six-dot drag overlay and multi groups use the 28-pixel tab strip without content remounts.
- [x] Center/edge docking and business/Files drag isolation work with no floating or popout user Panels.
- [x] Adapter and React StrictMode tests cover registration, default layout, singleton enforcement, DnD arbitration, and lifecycle stability.

## Validation

- `npx vitest run src/renderer/workspace/dockWorkspaceAdapter.test.ts src/renderer/workspace/DockWorkspace.test.tsx src/main/mainWindowConfig.test.ts` — 3 files, 8 tests passed.
- `npx tsc -b tsconfig.web.json --pretty false` — passed.
- `VITE_WEFTCUT_E2E=1 npx electron-vite build` — main, preload, and renderer builds passed.
- `npx playwright test -c playwright.config.ts e2e/electron/dock-workspace.spec.ts` — 1 real Electron test passed; verified Panel presence, 62/38 and 22/53/25 geometry, single/multi header presentation, and 960×640 main-window minimum.
- Compatibility spike remains the browser-level evidence for center/edge native docking, real six-dot HTML5 drag, header transition continuity, and no content remounts (19/19 passed).
- `npx react-doctor@latest --verbose --scope changed` — attempted once; produced no output and was terminated after the package runner stalled, consistent with the known unavailable online tool in this environment.
- `npx tsc -b tsconfig.main.json --pretty false` — blocked only by pre-existing `@weftcut/native-decode` ExportSw declaration gaps; `electron-vite build` compiled the changed main process successfully.
