//! Platform hardware decode helpers for ffmpeg proxy jobs.
//!
//! Decode may use GPU-backed ffmpeg hwaccel; encode stays on libx264 for
//! portable, WebCodecs-friendly proxy output. On failure we fall back to
//! software decode automatically.

use std::process::Output;

use anyhow::{Context, Result};
use ffmpeg_sidecar::paths::ffmpeg_path;
use tokio::process::Command;

use crate::process::NoConsoleWindow;
use tracing::{info, warn};

/// Native ffmpeg `-hwaccel` name for the current OS, if any.
pub fn preferred_hwaccel() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    {
        Some("d3d11va")
    }
    #[cfg(target_os = "macos")]
    {
        Some("videotoolbox")
    }
    #[cfg(target_os = "linux")]
    {
        Some("vaapi")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Append hardware-decode flags immediately before `-i`.
pub fn push_hwaccel_args(cmd: &mut Command) {
    let Some(accel) = preferred_hwaccel() else {
        return;
    };
    cmd.args(["-hwaccel", accel]);
    #[cfg(target_os = "linux")]
    {
        cmd.args(["-vaapi_device", "/dev/dri/renderD128"]);
    }
}

/// Run an ffmpeg transcode command, trying hardware decode first when
/// available. `build` receives `use_hw=true` for the first attempt.
pub async fn output_with_hw_decode_fallback<F>(label: &str, mut build: F) -> Result<Output>
where
    F: FnMut(bool, &mut Command),
{
    if preferred_hwaccel().is_some() {
        let mut cmd = Command::new(ffmpeg_path());
        cmd.no_console_window();
        // LANDMINE: without kill_on_drop, dropping the output() future (tokio
        // runtime shutdown, task abort) ORPHANS the ffmpeg child, which keeps
        // writing the deterministic `<dest>.tmp` — the next build then
        // interleaves with it and dies at promote (observed live 2026-07-23).
        cmd.kill_on_drop(true);
        build(true, &mut cmd);
        let output = cmd
            .output()
            .await
            .with_context(|| format!("spawn ffmpeg for {label} (hw decode)"))?;
        if output.status.success() {
            info!("{label}: hardware decode succeeded");
            return Ok(output);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!(
            "{label}: hardware decode failed, retrying with software decode: {}",
            stderr.trim()
        );
    }

    let mut cmd = Command::new(ffmpeg_path());
    cmd.no_console_window();
    cmd.kill_on_drop(true); // see the hw-attempt landmine above
    build(false, &mut cmd);
    if preferred_hwaccel().is_some() {
        info!("{label}: software decode fallback");
    } else {
        info!("{label}: software decode (no hwaccel on this platform)");
    }
    cmd.output()
        .await
        .with_context(|| format!("spawn ffmpeg for {label} (sw decode)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_hwaccel_is_set_on_supported_platforms() {
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        assert!(preferred_hwaccel().is_some());
    }
}
