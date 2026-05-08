//! libmpv embedded preview player + native surface management.
//!
//! Surface integration per OS — `docs/architecture.md` "libmpv surface integration":
//!   Windows: child HWND of the WebView2 host, Z-ordered with the webview.
//!   macOS:   NSView sibling of WKWebView, constrained to the placeholder div.
//!   Linux:   GtkBox placement inside the GtkApplicationWindow.
//!
//! **Feature-gated**: the `mpv` Cargo feature pulls in `libmpv2`. Without the
//! feature, all entry points are no-op stubs so the rest of the app keeps
//! building. Enabling the feature requires `libmpv-2.dll` next to the binary
//! and `mpv.lib` on `LIB`. The dev-time install lives in
//! `apps/desktop/src-tauri/vendor/libmpv/`; `build.rs` extends the linker
//! search path and stages the DLL into `target/<profile>/`.
//!
//! **Phase 1 surface scope**: libmpv runs in its own top-level window via
//! `force-window=yes`. That sidesteps the child-HWND-inside-WebView2 dance
//! while still proving end-to-end decode + display. Real embed-into-the-Tauri-
//! window arrives in a follow-on slice once we have a place for the per-OS
//! handle wiring (see architecture.md).

// `ensure_init` is intentionally not re-exported — it's an internal helper
// used by `play_file` / `play_graph` and shouldn't be called by callers
// directly (they'd skip the lazy-init guard semantics).
#[cfg(feature = "mpv")]
pub use real::{
    close, drain_events_and_close_if_shutdown, is_active, play_file, play_graph, seek,
    set_paused, MpvSlot,
};

#[cfg(not(feature = "mpv"))]
pub use stub::{
    close, drain_events_and_close_if_shutdown, is_active, play_file, play_graph, seek,
    set_paused, MpvSlot,
};

use crate::ir::MpvPlan;

pub fn spike() {
    #[cfg(feature = "mpv")]
    real::spike();
    #[cfg(not(feature = "mpv"))]
    stub::spike();
}

#[cfg(feature = "mpv")]
mod real {
    use std::sync::{Arc, Mutex};

    use libmpv2::events::Event;
    use libmpv2::Mpv;
    use tracing::{info, warn};

    /// Inner state behind `MpvSlot`. Lazy `mpv` instance plus the bookkeeping
    /// the hot-reload loop needs: an `active` flag (only re-apply graphs once
    /// the user has opened preview at least once) and `last_key` (skip no-op
    /// re-applies when the project hasn't structurally changed).
    ///
    /// `last_key` covers the full plan identity (`primary`, `external_files`,
    /// graph string), not just the graph — file-list rotations that leave the
    /// graph byte-identical (e.g. swapping layer A→B at the same input slot)
    /// must still trigger a reload.
    pub struct MpvState {
        pub mpv: Option<Mpv>,
        pub active: bool,
        pub last_key: Option<(Option<String>, Vec<String>, String)>,
    }

    impl Default for MpvState {
        fn default() -> Self {
            Self {
                mpv: None,
                active: false,
                last_key: None,
            }
        }
    }

    /// Tauri-managed slot holding the lazily-initialised mpv instance. Wrapped
    /// in `Mutex` so command handlers serialise across calls; libmpv itself is
    /// thread-safe but our wrapper keeps things simple.
    #[derive(Default, Clone)]
    pub struct MpvSlot(pub Arc<Mutex<MpvState>>);

    pub fn spike() {
        match Mpv::new() {
            Ok(mpv) => {
                if let Err(e) = mpv.set_property("vo", "null") {
                    warn!("libmpv set vo=null failed: {e:?}");
                }
                let version: String = mpv
                    .get_property("mpv-version")
                    .unwrap_or_else(|_| "unknown".to_string());
                info!("libmpv ready: {version}");
                drop(mpv);
            }
            Err(e) => warn!("libmpv unavailable: {e:?}. Install libmpv per docs/setup.md."),
        }
    }

    pub fn is_active(slot: &MpvSlot) -> bool {
        slot.0.lock().expect("mpv slot poisoned").active
    }

    /// Normalize a filesystem path for mpv's `loadfile` / `external-files`.
    ///
    /// Forward slashes are accepted on every OS, so swap them at the boundary.
    /// Drive-letter paths and UNC roots both round-trip cleanly under this rule.
    /// Backslashes elsewhere in the path are also fine (mpv's URL parser
    /// handles them on Windows), but consistency aids debugging.
    fn normalize_path_for_mpv(path: &str) -> String {
        if cfg!(windows) {
            path.replace('\\', "/")
        } else {
            path.to_string()
        }
    }

    /// Quote a single argument for libmpv2 4.1's broken `command()` wrapper.
    ///
    /// libmpv2 4.1 (`~/.cargo/registry/src/.../libmpv2-4.1.0/src/mpv.rs:551`)
    /// joins all command args into one space-separated string and passes it
    /// to `mpv_command_string` instead of using the array-form `mpv_command`.
    /// `mpv_command_string` whitespace-splits the result, so any arg
    /// containing a space (e.g. a path like `C:/Users/.../WhatsApp Video
    /// 2026-05-06.mp4`) gets shredded into multiple tokens, surfacing as
    /// `MPV_ERROR_INVALID_PARAMETER (-4)` from `loadfile`.
    ///
    /// Workaround: pre-quote each arg using mpv's input-parser grammar —
    /// wrap in `"..."`, escape `\` and `"` inside. Drop this helper once we
    /// upgrade to a libmpv2 release that uses the array form, or switch to a
    /// direct FFI call into `libmpv2_sys::mpv_command`.
    fn quote_arg_for_command_string(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for c in s.chars() {
            if c == '\\' || c == '"' {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('"');
        out
    }

    /// Construct the player on first use, applying the standalone-preview
    /// defaults that match Phase 1 scope.
    ///
    /// `force-window=yes` is required: when libmpv runs embedded without a
    /// host-supplied `wid`, it won't create its own window for `loadfile`
    /// alone — `force-window` is the property that makes it spawn a top-level
    /// window. Closing reliably is handled two ways: the explicit ✕ Close
    /// preview command in the UI (`close()` below), and the zombie-handle
    /// probe at the top of this function which re-inits fresh if a previous
    /// handle was externally quit.
    pub fn ensure_init(slot: &MpvSlot) -> Result<(), String> {
        let mut guard = slot.0.lock().expect("mpv slot poisoned");
        // If we hold a handle but it's been externally quit (e.g. user clicked
        // the OS close button), property access errors out. Probe with a cheap
        // read; if it fails, drop the zombie and re-init fresh.
        let zombie = guard
            .mpv
            .as_ref()
            .map(|m| m.get_property::<String>("mpv-version").is_err())
            .unwrap_or(false);
        if zombie {
            info!("libmpv: previous handle is gone (window closed by user); reinitialising");
            guard.mpv = None;
            guard.active = false;
            guard.last_key = None;
        }
        if guard.mpv.is_some() {
            return Ok(());
        }
        let mpv = Mpv::new().map_err(|e| format!("create mpv: {e:?}"))?;
        // Standalone window: libmpv owns the OS window. We'll pipe `wid` once
        // the WebView2-child slice lands.
        let _ = mpv.set_property("force-window", "yes");
        let _ = mpv.set_property("keep-open", "yes");
        let _ = mpv.set_property("osc", true);
        let _ = mpv.set_property("input-default-bindings", true);
        let _ = mpv.set_property("input-vo-keyboard", true);
        let _ = mpv.set_property("title", "Videtor preview");
        guard.mpv = Some(mpv);
        info!("libmpv preview initialised");
        Ok(())
    }

    /// Non-blocking drain of mpv's event queue. Called periodically by a
    /// background poller in `lib.rs`. The only event we act on is `Shutdown`
    /// — emitted when the user clicks the OS close button (default binding
    /// `CLOSE_WIN quit` → mpv shuts down internally). After Shutdown, the
    /// libmpv handle must not be used; dropping it triggers
    /// `mpv_terminate_destroy` which finally releases the window resource.
    /// Without this poller the window stays on screen as a zombie.
    pub fn drain_events_and_close_if_shutdown(slot: &MpvSlot) {
        let mut guard = slot.0.lock().expect("mpv slot poisoned");
        let mut shutdown = false;
        if let Some(mpv) = guard.mpv.as_mut() {
            let events = mpv.event_context_mut();
            loop {
                match events.wait_event(0.0) {
                    None => break,
                    Some(Ok(Event::Shutdown)) => {
                        shutdown = true;
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        warn!("libmpv event error: {e:?}");
                        break;
                    }
                }
            }
        }
        if shutdown {
            guard.mpv.take();
            guard.active = false;
            guard.last_key = None;
            info!("libmpv preview: shutdown event observed; handle dropped");
        }
    }

    /// Drop the mpv handle, closing the preview window. Idempotent.
    ///
    /// `Mpv::drop` calls `mpv_terminate_destroy` which synchronously tears the
    /// window down — no explicit `quit` command needed. Sending `quit` first
    /// can race the Drop and leave the window briefly orphaned.
    pub fn close(slot: &MpvSlot) -> Result<(), String> {
        let mut guard = slot.0.lock().expect("mpv slot poisoned");
        let was_some = guard.mpv.take().is_some();
        guard.active = false;
        guard.last_key = None;
        if was_some {
            info!("libmpv preview closed");
        }
        Ok(())
    }

    /// Load + play `path`. Initialises the player on first call. Marks the
    /// slot active so the hot-reload subscriber starts re-applying.
    pub fn play_file(slot: &MpvSlot, path: &str) -> Result<(), String> {
        ensure_init(slot)?;
        let mut guard = slot.0.lock().expect("mpv slot poisoned");
        let mpv = guard.mpv.as_ref().expect("init guarantees Some");
        // If the previous preview applied a project graph, that lavfi chain is
        // still live — applied to the *new* file's tracks it would produce
        // nonsense. Clear only in that case; touching `external-files` on a
        // fresh mpv interferes with the loadfile that follows (empirically
        // observed: the window opens but no file plays).
        if guard.last_key.is_some() {
            let _ = mpv.set_property("lavfi-complex", "");
            let _ = mpv.set_property("external-files", "");
        }
        let normalized = normalize_path_for_mpv(path);
        let quoted = quote_arg_for_command_string(&normalized);
        mpv.command("loadfile", &[quoted.as_str(), "replace"])
            .map_err(|e| format!("loadfile {normalized:?}: {e:?}"))?;
        // Raw-clip playback bypasses the project graph; clear last_key so the
        // next project preview always re-applies fresh.
        guard.last_key = None;
        guard.active = true;
        info!("libmpv: loaded {path}");
        Ok(())
    }

    /// Seek to an absolute timeline position (microseconds).
    /// Silently no-ops if no file is loaded.
    pub fn seek(slot: &MpvSlot, t_us: i64) -> Result<(), String> {
        let guard = slot.0.lock().expect("mpv slot poisoned");
        let Some(mpv) = guard.mpv.as_ref() else {
            return Ok(());
        };
        let secs = (t_us as f64) / 1_000_000.0;
        let secs_str = format!("{secs:.6}");
        // No spaces in the formatted float, but keep all `command` calls
        // consistently quoted so the libmpv2 4.1 string-concat bug stays
        // safely worked-around.
        let quoted_secs = quote_arg_for_command_string(&secs_str);
        mpv.command("seek", &[quoted_secs.as_str(), "absolute"])
            .map_err(|e| format!("seek: {e:?}"))
    }

    /// Set the `pause` property. Silently no-ops if no file is loaded.
    pub fn set_paused(slot: &MpvSlot, paused: bool) -> Result<(), String> {
        let guard = slot.0.lock().expect("mpv slot poisoned");
        let Some(mpv) = guard.mpv.as_ref() else {
            return Ok(());
        };
        mpv.set_property("pause", paused)
            .map_err(|e| format!("set pause: {e:?}"))
    }

    /// Apply a compiled `MpvPlan` to the player: sets external-files, the
    /// `lavfi-complex` graph, and loadfiles the primary input. Pure-Color
    /// projects (no decoded inputs) are skipped — there's nothing to load.
    ///
    /// Each call reissues the full setup, but skips silently when the graph
    /// string is byte-identical to the last one applied (common when the user
    /// commits a no-op or undo round-trip).
    pub fn play_graph(slot: &super::MpvSlot, plan: &super::MpvPlan) -> Result<(), String> {
        let Some(primary) = plan.primary.as_deref() else {
            info!("mpv preview: no decoded inputs, skipping play_graph");
            return Ok(());
        };
        ensure_init(slot)?;
        let mut guard = slot.0.lock().expect("mpv slot poisoned");

        // Dedup key: full plan identity. Graph string alone isn't enough — a
        // file swap at the same input slot leaves the graph identical but
        // changes which media plays.
        let next_key = (
            plan.primary.clone(),
            plan.external_files.clone(),
            plan.lavfi_complex.clone(),
        );
        if guard.last_key.as_ref() == Some(&next_key) {
            return Ok(());
        }

        let mpv = guard.mpv.as_ref().expect("init guarantees Some");

        // Order matters: mpv binds `[vid1]`/`[aid1]` to the *selected tracks
        // of the loaded file*. Setting `lavfi-complex` before any file is
        // loaded references unbound labels — mpv stores the string but the
        // first `loadfile` then fails with INVALID_PARAMETER when the
        // bind-tracks-to-labels step finds no tracks.
        //
        // Canonical sequence for runtime graph swaps:
        //   1. pause (the gap between loadfile and lavfi-complex would
        //      otherwise show as a flash of raw playback)
        //   2. clear stale lavfi-complex (so the about-to-load file isn't
        //      briefly fed through the previous file's [vid1])
        //   3. set external-files
        //   4. loadfile  → tracks bind, [vid1]/[aid1] resolve
        //   5. set lavfi-complex  → graph rebuilds against bound labels
        //   6. unpause

        // Mirror `play_file` byte-for-byte for the first-preview case so any
        // pre-loadfile state divergence (which empirically broke loadfile with
        // INVALID_PARAMETER in earlier iterations) is impossible.
        //
        // For repeat previews / hot-reload there's a stale graph + external
        // file list to clear; for cold previews the conditional skips
        // everything until after loadfile. The lavfi-complex set always lands
        // *after* loadfile so [vid1]/[aid1] are bound to real selected tracks
        // when the graph parser runs.
        let had_prior_graph = guard.last_key.is_some();

        // Path-list separator: ';' on Windows (drive letters use ':'), ':' elsewhere.
        // Matches mpv's OPT_PATHLIST handling.
        let sep = if cfg!(windows) { ";" } else { ":" };
        let normalized_primary = normalize_path_for_mpv(primary);
        let normalized_externals: Vec<String> = plan
            .external_files
            .iter()
            .map(|p| normalize_path_for_mpv(p))
            .collect();
        let externals = normalized_externals.join(sep);

        if had_prior_graph {
            // Previous graph references the prior file's bound labels; clear
            // before swapping files so the imminent loadfile starts clean.
            let _ = mpv.set_property("lavfi-complex", "");
            let _ = mpv.set_property("external-files", "");
        }
        // Only set externals when there's actually something to add.
        if !externals.is_empty() {
            mpv.set_property("external-files", externals.as_str())
                .map_err(|e| format!("set external-files: {e:?}"))?;
        }

        info!(
            ">>> mpv loadfile inputs:\n  primary    = {normalized_primary:?}\n  externals  = {externals:?}\n  lavfi      = {graph}",
            graph = plan.lavfi_complex
        );

        let quoted_primary = quote_arg_for_command_string(&normalized_primary);
        mpv.command("loadfile", &[quoted_primary.as_str(), "replace"])
            .map_err(|e| format!("loadfile {normalized_primary:?}: {e:?}"))?;

        if !plan.lavfi_complex.is_empty() {
            mpv.set_property("lavfi-complex", plan.lavfi_complex.as_str())
                .map_err(|e| format!("set lavfi-complex: {e:?}"))?;
        }

        guard.last_key = Some(next_key);
        guard.active = true;

        info!(
            "mpv preview: loaded primary={primary} externals={n} graph_len={glen}",
            n = plan.external_files.len(),
            glen = plan.lavfi_complex.len()
        );
        Ok(())
    }
}

#[cfg(not(feature = "mpv"))]
mod stub {
    #[derive(Default, Clone)]
    pub struct MpvSlot;

    pub fn spike() {
        tracing::info!(
            "libmpv spike: skipped (built without `mpv` feature). \
             Install libmpv per docs/setup.md and rebuild with `--features mpv`."
        );
    }

    pub fn is_active(_: &MpvSlot) -> bool {
        false
    }

    pub fn ensure_init(_: &MpvSlot) -> Result<(), String> {
        Err("libmpv preview is disabled (build with `--features mpv`)".to_string())
    }

    pub fn play_file(_: &MpvSlot, _: &str) -> Result<(), String> {
        Err("libmpv preview is disabled (build with `--features mpv`)".to_string())
    }

    pub fn seek(_: &MpvSlot, _: i64) -> Result<(), String> {
        Ok(())
    }

    pub fn set_paused(_: &MpvSlot, _: bool) -> Result<(), String> {
        Ok(())
    }

    pub fn play_graph(_: &MpvSlot, _: &super::MpvPlan) -> Result<(), String> {
        Err("libmpv preview is disabled (build with `--features mpv`)".to_string())
    }

    pub fn close(_: &MpvSlot) -> Result<(), String> {
        Ok(())
    }

    pub fn drain_events_and_close_if_shutdown(_: &MpvSlot) {}
}
