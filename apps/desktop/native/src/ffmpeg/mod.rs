//! The app's single owner of the ffmpeg / ffprobe binary path, plus the
//! sidecar bootstrap that makes sure one exists.
//!
//! WHY THIS EXISTS INSTEAD OF `ffmpeg_sidecar::paths::ffmpeg_path()`
//! (issue #7 boundary #7): that resolver prefers a binary sitting **adjacent
//! to the running executable** over anything on PATH. Electron main puts the
//! version-pinned build on PATH (`main/index.ts`), so an unrelated `ffmpeg`
//! left next to the Electron binary — a stale `auto_download` from an older
//! checkout is the observed source — silently outranks it for every spawn.
//! The failure is invisible by construction: the shadow is a real ffmpeg, so
//! nothing errors; it just has different encoders. On this repo's Linux host
//! it demoted every export to `libx264`/`libx265` because the johnvansickle
//! build carries no NVENC, and on macOS it masked a VideoToolbox probe
//! failure. Both incidents were diagnosed only from the status log.
//!
//! So the preference is INVERTED here: a PATH hit (the controlled build) wins,
//! and an exe-adjacent binary is REFUSED with a loud warning naming both
//! paths. The adjacent binary is still used when nothing else is reachable —
//! that is exactly where `auto_download` puts its download on Windows/macOS,
//! and refusing it there would break the clean-machine fallback.
//!
//! Every ffmpeg/ffprobe spawn in this crate resolves through `ffmpeg_path()` /
//! `ffprobe_path()` here. Importing the sidecar crate's versions re-opens the
//! hole.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use ffmpeg_sidecar::{download::auto_download, version::ffmpeg_version_with_path};
use parking_lot::Mutex;
use tracing::{info, warn};

use crate::process::NoConsoleWindow;

#[derive(Debug, Clone)]
pub enum BootstrapStatus {
    Ready(String),
    Unavailable(String),
}

/// Where a tool's binary came from, and what lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// What to hand `Command::new`. Absolute when we found it ourselves; the
    /// bare tool name only when nothing was reachable, so the spawn fails with
    /// the OS's own "not found" rather than silently doing nothing.
    pub path: PathBuf,
    /// An exe-adjacent binary that EXISTS but was refused because a
    /// PATH-resolved build was reachable. `Some` here is always a
    /// misconfiguration worth surfacing to the user.
    pub refused_shadow: Option<PathBuf>,
}

/// The resolution rule, split out from the filesystem so it can be tested
/// against every combination without a fixture tree.
fn choose(tool: &str, adjacent: Option<PathBuf>, on_path: Option<PathBuf>) -> Resolved {
    match (adjacent, on_path) {
        // The whole point: the controlled build wins, the adjacent one is named.
        (Some(shadow), Some(pinned)) => Resolved {
            path: pinned,
            refused_shadow: Some(shadow),
        },
        (None, Some(pinned)) => Resolved {
            path: pinned,
            refused_shadow: None,
        },
        // No controlled build reachable — this is `auto_download`'s own target
        // on a clean Windows/macOS machine, so it is the intended binary here.
        (Some(adjacent), None) => Resolved {
            path: adjacent,
            refused_shadow: None,
        },
        (None, None) => Resolved {
            path: PathBuf::from(tool),
            refused_shadow: None,
        },
    }
}

fn exe_adjacent(tool: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut candidate = exe.parent()?.join(tool);
    if cfg!(windows) {
        candidate.set_extension("exe");
    }
    candidate.is_file().then_some(candidate)
}

/// First PATH entry holding the tool. Deliberately hand-rolled rather than
/// `Command::new("ffmpeg")`: Windows' CreateProcess search order starts at the
/// *application directory*, so a bare name would re-prefer the very shadow
/// this module exists to refuse.
fn first_on_path(tool: &str) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(&name))
        .find(|candidate| candidate.is_file())
}

static FFMPEG: Mutex<Option<Resolved>> = Mutex::new(None);
static FFPROBE: Mutex<Option<Resolved>> = Mutex::new(None);

fn cell(tool: &str) -> &'static Mutex<Option<Resolved>> {
    match tool {
        "ffprobe" => &FFPROBE,
        _ => &FFMPEG,
    }
}

/// Resolve once per process and cache. The lock is held across the resolution
/// so the warning below is emitted exactly once even under a concurrent first
/// use (every job/probe spawn lands here).
fn resolve(tool: &str) -> Resolved {
    let cell = cell(tool);
    let mut slot = cell.lock();
    if let Some(cached) = slot.as_ref() {
        return cached.clone();
    }
    let resolved = choose(tool, exe_adjacent(tool), first_on_path(tool));
    match &resolved.refused_shadow {
        Some(shadow) => warn!(
            refused = %shadow.display(),
            using = %resolved.path.display(),
            "REFUSED an exe-adjacent {tool}: it would shadow the version-pinned build on PATH \
             (issue #7 boundary #7). Delete it — while it is there, any tool that resolves \
             through ffmpeg-sidecar runs an uncontrolled binary with unknown encoders."
        ),
        None => info!(path = %resolved.path.display(), "resolved {tool}"),
    }
    *slot = Some(resolved.clone());
    resolved
}

/// Drop the cached resolutions. Called after `auto_download`, whose download
/// lands exe-adjacent and so changes the answer we cached a moment earlier.
fn invalidate() {
    *FFMPEG.lock() = None;
    *FFPROBE.lock() = None;
}

/// The ffmpeg binary every spawn in this crate must use.
pub fn ffmpeg_path() -> PathBuf {
    resolve("ffmpeg").path
}

/// The ffprobe binary every spawn in this crate must use. Same trap, same rule
/// — `ffprobe_path()` in the sidecar crate also prefers the adjacent copy, and
/// the two shadows travel together (an `auto_download` drops both).
pub fn ffprobe_path() -> PathBuf {
    resolve("ffprobe").path
}

/// The exe-adjacent ffmpeg that was refused, if any. Producers surface this
/// where a user can see it (the export status log carries it alongside the
/// resolved encoder — that pairing is what would have made both past incidents
/// a one-line read).
pub fn refused_shadow() -> Option<PathBuf> {
    resolve("ffmpeg").refused_shadow
}

fn is_installed(path: &Path) -> bool {
    Command::new(path)
        .arg("-version")
        .no_console_window()
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `ffmpeg -version` succeeds on the resolved binary.
pub fn ffmpeg_is_installed() -> bool {
    is_installed(&ffmpeg_path())
}

/// `ffprobe -version` succeeds on the resolved binary.
pub fn ffprobe_is_installed() -> bool {
    is_installed(&ffprobe_path())
}

pub async fn bootstrap() -> Result<BootstrapStatus> {
    tokio::task::spawn_blocking(|| {
        if !ffmpeg_is_installed() {
            // Linux deliberately does NOT auto-download (issue #5 Block A). Its
            // Standard-engine sidecar is a version-pinned fetched build, and an
            // auto-download would drop an unversioned binary next to the
            // Electron exe — the shadow this module now refuses, but a refused
            // shadow is still a machine with no working ffmpeg. Fail with an
            // actionable hint instead. Windows/macOS keep the fallback.
            if cfg!(target_os = "linux") {
                let msg = "ffmpeg not found. On Linux WeftCut ships a version-pinned \
                     ffmpeg with the app; in a dev checkout run `npm run ffmpeg:fetch`, \
                     or install your distro's package (e.g. `apt install ffmpeg`)."
                    .to_string();
                warn!("{msg}");
                return Ok::<BootstrapStatus, anyhow::Error>(BootstrapStatus::Unavailable(msg));
            }
            info!("ffmpeg not found; attempting sidecar auto-download");
            if let Err(e) = auto_download() {
                let msg = format!(
                    "ffmpeg auto-download failed ({e:#}). Install manually: \
                     `winget install Gyan.FFmpeg` (Windows) or `brew install ffmpeg` (macOS)."
                );
                warn!("{msg}");
                return Ok::<BootstrapStatus, anyhow::Error>(BootstrapStatus::Unavailable(msg));
            }
            // The download landed exe-adjacent — the one case where an adjacent
            // binary is ours. Re-resolve so the cached "nothing found" miss
            // doesn't outlive the fix.
            invalidate();
        }
        let path = ffmpeg_path();
        let v = ffmpeg_version_with_path(&path).context("read ffmpeg version banner")?;
        info!(path = %path.display(), "ffmpeg ready: {v}");
        Ok(BootstrapStatus::Ready(v))
    })
    .await
    .context("ffmpeg bootstrap join")?
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADJ: &str = "/app/ffmpeg";
    const PINNED: &str = "/opt/weftcut/resources/ffmpeg/ffmpeg";

    #[test]
    fn path_hit_beats_the_exe_adjacent_binary_and_names_it() {
        let r = choose(
            "ffmpeg",
            Some(PathBuf::from(ADJ)),
            Some(PathBuf::from(PINNED)),
        );
        assert_eq!(r.path, PathBuf::from(PINNED));
        assert_eq!(r.refused_shadow, Some(PathBuf::from(ADJ)));
    }

    #[test]
    fn a_lone_path_hit_is_not_a_shadow() {
        let r = choose("ffmpeg", None, Some(PathBuf::from(PINNED)));
        assert_eq!(r.path, PathBuf::from(PINNED));
        assert_eq!(r.refused_shadow, None);
    }

    /// The clean-machine `auto_download` case: adjacent is the ONLY binary, so
    /// it is the intended one — refusing it here would break first-run on
    /// Windows/macOS.
    #[test]
    fn a_lone_adjacent_binary_is_used_not_refused() {
        let r = choose("ffmpeg", Some(PathBuf::from(ADJ)), None);
        assert_eq!(r.path, PathBuf::from(ADJ));
        assert_eq!(r.refused_shadow, None);
    }

    #[test]
    fn nothing_reachable_falls_back_to_the_bare_name() {
        let r = choose("ffprobe", None, None);
        assert_eq!(r.path, PathBuf::from("ffprobe"));
        assert_eq!(r.refused_shadow, None);
    }
}
