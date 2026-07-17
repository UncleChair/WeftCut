# 11 — Complete the Effect Panel and isolated pointer reordering

**What to build:** Make Effect the exclusive home of the primary visual Layer's ordered effect chain, including full card interactions and pointer reordering that cannot be mistaken for Panel docking.

**Blocked by:** 04 — Introduce the Dock Tree and built-in Editing layout.

**Status:** ready-for-agent

- [ ] Visual primary Layers expose add, enable, collapse, delete, parameter, keyframe, color, and ordered chain controls only in Effect.
- [ ] Audio selection shows an explicit unsupported state and no add-effect surface.
- [ ] Pointer drag reorders cards with one final command while keyboard-accessible move controls remain available.
- [ ] Effect pointer gestures never initiate Dockview HTML5 Panel drag and Panel tabs never reorder Effects.
- [ ] Existing transient overrides, catalog ownership, renderer output, and undo semantics remain authoritative.
- [ ] Component, pointer-sequence, actor, and Electron tests cover reordering and DnD isolation.
