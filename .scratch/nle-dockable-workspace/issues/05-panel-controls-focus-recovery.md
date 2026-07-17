# 05 — Complete Panel controls, focus, maximize, and recovery

**What to build:** Give editors complete control over singleton Panels through the View menu and keyboard: open or focus, close, reopen at the last meaningful placement, cycle focus, maximize temporarily, and recover from an intentionally empty Workspace.

**Blocked by:** 04 — Introduce the Dock Tree and built-in Editing layout.

**Status:** completed

- [x] View entries focus open Panels and reopen closed Panels at last placement or the agreed semantic fallback.
- [x] A single active Panel closes through View while multi-Panel tabs expose direct close controls.
- [x] Closing every Panel produces an intentional empty state with Open Panel and Reset Workspace recovery actions.
- [x] Focus cycling, one-pixel focus indication, backquote maximize, double-click maximize, and exact restore geometry work without changing global editing shortcuts.
- [x] Editable fields, dialogs, menus, and transient widgets retain shortcut suppression.
- [x] Adapter and UI tests cover close destruction, reopen recreation, focus, maximize, empty state, and fallback placement.

## Validation

- Focused Vitest: 5 files, 26 tests passed (adapter, DockWorkspace, View menu, App menu, shortcuts).
- Renderer Vitest: 167 files, 1,174 tests passed.
- Renderer TypeScript: `npx tsc -b tsconfig.web.json --pretty false` passed.
- Production build: `npm run build` passed; the E2E-hook build also passed.
- Electron smoke: existing `dock-workspace.spec.ts` passed after the required `VITE_WEFTCUT_E2E=1` build.
- React Doctor was attempted with the required changed-scope command; the unavailable network/package produced no output before the bounded 25-second timeout, so no score was available.
