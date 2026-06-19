---
status: accepted
---

# Motif L2 persisted pre-bake

## Context

L1 (in-RAM lookahead) can't keep up when raster throughput is the bottleneck
(stacked motifs / 4K / weak GPU): playback stutters and reopening a project
re-rasters every frame. The L2 disk layer existed in `frameCache.ts` but was
unwired — nothing read or wrote it.

## Decision

- Enable the on-disk layer under `<workspace>/Cache/raster/`, read and written
  via the fs bridge (`@/bridge/fs`) once a project is open.
- `resolveMotifFrame` is a read-only disk-first path shared by the sprite and
  prewarmer; a `MotifBaker` is the sole writer (centralized → no
  fire-and-forget LRU-eviction race).
- Two explicit triggers: a global "Pre-bake" setting (default off) and a
  per-layer "Pre-bake now". No measurement-driven auto-escalation (rejected:
  a single-raster timing mispredicts the stacked-motif case).
- PNG, not WebP (Canvas WebP is lossy; see ADR 0015). Bake at the motif's authored size (`manifest.size`); the layer's scale is applied at composite time, so it is out of the cache key.
- A baked-key index (readDir on load) gates disk reads so un-baked motifs
  pay no fs cost.

## Consequences

- Manual pre-bakes persist: PNGs are the state, honored on reload even with the
  global toggle off.
- Export reading PNGs directly is a possible follow-up, not part of this change.
- User-facing name is "Pre-bake", never "cache to disk".
