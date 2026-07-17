# 01 — Promote complete Layer selection to a global model

**What to build:** Make the renderer expose one authoritative selection model containing the primary Layer and the complete selected Layer set, so Timeline, search, Caption, Nearby, Attribute, and Effect always observe and mutate the same selection.

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] Plain, additive, range, and group selection preserve current Timeline behaviour while updating the global primary and selected set atomically.
- [x] External navigation can select one Layer or a complete set without Timeline-local state drifting from the global model.
- [x] The primary Layer is null exactly when the selected set is empty and otherwise belongs to the selected set.
- [x] Existing delete, copy, grouping, search, reveal, and project-session reset flows continue to work.
- [x] Store, navigation, and Timeline interaction tests cover invariant preservation and no-op updates.
