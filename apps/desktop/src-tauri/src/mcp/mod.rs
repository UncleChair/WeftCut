//! MCP server: tool surface, resources, prompts, SSE change feed.
//!
//! Transport: SSE on `127.0.0.1:<auto-port>`. Streamable HTTP is the spec
//! target but rmcp 0.1.x hasn't shipped it yet — Claude Desktop accepts both.
//! Swap to streamable-http when upstream lands.
//!
//! Per-session bearer token, regenerated on each app launch unless pinned.
//! rmcp 0.1.x's `SseServer` doesn't expose middleware injection, so the
//! token is generated and surfaced (UI panel + log) but **NOT enforced** on
//! incoming requests. Localhost-only binding is the real isolation on a
//! single-user machine; flipping to 0.0.0.0 must wait for proper auth.
//!
//! Resource surface (read-only, Phase 4 Stage 2):
//! - `project://current`     — full Project JSON
//! - `project://composition` — Composition only
//! - `project://media`       — media pool
//! - `project://tracks`      — tracks + layer envelopes
//! - `project://layers/{id}` — one Layer in detail
//! - `project://layers/{id}/effects` — effects on that layer (always [] today;
//!   effects deferred per `project_phase4_scope.md`)
//! - `project://markers`     — markers
//! - `project://history`     — recent ops + checkpoints (snapshot-free)
//! - `project://compiled`    — compiled IRGraph (JSON)
//!
//! Edit tools and the SSE change feed land in later Phase 4 stages.
//!
//! Design: `docs/mcp.md`.

use std::net::SocketAddr;

use anyhow::{Context, Result};
use rmcp::{
    Error as McpError, ServerHandler,
    model::{
        AnnotateAble, ListResourcesResult, PaginatedRequestParam, RawResource,
        ReadResourceRequestParam, ReadResourceResult, ResourceContents, ServerCapabilities,
        ServerInfo,
    },
    service::RequestContext,
    tool,
    transport::sse_server::SseServer,
};
use serde::Serialize;
use serde_json::Value;
use tracing::info;
use uuid::Uuid;

use crate::ir::{self, RenderTarget};
use crate::state::{LayerId, ProjectHandle, Rational};

const URI_PROJECT: &str = "project://current";
const URI_COMPOSITION: &str = "project://composition";
const URI_MEDIA: &str = "project://media";
const URI_TRACKS: &str = "project://tracks";
const URI_MARKERS: &str = "project://markers";
const URI_HISTORY: &str = "project://history";
const URI_COMPILED: &str = "project://compiled";
const PREFIX_LAYERS: &str = "project://layers/";

const HISTORY_LIMIT: usize = 100;

const APP_JSON: &str = "application/json";

/// Connection details surfaced to the UI / logs so the user can wire up Claude Desktop.
#[derive(Debug, Clone, Serialize)]
pub struct McpInfo {
    pub bind: SocketAddr,
    pub sse_url: String,
    pub message_url: String,
    pub bearer_token: String,
}

/// The MCP server identity. Carries a `ProjectHandle` so resources can read
/// state via the same single-writer actor that the UI commands use.
#[derive(Debug, Clone)]
pub struct VidetorServer {
    project: ProjectHandle,
}

#[tool(tool_box)]
impl VidetorServer {
    pub fn new(project: ProjectHandle) -> Self {
        Self { project }
    }

    #[tool(description = "Liveness check. Returns 'pong' to confirm the Videtor MCP server is reachable.")]
    async fn ping(&self) -> String {
        "pong".to_string()
    }
}

#[tool(tool_box)]
impl ServerHandler for VidetorServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Videtor exposes the open project as an MCP tool surface. \
                 Read-only resources cover the project state under `project://*`. \
                 Edit tools and change-feed events land in later Phase 4 stages."
                    .to_string(),
            ),
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
            ..Default::default()
        }
    }

    async fn list_resources(
        &self,
        _request: PaginatedRequestParam,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let resources = STATIC_RESOURCES
            .iter()
            .map(|d| {
                RawResource {
                    uri: d.uri.to_string(),
                    name: d.name.to_string(),
                    description: Some(d.description.to_string()),
                    mime_type: Some(APP_JSON.to_string()),
                    size: None,
                }
                .no_annotation()
            })
            .collect();
        Ok(ListResourcesResult {
            resources,
            next_cursor: None,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParam,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        let snap = self.project.snapshot().await;
        let uri = request.uri.as_str();

        let body: Value = match uri {
            URI_PROJECT => serde_json::to_value(&*snap).map_err(serialize_err)?,
            URI_COMPOSITION => serde_json::to_value(&snap.composition).map_err(serialize_err)?,
            URI_MEDIA => serde_json::to_value(&snap.media_pool).map_err(serialize_err)?,
            URI_TRACKS => serde_json::to_value(&snap.tracks).map_err(serialize_err)?,
            URI_MARKERS => serde_json::to_value(&snap.markers).map_err(serialize_err)?,
            URI_HISTORY => {
                let view = self.project.history_view(HISTORY_LIMIT).await;
                serde_json::to_value(&view).map_err(serialize_err)?
            }
            URI_COMPILED => {
                let target = RenderTarget::full(
                    snap.composition.width,
                    snap.composition.height,
                    Rational::new(snap.composition.fps.num, snap.composition.fps.den),
                    snap.composition.sample_rate,
                    snap.composition.channels,
                );
                match ir::lower(&snap, target) {
                    Ok(graph) => serde_json::to_value(&graph).map_err(serialize_err)?,
                    Err(e) => {
                        return Err(McpError::internal_error(
                            format!("compile project: {e}"),
                            None,
                        ));
                    }
                }
            }
            other if other.starts_with(PREFIX_LAYERS) => {
                let tail = &other[PREFIX_LAYERS.len()..];
                let (id_part, want_effects) = match tail.split_once('/') {
                    Some((id, "effects")) => (id, true),
                    Some((_, suffix)) => {
                        return Err(McpError::resource_not_found(
                            format!("unsupported layer sub-resource '{suffix}'"),
                            None,
                        ));
                    }
                    None => (tail, false),
                };
                let layer_id: LayerId = Uuid::parse_str(id_part).map_err(|_| {
                    McpError::resource_not_found(
                        format!("layer URI has invalid UUID: {id_part}"),
                        None,
                    )
                })?;
                let layer = snap
                    .tracks
                    .iter()
                    .flat_map(|t| t.layers.iter())
                    .find(|l| l.id == layer_id)
                    .ok_or_else(|| {
                        McpError::resource_not_found(
                            format!("layer {layer_id} not found"),
                            None,
                        )
                    })?;
                if want_effects {
                    // Effects deferred to Phase 4.x — see project_phase4_scope.md.
                    // The resource is reachable so agents can rely on the URI shape;
                    // it just always returns an empty array today.
                    serde_json::to_value(&layer.effects).map_err(serialize_err)?
                } else {
                    serde_json::to_value(layer).map_err(serialize_err)?
                }
            }
            other => {
                return Err(McpError::resource_not_found(
                    format!("unknown resource URI: {other}"),
                    None,
                ));
            }
        };

        let text = serde_json::to_string_pretty(&body).map_err(serialize_err)?;
        Ok(ReadResourceResult {
            contents: vec![ResourceContents::TextResourceContents {
                uri: uri.to_string(),
                mime_type: Some(APP_JSON.to_string()),
                text,
            }],
        })
    }
}

struct ResourceDescriptor {
    uri: &'static str,
    name: &'static str,
    description: &'static str,
}

const STATIC_RESOURCES: &[ResourceDescriptor] = &[
    ResourceDescriptor {
        uri: URI_PROJECT,
        name: "Current project",
        description: "The full open Videtor project as JSON. Re-fetch after change events.",
    },
    ResourceDescriptor {
        uri: URI_COMPOSITION,
        name: "Composition",
        description: "Canvas size, fps, sample rate, color space, background.",
    },
    ResourceDescriptor {
        uri: URI_MEDIA,
        name: "Media pool",
        description: "All imported media items keyed by id.",
    },
    ResourceDescriptor {
        uri: URI_TRACKS,
        name: "Tracks",
        description: "Tracks with layer envelopes. Read project://layers/{id} for full layer detail.",
    },
    ResourceDescriptor {
        uri: URI_MARKERS,
        name: "Markers",
        description: "Timeline markers, sorted by t_us.",
    },
    ResourceDescriptor {
        uri: URI_HISTORY,
        name: "History",
        description: "Recent operations and named checkpoints (no snapshots).",
    },
    ResourceDescriptor {
        uri: URI_COMPILED,
        name: "Compiled IR",
        description: "Compiled IR graph for the current project — for agents that want structural reasoning.",
    },
];

fn serialize_err(e: serde_json::Error) -> McpError {
    McpError::internal_error(format!("serialize: {e}"), None)
}

pub async fn serve(project: ProjectHandle) -> Result<McpInfo> {
    let port = pick_free_port().context("pick free localhost port")?;
    let bind = SocketAddr::from(([127, 0, 0, 1], port));
    let bearer_token = random_token();

    let server = SseServer::serve(bind).await.context("start rmcp SSE server")?;
    // The cancellation token gates the spawned server task. We intentionally drop
    // it — the server keeps running for the app's lifetime; tearing it down is a
    // future concern when sessions get pinned/unpinned.
    let project_for_factory = project.clone();
    let _ct = server.with_service(move || VidetorServer::new(project_for_factory.clone()));

    let info = McpInfo {
        bind,
        sse_url: format!("http://{bind}/sse"),
        message_url: format!("http://{bind}/message"),
        bearer_token,
    };

    info!(
        "MCP server listening — sse: {} message: {} bearer: {}",
        info.sse_url, info.message_url, info.bearer_token
    );
    Ok(info)
}

fn pick_free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Localhost-only spike token — entropy from monotonic-ish nanoseconds + process id
    // is enough to avoid trivial guessing on a single-user machine. Real auth swaps in
    // a CSPRNG-backed token and surfaces it through the keyring; gated on rmcp shipping
    // middleware support.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut seed = [0u8; 24];
    seed[..16].copy_from_slice(&nanos.to_le_bytes());
    seed[16..20].copy_from_slice(&std::process::id().to_le_bytes());
    seed[20..24].copy_from_slice(&fastrand_seed_from_addr().to_le_bytes());
    blake3::hash(&seed).to_hex().to_string()
}

fn fastrand_seed_from_addr() -> u32 {
    // Stack-address bits — varies across runs thanks to ASLR, no extra deps needed.
    let local = 0u8;
    (&local as *const u8 as usize) as u32
}
