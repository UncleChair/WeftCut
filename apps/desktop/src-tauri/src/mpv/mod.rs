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
//! **Windows surface mode (embed)**: at app startup `create_host_hwnd` makes
//! a child HWND of the Tauri main window and stores it in the `MpvSlot`.
//! `ensure_init` passes that HWND to libmpv via the `wid` property *before*
//! the first `loadfile`, so the VO embeds into the host instead of spawning a
//! top-level window. JS measures `#video-surface` (`getBoundingClientRect *
//! devicePixelRatio`) and calls `mpv_set_surface_rect` to reposition the host
//! HWND via `SetWindowPos(HWND_TOP, …)`.
//!
//! **Non-Windows fallback**: macOS/Linux still use the Phase 1 standalone
//! window via `force-window=yes`. The NSView / GtkBox embed paths haven't
//! been wired yet.

// `ensure_init` is intentionally not re-exported — it's an internal helper
// used by `play_file` / `play_graph` and shouldn't be called by callers
// directly (they'd skip the lazy-init guard semantics).
#[cfg(feature = "mpv")]
pub use real::{
    close, drain_events_and_close_if_shutdown, is_active, play_file, play_graph,
    playback_time_us, seek, set_host_clip, set_host_hwnd, set_host_visible,
    set_paused, set_surface_rect, MpvPopupSlot, MpvSlot,
};
#[cfg(all(feature = "mpv", target_os = "windows"))]
pub use real::create_host_hwnd;

#[cfg(not(feature = "mpv"))]
pub use stub::{
    close, drain_events_and_close_if_shutdown, is_active, play_file, play_graph,
    playback_time_us, seek, set_host_clip, set_host_hwnd, set_host_visible,
    set_paused, set_surface_rect, MpvPopupSlot, MpvSlot,
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
    ///
    /// `host_hwnd` is the child HWND created at app startup (Windows only).
    /// libmpv embeds into it via the `wid` property — set in `ensure_init`
    /// *before* the first `loadfile` (mpv only honours `wid` at init time).
    /// On non-Windows it stays `None` and `ensure_init` falls back to
    /// `force-window=yes` for a standalone top-level window.
    pub struct MpvState {
        pub mpv: Option<Mpv>,
        pub active: bool,
        pub last_key: Option<(Option<String>, Vec<String>, String)>,
        pub host_hwnd: Option<isize>,
        /// Last `set_surface_rect` value `(x, y, w, h)` in parent-client
        /// physical pixels. `set_host_clip` reads this so it can translate
        /// the clip rect (also in parent-client coords) into the host's
        /// own coord space (origin at host top-left).
        pub host_rect: Option<(i32, i32, i32, i32)>,
    }

    impl Default for MpvState {
        fn default() -> Self {
            Self {
                mpv: None,
                active: false,
                last_key: None,
                host_hwnd: None,
                host_rect: None,
            }
        }
    }

    /// Tauri-managed slot holding the lazily-initialised mpv instance. Wrapped
    /// in `Mutex` so command handlers serialise across calls; libmpv itself is
    /// thread-safe but our wrapper keeps things simple.
    #[derive(Default, Clone)]
    pub struct MpvSlot(pub Arc<Mutex<MpvState>>);

    /// Second slot used for the media-pool / raw-file preview path. Same
    /// shape as `MpvSlot`, just registered as a distinct Tauri-managed
    /// state so the project preview (embedded into the WebView2 sibling
    /// HWND) and the raw-file preview (popup top-level window) don't share
    /// a libmpv instance — they'd fight over `wid` and graph state.
    /// `host_hwnd` is intentionally never set on this slot, so
    /// `ensure_init` takes the `force-window=yes` standalone branch.
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

    /// Construct the player on first use.
    ///
    /// Two modes, selected by whether `host_hwnd` was registered at startup:
    ///   * **Embed (Windows)** — set `wid` to the host HWND so libmpv's VO
    ///     attaches into the child window we created as a sibling of WebView2.
    ///     `force-window` is *not* set; the host HWND itself supplies the
    ///     drawing surface. OSC + default key bindings are off — the React UI
    ///     owns transport.
    ///   * **Standalone (mac/Linux + Windows-without-host)** — set
    ///     `force-window=yes` so libmpv spawns its own top-level window;
    ///     without it `loadfile` succeeds silently with no display surface.
    ///     OSC is also off here so the popup preview stays clean; keyboard
    ///     bindings remain on so space / arrow keys still drive the popup.
    ///
    /// `wid` must be set before the first VO init, which means before the
    /// first `loadfile`. Once VO is up libmpv ignores further `wid` changes.
    ///
    /// Zombie handling: if a previous handle has been externally quit
    /// (Shutdown event, OS close button on the standalone window) a cheap
    /// property probe fails and we drop + recreate. On the embed path there's
    /// no OS close button so this branch is near-dead, but we keep it for
    /// internal shutdown paths (and for the standalone fallback).
    pub fn ensure_init(slot: &MpvSlot) -> Result<(), String> {
        let mut guard = slot.0.lock().expect("mpv slot poisoned");
        let zombie = guard
            .mpv
            .as_ref()
            .map(|m| m.get_property::<String>("mpv-version").is_err())
            .unwrap_or(false);
        if zombie {
            info!("libmpv: previous handle is gone; reinitialising");
            guard.mpv = None;
            guard.active = false;
            guard.last_key = None;
        }
        if guard.mpv.is_some() {
            return Ok(());
        }
        let mpv = Mpv::new().map_err(|e| format!("create mpv: {e:?}"))?;
        match guard.host_hwnd {
            Some(hwnd) => {
                // Embed mode: VO renders into the host HWND.
                mpv.set_property("wid", hwnd as i64)
                    .map_err(|e| format!("set wid: {e:?}"))?;
                let _ = mpv.set_property("osc", false);
                // Suppress every default OSD overlay: the seek-bar that pops
                // up on every `seek` command, the volume bar, the file-load
                // message, etc. The React UI owns all transport feedback so
                // any libmpv-rendered chrome is pure clutter on the embed.
                let _ = mpv.set_property("osd-bar", false);
                let _ = mpv.set_property("osd-on-seek", "no");
                let _ = mpv.set_property("osd-level", 0i64);
                let _ = mpv.set_property("input-default-bindings", false);
                let _ = mpv.set_property("input-vo-keyboard", false);
                info!("libmpv preview initialised (embed, wid={hwnd:#x})");
            }
            None => {
                // Standalone mode: libmpv owns the OS window. OSC stays off
                // so the seek bar / progress overlay doesn't clutter the
                // popup preview; keyboard bindings remain on so space / arrow
                // keys still drive the popup when it has focus.
                let _ = mpv.set_property("force-window", "yes");
                let _ = mpv.set_property("osc", false);
                let _ = mpv.set_property("osd-bar", false);
                let _ = mpv.set_property("osd-on-seek", "no");
                let _ = mpv.set_property("input-default-bindings", true);
                let _ = mpv.set_property("input-vo-keyboard", true);
                let _ = mpv.set_property("title", "Videtor preview");
                info!("libmpv preview initialised (standalone window)");
            }
        }
        let _ = mpv.set_property("keep-open", "yes");
        let _ = mpv.set_property("idle", "yes");
        guard.mpv = Some(mpv);
        Ok(())
    }

    /// Register the embed host HWND created at Tauri startup. Called once,
    /// before any `play_*` invocation. Stored as `isize` so the lock guards
    /// stay `Send` — we reconstruct the `HWND` at use sites.
    pub fn set_host_hwnd(slot: &MpvSlot, hwnd: isize) {
        let mut guard = slot.0.lock().expect("mpv slot poisoned");
        guard.host_hwnd = Some(hwnd);
        info!("mpv preview: host HWND registered ({hwnd:#x})");
    }

    /// Reposition the embed host HWND to match the React placeholder div.
    ///
    /// Coordinates are physical pixels relative to the parent Tauri window's
    /// client area (JS pre-multiplies CSS px by `devicePixelRatio`). HWND_TOP
    /// keeps the host above its WebView2 sibling in Z-order.
    /// No-op when the host HWND wasn't registered (non-Windows builds).
    pub fn set_surface_rect(
        slot: &MpvSlot,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Result<(), String> {
        let mut guard = slot.0.lock().expect("mpv slot poisoned");
        let Some(hwnd_isize) = guard.host_hwnd else {
            return Ok(());
        };
        guard.host_rect = Some((x, y, w, h));
        drop(guard);
        set_surface_rect_native(hwnd_isize, x, y, w, h)
    }

    /// Punch a rectangular hole in the host HWND's visible region so the
    /// content beneath (WebView2) shows through there. Used by dropdown
    /// menus so they can sit over the preview area without the libmpv
    /// child HWND obscuring them. `None` restores the default rectangular
    /// region (full host visible again).
    ///
    /// Clip rect is given in **parent-client physical pixel coords** —
    /// the same coord system `set_surface_rect` uses — and gets
    /// translated to the host's own coord system (origin at host
    /// top-left) via the stored `host_rect`. No-op when no host or no
    /// host_rect is registered.
    pub fn set_host_clip(
        slot: &MpvSlot,
        clip: Option<(i32, i32, i32, i32)>,
    ) -> Result<(), String> {
        let guard = slot.0.lock().expect("mpv slot poisoned");
        let Some(hwnd_isize) = guard.host_hwnd else {
            return Ok(());
        };
        let host_rect = guard.host_rect;
        drop(guard);
        set_host_clip_native(hwnd_isize, host_rect, clip)
    }

    #[cfg(target_os = "windows")]
    fn set_host_clip_native(
        hwnd_isize: isize,
        host_rect: Option<(i32, i32, i32, i32)>,
        clip: Option<(i32, i32, i32, i32)>,
    ) -> Result<(), String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{
            CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
        };
        let hwnd = HWND(hwnd_isize as *mut _);
        let Some((cx, cy, cw, ch)) = clip else {
            // `None` for hRgn restores the default rectangular region —
            // host fully visible again. Return value (BOOL/i32) is 0 on
            // failure, non-zero on success; we don't have a useful
            // recovery for failure so just ignore.
            let _ = unsafe { SetWindowRgn(hwnd, None, true) };
            return Ok(());
        };
        let Some((hx, hy, hw, hh)) = host_rect else {
            // No host position recorded yet — can't translate clip into
            // host-local space. Skip silently; the next set_surface_rect
            // will populate `host_rect` and the next clip will work.
            return Ok(());
        };
        let local_x = cx - hx;
        let local_y = cy - hy;
        unsafe {
            // CreateRectRgn uses inclusive-left, exclusive-right
            // semantics — the rect (l, t, r, b) covers `[l, r) × [t, b)`.
            let full = CreateRectRgn(0, 0, hw, hh);
            let cut = CreateRectRgn(local_x, local_y, local_x + cw, local_y + ch);
            let result = CreateRectRgn(0, 0, 0, 0);
            CombineRgn(Some(result), Some(full), Some(cut), RGN_DIFF);
            // Free the two source regions; `result` is handed to the
            // system below and must NOT be freed by us.
            let _ = DeleteObject(full.into());
            let _ = DeleteObject(cut.into());
            let _ = SetWindowRgn(hwnd, Some(result), true);
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    fn set_host_clip_native(
        _hwnd_isize: isize,
        _host_rect: Option<(i32, i32, i32, i32)>,
        _clip: Option<(i32, i32, i32, i32)>,
    ) -> Result<(), String> {
        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn set_surface_rect_native(
        hwnd_isize: isize,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Result<(), String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOP, SWP_NOACTIVATE,
        };
        let hwnd = HWND(hwnd_isize as *mut _);
        unsafe {
            SetWindowPos(hwnd, Some(HWND_TOP), x, y, w, h, SWP_NOACTIVATE)
                .map_err(|e| format!("SetWindowPos: {e}"))
        }
    }

    /// Toggle the embed host HWND's visibility. Used by dropdown menus
    /// that extend over the preview area — the host's `HWND_TOP` z-order
    /// captures mouse events otherwise, blocking clicks on menu items.
    /// Hide on menu open, show on close. No-op when no host is registered.
    pub fn set_host_visible(slot: &MpvSlot, visible: bool) -> Result<(), String> {
        let guard = slot.0.lock().expect("mpv slot poisoned");
        let Some(hwnd_isize) = guard.host_hwnd else {
            return Ok(());
        };
        drop(guard);
        set_host_visible_native(hwnd_isize, visible)
    }

    #[cfg(target_os = "windows")]
    fn set_host_visible_native(hwnd_isize: isize, visible: bool) -> Result<(), String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNA};
        let hwnd = HWND(hwnd_isize as *mut _);
        let cmd = if visible { SW_SHOWNA } else { SW_HIDE };
        // ShowWindow returns BOOL indicating prev visibility — never an
        // error per docs. Discard.
        let _ = unsafe { ShowWindow(hwnd, cmd) };
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    fn set_host_visible_native(_hwnd_isize: isize, _visible: bool) -> Result<(), String> {
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    fn set_surface_rect_native(
        _hwnd_isize: isize,
        _x: i32,
        _y: i32,
        _w: i32,
        _h: i32,
    ) -> Result<(), String> {
        // Should never be reached — non-Windows builds don't register a host
        // HWND, so `set_surface_rect` short-circuits before this is called.
        Ok(())
    }

    /// Create a child HWND of the Tauri main window to host the libmpv VO.
    ///
    /// The host is a sibling of WebView2 (both children of the outer Tauri
    /// HWND). `WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS` plus a per-call
    /// `HWND_TOP` Z-order in `set_surface_rect` keeps it drawn over the
    /// webview. The window class is registered exactly once via `Once`;
    /// subsequent calls reuse it.
    ///
    /// Returned as `isize` so the value can travel through the Tauri-managed
    /// `MpvSlot` without dragging `!Send` window handles around.
    #[cfg(target_os = "windows")]
    pub fn create_host_hwnd(parent: isize) -> Result<isize, String> {
        use std::sync::Once;
        use windows::core::{w, PCWSTR};
        use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
        use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, BLACK_BRUSH};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, RegisterClassExW, CS_HREDRAW, CS_VREDRAW,
            WINDOW_EX_STYLE, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
        };

        // windows-rs's `DefWindowProcW` is exported as a regular Rust function
        // that internally links to the user32 symbol; its ABI doesn't match
        // the `WNDPROC = Option<unsafe extern "system" fn(...)>` type, so we
        // need a tiny `extern "system"` trampoline that calls through.
        unsafe extern "system" fn wnd_proc(
            hwnd: HWND,
            msg: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        static REGISTER: Once = Once::new();
        const CLASS: PCWSTR = w!("VidetorMpvHost");

        let hmod = unsafe { GetModuleHandleW(None) }
            .map_err(|e| format!("GetModuleHandleW: {e}"))?;
        let hinst: windows::Win32::Foundation::HINSTANCE = hmod.into();

        REGISTER.call_once(|| {
            let bg = unsafe { GetStockObject(BLACK_BRUSH) };
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinst,
                hbrBackground: HBRUSH(bg.0),
                lpszClassName: CLASS,
                ..Default::default()
            };
            // Ignore RegisterClassExW return — if it's 0 because the class
            // already exists (e.g. hot reload during dev), CreateWindowExW
            // below will succeed anyway.
            unsafe {
                RegisterClassExW(&wc);
            }
        });

        // Spawn offscreen and sized 1×1 so the host doesn't briefly flash a
        // black square in the parent's top-left before React's first
        // `mpv_set_surface_rect` reposition. WebView2's z-clip would also let
        // a (0, 0, 16, 16) host overlap the React header bar for a beat.
        let parent_hwnd = HWND(parent as *mut _);
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                CLASS,
                w!("mpv-host"),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                -10_000,
                -10_000,
                1,
                1,
                Some(parent_hwnd),
                None,
                Some(hinst),
                None,
            )
        }
        .map_err(|e| format!("CreateWindowExW: {e}"))?;
        info!("mpv host HWND created ({hwnd:?})");
        Ok(hwnd.0 as isize)
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

    /// Current playback position in microseconds, or `None` if the slot has
    /// no live handle / nothing loaded. Read on every poll tick so the UI
    /// playhead can mirror libmpv during playback.
    pub fn playback_time_us(slot: &MpvSlot) -> Option<i64> {
        let guard = slot.0.lock().expect("mpv slot poisoned");
        if !guard.active {
            return None;
        }
        let mpv = guard.mpv.as_ref()?;
        let secs: f64 = mpv.get_property("playback-time").ok()?;
        if !secs.is_finite() || secs < 0.0 {
            return None;
        }
        Some((secs * 1_000_000.0) as i64)
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

    #[derive(Default, Clone)]
    pub struct MpvPopupSlot(pub MpvSlot);

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

    pub fn playback_time_us(_: &MpvSlot) -> Option<i64> {
        None
    }

    pub fn set_host_hwnd(_: &MpvSlot, _: isize) {}

    pub fn set_surface_rect(_: &MpvSlot, _: i32, _: i32, _: i32, _: i32) -> Result<(), String> {
        Ok(())
    }

    pub fn set_host_visible(_: &MpvSlot, _: bool) -> Result<(), String> {
        Ok(())
    }

    pub fn set_host_clip(
        _: &MpvSlot,
        _: Option<(i32, i32, i32, i32)>,
    ) -> Result<(), String> {
        Ok(())
    }
}
