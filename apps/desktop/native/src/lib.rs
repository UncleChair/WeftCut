//! WeftCut domain core, exposed to Electron via napi-rs (`Backend`).
//! Architecture: see `docs/architecture.md` and `docs/mcp.md`.

// imbl's persistent collections have deep type chains (`Vector<T>` → internal
// RRB nodes → Arc<Chunk<Node<T>>>); proving `Send`/`Sync` of the actor's future
// blows the default trait-recursion limit when the actor captures a deeply
// nested `Arc<Project>`.
#![recursion_limit = "512"]

mod app_settings;
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
// Plain JSON store, no `export`/ffmpeg dependency — kept ungated so the prefs
// command group can reach `export_settings_get/set` without `export`.
mod export_settings_store;
#[cfg(feature = "cloud")]
mod cloud;
#[cfg(feature = "mcp")]
mod mcp;
#[cfg(feature = "motifs")]
mod motifs;
// The Motif *catalog* (manifest schema + built-ins) is pure serde data with no
// capture dependency, and the core `state` actor reaches it to clamp
// Motif-layer content windows. Keep it reachable as `crate::motifs::catalog`
// even when the capture subsystem (the rest of `motifs`) is gated off.
#[cfg(not(feature = "motifs"))]
mod motifs {
    // `#[path]` on a submodule of an inline module resolves relative to the
    // inline module's directory (`src/motifs/`), so name the file bare.
    #[path = "catalog.rs"]
    pub mod catalog;
}

mod keybindings;
mod logs;
mod preview;
mod agent_session;
mod recents;
mod state;
pub mod subtitles;
mod view_state;
mod workspace;
