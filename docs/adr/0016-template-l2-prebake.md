---
status: accepted
---

# Template L2 persisted pre-bake

## Context

L1 (in-RAM lookahead) can't keep up when raster throughput is the bottleneck
(stacked templates / 4K / weak GPU): playback stutters and reopening a project
re-rasters every frame. The L2 disk layer existed in `frameCache.ts` but was
unwired and runtime-blocked (the fs scope excluded the user-chosen workspace).

## Decision

- Grant the fs plugin the workspace dir at project-open
  (`app.fs_scope().allow_directory(ws, true)`) plus the `fs:allow-*` perms.
- `resolveTemplateFrame` is a read-only disk-first path shared by the sprite and
  prewarmer; a `TemplateBaker` is the sole writer (centralized → no
  fire-and-forget LRU-eviction race).
- Two explicit triggers: a global "Pre-bake" setting (default off) and a
  per-layer "Pre-bake now". No measurement-driven auto-escalation (rejected:
  a single-raster timing mispredicts the stacked-template case).
- PNG, not WebP (Canvas WebP is lossy; see ADR 0015). Bake at the template's authored size (`manifest.size`); the layer's scale is applied at composite time, so it is out of the cache key.
- A baked-key index (readDir on load) gates disk reads so un-baked templates
  pay no fs cost.

## Consequences

- Manual pre-bakes persist: PNGs are the state, honored on reload even with the
  global toggle off.
- Export reading PNGs directly is a possible follow-up, not part of this change.
- User-facing name is "Pre-bake", never "cache to disk".
