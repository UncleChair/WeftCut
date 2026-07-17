# 08 — Persist and recover the current Editing Workspace

**What to build:** Persist the current app-level Dock arrangement in an atomic versioned Electron document, restore it after restart, and repair invalid data through current, saved, and built-in Editing fallbacks without touching Project state or history.

**Blocked by:** 05 — Complete Panel controls, focus, maximize, and recovery.

**Status:** ready-for-agent

- [ ] Main owns an atomic versioned Workspace document and debounced disk writes with a quit-time flush.
- [ ] Renderer sends validated WeftCut layout snapshots and restores through existing-Panel reuse.
- [ ] Selected tabs, split proportions, open/closed state, tab order, and closed-Panel placement survive restart.
- [ ] Unknown Panel kinds are dropped, duplicate singletons are normalized, and successful fallback repairs current storage.
- [ ] An intentionally empty Workspace is valid and distinct from missing or corrupt layout data.
- [ ] Workspace mutations never dirty the Project or enter Project undo history.
- [ ] Store, adapter, IPC, restart, fallback, and empty-layout tests cover the full path.
