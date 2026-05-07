//! MCP server: tool surface, resources, prompts, SSE change feed.
//!
//! Transport: Streamable HTTP on `127.0.0.1:<auto-port>` per the architecture doc.
//! Phase 0 spike falls back to **SSE** because `rmcp` (0.1.x) hasn't shipped
//! Streamable HTTP yet — Claude Desktop accepts both. Swap to streamable-http when
//! the upstream feature lands.
//!
//! Per-session bearer token, regenerated on each app launch unless pinned.
//! Phase 0 spike: token is generated and logged but **NOT enforced** — `rmcp`'s
//! `SseServer` doesn't expose middleware injection. Bind is localhost-only, which
//! provides single-host isolation. Real auth is a Phase 4 concern (`docs/mcp.md`).
//!
//! Phase 1.8 layers in a single read-only resource: `project://current` returns
//! the project snapshot as JSON. Edit tools are still Phase 4 work.
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
use tracing::info;

use crate::state::ProjectHandle;

const PROJECT_URI: &str = "project://current";

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
                 Phase 1: read `project://current` for the full project state; \
                 `ping` confirms reachability. Edit tools land in Phase 4."
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
        let resource = RawResource {
            uri: PROJECT_URI.to_string(),
            name: "Current project".to_string(),
            description: Some(
                "The open Videtor project as JSON. Re-fetch after change events.".to_string(),
            ),
            mime_type: Some("application/json".to_string()),
            size: None,
        }
        .no_annotation();
        Ok(ListResourcesResult {
            resources: vec![resource],
            next_cursor: None,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParam,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        match request.uri.as_str() {
            PROJECT_URI => {
                let snap = self.project.snapshot().await;
                let json = serde_json::to_string_pretty(&*snap).map_err(|e| {
                    McpError::internal_error(
                        format!("serialize project: {e}"),
                        None,
                    )
                })?;
                Ok(ReadResourceResult {
                    contents: vec![ResourceContents::TextResourceContents {
                        uri: PROJECT_URI.to_string(),
                        mime_type: Some("application/json".to_string()),
                        text: json,
                    }],
                })
            }
            other => Err(McpError::resource_not_found(
                format!("unknown resource URI: {other}"),
                None,
            )),
        }
    }
}

pub async fn serve(project: ProjectHandle) -> Result<McpInfo> {
    let port = pick_free_port().context("pick free localhost port")?;
    let bind = SocketAddr::from(([127, 0, 0, 1], port));
    let bearer_token = random_token();

    let server = SseServer::serve(bind).await.context("start rmcp SSE server")?;
    // The cancellation token gates the spawned server task. We intentionally drop
    // it — the server keeps running for the app's lifetime; tearing it down is a
    // future Phase 4 concern when sessions get pinned/unpinned.
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
    // is enough to avoid trivial guessing on a single-user machine. Phase 4 swaps in
    // a CSPRNG-backed token and surfaces it through the keyring.
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
