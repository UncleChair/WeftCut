//! Console-window suppression for child-process spawns on Windows.
//!
//! A GUI-subsystem process — Electron, and the napi addon hosted inside it —
//! owns no console, so every ffmpeg/ffprobe spawn makes Windows allocate a
//! fresh conhost window that flashes on screen. The old Tauri *debug* binary
//! was a console-subsystem app (`#![cfg_attr(not(debug_assertions),
//! windows_subsystem = "windows")]`) and inherited the dev terminal, which is
//! why this never appeared under `tauri dev`. `CREATE_NO_WINDOW` suppresses the
//! window in both dev and packaged Electron builds, and is a no-op on
//! macOS/Linux where child processes have no window concept at all.
//!
//! LANDMINE: EVERY non-test ffmpeg/ffprobe spawn MUST call `.no_console_window()`.
//! A bare `Command::new(..)` re-introduces the popup. The codebase spawns through
//! both `std::process::Command` (sync probes) and `tokio::process::Command`
//! (async jobs/export), so the trait is implemented for both.

/// Suppress the Windows console window for a child-process spawn. Chainable on a
/// builder (`Command::new(..).no_console_window().args(..)`) or callable as a
/// statement on a `let mut cmd`. No-op off Windows.
pub(crate) trait NoConsoleWindow {
    fn no_console_window(&mut self) -> &mut Self;
}

/// `CREATE_NO_WINDOW` — hides the child's console window while leaving its stdio
/// handles intact. (`DETACHED_PROCESS` would also hide it but severs stdio; we
/// depend on piped stdout/stderr to read ffprobe JSON and ffmpeg progress.)
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(windows)]
impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        // tokio re-exposes `creation_flags` as an inherent Windows-only method.
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(not(windows))]
impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}
