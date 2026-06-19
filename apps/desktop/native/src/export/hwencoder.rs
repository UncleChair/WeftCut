//! Hardware-encoder probing, generalized per target codec.
//!
//! `ffmpeg -encoders` lists every encoder ffmpeg was built with — including
//! ones the host can't actually drive. So we run a 0.1s synthetic encode per
//! candidate and only treat it as available if ffmpeg returns 0. Results are
//! cached per target codec for the process lifetime.
//!
//! Selection order per platform: Windows NVENC > QSV > AMF; macOS
//! VideoToolbox; Linux NVENC > VAAPI. Software fallback (libx265/libsvtav1/
//! libvpx-vp9/libx264) is chosen when no HW encoder is found.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ffmpeg_sidecar::paths::ffmpeg_path;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tracing::{debug, info, warn};

/// Target video codec the user picked. Strings come over IPC.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TargetCodec {
    H264,
    Hevc,
    Av1,
    Vp9,
}

impl TargetCodec {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "h264" => Some(Self::H264),
            "hevc" => Some(Self::Hevc),
            "av1" => Some(Self::Av1),
            "vp9" => Some(Self::Vp9),
            _ => None,
        }
    }

    /// Software encoder ffmpeg always has (Gyan full build).
    pub fn software_encoder(self) -> &'static str {
        match self {
            Self::H264 => "libx264",
            Self::Hevc => "libx265",
            Self::Av1 => "libsvtav1",
            Self::Vp9 => "libvpx-vp9",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HwFamily {
    Nvenc,
    Qsv,
    Amf,
    VideoToolbox,
    Vaapi,
}

impl HwFamily {
    /// ffmpeg encoder name for this family + codec, or None if the family
    /// has no encoder for that codec.
    pub fn encoder_for(self, codec: TargetCodec) -> Option<&'static str> {
        match (self, codec) {
            (Self::Nvenc, TargetCodec::H264) => Some("h264_nvenc"),
            (Self::Nvenc, TargetCodec::Hevc) => Some("hevc_nvenc"),
            (Self::Nvenc, TargetCodec::Av1) => Some("av1_nvenc"),
            (Self::Qsv, TargetCodec::H264) => Some("h264_qsv"),
            (Self::Qsv, TargetCodec::Hevc) => Some("hevc_qsv"),
            (Self::Qsv, TargetCodec::Av1) => Some("av1_qsv"),
            (Self::Amf, TargetCodec::H264) => Some("h264_amf"),
            (Self::Amf, TargetCodec::Hevc) => Some("hevc_amf"),
            (Self::Amf, TargetCodec::Av1) => Some("av1_amf"),
            (Self::VideoToolbox, TargetCodec::H264) => Some("h264_videotoolbox"),
            (Self::VideoToolbox, TargetCodec::Hevc) => Some("hevc_videotoolbox"),
            (Self::Vaapi, TargetCodec::H264) => Some("h264_vaapi"),
            (Self::Vaapi, TargetCodec::Hevc) => Some("hevc_vaapi"),
            (Self::Vaapi, TargetCodec::Av1) => Some("av1_vaapi"),
            _ => None,
        }
    }
}

/// Platform-ordered HW families to try (best first).
pub fn platform_families() -> &'static [HwFamily] {
    if cfg!(target_os = "macos") {
        &[HwFamily::VideoToolbox]
    } else if cfg!(target_os = "windows") {
        &[HwFamily::Nvenc, HwFamily::Qsv, HwFamily::Amf]
    } else {
        &[HwFamily::Nvenc, HwFamily::Vaapi]
    }
}

/// Output pixel-format + profile flags for a 10-bit encode through `encoder`.
/// NVENC/QSV/AMF HEVC take P010 input frames; software encoders take planar.
pub fn tenbit_encode_args(encoder: &str) -> Vec<std::ffi::OsString> {
    let mk = |xs: &[&str]| xs.iter().map(|s| s.into()).collect();
    match encoder {
        "hevc_nvenc" | "hevc_qsv" | "hevc_amf" => mk(&["-pix_fmt", "p010le", "-profile:v", "main10"]),
        "libx265" => mk(&["-pix_fmt", "yuv420p10le", "-profile:v", "main10"]),
        _ => mk(&["-pix_fmt", "yuv420p10le"]),
    }
}

/// Per-codec cache of the chosen ffmpeg encoder name (HW if probed-good,
/// else the software encoder). Held in Tauri state so each export reads from
/// memory.
pub struct HwEncoderCache {
    inner: Mutex<HashMap<TargetCodec, Arc<String>>>,
    inner10: Mutex<HashMap<TargetCodec, Arc<String>>>,
}

impl Default for HwEncoderCache {
    fn default() -> Self {
        Self::new()
    }
}

impl HwEncoderCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            inner10: Mutex::new(HashMap::new()),
        }
    }

    /// The ffmpeg `-c:v` encoder name to use for `codec`. Probes HW families
    /// in platform order on first call; caches the result.
    pub async fn encoder_for(&self, codec: TargetCodec) -> Arc<String> {
        if let Some(cached) = self.inner.lock().await.get(&codec) {
            return cached.clone();
        }
        let chosen = pick_encoder(codec).await;
        let arc = Arc::new(chosen);
        self.inner.lock().await.insert(codec, arc.clone());
        arc
    }

    /// The ffmpeg `-c:v` encoder name to use for 10-bit `codec`. Probes HW
    /// families for 10-bit capability in platform order on first call; caches.
    pub async fn encoder_for_10bit(&self, codec: TargetCodec) -> Arc<String> {
        if let Some(cached) = self.inner10.lock().await.get(&codec) {
            return cached.clone();
        }
        let chosen = pick_encoder_10bit(codec).await;
        let arc = Arc::new(chosen);
        self.inner10.lock().await.insert(codec, arc.clone());
        arc
    }
}

async fn pick_encoder(codec: TargetCodec) -> String {
    for &fam in platform_families() {
        if let Some(name) = fam.encoder_for(codec) {
            if probe_encoder(name).await {
                info!("hw encoder for {:?}: {}", codec, name);
                return name.to_string();
            }
        }
    }
    let sw = codec.software_encoder();
    info!("no usable hw encoder for {:?}, using software {}", codec, sw);
    sw.to_string()
}

async fn pick_encoder_10bit(codec: TargetCodec) -> String {
    for &fam in platform_families() {
        if let Some(name) = fam.encoder_for(codec) {
            if probe_encoder_10bit(name).await {
                info!("hw 10-bit encoder for {:?}: {}", codec, name);
                return name.to_string();
            }
        }
    }
    let sw = codec.software_encoder();
    info!("no usable hw 10-bit encoder for {:?}, using software {}", codec, sw);
    sw.to_string()
}

/// Shared spawn/stderr/wait/timeout tail for both probe variants.
async fn run_probe(mut cmd: Command, encoder_name: &str) -> bool {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            debug!("hw probe spawn {} failed: {e}", encoder_name);
            return false;
        }
    };
    let mut stderr_buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut stderr_buf).await;
    }
    match timeout(Duration::from_secs(4), child.wait()).await {
        Ok(Ok(status)) if status.success() => true,
        Ok(Ok(status)) => {
            debug!("hw probe {} -> {}: {}", encoder_name, status,
                stderr_buf.lines().next().unwrap_or(""));
            false
        }
        Ok(Err(e)) => {
            warn!("hw probe {} wait failed: {e}", encoder_name);
            false
        }
        Err(_) => {
            warn!("hw probe {} timed out", encoder_name);
            let _ = child.kill().await;
            false
        }
    }
}

/// 0.1s synthetic encode through `encoder_name`; true iff ffmpeg returns 0.
/// Time-boxed at 4s (some HW init can hang).
async fn probe_encoder(encoder_name: &str) -> bool {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=128x128:d=0.1:r=30",
        "-c:v", encoder_name, "-frames:v", "1", "-f", "null", "-",
    ]);
    run_probe(cmd, encoder_name).await
}

/// 0.1s synthetic 10-bit encode through `encoder_name`; true iff ffmpeg returns 0.
/// Uses a yuv420p10le lavfi source + the encoder's 10-bit pixel-format flags.
async fn probe_encoder_10bit(encoder_name: &str) -> bool {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=128x128:d=0.1:r=30,format=yuv420p10le",
        "-c:v", encoder_name,
    ]);
    for arg in tenbit_encode_args(encoder_name) {
        cmd.arg(arg);
    }
    cmd.args(["-frames:v", "1", "-f", "null", "-"]);
    run_probe(cmd, encoder_name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenbit_args_per_encoder() {
        let s = |v: &Vec<std::ffi::OsString>| -> Vec<String> {
            v.iter().map(|o| o.to_string_lossy().into_owned()).collect()
        };
        assert_eq!(s(&tenbit_encode_args("hevc_nvenc")), vec!["-pix_fmt", "p010le", "-profile:v", "main10"]);
        assert_eq!(s(&tenbit_encode_args("libx265")), vec!["-pix_fmt", "yuv420p10le", "-profile:v", "main10"]);
        assert_eq!(s(&tenbit_encode_args("libsvtav1")), vec!["-pix_fmt", "yuv420p10le"]);
    }

    #[test]
    fn parse_codec_strings() {
        assert_eq!(TargetCodec::parse("hevc"), Some(TargetCodec::Hevc));
        assert_eq!(TargetCodec::parse("av1"), Some(TargetCodec::Av1));
        assert_eq!(TargetCodec::parse("nope"), None);
    }

    #[test]
    fn software_encoders() {
        assert_eq!(TargetCodec::Hevc.software_encoder(), "libx265");
        assert_eq!(TargetCodec::Av1.software_encoder(), "libsvtav1");
    }

    #[test]
    fn nvenc_encoder_names() {
        assert_eq!(HwFamily::Nvenc.encoder_for(TargetCodec::Hevc), Some("hevc_nvenc"));
        assert_eq!(HwFamily::Nvenc.encoder_for(TargetCodec::Av1), Some("av1_nvenc"));
        // VideoToolbox has no AV1 encoder.
        assert_eq!(HwFamily::VideoToolbox.encoder_for(TargetCodec::Av1), None);
    }
}
