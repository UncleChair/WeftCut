//! Hardware-encoder probing.
//!
//! `ffmpeg -encoders` lists every encoder ffmpeg was compiled with — including
//! ones the host has no hardware to drive. So we don't trust the static list:
//! we run a tiny synthetic encode for each candidate and only treat it as
//! "available" if ffmpeg returns 0. The probe runs once at app startup; the
//! result is cached in memory for the process lifetime. (No on-disk cache yet
//! — the probe is fast enough, and avoiding stale-cache pitfalls is worth it.)
//!
//! Selection order per platform:
//! - Windows: NVENC > QSV > AMF
//! - macOS:   VideoToolbox
//! - Linux:   NVENC > VAAPI

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ffmpeg_sidecar::paths::ffmpeg_path;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::OnceCell;
use tokio::time::timeout;
use tracing::{debug, info, warn};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
pub enum HwEncoder {
    Nvenc,
    Qsv,
    Amf,
    VideoToolbox,
    Vaapi,
}

impl HwEncoder {
    pub fn ffmpeg_codec_name(self) -> &'static str {
        match self {
            HwEncoder::Nvenc => "h264_nvenc",
            HwEncoder::Qsv => "h264_qsv",
            HwEncoder::Amf => "h264_amf",
            HwEncoder::VideoToolbox => "h264_videotoolbox",
            HwEncoder::Vaapi => "h264_vaapi",
        }
    }
}

/// Result of probing the host. `available` is the subset that actually
/// produced output without erroring; `recommended` is the platform-specific
/// best-of-available, or `None` if all probes failed (caller falls back to
/// libx264).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HwEncoderProbe {
    pub available: Vec<HwEncoder>,
    pub recommended: Option<HwEncoder>,
}

/// Lazily-populated cache of the HW probe result. Held in Tauri's `State`
/// so every export call reads from memory instead of running the probes
/// fresh (per-encoder probes time out at 4s on absent hardware → could
/// stall an export by 8-12s on a bare-metal Windows box without GPU).
#[derive(Default)]
pub struct HwEncoderCache {
    inner: OnceCell<Arc<HwEncoderProbe>>,
}

impl HwEncoderCache {
    pub fn new() -> Self {
        Self {
            inner: OnceCell::new(),
        }
    }

    /// Run the probe once, then return the recommended encoder on every
    /// subsequent call. The first caller pays the probe cost; concurrent
    /// callers wait on the same `OnceCell::get_or_init`.
    pub async fn get(&self) -> Option<HwEncoder> {
        self.probe().await.recommended
    }

    pub async fn probe(&self) -> Arc<HwEncoderProbe> {
        self.inner
            .get_or_init(|| async { Arc::new(probe_hw_encoders().await) })
            .await
            .clone()
    }
}

pub async fn probe_hw_encoders() -> HwEncoderProbe {
    let candidates: &[HwEncoder] = if cfg!(target_os = "macos") {
        &[HwEncoder::VideoToolbox]
    } else if cfg!(target_os = "windows") {
        &[HwEncoder::Nvenc, HwEncoder::Qsv, HwEncoder::Amf]
    } else {
        // Linux / others
        &[HwEncoder::Nvenc, HwEncoder::Vaapi]
    };

    let mut available = Vec::new();
    for &enc in candidates {
        if probe_encoder(enc).await {
            available.push(enc);
        }
    }
    let recommended = available.first().copied();
    if let Some(r) = recommended {
        info!("hw encoder probe: recommending {}", r.ffmpeg_codec_name());
    } else {
        info!("hw encoder probe: no usable hw encoder, libx264 will be used");
    }
    HwEncoderProbe {
        available,
        recommended,
    }
}

/// Run a 0.1s synthetic encode through `enc` to confirm the host actually
/// supports it. Time-boxed at 4s — older NVIDIA drivers can hang on init when
/// the GPU is busy; we'd rather skip than block app startup.
async fn probe_encoder(enc: HwEncoder) -> bool {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=128x128:d=0.1:r=30",
        "-c:v",
        enc.ffmpeg_codec_name(),
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
    ]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            debug!("hw probe spawn {:?} failed: {e}", enc);
            return false;
        }
    };
    // Read stderr in case we need to log on failure.
    let mut stderr_buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut stderr_buf).await;
    }
    let result = timeout(Duration::from_secs(4), child.wait()).await;
    match result {
        Ok(Ok(status)) if status.success() => true,
        Ok(Ok(status)) => {
            debug!(
                "hw probe {:?} returned {}: {}",
                enc,
                status,
                stderr_buf.lines().next().unwrap_or("")
            );
            false
        }
        Ok(Err(e)) => {
            warn!("hw probe {:?} wait failed: {e}", enc);
            false
        }
        Err(_) => {
            warn!("hw probe {:?} timed out", enc);
            // Best-effort kill so we don't leak the child.
            let _ = child.kill().await;
            false
        }
    }
}
