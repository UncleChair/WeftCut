//! Media probing for import — file hashing, ffprobe metadata, kind detection.
//!
//! Project save / load and the schema-version gate live in TypeScript now
//! (`src/main/state/persistence.ts`): the TS actor is the sole writer and
//! loader of `project.json`. The Rust core only keeps a read-mirror, which
//! `Backend::set_project_mirror` fills with a plain serde deserialize of the
//! already-migrated JSON the TS host pushes — no Rust-side load, save, or
//! migration step remains. On-disk format + versioning: `docs/data-model.md`.

#[cfg(feature = "jobs")]
pub mod probe;
