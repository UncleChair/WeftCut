# 10 — Complete the primary-Layer Attribute Panel

**What to build:** Make Attribute the complete contextual editor for the primary selected Layer, combining the common Layer envelope with existing kind-specific parameters while using the same authoritative move, trim, group, lock, snap, and composition-autofit semantics as Timeline.

**Blocked by:** 02 — Extract five semantic tool Panel boundaries.

**Status:** ready-for-agent

- [ ] Attribute shows name, kind, Track, group state, enabled, locked, Timeline Start, Timeline End, and duration for the primary Layer.
- [ ] Start edits use the existing group-aware move command; End and duration edits use the existing group-aware trim command.
- [ ] Visual, Text, VideoClip, ImageOverlay, Color, Audio, and Motif fields retain their current editing and keyframe behaviour.
- [ ] Audio exposes per-Layer gain, pan, fades, mute, and Audio Role; Motif exposes its accepted lifecycle controls.
- [ ] Multi-selection clearly identifies which primary Layer Attribute edits without implying batch editing.
- [ ] Component and actor-facing tests prove command routing, frame snapping, group behaviour, and one expected undo per edit.
