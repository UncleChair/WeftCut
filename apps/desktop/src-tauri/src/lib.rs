//! WeftCut desktop app entry point.
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
mod keybindings;
mod mcp;
mod mpv;
mod preview;
mod raster;
mod recents;
mod state;
mod workspace;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,weftcut=debug,weftcut_lib=debug")),
        )
        .init();

    tracing::info!("weftcut starting");

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
            commands::project_save,
            commands::project_save_as,
            commands::project_open,
            commands::project_new_workspace,
            commands::recents_list,
            commands::recents_remove,
            commands::recents_get_reopen_on_launch,
            commands::recents_set_reopen_on_launch,
            commands::recents_most_recent,
            commands::recents_last_new_project_parent,
            commands::keybindings_get,
            commands::keybindings_set,
            commands::keybindings_reset_all,
            commands::keybindings_export,
            commands::keybindings_import,
            commands::import_media,
            commands::import_cancel,
            commands::import_queue_list,
            commands::compile_project,
            commands::export_project,
            commands::export_queue_enqueue,
            commands::export_queue_list,
            commands::export_queue_remove,
            commands::export_queue_clear_finished,
            commands::hw_encoder_probe,
            commands::mpv_play_file,
            commands::mpv_play_media,
            commands::settings_get_api_key_status,
            commands::settings_set_api_key,
            commands::settings_clear_api_key,
            commands::settings_test_provider,
            commands::get_waveform_peaks,
            commands::get_media_thumbnail,
            commands::list_templates,
            commands::add_template,
            commands::template_preview,
            commands::preview_current_path,
        ])
        .setup(|app| {
            // Project actor — single writer for all state mutations, shared by
            // UI commands (now) and the MCP tool surface.
            let project_handle = state::spawn(state::Project::new_blank("untitled"));
            let project_for_mcp = project_handle.clone();
            let project_for_ui_events = project_handle.clone();
            let project_for_autosave = project_handle.clone();
            let project_for_preview_renderer = project_handle.clone();
            app.manage(project_handle);
            // libmpv survives only for the media-pool popup preview (a
            // standalone OS window with no z-order conflict against the
            // Phase-D DOM `<video>` project preview). The embed slot
            // (`mpv_slot`) stays in the type system for cross-platform
            // parity but has no HWND wired up and is never play_graph'd.
            let mpv_slot = mpv::MpvSlot::default();
            let mpv_popup_slot = mpv::MpvPopupSlot::default();
            #[cfg(feature = "mpv")]
            let mpv_popup_for_events = mpv_popup_slot.clone();

            // Per workspace-redesign Q10 / Phase D: the project preview is
            // a DOM `<video>` element backed by `preview::PreviewRenderer`,
            // not an embedded libmpv HWND. No host HWND is created here.
            // The popup slot below (`mpv_popup_slot`) survives — it backs
            // the media-pool play-on-click preview, which is a standalone
            // top-level window and has no z-order conflict. The embed
            // slot stays in the type system to keep cross-platform parity
            // until Phase D.4 cleanup deletes it outright.

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
            let workspace_slot = workspace::WorkspaceSlot::new();
            app.manage(workspace_slot.clone());

            // Recent-projects store + app prefs (`reopen_on_launch`). Phase
            // B's startup screen reads from this; `project_open` /
            // `project_save_as` / `project_new_workspace` push to it.
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("./config"));
            if let Err(e) = std::fs::create_dir_all(&config_dir) {
                tracing::warn!(
                    "app config dir setup failed: {e:#} ({})",
                    config_dir.display()
                );
            }
            app.manage(recents::RecentsStore::new(config_dir.clone()));

            // Keyboard-shortcut overrides. Per-user, app-level (not
            // workspace-level), so the same physical location as
            // `recents.json`. The frontend `shortcuts/` module reads
            // this once at startup and re-fetches whenever the
            // Settings → Keyboard panel writes.
            app.manage(keybindings::KeybindingsStore::new(config_dir));

            // Auto-save subscriber. Listens to actor events, debounces
            // 500ms, writes `project.json` whenever a workspace is set.
            // Periodic snapshots land in `Backups/`. The blank-on-boot
            // window has no workspace so the task is a dormant
            // dirty-flag-keeper until the first `project_save_as` /
            // `project_open`. See `docs/workspace-redesign.md` Q8.
            let autosave =
                io::autosave::AutosaveController::spawn(
                    project_for_autosave,
                    workspace_slot,
                );
            app.manage(autosave);

            // Phase D preview renderer (workspace-redesign Q10). Subscribes
            // to actor commits, debounces 1s, renders the project to
            // `<workspace>/Cache/preview/<state_hash>.mp4` via the export
            // pipeline (proxies substituted for originals when present).
            // The React `<PreviewSurface>` listens for `preview:render_*`
            // events and swaps its `<video src>` accordingly.
            let preview_renderer = preview::PreviewRenderer::spawn(
                app.handle().clone(),
                project_for_preview_renderer,
            );
            app.manage(preview_renderer);
            let cache_for_mcp = cache_layout.clone();
            let cache_for_spike = cache_layout.clone();
            app.manage(cache_layout);

            // Render queue. Single-task FIFO; emits `export:queue` events on
            // every state change. Lives for the app lifetime.
            let export_queue = export::ExportQueue::new(app.handle().clone());
            app.manage(export_queue);

            // Import queue. Single-task FIFO, like `export_queue`. Pops a
            // PendingImport, copies source → `<workspace>/Media/...`,
            // dispatches an actor command to flip the MediaItem's
            // `path_abs` + `path_rel`. Emits `import:queue` / `started` /
            // `complete` / `error`. See workspace-redesign.md Q6.
            let import_queue = jobs::import::ImportQueue::new(app.handle().clone());
            app.manage(import_queue);

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

            // Popup-slot event drain. The media-pool play button opens a
            // standalone libmpv window via `mpv_play_media` — mpv binds
            // CLOSE_WIN→quit by default, but the resulting Shutdown event
            // doesn't release the window resource until our handle is
            // dropped. The 33ms tick drains those events so the OS close
            // button actually closes the popup. The embed slot is gone
            // (Phase D), so only the popup is drained.
            #[cfg(feature = "mpv")]
            tauri::async_runtime::spawn(async move {
                let mut tick =
                    tokio::time::interval(std::time::Duration::from_millis(33));
                loop {
                    tick.tick().await;
                    let popup = mpv_popup_for_events.0.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        mpv::drain_events_and_close_if_shutdown(&popup);
                    })
                    .await;
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri runtime");
}

