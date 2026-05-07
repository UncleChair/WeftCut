//! ffmpeg-sidecar wrapper: auto-download on first run, export pipeline driver,
//! analysis tools (silence detection, scene detection, frame extraction).
//!
//! Phase 0 spike: `bootstrap()` ensures ffmpeg is on disk and logs its version.

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
