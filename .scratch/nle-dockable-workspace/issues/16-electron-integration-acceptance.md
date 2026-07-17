# 16 — Complete cross-Panel Electron integration acceptance

**What to build:** Exercise the finished Dock Workspace as one real editor workflow and harden any integration seams so layout operations and every business Panel continue to use the same Project actor, playback resources, drag protocols, and undo model.

**Blocked by:** 03 — Replace the inline HUD with an on-demand Dev Performance Monitor; 06 — Let the Media Pool Panel replace the legacy drawer; 09 — Manage named Workspaces and saved baselines; 10 — Complete the primary-Layer Attribute Panel; 11 — Complete the Effect Panel and isolated pointer reordering; 12 — Complete the global Caption corpus workflow; 13 — Complete Nearby discovery, reveal, and rename; 15 — Add Role Gain audition and the real Master meter.

**Status:** ready-for-agent

- [ ] Electron tests cover real Panel center/edge drag, tab reorder, split resize, close/reopen, focus, maximize, empty recovery, and restart persistence.
- [ ] Media payloads, OS Files, Timeline move/trim, Effect reordering, and Panel docking remain mutually exclusive.
- [ ] Preview resource identity and playback continuity survive the full Dock operation matrix; actual close destroys the resource.
- [ ] Selection, Attribute timing, Caption navigation/restyle, Effect ordering, Nearby rename/go-to, and Role gain/meter work after Panel moves and Workspace switches.
- [ ] Workspace mutation never dirties the Project or changes Project undo depth; business mutations retain their specified undo granularity.
- [ ] Typecheck, focused unit/integration suites, Electron acceptance, accessibility checks, and production build pass without assertions on Dockview private DOM or JSON.
