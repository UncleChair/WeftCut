//! ffmpeg-sidecar bootstrap: ensure ffmpeg is on disk (sidecar auto-download on
//! first run) and log its version.

use anyhow::{Context, Result};
use ffmpeg_sidecar::{
    command::ffmpeg_is_installed, download::auto_download, version::ffmpeg_version,
};
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub enum BootstrapStatus {
    Ready(String),
    Unavailable(String),
}

pub async fn bootstrap() -> Result<BootstrapStatus> {
    tokio::task::spawn_blocking(|| {
        if !ffmpeg_is_installed() {
            // Linux deliberately does NOT auto-download (issue #5 Block A). Its
            // Standard-engine sidecar is a version-pinned fetched build; a
            // sidecar auto-download drops an unversioned binary next to the
            // Electron exe, which ffmpeg-sidecar's ffmpeg_path() then prefers
            // over the controlled build on PATH — the "sidecar version
            // uncontrolled" trap. Fail with an actionable hint instead.
            // Windows/macOS keep the auto-download fallback.
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
        }
        let v = ffmpeg_version().context("read ffmpeg version banner")?;
        info!("ffmpeg ready: {v}");
        Ok(BootstrapStatus::Ready(v))
    })
    .await
    .context("ffmpeg bootstrap join")?
}
