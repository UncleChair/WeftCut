//! libmpv popup preview for the media-pool play button.
//!
//! Per `docs/workspace-redesign.md` Q10 (Phase D) the **project** preview is
//! a DOM `<video>` element backed by `preview::PreviewRenderer`. libmpv
//! survives only for the media-pool play button — `mpv_play_media` opens a
//! standalone OS window so the user can scrub a raw imported clip without
//! involving the project graph. That window is top-level, has no z-order
//! conflict with the WebView2 surface, and is independent of the editor's
//! preview state machine.
//!
//! **Feature-gated**: the `mpv` Cargo feature pulls in `libmpv2`. Without
//! the feature, the entry points are no-op stubs so the rest of the app
//! keeps building. Enabling the feature requires `libmpv-2.dll` next to
//! the binary and `mpv.lib` on `LIB` — see `docs/setup.md`. `build.rs`
//! stages the DLL into `target/<profile>/`.
//!
//! Two slot types kept for backwards compatibility:
//!   * `MpvSlot` — internal handle. Used to be the embed slot; now only
//!     ever wrapped by `MpvPopupSlot`. We keep the wrapping so the popup
//!     drain-events loop stays straightforward.
//!   * `MpvPopupSlot` — Tauri-managed; backs `mpv_play_media`. Always
//!     standalone-window (libmpv `force-window=yes`).

#[cfg(feature = "mpv")]
pub use real::{drain_events_and_close_if_shutdown, play_file, MpvPopupSlot, MpvSlot};
#[cfg(not(feature = "mpv"))]
pub use stub::{drain_events_and_close_if_shutdown, play_file, MpvPopupSlot, MpvSlot};

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

    /// Inner state behind `MpvSlot`. After the Phase D embed removal this
    /// is a thin wrapper: just the lazy mpv handle. `last_key` from the
    /// pre-Phase-D project-graph path is gone — the popup never loads a
    /// lavfi graph.
    #[derive(Default)]
    pub struct MpvState {
        pub mpv: Option<Mpv>,
    }

    /// Cloneable Tauri-managed slot. The Mutex serialises command handlers
    /// against the underlying libmpv handle.
    #[derive(Default, Clone)]
    pub struct MpvSlot(pub Arc<Mutex<MpvState>>);

    /// Tauri-managed slot for the media-pool popup preview. Wraps
    /// `MpvSlot` so the drain-events loop has the same shape as the
    /// (deleted) embed path would have had.
    #[derive(Default, Clone)]
    pub struct MpvPopupSlot(pub MpvSlot);

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

    /// Standalone-window init for the popup. The pre-Phase-D embed branch
    /// (set `wid` to a host HWND) is gone — there's no host HWND anymore.
    /// libmpv spawns its own top-level window via `force-window=yes`.
    /// Zombie handling: if a previous popup was closed via its OS X
    /// button, a cheap property probe fails on the dead handle and we
    /// drop + recreate so the next `play_file` opens a fresh window.
    fn ensure_init(slot: &MpvSlot) -> Result<(), String> {
        let mut guard = slot.0.lock().expect("mpv slot poisoned");
        let zombie = guard
            .mpv
            .as_ref()
            .map(|m| m.get_property::<String>("mpv-version").is_err())
            .unwrap_or(false);
        if zombie {
            info!("libmpv: previous popup handle is gone; reinitialising");
            guard.mpv = None;
        }
        if guard.mpv.is_some() {
            return Ok(());
        }
        let mpv = Mpv::new().map_err(|e| format!("create mpv: {e:?}"))?;
        let _ = mpv.set_property("force-window", "yes");
        let _ = mpv.set_property("osc", false);
        let _ = mpv.set_property("osd-bar", false);
        let _ = mpv.set_property("osd-on-seek", "no");
        let _ = mpv.set_property("input-default-bindings", true);
        let _ = mpv.set_property("input-vo-keyboard", true);
        let _ = mpv.set_property("title", "Videtor preview");
        let _ = mpv.set_property("keep-open", "yes");
        let _ = mpv.set_property("idle", "yes");
        info!("libmpv popup initialised (standalone window)");
        guard.mpv = Some(mpv);
        Ok(())
    }

    /// Normalize a filesystem path for mpv's `loadfile`. Forward slashes
    /// are accepted on every OS; swap them at the boundary on Windows so
    /// drive-letter / UNC paths round-trip cleanly.
    fn normalize_path_for_mpv(path: &str) -> String {
        if cfg!(windows) {
            path.replace('\\', "/")
        } else {
            path.to_string()
        }
    }

    /// Pre-quote a single argument for libmpv2 4.1's broken `command()`
    /// wrapper (see `feedback_libmpv2_command_bug`). 4.1 joins all args
    /// into one space-separated string and passes it to
    /// `mpv_command_string`, which then whitespace-splits — destroying
    /// any path containing a space. Wrap in `"..."` with `\` / `"`
    /// escaped inside.
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

    /// Load + play `path` in the popup window. Initialises the player on
    /// first call. Used exclusively by the media-pool play button —
    /// project preview is the DOM `<video>` element, not this.
    pub fn play_file(slot: &MpvSlot, path: &str) -> Result<(), String> {
        ensure_init(slot)?;
        let guard = slot.0.lock().expect("mpv slot poisoned");
        let mpv = guard.mpv.as_ref().expect("init guarantees Some");
        let normalized = normalize_path_for_mpv(path);
        let quoted = quote_arg_for_command_string(&normalized);
        mpv.command("loadfile", &[quoted.as_str(), "replace"])
            .map_err(|e| format!("loadfile {normalized:?}: {e:?}"))?;
        info!("libmpv popup: loaded {path}");
        Ok(())
    }

    /// Drain the popup's event queue. The OS close button on the popup
    /// window emits `Shutdown` via mpv's default `CLOSE_WIN→quit`
    /// binding; until our handle drops, the window resource isn't
    /// released. The lib.rs background tick calls this every ~33 ms.
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
            info!("libmpv popup: shutdown event observed; handle dropped");
        }
    }
}

#[cfg(not(feature = "mpv"))]
mod stub {
    #[derive(Default, Clone)]
    pub struct MpvSlot;

    #[derive(Default, Clone)]
    pub struct MpvPopupSlot(pub MpvSlot);

    pub fn spike() {
        tracing::info!(
            "libmpv spike: skipped (built without `mpv` feature). \
             Install libmpv per docs/setup.md and rebuild with `--features mpv`."
        );
    }

    pub fn play_file(_: &MpvSlot, _: &str) -> Result<(), String> {
        Err("libmpv popup preview is disabled (build with `--features mpv`)".to_string())
    }

    pub fn drain_events_and_close_if_shutdown(_: &MpvSlot) {}
}
