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
        mpv.command("loadfile", &[path, "replace"])
            .map_err(|e| format!("loadfile: {e:?}"))?;
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
        mpv.command("seek", &[&secs_str, "absolute"])
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

        // Clear any previous graph before swapping files. mpv won't always
        // reparse `lavfi-complex` if you set the same option to a new value
        // back-to-back; clearing forces the rebuild on the next set.
        let _ = mpv.set_property("lavfi-complex", "");

        // Path-list separator: ';' on Windows (drive letters use ':'), ':' elsewhere.
        // Matches mpv's OPT_PATHLIST handling.
        let sep = if cfg!(windows) { ";" } else { ":" };
        let externals = plan.external_files.join(sep);
        mpv.set_property("external-files", externals.as_str())
            .map_err(|e| format!("set external-files: {e:?}"))?;

        mpv.set_property("lavfi-complex", plan.lavfi_complex.as_str())
            .map_err(|e| format!("set lavfi-complex: {e:?}"))?;

        mpv.command("loadfile", &[primary, "replace"])
            .map_err(|e| format!("loadfile: {e:?}"))?;

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
