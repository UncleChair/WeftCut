# 12 — Complete the global Caption corpus workflow

**What to build:** Make Caption a project-wide management surface across every caption-role Track, with synchronized cue navigation and one atomic restyle command for the entire caption corpus.

**Blocked by:** 02 — Extract five semantic tool Panel boundaries.

**Status:** ready-for-agent

- [ ] Cues from every caption-role Track are flattened in time order, including overlapping tracks.
- [ ] Activating a cue selects its Text Layer, seeks to its start, and reveals it in Timeline.
- [ ] Inline text editing continues to update one ordinary Text Layer.
- [ ] Project-wide style changes update all caption-role Tracks in one actor command and one undo entry.
- [ ] Attribute can still edit a selected caption Text Layer as an ordinary Text Layer.
- [ ] Mutation, actor routing, IPC, Panel, navigation, undo, and Electron tests cover the end-to-end workflow.
