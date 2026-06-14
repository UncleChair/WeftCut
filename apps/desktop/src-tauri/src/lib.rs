//! WeftCut desktop app entry point.
//!
//! Architecture: see `docs/architecture.md`.

// imbl's persistent collections have deep type chains (`Vector<T>` → internal
// RRB nodes → Arc<Chunk<Node<T>>>); proving `Send`/`Sync` of the actor's future
// blows the default trait-recursion limit when the actor captures a deeply
// nested `Arc<Project>`.
#![recursion_limit = "512"]

mod app_settings;
mod audio;
mod cache;
mod cloud;
mod commands;
mod export;
mod export_settings_store;
mod ffmpeg;
mod io;
mod jobs;
mod keybindings;
mod logs;
mod mcp;
#[cfg(windows)]
mod media_drop;
mod motifs;
mod preview;
mod agent_session;
mod recents;
mod state;
mod view_state;
mod workspace;

/// Dev-only system-resource sampler (CPU%/RSS of the app process tree),
/// surfaced to the dev `PerfHUD`. Behind `debug_assertions` so release
/// builds neither spawn the sampler nor expose the `get_system_stats`
/// command.
#[cfg(debug_assertions)]
mod sysmon;

use tauri::Manager;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Log-bus slot is created here (pre-Tauri) so the tracing layer
    // can hold an `Arc` clone. The slot starts `None`; a workspace
    // open/save-as/new installs the bus. See
    // `docs/status-log.md` Q8 (strict pre-workspace refuse).
    let log_slot = logs::LogBusSlot::new();

    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,weftcut=debug,weftcut_lib=debug")),
        )
        .with(fmt::layer())
        .with(logs::LogBusLayer::new(log_slot.clone()))
        .init();

    tracing::info!("weftcut starting");

    let mut builder = tauri::Builder::default()
        // Single-instance must be the FIRST registered plugin (its docs).
        // A second launch would race the project actor and the MCP port;
        // instead it surfaces the existing window. Dev second-instance
        // workflows keep working — the lock is keyed on the app
        // identifier, which those runs override.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // Persist size/position/maximized across launches. VISIBLE is
        // excluded: the window is created hidden (`visible: false`) and
        // the frontend shows it after first paint — letting the plugin
        // restore visibility would resurrect the startup flash.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                // The hidden Motif capture host's geometry is owned by the
                // capture pipeline (CDP metrics override) — persisting or
                // restoring it is meaningless at best.
                .with_denylist(&["motif-host"])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());
    // Dev-only: expose the running webview to the tauri-mcp-server (localhost
    // 9223) so it can be driven for in-app testing. Never active in release.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }
    // Motifs: custom `motif:` URI scheme serving the embedded built-in Motif
    // bundles. On Windows the scheme is reachable as
    // `http://motif.localhost/<id>/<file>`; the hidden host window loads
    // `http://motif.localhost/<id>/index.html`. See `motifs::builtin`.
    builder = builder.register_uri_scheme_protocol("motif", motifs::builtin::handle_request);
    // Closing the main window must exit the app. Tauri's default exit rule
    // is "when ALL windows are gone", but the hidden Motif capture host
    // (and any Render & Play popup) keeps the process alive as a windowless
    // zombie — which also meant RunEvent::Exit (where window-state persists
    // itself) never fired. `exit()` runs the normal exit path, so plugins
    // still get their save hooks.
    builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::Destroyed = event {
            if window.label() == "main" {
                window.app_handle().exit(0);
            }
        }
    });
    builder
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_mcp_info,
            commands::reset_mcp_token,
            commands::project_summary,
            commands::add_track,
            commands::separate_audio_to_new_track,
            commands::add_demo_color_layer,
            commands::add_media_layer,
            commands::add_text_layer,
            commands::add_demo_text_layer,
            commands::update_layer,
            commands::update_layer_params,
            commands::update_layer_param_track,
            commands::update_layer_param_tracks,
            commands::add_subtitles_layer,
            commands::move_layer,
            commands::trim_layer,
            commands::split_layer_grouped,
            commands::groups_create,
            commands::groups_dissolve,
            commands::duplicate_layer,
            commands::delete_layer,
            commands::set_composition,
            commands::fit_composition_to_layers,
            commands::get_project_settings,
            commands::update_project_settings,
            commands::update_track_flags,
            commands::add_marker,
            commands::project_undo,
            commands::project_redo,
            commands::project_restore_checkpoint,
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
            commands::app_settings_get,
            commands::app_settings_set,
            commands::view_state_get,
            commands::view_state_set,
            commands::export_settings_get,
            commands::export_settings_set,
            commands::workspace_dir,
            commands::agent_session_get,
            commands::agent_session_end,
            #[cfg(debug_assertions)]
            commands::debug_simulate_agent_session,
            #[cfg(debug_assertions)]
            commands::debug_lock_history,
            #[cfg(debug_assertions)]
            commands::debug_unlock_history,
            commands::import_media,
            commands::import_cancel,
            commands::import_queue_list,
            commands::export_project_audio_only,
            commands::mux_export,
            commands::settings_get_api_key_status,
            commands::settings_set_api_key,
            commands::settings_clear_api_key,
            commands::settings_test_provider,
            commands::get_waveform_peaks,
            commands::get_media_thumbnail,
            commands::ensure_full_proxy,
            commands::ensure_conform,
            commands::ensure_export_audio_conform,
            commands::report_audio_meter,
            commands::list_motifs,
            commands::add_motif,
            motifs::authoring_commands::get_motif_source,
            motifs::authoring_commands::write_motif_draft,
            motifs::authoring_commands::amend_motif_draft,
            motifs::authoring_commands::create_edit_draft,
            motifs::authoring_commands::import_motif,
            motifs::authoring_commands::install_motif,
            motifs::authoring_commands::delete_motif,
            motifs::staleness::motif_staleness_report,
            motifs::staleness::acknowledge_motif_staleness,
            commands::log_list,
            commands::log_clear,
            commands::log_emit,
            commands::log_dir_path,
            motifs::motif_register_runtime,
            #[cfg(windows)]
            motifs::commands::motif_capture_frame,
            #[cfg(debug_assertions)]
            sysmon::get_system_stats,
            export::videosink::export_video_sink_start,
            export::videosink::export_video_sink_finish,
            export::videosink::export_video_sink_cancel,
            export::videosink::export_video_sink_write,
        ])
        .setup(move |app| {
            // WebView2 polish (Windows): kill Ctrl+wheel / Ctrl+± page zoom
            // always, and the browser-feature accelerator keys (F5 / Ctrl+R
            // reload, Ctrl+F find bar, Ctrl+P print, F12) in RELEASE builds
            // only. Per WebView2 docs this leaves text-editing accelerators
            // (Ctrl+C/V/X/Z) and plain DOM keydown delivery untouched — the
            // app's rebindable shortcut dispatcher sees every key it did
            // before, whatever the user binds.
            #[cfg(windows)]
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.with_webview(|pw| unsafe {
                    let Ok(core) = pw.controller().CoreWebView2() else {
                        return;
                    };
                    let Ok(settings) = core.Settings() else {
                        return;
                    };
                    let _ = settings.SetIsZoomControlEnabled(false);
                    #[cfg(not(debug_assertions))]
                    {
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                        use windows::core::Interface;
                        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                        }
                    }
                });
                // Media-pool drag-to-import: path recovery for HTML5 file
                // drops (see media_drop.rs).
                if let Err(e) = media_drop::attach(&main) {
                    tracing::warn!("media_drop attach failed: {e}");
                }
            }

            // Motifs runtime slot — holds the JS-side clock-takeover runtime
            // source string. `None` until the frontend calls
            // `motif_register_runtime` once at boot; the hidden host window
            // injects it as its `initialization_script`.
            app.manage(motifs::MotifRuntime::new());
            // Serializes Motif captures + caches per-host metrics/ready state.
            app.manage(motifs::MotifCapture::new());

            // Latest preview master-bus meter reading (webview pushes ~2 Hz
            // while playing); read by the MCP `composition://meter` resource.
            app.manage(commands::AudioMeterState::default());

            // Project actor — single writer for all state mutations, shared by
            // UI commands (now) and the MCP tool surface.
            let project_handle = state::spawn(state::Project::new_blank("untitled"));
            let project_for_mcp = project_handle.clone();
            let project_for_ui_events = project_handle.clone();
            let project_for_autosave = project_handle.clone();
            app.manage(project_handle);

            // Status/log subsystem slot — `None` until a workspace is
            // opened. Producers (project_save_as, project_open,
            // project_new_workspace) install a fresh bus rooted at
            // `<workspace>/Logs/`. The tracing layer was wired earlier
            // (above this setup callback) to forward `error!` events
            // from our crate into whichever bus is current.
            app.manage(log_slot.clone());
            let log_slot_for_ui_events = log_slot.clone();

            // Cache layout. **Per data-model** (`docs/data-model.md`), the cache
            // lives at `<workspace>/Cache/` once a
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
            // `project_open` populate it. Jobs and commands read it for
            // the workspace root (cache layout, import copies, fs-scope
            // grants); media paths come from `MediaItem.path_abs`, which
            // `io::load_from_dir` reconciles against this root at load.
            let workspace_slot = workspace::WorkspaceSlot::new();
            app.manage(workspace_slot.clone());

            // Agent-session slot — process-global. `None` in editor mode;
            // `Some(...)` while an MCP-initiated agent session is active.
            // Reset on workspace change (project_save_as/open/new_workspace
            // emit the change event themselves). MCP-side begin/end is wired
            // in Phase 2.
            let agent_session_slot = agent_session::AgentSessionSlot::new();
            app.manage(agent_session_slot.clone());

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
            app.manage(keybindings::KeybindingsStore::new(config_dir.clone()));

            // A/B-roll redesign app prefs (`docs/data-model.md`). Same
            // physical location as `keybindings.json` and `recents.json`.
            // Display mode + peek-window + drawer-state live here; the
            // inline pill / View menu / `T` shortcut all mutate this
            // store directly and emit `app_settings:changed` so the
            // frontend re-filters the timeline immediately.
            app.manage(app_settings::AppSettingsStore::new(config_dir.clone()));

            // User-installed Motifs live in `<app_config_dir>/motifs/`, served
            // by the `motif:` scheme handler and merged into the catalog
            // alongside the embedded built-ins. (Upload design spec §2.)
            let motifs_root = config_dir.join("motifs");
            if let Err(e) = std::fs::create_dir_all(&motifs_root) {
                tracing::warn!("user-motif dir setup failed: {e:#} ({})", motifs_root.display());
            }
            app.manage(motifs::store::UserMotifStore::new(motifs_root.clone()));
            // Stage 5 hot-reload: external edits anywhere under the user-Motif
            // tree (drafts AND installed) emit a debounced `motifs:changed`,
            // driving the same resync the in-app source panel uses. Attach
            // failure degrades to "no hot reload", never an app failure.
            let watcher_app = app.handle().clone();
            match motifs::watcher::spawn(motifs_root, move || {
                motifs::authoring_commands::emit_motifs_changed(&watcher_app);
            }) {
                Ok(w) => {
                    app.manage(w);
                }
                Err(e) => tracing::warn!("motif watcher setup failed: {e:#}"),
            }

            // Auto-save subscriber. Listens to actor events, debounces
            // 500ms, writes `project.json` whenever a workspace is set.
            // Periodic snapshots land in `Backups/`. The blank-on-boot
            // window has no workspace so the task is a dormant
            // dirty-flag-keeper until the first `project_save_as` /
            // `project_open`. See `docs/data-model.md` Q8.
            let autosave =
                io::autosave::AutosaveController::spawn(
                    project_for_autosave,
                    workspace_slot,
                );
            app.manage(autosave);

            // Pixi renderer owns preview + video export; Rust supplies the
            // audio-only m4a + stream-copy mux, both invoked synchronously
            // from the JS orchestrator (no events, no queue, no preset
            // selector).
            let cache_for_mcp = cache_layout.clone();
            app.manage(cache_layout);

            // Per-codec HW-encoder cache for the ffmpeg export-transcode path
            // (lazily probed on first non-WebCodecs export).
            app.manage(export::HwEncoderCache::new());

            // Task 1 (10-bit export): loopback WS video sink. Starts empty;
            // `export_video_sink_start` activates it, `_finish` / `_cancel`
            // clear it.
            app.manage(crate::export::videosink::VideoSinkState::default());

            // Import queue. Single-task FIFO. Pops a PendingImport, copies
            // source → `<workspace>/Media/...`, dispatches an actor command
            // to flip the MediaItem's `path_abs` + `path_rel`. Emits
            // `import:queue` / `started` / `complete` / `error`.
            let import_queue = jobs::import::ImportQueue::new(app.handle().clone());
            app.manage(import_queue);

            tauri::async_runtime::spawn(async {
                match ffmpeg::bootstrap().await {
                    Ok(ffmpeg::BootstrapStatus::Ready(v)) => tracing::info!("ffmpeg: {v}"),
                    Ok(ffmpeg::BootstrapStatus::Unavailable(why)) => tracing::warn!("ffmpeg unavailable: {why}"),
                    Err(e) => tracing::error!("ffmpeg bootstrap join failed: {e:?}"),
                }
            });

            // Dev-only system-resource sampler feeding the PerfHUD
            // (CPU%/RSS of the app's WebView2 process tree, 1 s tick).
            // Release builds skip both the managed slot and the sampler.
            #[cfg(debug_assertions)]
            {
                let stats_slot = sysmon::new_slot();
                app.manage(stats_slot.clone());
                sysmon::spawn_sampler(stats_slot);
            }
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
                                    "actor_kind": actor_kind,
                                    "client": client,
                                    "summary": event.summary,
                                    "timestamp": event.timestamp.to_rfc3339(),
                                    "affected_count": event.affected.len(),
                                }),
                            );

                            // Phase 1 producer: project-mutation entry.
                            // Carries the same actor kind so the bar /
                            // expanded console can show "User" vs
                            // "Agent · <client>". `op_id` is propagated
                            // so future MCP producers (Phase 3) can fold
                            // their tool-call Started/Ok entries into
                            // the same group. No-op pre-workspace.
                            let source = match &event.actor {
                                state::Actor::User => logs::LogSource::User,
                                state::Actor::Agent { client } => logs::LogSource::Agent {
                                    client: client.clone(),
                                },
                            };
                            log_slot_for_ui_events.emit(logs::LogEntryInput {
                                level: logs::LogLevel::Info,
                                category: logs::LogCategory::Project,
                                source,
                                message: event.summary.clone(),
                                op_id: Some(event.op_id),
                                ..Default::default()
                            });
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

            // Dev-only Motifs smoke + conformance trigger. Gated on Windows +
            // debug + an env var so it never runs unless a human opts in
            // (`WEFTCUT_MOTIF_SMOKE=1`). A few seconds after boot — giving the
            // frontend time to call `motif_register_runtime` and the host
            // window time to load — it captures `countdown` frames and runs
            // three conformance checks:
            //   1. Determinism  — two captures at t=2.5 must be byte-identical.
            //   2. Advance      — t=1.0 capture must differ from t=2.5.
            //   3. Known-frame  — at t=2.5 with duration=5, ceil(5-2.5)=3, so
            //                     the `#num` element must contain "3".
            // Results are printed as `[MOTIF-CONF] <check> PASS/FAIL …`.
            // Throwaway: delete once a real Motifs UI exists.
            #[cfg(all(windows, debug_assertions))]
            {
                if std::env::var("WEFTCUT_MOTIF_SMOKE").as_deref() == Ok("1") {
                    let app_for_smoke = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        use tauri::Manager;
                        // Give the frontend a beat to register the runtime and
                        // the host window to build + load its first paint.
                        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                        let state = app_for_smoke.state::<motifs::MotifRuntime>();
                        if state.get().is_none() {
                            eprintln!(
                                "[MOTIF-SMOKE] err runtime-not-registered (frontend never called motif_register_runtime)"
                            );
                            return;
                        }
                        let props = r##"{"seconds":5,"label":"GO","accent":"#ff4d4d"}"##;

                        // Helper: capture one frame and return the base64 PNG string.
                        macro_rules! capture {
                            ($t:expr) => {{
                                let s2 = app_for_smoke.state::<motifs::MotifRuntime>();
                                let c2 = app_for_smoke.state::<motifs::MotifCapture>();
                                let st = app_for_smoke.state::<motifs::store::UserMotifStore>();
                                motifs::commands::motif_capture_frame(
                                    app_for_smoke.clone(),
                                    s2,
                                    c2,
                                    st,
                                    "countdown".to_string(),
                                    $t,
                                    props.to_string(),
                                    480,
                                    480,
                                    None,
                                    // Built-in is served by the scheme handler regardless of
                                    // the `?v=` query; a stable "" keeps host reuse across the
                                    // two capture! calls (different t, same id+version).
                                    String::new(),
                                )
                                .await
                            }};
                        }

                        // Helper: base64-decode then blake3-hash a capture result.
                        fn hash_b64(b64: &str) -> String {
                            use base64::Engine;
                            let bytes = base64::engine::general_purpose::STANDARD
                                .decode(b64)
                                .unwrap_or_default();
                            blake3::hash(&bytes).to_hex().to_string()
                        }

                        // --- Capture A: t=2.5 (first time, also warms the host window) ---
                        let b64_a = match capture!(2.5_f64) {
                            Ok(b) => {
                                eprintln!("[MOTIF-SMOKE] ok bytes={}", b.len());
                                b
                            }
                            Err(e) => {
                                eprintln!("[MOTIF-SMOKE] err first capture: {e}");
                                eprintln!("[MOTIF-CONF] determinism FAIL (first capture failed)");
                                eprintln!("[MOTIF-CONF] advance FAIL (first capture failed)");
                                eprintln!("[MOTIF-CONF] known-frame FAIL (first capture failed)");
                                return;
                            }
                        };
                        let hash_a = hash_b64(&b64_a);

                        // --- CHECK 1: Determinism — capture t=2.5 a second time ---
                        match capture!(2.5_f64) {
                            Ok(b64_b) => {
                                let hash_b = hash_b64(&b64_b);
                                if hash_a == hash_b {
                                    eprintln!("[MOTIF-CONF] determinism PASS ({hash_a})");
                                } else {
                                    eprintln!(
                                        "[MOTIF-CONF] determinism FAIL (a={hash_a} b={hash_b})"
                                    );
                                }
                            }
                            Err(e) => {
                                eprintln!("[MOTIF-CONF] determinism FAIL (second capture failed: {e})");
                            }
                        }

                        // --- CHECK 2: Advance — t=1.0 must differ from t=2.5 ---
                        match capture!(1.0_f64) {
                            Ok(b64_t1) => {
                                let hash_t1 = hash_b64(&b64_t1);
                                if hash_t1 != hash_a {
                                    eprintln!("[MOTIF-CONF] advance PASS (t=1.0 differs from t=2.5)");
                                } else {
                                    eprintln!(
                                        "[MOTIF-CONF] advance FAIL (t=1.0 hash equals t=2.5 hash: {hash_t1})"
                                    );
                                }
                            }
                            Err(e) => {
                                eprintln!("[MOTIF-CONF] advance FAIL (t=1.0 capture failed: {e})");
                            }
                        }

                        // --- CHECK 3: Known-frame — after t=2.5, #num must contain "3" ---
                        // ceil(duration=5 - t=2.5) = ceil(2.5) = 3.
                        // Re-render t=2.5 so the DOM is definitely at that time, then
                        // read the element via a throwing CDP eval expression:
                        // throws if wrong (so eval_await returns Err), passes if correct.
                        //
                        // We reach the host window directly by its fixed label so we can
                        // call eval_await without going through the full capture command.
                        let known_frame_result = (|| async {
                            // Re-render t=2.5 to ensure the DOM is at the right frame.
                            capture!(2.5_f64).map_err(|e| format!("re-render failed: {e}"))?;
                            // Get the host window (created by ensure_host above).
                            let host_win = app_for_smoke
                                .get_webview_window(motifs::host::HOST_LABEL)
                                .ok_or_else(|| "motif-host window not found".to_string())?;
                            // Assert via a throwing expression: the CDP eval returns Err
                            // (with the thrown message) if the text is wrong, Ok(()) if right.
                            let check_expr = concat!(
                                "(function(){",
                                "var t=document.getElementById('num').textContent;",
                                "if(t!=='3')throw new Error('expected 3 got '+t);",
                                "return true;",
                                "})()"
                            );
                            motifs::cdp::eval_await(&host_win, check_expr)
                                .await
                                .map_err(|e| format!("DOM check: {e}"))
                        })()
                        .await;

                        match known_frame_result {
                            Ok(()) => {
                                eprintln!("[MOTIF-CONF] known-frame PASS (t=2.5 → #num='3')");
                            }
                            Err(msg) => {
                                eprintln!("[MOTIF-CONF] known-frame FAIL ({msg})");
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri runtime");
}

