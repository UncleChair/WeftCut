# 06 — Let the Media Pool Panel replace the legacy drawer

**What to build:** Make the dockable Media Pool the only Media Pool surface and entry point, removing the unreleased drawer preference and M shortcut without migration while preserving import and reveal workflows.

**Blocked by:** 05 — Complete Panel controls, focus, maximize, and recovery.

**Status:** completed

- [x] View and navigation actions open or focus the Media Pool Panel instead of toggling a drawer.
- [x] The drawer setting, renderer state, fixed-grid class, menu copy, and shortcut action are removed across the app.
- [x] M is unbound and available for a future Marker command; stale persisted keys are harmlessly ignored.
- [x] Media import, OS file drop, media-to-Timeline drag, and search reveal remain operational.
- [x] Settings, shortcuts, navigation, and Electron drag/drop tests cover the final behaviour.

## Validation

- Focused Vitest: 9 files, 85 tests passed (app settings, navigation, shortcuts, View menu, app/search commands, Media Pool DnD, Dock adapter DnD, and Timeline media drop).
- Renderer Vitest: 167 files, 1,177 tests passed.
- Renderer TypeScript: `npx tsc -b tsconfig.web.json --pretty false` passed.
- Production builds: normal and `VITE_WEFTCUT_E2E=1` `electron-vite build` both passed.
- Electron acceptance: the Media search test passed and covers View focus/close, M remaining unbound, and search reopening/focusing the singleton Media Pool before flashing the result. The direct external-drop pipeline and existing caption-search smoke also passed in the combined run.
- The existing real CDP OS Files-drop test now also asserts that the six open Panel kinds remain unchanged. This environment's synthetic Files event did not produce a native-backed path for an ad-hoc tiny fixture, so that conditional fixture-dependent case could not complete locally; component and adapter tests passed the Files/business/Panel drag arbitration contract.
- `npx react-doctor@latest --verbose --scope changed` was attempted once; the online package runner produced no output and was terminated after 30 seconds, so no score was available.
