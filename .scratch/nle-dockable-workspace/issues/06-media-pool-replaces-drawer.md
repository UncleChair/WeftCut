# 06 — Let the Media Pool Panel replace the legacy drawer

**What to build:** Make the dockable Media Pool the only Media Pool surface and entry point, removing the unreleased drawer preference and M shortcut without migration while preserving import and reveal workflows.

**Blocked by:** 05 — Complete Panel controls, focus, maximize, and recovery.

**Status:** ready-for-agent

- [ ] View and navigation actions open or focus the Media Pool Panel instead of toggling a drawer.
- [ ] The drawer setting, renderer state, fixed-grid class, menu copy, and shortcut action are removed across the app.
- [ ] M is unbound and available for a future Marker command; stale persisted keys are harmlessly ignored.
- [ ] Media import, OS file drop, media-to-Timeline drag, and search reveal remain operational.
- [ ] Settings, shortcuts, navigation, and Electron drag/drop tests cover the final behaviour.
