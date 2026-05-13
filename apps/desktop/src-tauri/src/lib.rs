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
mod workspace;

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
            commands::reset_mcp_token,
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
            commands::mpv_set_surface_rect,
            commands::mpv_set_host_visible,
            commands::mpv_set_host_clip,
            commands::settings_get_api_key_status,
            commands::settings_set_api_key,
            commands::settings_clear_api_key,
            commands::settings_test_provider,
            commands::get_waveform_peaks,
            commands::get_media_thumbnail,
            commands::list_templates,
            commands::add_template,
            commands::template_preview,
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
            // Lazily-initialised libmpv slots. Two distinct instances so
            // they don't share `wid` / graph state:
            //   * `mpv_slot`        — project preview (embedded into the
            //                         WebView2 sibling HWND on Windows).
            //   * `mpv_popup_slot`  — media-pool / raw-file preview, always
            //                         a standalone top-level window. No
            //                         host_hwnd is registered on this slot,
            //                         so `ensure_init` falls back to
            //                         `force-window=yes`.
            // Stub variants when the `mpv` feature is off keep the same
            // shape so callers don't `cfg!`.
            let mpv_slot = mpv::MpvSlot::default();
            let mpv_popup_slot = mpv::MpvPopupSlot::default();
            #[cfg(feature = "mpv")]
            let mpv_slot_for_preview = mpv_slot.clone();
            #[cfg(feature = "mpv")]
            let mpv_slot_for_events = mpv_slot.clone();
            #[cfg(feature = "mpv")]
            let mpv_popup_for_events = mpv_popup_slot.clone();

            // Windows embed: create a child HWND of the main Tauri window to
            // host libmpv's VO for the *project* preview. Registered on the
            // embed slot only — the popup slot stays unregistered so raw
            // file previews keep opening as standalone top-level windows.
            #[cfg(all(feature = "mpv", target_os = "windows"))]
            {
                if let Some(main_window) = app.get_webview_window("main") {
                    match main_window.hwnd() {
                        Ok(parent) => match mpv::create_host_hwnd(parent.0 as isize) {
                            Ok(host) => mpv::set_host_hwnd(&mpv_slot, host),
                            Err(e) => tracing::error!("mpv embed: create_host_hwnd: {e}"),
                        },
                        Err(e) => tracing::error!("mpv embed: main_window.hwnd: {e}"),
                    }
                } else {
                    tracing::error!("mpv embed: main webview window not found");
                }
            }

            app.manage(mpv_slot);
            app.manage(mpv_popup_slot);

            // Cache layout. **Per workspace-redesign Q3** (`docs/workspace-
            // redesign.md`), the cache lives at `<workspace>/Cache/` once a
            // workspace is opened or saved. Until then — the blank-on-boot
            // session before any Save As / Open — we use OS app-cache as a
            // transitional fallback so the pre-existing import / proxy /
            // thumbnail pipeline still works. `project_save_as` and
            // `project_open` call `cache.set_workspace(...)` to flip the root
            // to the workspace folder at the right moment. Phase B's startup
            // screen will make "no workspace" unreachable.
            let cache_root = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("./cache"));
            let cache_layout = cache::CacheLayout::new(cache_root);
            if let Err(e) = cache_layout.ensure_dirs() {
                tracing::warn!("cache dir setup failed: {e:#}");
            }

            // Workspace path tracker. Starts empty; `project_save_as` /
            // `project_open` populate it. `workspace::resolve_media_path`
            // routes media-path reads through it so the workspace's
            // `path_rel` becomes authoritative once Phase A.4 migration or
            // Phase C.1 import fills it in.
            app.manage(workspace::WorkspaceSlot::new());
            let cache_for_mcp = cache_layout.clone();
            #[cfg(feature = "mpv")]
            let cache_for_hotreload = cache_layout.clone();
            let cache_for_spike = cache_layout.clone();
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
            } else {
                // Phase 5 spike: snapshot the offscreen webview to a PNG once,
                // shortly after startup. The log line `raster capture spike:
                // wrote N bytes …` confirms the load-bearing capture path
                // works before we build the rest of the rasterizer.
                raster::schedule_capture_spike(app.handle(), cache_for_spike);
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

            // Event poller: drains libmpv's event queue every ~33ms (≈30 fps)
            // and drops the handle when MPV_EVENT_SHUTDOWN arrives. For the
            // popup slot this is what makes the OS close button on the
            // preview window actually close — mpv binds CLOSE_WIN→quit by
            // default, but the resulting Shutdown event doesn't release the
            // window resource until our handle is dropped. For the embedded
            // slot there's no OS close button so Shutdown is rare, but the
            // poller still covers internal shutdown paths.
            //
            // Same tick also reads `playback-time` from the embed slot and
            // emits `mpv:time` whenever the value changes — the UI listens
            // and slides the timeline playhead in sync with libmpv during
            // playback. Emit only on change so a paused player doesn't
            // flood IPC.
            #[cfg(feature = "mpv")]
            let app_for_mpv_events = app.handle().clone();
            #[cfg(feature = "mpv")]
            tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                let mut tick =
                    tokio::time::interval(std::time::Duration::from_millis(33));
                let mut last_emit: Option<i64> = None;
                loop {
                    tick.tick().await;
                    let embed = mpv_slot_for_events.clone();
                    let popup = mpv_popup_for_events.0.clone();
                    let result = tokio::task::spawn_blocking(move || -> Option<i64> {
                        mpv::drain_events_and_close_if_shutdown(&embed);
                        mpv::drain_events_and_close_if_shutdown(&popup);
                        mpv::playback_time_us(&embed)
                    })
                    .await;
                    let t_us = match result {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if t_us != last_emit {
                        last_emit = t_us;
                        if let Some(t_us) = t_us {
                            let _ = app_for_mpv_events
                                .emit("mpv:time", serde_json::json!({ "t_us": t_us }));
                        }
                    }
                }
            });

            // Hot-reload: every project commit recompiles the IR and re-applies
            // the lavfi-complex graph to the open libmpv preview window. Only
            // active once the user has opened preview at least once; before
            // that, ChangeEvents are observed but ignored.
            #[cfg(feature = "mpv")]
            let app_for_hotreload = app.handle().clone();
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
                    let template_renders = match ir::materialize_templates(
                        &snap,
                        &cache_for_hotreload,
                        &app_for_hotreload,
                    )
                    .await
                    {
                        Ok(m) => m,
                        Err(e) => {
                            tracing::warn!("mpv hot-reload: materialize templates failed: {e}");
                            continue;
                        }
                    };
                    let graph = match ir::lower(&snap, target, &inline_subs, &template_renders) {
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

