# 13 — Complete Nearby discovery, reveal, and rename

**What to build:** Make Nearby a self-contained A/B Roll discovery surface that reveals hidden unassigned-track Layers without unexpectedly moving the playhead, while offering explicit navigation and lightweight rename.

**Blocked by:** 02 — Extract five semantic tool Panel boundaries.

**Status:** ready-for-agent

- [ ] Nearby lists hidden role-null Layers intersecting the configured playhead window and filters Video, Audio, and Text.
- [ ] Selecting an item updates global selection and reveals its Track without seeking.
- [ ] An explicit Go To action seeks and scrolls to the Layer.
- [ ] Show All mode explains that all Tracks are already visible instead of rendering an unexplained blank Panel.
- [ ] Double-click rename supports commit and cancel and uses the recorded Layer label command.
- [ ] Pure windowing, navigation, rename, component, and Electron tests verify playhead and undo behaviour.
