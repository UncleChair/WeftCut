# 09 — Manage named Workspaces and saved baselines

**What to build:** Let editors create and manage task-specific app-level Workspaces with separate auto-saved current layouts and explicit reset baselines, while keeping built-in Editing immutable and always recoverable.

**Blocked by:** 08 — Persist and recover the current Editing Workspace.

**Status:** ready-for-agent

- [ ] View lists Editing and custom Workspaces and exposes switch, save, save-as, rename, delete, and reset operations.
- [ ] Switching flushes the current profile and restores the destination without a save prompt.
- [ ] Save promotes current to the custom profile's baseline; Reset restores that baseline.
- [ ] Editing cannot be renamed, deleted, or overwritten.
- [ ] Deleting the active custom Workspace first activates Editing.
- [ ] Store, menu, IPC, and Electron tests cover profile CRUD, active selection, baselines, and restart.
