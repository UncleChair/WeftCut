//! Media probing for import — file hashing, ffprobe metadata, kind detection.
//!
//! No project persistence here — TS owns `project.json`
//! (`src/main/state/persistence.ts`). On-disk format + versioning:
//! `docs/data-model.md`.

#[cfg(feature = "jobs")]
pub mod probe;
