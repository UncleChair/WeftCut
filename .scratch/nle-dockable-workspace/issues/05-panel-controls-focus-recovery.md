# 05 — Complete Panel controls, focus, maximize, and recovery

**What to build:** Give editors complete control over singleton Panels through the View menu and keyboard: open or focus, close, reopen at the last meaningful placement, cycle focus, maximize temporarily, and recover from an intentionally empty Workspace.

**Blocked by:** 04 — Introduce the Dock Tree and built-in Editing layout.

**Status:** ready-for-agent

- [ ] View entries focus open Panels and reopen closed Panels at last placement or the agreed semantic fallback.
- [ ] A single active Panel closes through View while multi-Panel tabs expose direct close controls.
- [ ] Closing every Panel produces an intentional empty state with Open Panel and Reset Workspace recovery actions.
- [ ] Focus cycling, one-pixel focus indication, backquote maximize, double-click maximize, and exact restore geometry work without changing global editing shortcuts.
- [ ] Editable fields, dialogs, menus, and transient widgets retain shortcut suppression.
- [ ] Adapter and UI tests cover close destruction, reopen recreation, focus, maximize, empty state, and fallback placement.
