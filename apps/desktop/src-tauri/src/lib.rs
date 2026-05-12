//! Videtor desktop app entry point.
//!
//! Architecture: see `docs/architecture.md`.

// imbl's persistent collections have deep type chains (`Vector<T>` → internal
// RRB nodes → Arc<Chunk<Node<T>>>); proving `Send`/`Sync` of the actor's future
// blows the default trait-recursion limit when the actor captures a deeply
// nested `Arc<Project>`.
#![recursion_limit = "512"]

mod cache;
mod cloud;
mod commands;
mod export;
mod ffmpeg;
mod io;
mod ir;
mod jobs;
mod mcp;
mod mpv;
mod raster;
mod state;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,videtor=debug,videtor_lib=debug")),
        )
        .init();

    tracing::info!("videtor starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_mcp_info,
            commands::project_summary,
            commands::add_video_track,
            commands::add_demo_color_layer,
            commands::add_media_layer,
            commands::add_text_layer,
            commands::add_demo_text_layer,
            commands::split_first_layer,
            commands::update_layer,
            commands::update_layer_params,
            commands::add_subtitles_layer,
            commands::move_layer,
            commands::duplicate_layer,
            commands::delete_layer,
            commands::set_composition,
            commands::add_marker,
            commands::project_undo,
            commands::project_redo,
            commands::project_save_as,
            commands::project_open,
            commands::import_media,
            commands::compile_project,
            commands::export_project,
            commands::export_queue_enqueue,
            commands::export_queue_list,
            commands::export_queue_remove,
            commands::export_queue_clear_finished,
            commands::hw_encoder_probe,
            commands::mpv_close_preview,
            commands::mpv_play_file,
            commands::mpv_play_media,
            commands::mpv_preview_project,
            commands::mpv_seek,
            commands::mpv_set_paused,
            commands::settings_get_api_key_status,
            commands::settings_set_api_key,
            commands::settings_clear_api_key,
            commands::settings_test_provider,
            commands::get_waveform_peaks,
            commands::get_media_thumbnail,
        ])
        .setup(|app| {
            // Project actor — single writer for all state mutations, shared by
            // UI commands (now) and the MCP tool surface.
            let project_handle = state::spawn(state::Project::new_blank("untitled"));
            let project_for_mcp = project_handle.clone();
            let project_for_ui_events = project_handle.clone();
            #[cfg(feature = "mpv")]
            let project_for_preview = project_handle.clone();
            app.manage(project_handle);
            // Lazily-initialised libmpv slot for the preview window; commands
            // populate it on first use. Stub variant when the `mpv` feature
            // is off keeps the same shape so callers don't `cfg!`.
            let mpv_slot = mpv::MpvSlot::default();
            #[cfg(feature = "mpv")]
            let mpv_slot_for_preview = mpv_slot.clone();
            #[cfg(feature = "mpv")]
            let mpv_slot_for_events = mpv_slot.clone();
            app.manage(mpv_slot);

            // Cache layout for media derivatives (proxies / thumbnails /
            // waveforms / on-demand frames). Lives in the OS app-cache dir
            // rather than per-`.vproj` because content-addressed entries can
            // be shared across projects. See `cache/mod.rs` for the
            // deviation rationale + atomicity rules.
            let cache_root = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("./cache"));
            let cache_layout = cache::CacheLayout::new(cache_root);
            if let Err(e) = cache_layout.ensure_dirs() {
                tracing::warn!("cache dir setup failed: {e:#}");
            }
            let cache_for_mcp = cache_layout.clone();
            #[cfg(feature = "mpv")]
            let cache_for_hotreload = cache_layout.clone();
            app.manage(cache_layout);

            // Render queue. Single-task FIFO; emits `export:queue` events on
            // every state change. Lives for the app lifetime.
            let export_queue = export::ExportQueue::new(app.handle().clone());
            app.manage(export_queue);

            // HW encoder cache. Probes the host (NVENC/QSV/AMF/VideoToolbox/
            // VAAPI) on first access, memoized for the process lifetime. We
            // kick off a background probe at startup so the first export
            // doesn't pay the latency.
            let hw_cache = export::HwEncoderCache::new();
            app.manage(hw_cache);
            let hw_for_warmup = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(c) = hw_for_warmup.try_state::<export::HwEncoderCache>() {
                    let _ = c.probe().await;
                }
            });

            if let Err(e) = raster::spawn_spike(app.handle()) {
                tracing::error!("raster spike failed: {e:?}");
            }
            tauri::async_runtime::spawn(async {
                match ffmpeg::bootstrap().await {
                    Ok(ffmpeg::BootstrapStatus::Ready(v)) => tracing::info!("ffmpeg: {v}"),
                    Ok(ffmpeg::BootstrapStatus::Unavailable(why)) => tracing::warn!("ffmpeg unavailable: {why}"),
                    Err(e) => tracing::error!("ffmpeg bootstrap join failed: {e:?}"),
                }
            });
            // Bridge actor ChangeEvents to a Tauri event the React UI listens
            // for. Without this, MCP-driven mutations land in state but the
            // UI panels (project bar, timeline, property panel, media pool)
            // stay frozen until the user clicks something. The payload is a
            // tiny summary — the UI just calls `projectSummary()` again on
            // any signal.
            let app_handle_for_ui_events = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::sync::broadcast::error::RecvError;
                use tauri::Emitter;
                let mut rx = project_for_ui_events.subscribe();
                loop {
                    match rx.recv().await {
                        Ok(event) => {
                            let (actor_kind, client) = match &event.actor {
                                state::Actor::User => ("user", None),
                                state::Actor::Agent { client } => {
                                    ("agent", Some(client.clone()))
                                }
                            };
                            let _ = app_handle_for_ui_events.emit(
                                "project:changed",
                                serde_json::json!({
                                    "op_id": event.op_id.to_string(),
                                    // Legacy: short human-readable label kept
                                    // for back-compat with the existing
                                    // hot-reload bridge.
                                    "actor": match &event.actor {
                                        state::Actor::User => "User".to_string(),
                                        state::Actor::Agent { client } => {
                                            format!("Agent({client})")
                                        }
                                    },
                                    // Structured fields for the activity panel.
                                    "actor_kind": actor_kind,
                                    "client": client,
                                    "summary": event.summary,
                                    "timestamp": event.timestamp.to_rfc3339(),
                                    "affected_count": event.affected.len(),
                                }),
                            );
                        }
                        Err(RecvError::Lagged(n)) => {
                            tracing::warn!(
                                "ui-event bridge: lagged {n} events; emitting refresh signal"
                            );
                            let _ = app_handle_for_ui_events
                                .emit("project:changed", serde_json::json!({ "lagged": n }));
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            // Shared cell the MCP server writes its connection details into
            // once it's bound to a port. The connect-agent panel reads it via
            // the `get_mcp_info` Tauri command.
            let mcp_info_cell: mcp::McpInfoCell = std::sync::Arc::new(std::sync::RwLock::new(None));
            app.manage(mcp_info_cell.clone());
            let app_for_mcp = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match mcp::serve(project_for_mcp, cache_for_mcp, app_for_mcp).await {
                    Ok(info) => {
                        if let Ok(mut slot) = mcp_info_cell.write() {
                            *slot = Some(info);
                        }
                    }
                    Err(e) => tracing::error!("mcp serve failed: {e:?}"),
                }
            });
            tauri::async_runtime::spawn_blocking(mpv::spike);

            // Event poller: drains libmpv's event queue every 200ms and drops
            // the handle when MPV_EVENT_SHUTDOWN arrives. This is what makes
            // the OS close button on the preview window actually close — mpv
            // binds CLOSE_WIN→quit by default, but the resulting Shutdown event
            // doesn't release the window resource until our handle is dropped.
            #[cfg(feature = "mpv")]
            tauri::async_runtime::spawn(async move {
                let mut tick =
                    tokio::time::interval(std::time::Duration::from_millis(200));
                loop {
                    tick.tick().await;
                    let slot = mpv_slot_for_events.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        mpv::drain_events_and_close_if_shutdown(&slot)
                    })
                    .await;
                }
            });

            // Hot-reload: every project commit recompiles the IR and re-applies
            // the lavfi-complex graph to the open libmpv preview window. Only
            // active once the user has opened preview at least once; before
            // that, ChangeEvents are observed but ignored.
            #[cfg(feature = "mpv")]
            tauri::async_runtime::spawn(async move {
                use tokio::sync::broadcast::error::RecvError;
                let mut rx = project_for_preview.subscribe();
                loop {
                    match rx.recv().await {
                        Ok(_event) => {}
                        Err(RecvError::Lagged(n)) => {
                            tracing::warn!(
                                "mpv hot-reload: lagged {n} events; recompiling from current snapshot"
                            );
                        }
                        Err(RecvError::Closed) => break,
                    }
                    if !mpv::is_active(&mpv_slot_for_preview) {
                        continue;
                    }
                    let snap = project_for_preview.snapshot().await;
                    let target = ir::RenderTarget::full(
                        snap.composition.width,
                        snap.composition.height,
                        state::Rational::new(snap.composition.fps.num, snap.composition.fps.den),
                        snap.composition.sample_rate,
                        snap.composition.channels,
                    );
                    let inline_subs =
                        match ir::materialize_inline_subtitles(&snap, &cache_for_hotreload) {
                            Ok(m) => m,
                            Err(e) => {
                                tracing::warn!("mpv hot-reload: materialize failed: {e}");
                                continue;
                            }
                        };
                    let graph = match ir::lower(&snap, target, &inline_subs) {
                        Ok(g) => g,
                        Err(e) => {
                            tracing::warn!("mpv hot-reload: lower failed: {e}");
                            continue;
                        }
                    };
                    let plan = ir::emit_mpv(&graph);
                    let slot = mpv_slot_for_preview.clone();
                    if let Err(e) =
                        tokio::task::spawn_blocking(move || mpv::play_graph(&slot, &plan))
                            .await
                            .unwrap_or_else(|e| Err(format!("join: {e}")))
                    {
                        tracing::warn!("mpv hot-reload: apply failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri runtime");
}

