//! WeftCut domain core, exposed to Electron via napi-rs (`Backend`).
//! Architecture: see `docs/architecture.md` and `docs/mcp.md`.

// imbl's persistent collections have deep type chains (`Vector<T>` → internal
// RRB nodes → Arc<Chunk<Node<T>>>); proving `Send`/`Sync` of the actor's future
// blows the default trait-recursion limit when the actor captures a deeply
// nested `Arc<Project>`.
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

#[cfg(any(feature = "jobs", feature = "export"))]
mod ffmpeg;
mod io;
#[cfg(feature = "jobs")]
mod jobs;
#[cfg(feature = "export")]
mod export;
#[cfg(feature = "cloud")]
mod cloud;
#[cfg(feature = "mcp")]
mod mcp;

mod keybindings;
mod logs;
mod preview;
mod agent_session;
mod recents;
pub mod state;
pub mod subtitles;
mod workspace;
