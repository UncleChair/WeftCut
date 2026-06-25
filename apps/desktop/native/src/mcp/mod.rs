//! MCP tool surface (transport-free). The HTTP/streamable server lives in the
//! Electron main process; this module exposes tools/resources/prompts + a
//! catalog the napi `Backend` bridges. rmcp/axum are gone — the wire types in
//! `wire.rs` serialize to the exact JSON the `@modelcontextprotocol/sdk`
//! low-level Server expects, so the TS layer forwards Rust output verbatim.
//!
//! Module shape:
//! - `wire`     — transport-agnostic result/error/catalog types.
//! - `tools`    — every active tool as a `pub(super) async fn(&Backend, Args)`.
//! - `resources`— the read-only `project://*` / `media://*` resource readers.
//! - `prompts`  — user-invokable prompt templates (`cut-silences`).
//! - `keyframes`— keyframe-authoring helpers (the thin tool wrappers live in
//!   `tools.rs`).
//! - `catalog`  — the `tool_table!` macro feeding BOTH the advertised schemas
//!   and the name→handler dispatch.
//!
//! Design: `docs/mcp.md`.

mod catalog;
mod effects;
mod keyframes;
mod prompts;
mod resources;
mod tools;
mod wire;

pub(crate) use wire::*;

pub(crate) use catalog::{
    catalog, prompt_catalog, resource_catalog, tool_catalog,
};
// `dispatch_tool` is `pub` (catalog.rs macro) so lib.rs can re-export it for the
// mcp_driver differential bin; the `mcp` mod itself is private so this is not a
// production API-surface widening. napi_backend uses `crate::mcp::dispatch_tool`.
pub use catalog::dispatch_tool;
// synthesize_speech hybrid (Phase 3d-e): napi_backend's `synthesize_speech_compute`
// calls the TTS compute half + needs the args type. Re-exported here (the `tools`
// mod is private) — same precedent as `dispatch_tool` above; not a public widening.
#[cfg(feature = "cloud")]
pub(crate) use tools::{SynthesizeSpeechArgs, synthesize_speech_audio};
#[cfg(feature = "replay")]
pub use wire::reply;
pub(crate) use prompts::{catalog as list_prompts, expand as get_prompt};
pub(crate) use resources::read_resource;

use serde::Serialize;

/// Empty arg shape for tools that take no parameters. The dispatch table
/// deserializes `{}` (or any object) into this; `schemars` advertises it as an
/// empty object schema.
#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema, Default)]
pub(crate) struct EmptyArgs {}

/// Snapshot-free projection of a `ChangeEvent` — the wire shape for the
/// `mcp:change` event the napi `Backend` emits. The event rides the EventSink
/// like every other notification.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChangeEventSummary {
    pub op_id: crate::state::OpId,
    pub actor: crate::state::Actor,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub summary: String,
    pub affected: Vec<crate::state::actor::EntityRef>,
    pub diff_hint: crate::state::actor::DiffHint,
}

impl From<&crate::state::actor::ChangeEvent> for ChangeEventSummary {
    fn from(e: &crate::state::actor::ChangeEvent) -> Self {
        Self {
            op_id: e.op_id,
            actor: e.actor.clone(),
            timestamp: e.timestamp,
            summary: e.summary.clone(),
            affected: e.affected.clone(),
            diff_hint: e.diff_hint,
        }
    }
}
