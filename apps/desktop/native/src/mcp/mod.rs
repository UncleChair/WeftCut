//! MCP tool surface (transport-free). The HTTP/streamable server lives in the
//! Electron main process; this module exposes tools/resources/prompts + a
//! catalog the napi `Backend` bridges. The wire types in `wire.rs` serialize
//! to the exact JSON the `@modelcontextprotocol/sdk` low-level Server
//! expects, so the TS layer forwards Rust output verbatim.
//!
//! Module shape:
//! - `wire`     — transport-agnostic result/error/catalog types.
//! - `tools`    — native/compute/hybrid-compute tools only; mutations are
//!   served by the TS actor's `MCP_TOOLS` table, never here.
//! - `resources`— the read-only `project://*` / `media://*` resource readers.
//! - `prompts`  — user-invokable prompt templates (`cut-silences`).
//! - `catalog`  — the `tool_table!` macro feeding BOTH the advertised schemas
//!   and the name→handler dispatch (native/compute/hybrid only).
//!
//! Design: `docs/mcp.md`.

mod catalog;
mod prompts;
mod resources;
mod tools;
mod wire;

pub(crate) use wire::*;

pub(crate) use catalog::catalog;
// `dispatch_tool` is `pub` (catalog.rs macro); napi_backend uses
// `crate::mcp::dispatch_tool`. The `mcp` mod itself is private.
pub use catalog::dispatch_tool;
// synthesize_speech hybrid: napi_backend's `synthesize_speech_compute`
// calls the TTS compute half + needs the args type. Re-exported here (the `tools`
// mod is private) — same precedent as `dispatch_tool` above; not a public widening.
#[cfg(feature = "cloud")]
pub(crate) use tools::{SynthesizeSpeechArgs, synthesize_speech_audio};
pub(crate) use prompts::{catalog as list_prompts, expand as get_prompt};
pub(crate) use resources::read_resource;

// The `mcp:change` notification is emitted by the TS host (the TS actor's
// `mcpCall` notifies via `mcpNotify`) post-4b; the Rust `ChangeEventSummary`
// wire-projection + its `From<&ChangeEvent>` impl went with the deleted actor.

/// Empty arg shape for tools that take no parameters. The dispatch table
/// deserializes `{}` (or any object) into this; `schemars` advertises it as an
/// empty object schema.
#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema, Default)]
pub(crate) struct EmptyArgs {}
