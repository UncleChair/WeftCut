//! MCP change-feed: a separate SSE endpoint at `/events` that pushes
//! `ChangeEvent` notifications to subscribed agents. Sits alongside the rmcp
//! JSON-RPC SSE channel rather than riding it as MCP notifications, because
//! rmcp 0.1.x doesn't expose a per-session notification surface — and per
//! docs/mcp.md the events are notifications, not a sync protocol, so a plain
//! SSE stream is the right shape anyway.
//!
//! Event format (per docs/mcp.md):
//! ```text
//! event: change
//! data: {"op_id":"...","actor":{"kind":"User"},"summary":"Moved 'intro'...","affected":[...],"timestamp":"...","diff_hint":{"kind":"Layer","id":"..."}}
//! ```
//!
//! Agents fetch the full new state via `project://current` after a change
//! event arrives. We deliberately do NOT bake the snapshot into the event.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::Router;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use chrono::{DateTime, Utc};
use futures::stream::{Stream, StreamExt};
use serde::Serialize;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tracing::{info, warn};

use crate::state::{Actor, ChangeEvent, DiffHint, EntityRef, OpId, ProjectHandle};

/// Snapshot-free projection of a `ChangeEvent` — the wire shape for `/events`.
#[derive(Debug, Clone, Serialize)]
pub struct ChangeEventSummary {
    pub op_id: OpId,
    pub actor: Actor,
    pub timestamp: DateTime<Utc>,
    pub summary: String,
    pub affected: Vec<EntityRef>,
    pub diff_hint: DiffHint,
}

impl From<&ChangeEvent> for ChangeEventSummary {
    fn from(e: &ChangeEvent) -> Self {
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

/// Connection details for the change-feed endpoint, surfaced to the UI / logs.
#[derive(Debug, Clone, Serialize)]
pub struct EventsInfo {
    pub bind: SocketAddr,
    pub events_url: String,
}

/// Spawn the change-feed server. Picks a free localhost port; the returned
/// `EventsInfo.events_url` is what agents subscribe to (e.g.
/// `http://127.0.0.1:<port>/events`).
pub async fn serve(project: ProjectHandle) -> Result<EventsInfo> {
    let port = pick_free_port().context("pick free localhost port for events server")?;
    let bind: SocketAddr = ([127, 0, 0, 1], port).into();

    let router = Router::new()
        .route("/events", get(events_handler))
        .with_state(project);

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("bind events server on {bind}"))?;
    let actual_bind = listener
        .local_addr()
        .with_context(|| "events listener has no local addr")?;

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!("events server crashed: {e}");
        }
    });

    let info = EventsInfo {
        bind: actual_bind,
        events_url: format!("http://{actual_bind}/events"),
    };
    info!("MCP change-feed listening — events: {}", info.events_url);
    Ok(info)
}

async fn events_handler(
    axum::extract::State(project): axum::extract::State<ProjectHandle>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // Subscribe to the broadcast channel before yielding the stream so we
    // don't miss events that happen between the request arriving and the
    // first poll.
    let rx = project.subscribe();
    let bcast = BroadcastStream::new(rx);
    let stream = bcast.filter_map(|r| async move {
        match r {
            Ok(ev) => {
                let summary = ChangeEventSummary::from(&ev);
                match serde_json::to_string(&summary) {
                    Ok(json) => Some(Ok(Event::default().event("change").data(json))),
                    Err(e) => {
                        warn!("change-feed serialize failed: {e}");
                        None
                    }
                }
            }
            Err(BroadcastStreamRecvError::Lagged(n)) => {
                // Tell the agent it missed some events so it can re-fetch
                // project://current to resync.
                Some(Ok(Event::default()
                    .event("lagged")
                    .data(format!("{{\"missed\": {n}}}"))))
            }
        }
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

fn pick_free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}
