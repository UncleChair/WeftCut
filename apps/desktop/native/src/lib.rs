//! WeftCut domain core, exposed to Electron via napi-rs (`Backend`).
//! Architecture: see `docs/architecture.md` and `docs/mcp.md`.

// imbl's persistent collections have deep type chains (`Vector<T>` → internal
// RRB nodes → Arc<Chunk<Node<T>>>); proving `Send`/`Sync` for the nested
// project state (`state::Project` → `Vector<Track>` → `Vector<Layer>`) blows
// the default trait-recursion limit.
#![recursion_limit = "512"]

// `audio::{conform_reader, mix}` read the VCONF conform format produced by
// `jobs`, and the `export` mixer consumes `audio`. With both deferred features
// off there is no consumer, so gate the whole module to keep the base build lean.
#[cfg(any(feature = "jobs", feature = "export"))]
mod audio;
mod cache;
mod commands;
mod events;
mod napi_backend;
// Always compiled: `io::probe` spawns ffprobe even in the base build, so the
// console-window suppression trait can't live behind a feature gate.
mod process;

#[cfg(feature = "speech")]
mod speech;
// Video-understanding sidecar (scene description). Twin of `speech/`; gated on
// the same `speech` feature — it reuses `jobs` ffmpeg (frame sampling) and the
// `speech::http` cloud client, both of which `speech` already pulls in.
#[cfg(feature = "speech")]
mod vlm;
#[cfg(feature = "export")]
mod export;
// Public because the `media_conformance` bin spawns ffmpeg too and must
// resolve it through the same owner (issue #7 boundary #7) — see ffmpeg/mod.rs.
#[cfg(any(feature = "jobs", feature = "export"))]
pub mod ffmpeg;
mod io;
#[cfg(feature = "jobs")]
mod jobs;
#[cfg(feature = "mcp")]
mod mcp;

mod agent_session;
mod logs;
pub mod state;
pub mod subtitles;
mod workspace;
