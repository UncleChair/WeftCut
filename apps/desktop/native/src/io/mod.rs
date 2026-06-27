//! Media probing for import — file hashing, ffprobe metadata, kind detection.
//!
//! Project save / load and the schema-version gate live in TypeScript now
//! (`src/main/state/persistence.ts`): the TS actor is the sole writer and
//! loader of `project.json`. The Rust core holds no resident project state; it
//! only deserializes the project/MediaItem slice it is handed per compute call
//! (audio export, `project://compiled`) — no Rust-side load, save, or migration
//! step remains. On-disk format + versioning: `docs/data-model.md`.

#[cfg(feature = "jobs")]
pub mod probe;
