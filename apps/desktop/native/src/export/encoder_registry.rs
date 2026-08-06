//! FFmpeg encoder registry and capability resolver.
//!
//! Callers describe export intent without naming an FFmpeg library. This
//! module owns the catalog of known encoder adapters, their platform order,
//! real one-frame capability probes, cached selection, and every output-side
//! encoder argument. Its single external seam is
//! `EncoderRegistry::resolve(EncoderIntent)`: success is a complete
//! `EncoderPlan`; failure is a structured `EncodeUnavailable`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ffmpeg_sidecar::paths::ffmpeg_path;
use serde::Serialize;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tracing::{debug, info, warn};

use crate::process::NoConsoleWindow;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VideoCodec {
    H264,
    Hevc,
    Av1,
    Prores,
    Dnxhr,
}

impl VideoCodec {
    pub(crate) fn parse(value: &str) -> Result<Self, EncodeUnavailable> {
        match value {
            "h264" => Ok(Self::H264),
            "hevc" => Ok(Self::Hevc),
            "av1" => Ok(Self::Av1),
            "prores" => Ok(Self::Prores),
            "dnxhr" => Ok(Self::Dnxhr),
            _ => Err(EncodeUnavailable::invalid(
                "codec",
                value,
                "expected h264, hevc, av1, prores, or dnxhr",
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
            Self::Prores => "prores",
            Self::Dnxhr => "dnxhr",
        }
    }
}

impl fmt::Display for VideoCodec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BitDepth {
    Eight,
    Ten,
}

impl BitDepth {
    pub(crate) fn from_raw_pixel_format(value: &str) -> Result<Self, EncodeUnavailable> {
        match value {
            "yuv420p" | "yuv422p" => Ok(Self::Eight),
            "yuv420p10le" | "yuv422p10le" => Ok(Self::Ten),
            _ => Err(EncodeUnavailable::invalid(
                "pixFmt",
                value,
                "expected yuv420p, yuv420p10le, yuv422p, or yuv422p10le",
            )),
        }
    }

    fn bits(self) -> u8 {
        match self {
            Self::Eight => 8,
            Self::Ten => 10,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Acceleration {
    Automatic,
    Software,
}

impl fmt::Display for Acceleration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Automatic => "automatic",
            Self::Software => "software",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BitrateMode {
    Variable,
    Constant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProresProfile {
    Proxy,
    Lt,
    Standard,
    Hq,
}

impl ProresProfile {
    pub(crate) fn parse(value: Option<&str>) -> Result<Self, EncodeUnavailable> {
        match value.unwrap_or("422") {
            "proxy" => Ok(Self::Proxy),
            "lt" => Ok(Self::Lt),
            "422" => Ok(Self::Standard),
            "hq" => Ok(Self::Hq),
            value => Err(EncodeUnavailable::invalid(
                "profile",
                value,
                "expected proxy, lt, 422, or hq for ProRes",
            )),
        }
    }

    fn ffmpeg_value(self) -> &'static str {
        match self {
            Self::Proxy => "0",
            Self::Lt => "1",
            Self::Standard => "2",
            Self::Hq => "3",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DnxhrProfile {
    Lb,
    Sq,
    Hq,
}

impl DnxhrProfile {
    pub(crate) fn parse(value: Option<&str>) -> Result<Self, EncodeUnavailable> {
        match value.unwrap_or("sq") {
            "lb" => Ok(Self::Lb),
            "sq" => Ok(Self::Sq),
            "hq" => Ok(Self::Hq),
            value => Err(EncodeUnavailable::invalid(
                "profile",
                value,
                "expected lb, sq, or hq for DNxHR",
            )),
        }
    }

    fn ffmpeg_value(self) -> &'static str {
        match self {
            Self::Lb => "dnxhr_lb",
            Self::Sq => "dnxhr_sq",
            Self::Hq => "dnxhr_hq",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RateControl {
    /// A bitrate target, optionally constrained. `max_bps` is the VBV ceiling
    /// (`-maxrate`) and `buffer_bits` its averaging window (`-bufsize`); both
    /// `None` mean "unconstrained", which for `Variable` is plain ABR — no
    /// ceiling arg is emitted at all. `Constant` pins the ceiling to the
    /// target itself and ignores `max_bps`, because CBR has no peak distinct
    /// from its average; a stale peak carried over from VBR must not leak in.
    Bitrate {
        target_bps: u64,
        mode: BitrateMode,
        max_bps: Option<u64>,
        buffer_bits: Option<u64>,
    },
    ConstantQuality {
        quality: u32,
    },
    ProresProfile(ProresProfile),
    DnxhrProfile(DnxhrProfile),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum RateControlKind {
    Bitrate,
    ConstantQuality,
    ProresProfile,
    DnxhrProfile,
}

impl RateControl {
    fn kind(self) -> RateControlKind {
        match self {
            Self::Bitrate { .. } => RateControlKind::Bitrate,
            Self::ConstantQuality { .. } => RateControlKind::ConstantQuality,
            Self::ProresProfile(_) => RateControlKind::ProresProfile,
            Self::DnxhrProfile(_) => RateControlKind::DnxhrProfile,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Speed {
    Fast,
    Medium,
    Slow,
}

impl Speed {
    pub(crate) fn parse(value: Option<&str>) -> Result<Self, EncodeUnavailable> {
        match value.unwrap_or("medium") {
            "fast" => Ok(Self::Fast),
            "medium" => Ok(Self::Medium),
            "slow" => Ok(Self::Slow),
            value => Err(EncodeUnavailable::invalid(
                "preset",
                value,
                "expected fast, medium, or slow",
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Medium => "medium",
            Self::Slow => "slow",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OutputContainer {
    Mp4,
    Mov,
    Matroska,
}

impl OutputContainer {
    pub(crate) fn from_path(path: &Path) -> Result<Self, EncodeUnavailable> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match extension.as_str() {
            "mp4" => Ok(Self::Mp4),
            "mov" => Ok(Self::Mov),
            "mkv" => Ok(Self::Matroska),
            _ => Err(EncodeUnavailable::invalid(
                "outputPath",
                path.display().to_string(),
                "native video output must use .mp4, .mov, or .mkv",
            )),
        }
    }
}

/// Library-agnostic request presented at the registry seam.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EncoderIntent {
    pub codec: VideoCodec,
    pub bit_depth: BitDepth,
    pub acceleration: Acceleration,
    pub rate_control: RateControl,
    pub speed: Speed,
    pub gop_frames: u64,
    pub container: OutputContainer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SelectedAcceleration {
    Hardware,
    Software,
}

/// Everything the sink needs on the output side of its FFmpeg invocation.
/// The sink owns raw-frame input/process lifecycle only; it must not append or
/// reinterpret encoder arguments after this plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EncoderPlan {
    pub codec: VideoCodec,
    pub bit_depth: BitDepth,
    pub encoder_name: &'static str,
    pub acceleration: SelectedAcceleration,
    pub ffmpeg_args: Vec<OsString>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncoderAttempt {
    pub adapter: String,
    pub reason: String,
}

/// A typed failure at the registry seam. `NoCapableEncoder` preserves every
/// adapter tried and why it failed; `InvalidIntent` reports a rejected
/// library-agnostic request before any process is spawned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum EncodeUnavailable {
    InvalidIntent {
        field: String,
        value: String,
        reason: String,
    },
    NoCapableEncoder {
        codec: VideoCodec,
        bit_depth: BitDepth,
        acceleration: Acceleration,
        attempts: Vec<EncoderAttempt>,
    },
}

impl EncodeUnavailable {
    fn invalid(
        field: impl Into<String>,
        value: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self::InvalidIntent {
            field: field.into(),
            value: value.into(),
            reason: reason.into(),
        }
    }
}

impl fmt::Display for EncodeUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIntent {
                field,
                value,
                reason,
            } => write!(f, "invalid encoder intent {field}={value:?}: {reason}"),
            Self::NoCapableEncoder {
                codec,
                bit_depth,
                acceleration,
                attempts,
            } => {
                write!(
                    f,
                    "no usable FFmpeg encoder for {codec} {}-bit ({acceleration})",
                    bit_depth.bits()
                )?;
                if !attempts.is_empty() {
                    f.write_str("; tried ")?;
                    for (index, attempt) in attempts.iter().enumerate() {
                        if index > 0 {
                            f.write_str(", ")?;
                        }
                        write!(f, "{} ({})", attempt.adapter, attempt.reason)?;
                    }
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for EncodeUnavailable {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Platform {
    Windows,
    Macos,
    Linux,
}

impl Platform {
    fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }

    fn hardware_families(self) -> &'static [HardwareFamily] {
        match self {
            Self::Windows => &[
                HardwareFamily::Nvenc,
                HardwareFamily::Qsv,
                HardwareFamily::Amf,
            ],
            Self::Macos => &[HardwareFamily::VideoToolbox],
            Self::Linux => &[HardwareFamily::Nvenc, HardwareFamily::Vaapi],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HardwareFamily {
    Nvenc,
    Qsv,
    Amf,
    VideoToolbox,
    Vaapi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum AdapterId {
    H264Nvenc,
    HevcNvenc,
    Av1Nvenc,
    H264Qsv,
    HevcQsv,
    Av1Qsv,
    H264Amf,
    HevcAmf,
    Av1Amf,
    H264VideoToolbox,
    HevcVideoToolbox,
    H264Vaapi,
    HevcVaapi,
    Av1Vaapi,
    Libx264,
    Libx265,
    LibsvtAv1,
    LibaomAv1,
    ProresKs,
    Dnxhd,
}

impl AdapterId {
    fn for_hardware(family: HardwareFamily, codec: VideoCodec) -> Option<Self> {
        match (family, codec) {
            (HardwareFamily::Nvenc, VideoCodec::H264) => Some(Self::H264Nvenc),
            (HardwareFamily::Nvenc, VideoCodec::Hevc) => Some(Self::HevcNvenc),
            (HardwareFamily::Nvenc, VideoCodec::Av1) => Some(Self::Av1Nvenc),
            (HardwareFamily::Qsv, VideoCodec::H264) => Some(Self::H264Qsv),
            (HardwareFamily::Qsv, VideoCodec::Hevc) => Some(Self::HevcQsv),
            (HardwareFamily::Qsv, VideoCodec::Av1) => Some(Self::Av1Qsv),
            (HardwareFamily::Amf, VideoCodec::H264) => Some(Self::H264Amf),
            (HardwareFamily::Amf, VideoCodec::Hevc) => Some(Self::HevcAmf),
            (HardwareFamily::Amf, VideoCodec::Av1) => Some(Self::Av1Amf),
            (HardwareFamily::VideoToolbox, VideoCodec::H264) => Some(Self::H264VideoToolbox),
            (HardwareFamily::VideoToolbox, VideoCodec::Hevc) => Some(Self::HevcVideoToolbox),
            (HardwareFamily::Vaapi, VideoCodec::H264) => Some(Self::H264Vaapi),
            (HardwareFamily::Vaapi, VideoCodec::Hevc) => Some(Self::HevcVaapi),
            (HardwareFamily::Vaapi, VideoCodec::Av1) => Some(Self::Av1Vaapi),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::H264Nvenc => "h264_nvenc",
            Self::HevcNvenc => "hevc_nvenc",
            Self::Av1Nvenc => "av1_nvenc",
            Self::H264Qsv => "h264_qsv",
            Self::HevcQsv => "hevc_qsv",
            Self::Av1Qsv => "av1_qsv",
            Self::H264Amf => "h264_amf",
            Self::HevcAmf => "hevc_amf",
            Self::Av1Amf => "av1_amf",
            Self::H264VideoToolbox => "h264_videotoolbox",
            Self::HevcVideoToolbox => "hevc_videotoolbox",
            Self::H264Vaapi => "h264_vaapi",
            Self::HevcVaapi => "hevc_vaapi",
            Self::Av1Vaapi => "av1_vaapi",
            Self::Libx264 => "libx264",
            Self::Libx265 => "libx265",
            Self::LibsvtAv1 => "libsvtav1",
            Self::LibaomAv1 => "libaom-av1",
            Self::ProresKs => "prores_ks",
            Self::Dnxhd => "dnxhd",
        }
    }

    fn codec(self) -> VideoCodec {
        match self {
            Self::H264Nvenc
            | Self::H264Qsv
            | Self::H264Amf
            | Self::H264VideoToolbox
            | Self::H264Vaapi
            | Self::Libx264 => VideoCodec::H264,
            Self::HevcNvenc
            | Self::HevcQsv
            | Self::HevcAmf
            | Self::HevcVideoToolbox
            | Self::HevcVaapi
            | Self::Libx265 => VideoCodec::Hevc,
            Self::Av1Nvenc
            | Self::Av1Qsv
            | Self::Av1Amf
            | Self::Av1Vaapi
            | Self::LibsvtAv1
            | Self::LibaomAv1 => VideoCodec::Av1,
            Self::ProresKs => VideoCodec::Prores,
            Self::Dnxhd => VideoCodec::Dnxhr,
        }
    }

    fn is_hardware(self) -> bool {
        !matches!(
            self,
            Self::Libx264
                | Self::Libx265
                | Self::LibsvtAv1
                | Self::LibaomAv1
                | Self::ProresKs
                | Self::Dnxhd
        )
    }

    fn supports_bit_depth(self, bit_depth: BitDepth) -> bool {
        match self.codec() {
            VideoCodec::H264 | VideoCodec::Dnxhr => bit_depth == BitDepth::Eight,
            VideoCodec::Prores => bit_depth == BitDepth::Ten,
            VideoCodec::Hevc | VideoCodec::Av1 => true,
        }
    }
}

const H264_SOFTWARE: &[AdapterId] = &[AdapterId::Libx264];
const HEVC_SOFTWARE: &[AdapterId] = &[AdapterId::Libx265];
// The pinned Windows Essentials build has libaom but not libsvtav1; Linux's
// BtbN GPL build has libsvtav1. Both are catalog entries and both are probed.
const AV1_SOFTWARE: &[AdapterId] = &[AdapterId::LibsvtAv1, AdapterId::LibaomAv1];

fn software_adapters(codec: VideoCodec) -> &'static [AdapterId] {
    match codec {
        VideoCodec::H264 => H264_SOFTWARE,
        VideoCodec::Hevc => HEVC_SOFTWARE,
        VideoCodec::Av1 => AV1_SOFTWARE,
        VideoCodec::Prores => &[AdapterId::ProresKs],
        VideoCodec::Dnxhr => &[AdapterId::Dnxhd],
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct CapabilityKey {
    codec: VideoCodec,
    bit_depth: BitDepth,
    acceleration: Acceleration,
    rate_control: RateControlKind,
}

impl From<EncoderIntent> for CapabilityKey {
    fn from(intent: EncoderIntent) -> Self {
        Self {
            codec: intent.codec,
            bit_depth: intent.bit_depth,
            acceleration: intent.acceleration,
            rate_control: intent.rate_control.kind(),
        }
    }
}

#[derive(Clone, Debug)]
enum CachedSelection {
    Available(AdapterId),
    Unavailable(Vec<EncoderAttempt>),
}

#[async_trait::async_trait]
trait CapabilityProbe: Send + Sync {
    async fn probe(&self, adapter: AdapterId, capability: CapabilityKey) -> Result<(), String>;
}

/// How long one encoder probe may take before it is called unavailable.
///
/// The probe only encodes a single 640x360 black frame, so a warm machine
/// answers in well under a second — but the wall clock also covers spawning
/// ffmpeg and, for the hardware adapters, driver/runtime enumeration. The
/// previous 4s budget was too tight for a loaded CI runner: a Windows leg
/// running two Electron workers reported `h264_nvenc`, `h264_qsv`, `h264_amf`
/// AND `libx264` as "probe timed out after 4s" and then failed the export with
/// "no usable FFmpeg encoder for h264 8-bit" — on a bundled ffmpeg that does
/// ship libx264. A timeout must mean "this encoder is unusable", never "this
/// machine was busy", so the budget is generous; probes that resolve at all
/// resolve fast, and each result is cached per capability key.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct FfmpegCapabilityProbe;

#[async_trait::async_trait]
impl CapabilityProbe for FfmpegCapabilityProbe {
    async fn probe(&self, adapter: AdapterId, capability: CapabilityKey) -> Result<(), String> {
        let intent = probe_intent(adapter, capability);
        let plan = build_plan(intent, adapter).map_err(|error| error.to_string())?;
        let source = match capability.bit_depth {
            BitDepth::Eight => "color=c=black:s=640x360:d=0.1:r=30",
            BitDepth::Ten => "color=c=black:s=640x360:d=0.1:r=30,format=yuv420p10le",
        };

        let mut cmd = Command::new(ffmpeg_path());
        cmd.no_console_window();
        cmd.kill_on_drop(true);
        cmd.args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            source,
            "-vf",
            "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
        ]);
        cmd.args(plan.ffmpeg_args);
        cmd.args(["-frames:v", "1", "-f", "null", "-"]);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let child = cmd
            .spawn()
            .map_err(|error| format!("spawn failed: {error}"))?;
        let output = timeout(PROBE_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| format!("probe timed out after {}s", PROBE_TIMEOUT.as_secs()))?
            .map_err(|error| format!("wait failed: {error}"))?;
        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let summary = stderr
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("no stderr")
            .chars()
            .take(240)
            .collect::<String>();
        Err(format!("exit {}: {summary}", output.status))
    }
}

/// Process-lifetime capability resolver. Cached entries include failures, so
/// a missing library or terminally unusable device is not reprobed per export.
pub(crate) struct EncoderRegistry {
    platform: Platform,
    probe: Arc<dyn CapabilityProbe>,
    selections: Mutex<HashMap<CapabilityKey, CachedSelection>>,
}

impl Default for EncoderRegistry {
    fn default() -> Self {
        Self {
            platform: Platform::current(),
            probe: Arc::new(FfmpegCapabilityProbe),
            selections: Mutex::new(HashMap::new()),
        }
    }
}

impl EncoderRegistry {
    /// Resolve one intent to a fully mapped plan. No encoder name leaves this
    /// module unless its adapter passed a real one-frame probe.
    pub(crate) async fn resolve(
        &self,
        intent: EncoderIntent,
    ) -> Result<EncoderPlan, EncodeUnavailable> {
        validate_intent(intent)?;
        let key = CapabilityKey::from(intent);

        let cached = self.selections.lock().await.get(&key).cloned();
        let selection = match cached {
            Some(selection) => selection,
            None => {
                let resolved = self.select(key).await;
                let mut selections = self.selections.lock().await;
                selections
                    .entry(key)
                    .or_insert_with(|| resolved.clone())
                    .clone()
            }
        };

        match selection {
            CachedSelection::Available(adapter) => build_plan(intent, adapter),
            CachedSelection::Unavailable(attempts) => Err(EncodeUnavailable::NoCapableEncoder {
                codec: intent.codec,
                bit_depth: intent.bit_depth,
                acceleration: intent.acceleration,
                attempts,
            }),
        }
    }

    async fn select(&self, key: CapabilityKey) -> CachedSelection {
        let candidates = candidate_adapters(self.platform, key);
        let mut attempts = Vec::with_capacity(candidates.len());
        for adapter in candidates {
            match self.probe.probe(adapter, key).await {
                Ok(()) => {
                    info!(
                        codec = %key.codec,
                        bit_depth = key.bit_depth.bits(),
                        acceleration = %key.acceleration,
                        encoder = adapter.name(),
                        "FFmpeg encoder adapter selected"
                    );
                    return CachedSelection::Available(adapter);
                }
                Err(reason) => {
                    debug!(
                        codec = %key.codec,
                        bit_depth = key.bit_depth.bits(),
                        encoder = adapter.name(),
                        %reason,
                        "FFmpeg encoder adapter unavailable"
                    );
                    attempts.push(EncoderAttempt {
                        adapter: adapter.name().to_string(),
                        reason,
                    });
                }
            }
        }
        warn!(
            codec = %key.codec,
            bit_depth = key.bit_depth.bits(),
            acceleration = %key.acceleration,
            "no FFmpeg encoder adapter passed its capability probe"
        );
        CachedSelection::Unavailable(attempts)
    }

    #[cfg(test)]
    fn with_probe(platform: Platform, probe: Arc<dyn CapabilityProbe>) -> Self {
        Self {
            platform,
            probe,
            selections: Mutex::new(HashMap::new()),
        }
    }
}

fn candidate_adapters(platform: Platform, key: CapabilityKey) -> Vec<AdapterId> {
    let mut candidates = Vec::new();
    let may_use_hardware = key.acceleration == Acceleration::Automatic
        && key.rate_control == RateControlKind::Bitrate
        && matches!(
            key.codec,
            VideoCodec::H264 | VideoCodec::Hevc | VideoCodec::Av1
        );
    if may_use_hardware {
        for family in platform.hardware_families() {
            if let Some(adapter) = AdapterId::for_hardware(*family, key.codec) {
                if adapter.supports_bit_depth(key.bit_depth) {
                    candidates.push(adapter);
                }
            }
        }
    }
    candidates.extend(
        software_adapters(key.codec)
            .iter()
            .copied()
            .filter(|adapter| adapter.supports_bit_depth(key.bit_depth)),
    );
    candidates
}

fn validate_intent(intent: EncoderIntent) -> Result<(), EncodeUnavailable> {
    let valid_depth = match intent.codec {
        VideoCodec::H264 | VideoCodec::Dnxhr => intent.bit_depth == BitDepth::Eight,
        VideoCodec::Prores => intent.bit_depth == BitDepth::Ten,
        VideoCodec::Hevc | VideoCodec::Av1 => true,
    };
    if !valid_depth {
        return Err(EncodeUnavailable::invalid(
            "bitDepth",
            intent.bit_depth.bits().to_string(),
            format!("{} does not support this export bit depth", intent.codec),
        ));
    }

    let valid_rate_control = matches!(
        (intent.codec, intent.rate_control),
        (
            VideoCodec::H264 | VideoCodec::Hevc | VideoCodec::Av1,
            RateControl::Bitrate { .. } | RateControl::ConstantQuality { .. }
        ) | (VideoCodec::Prores, RateControl::ProresProfile(_))
            | (VideoCodec::Dnxhr, RateControl::DnxhrProfile(_))
    );
    if !valid_rate_control {
        return Err(EncodeUnavailable::invalid(
            "rateControl",
            format!("{:?}", intent.rate_control),
            format!("rate-control mode does not match {}", intent.codec),
        ));
    }

    if let RateControl::Bitrate { target_bps: 0, .. } = intent.rate_control {
        return Err(EncodeUnavailable::invalid(
            "bitrate",
            "0",
            "bitrate must be greater than zero",
        ));
    }
    if let RateControl::Bitrate {
        target_bps,
        max_bps,
        buffer_bits,
        ..
    } = intent.rate_control
    {
        // A ceiling under the average is not a weaker constraint — the encoder
        // cannot satisfy both, so it silently abandons the average and the file
        // comes out at the ceiling. Reject rather than pick a winner.
        if let Some(max) = max_bps {
            if max == 0 {
                return Err(EncodeUnavailable::invalid(
                    "maxBitrate",
                    "0",
                    "peak bitrate must be greater than zero",
                ));
            }
            if max < target_bps {
                return Err(EncodeUnavailable::invalid(
                    "maxBitrate",
                    max.to_string(),
                    format!("peak bitrate must be at least the target bitrate ({target_bps})"),
                ));
            }
        }
        if buffer_bits == Some(0) {
            return Err(EncodeUnavailable::invalid(
                "bufferSize",
                "0",
                "buffer size must be greater than zero",
            ));
        }
    }
    if let RateControl::ConstantQuality { quality } = intent.rate_control {
        if quality > 51 {
            return Err(EncodeUnavailable::invalid(
                "quality",
                quality.to_string(),
                "constant-quality value must be in 0..=51",
            ));
        }
    }
    if matches!(
        intent.codec,
        VideoCodec::H264 | VideoCodec::Hevc | VideoCodec::Av1
    ) && intent.gop_frames == 0
    {
        return Err(EncodeUnavailable::invalid(
            "gop",
            "0",
            "GOP length must be greater than zero",
        ));
    }

    match (intent.codec, intent.container) {
        (VideoCodec::Av1, OutputContainer::Mov) => Err(EncodeUnavailable::invalid(
            "container",
            "mov",
            "AV1 is supported in MP4 or MKV, not MOV",
        )),
        (VideoCodec::Prores | VideoCodec::Dnxhr, container)
            if container != OutputContainer::Mov =>
        {
            Err(EncodeUnavailable::invalid(
                "container",
                format!("{container:?}"),
                "ProRes and DNxHR exports require MOV",
            ))
        }
        _ => Ok(()),
    }
}

fn build_plan(intent: EncoderIntent, adapter: AdapterId) -> Result<EncoderPlan, EncodeUnavailable> {
    validate_intent(intent)?;
    if adapter.codec() != intent.codec || !adapter.supports_bit_depth(intent.bit_depth) {
        return Err(EncodeUnavailable::invalid(
            "adapter",
            adapter.name(),
            "adapter does not satisfy the requested codec and bit depth",
        ));
    }

    let mut args: Vec<OsString> = vec!["-c:v".into(), adapter.name().into()];
    match intent.rate_control {
        RateControl::ProresProfile(profile) => {
            args.extend::<Vec<OsString>>(vec![
                "-profile:v".into(),
                profile.ffmpeg_value().into(),
                "-vendor".into(),
                "apl0".into(),
                "-pix_fmt".into(),
                "yuv422p10le".into(),
            ]);
        }
        RateControl::DnxhrProfile(profile) => {
            args.extend::<Vec<OsString>>(vec![
                "-profile:v".into(),
                profile.ffmpeg_value().into(),
                "-pix_fmt".into(),
                "yuv422p".into(),
            ]);
        }
        RateControl::Bitrate {
            target_bps,
            mode,
            max_bps,
            buffer_bits,
        } => {
            args.extend::<Vec<OsString>>(vec!["-b:v".into(), target_bps.to_string().into()]);
            let ceiling = match mode {
                BitrateMode::Constant => Some(target_bps),
                BitrateMode::Variable => max_bps,
            };
            if let Some(ceiling) = ceiling {
                args.extend::<Vec<OsString>>(vec!["-maxrate".into(), ceiling.to_string().into()]);
                if mode == BitrateMode::Constant {
                    args.extend::<Vec<OsString>>(vec![
                        "-minrate".into(),
                        target_bps.to_string().into(),
                    ]);
                }
                // Derivation lives here, not in the renderer: `bufsize` is an
                // encoder-side concept and one default is easier to keep honest
                // than two. 2× the ceiling is the shipped value.
                let buffer = buffer_bits.unwrap_or_else(|| ceiling.saturating_mul(2));
                args.extend::<Vec<OsString>>(vec!["-bufsize".into(), buffer.to_string().into()]);
            }
            append_delivery_args(&mut args, intent, adapter);
        }
        RateControl::ConstantQuality { quality } => {
            args.extend::<Vec<OsString>>(vec!["-crf".into(), quality.to_string().into()]);
            if adapter == AdapterId::LibaomAv1 {
                // libaom's default bitrate constrains `-crf`; zero makes this
                // true constant quality.
                args.extend::<Vec<OsString>>(vec!["-b:v".into(), "0".into()]);
            }
            append_delivery_args(&mut args, intent, adapter);
        }
    }

    args.extend::<Vec<OsString>>(vec![
        "-colorspace".into(),
        "bt709".into(),
        "-color_primaries".into(),
        "bt709".into(),
        "-color_trc".into(),
        "bt709".into(),
        "-color_range".into(),
        "tv".into(),
    ]);
    if intent.codec == VideoCodec::Hevc
        && matches!(
            intent.container,
            OutputContainer::Mp4 | OutputContainer::Mov
        )
    {
        args.extend::<Vec<OsString>>(vec!["-tag:v".into(), "hvc1".into()]);
    }

    Ok(EncoderPlan {
        codec: intent.codec,
        bit_depth: intent.bit_depth,
        encoder_name: adapter.name(),
        acceleration: if adapter.is_hardware() {
            SelectedAcceleration::Hardware
        } else {
            SelectedAcceleration::Software
        },
        ffmpeg_args: args,
    })
}

fn append_delivery_args(args: &mut Vec<OsString>, intent: EncoderIntent, adapter: AdapterId) {
    let gop = intent.gop_frames.to_string();
    args.extend::<Vec<OsString>>(vec![
        "-g".into(),
        gop.clone().into(),
        "-keyint_min".into(),
        gop.into(),
    ]);

    match adapter {
        AdapterId::LibsvtAv1 => {
            let value = match intent.speed {
                Speed::Fast => "10",
                Speed::Medium => "8",
                Speed::Slow => "6",
            };
            args.extend::<Vec<OsString>>(vec!["-preset".into(), value.into()]);
        }
        AdapterId::LibaomAv1 => {
            let value = match intent.speed {
                Speed::Fast => "8",
                Speed::Medium => "6",
                Speed::Slow => "4",
            };
            args.extend::<Vec<OsString>>(vec![
                "-cpu-used".into(),
                value.into(),
                "-row-mt".into(),
                "1".into(),
            ]);
        }
        AdapterId::Libx264 | AdapterId::Libx265 => {
            args.extend::<Vec<OsString>>(vec![
                "-preset".into(),
                intent.speed.as_str().into(),
                "-sc_threshold".into(),
                "0".into(),
            ]);
        }
        _ => {}
    }

    match (intent.bit_depth, adapter) {
        (BitDepth::Eight, _) => {
            args.extend::<Vec<OsString>>(vec!["-pix_fmt".into(), "yuv420p".into()]);
        }
        (BitDepth::Ten, AdapterId::HevcNvenc | AdapterId::HevcQsv | AdapterId::HevcAmf) => {
            args.extend::<Vec<OsString>>(vec![
                "-pix_fmt".into(),
                "p010le".into(),
                "-profile:v".into(),
                "main10".into(),
            ]);
        }
        (BitDepth::Ten, AdapterId::Libx265) => {
            args.extend::<Vec<OsString>>(vec![
                "-pix_fmt".into(),
                "yuv420p10le".into(),
                "-profile:v".into(),
                "main10".into(),
            ]);
        }
        (BitDepth::Ten, _) => {
            args.extend::<Vec<OsString>>(vec!["-pix_fmt".into(), "yuv420p10le".into()]);
        }
    }
}

fn probe_intent(adapter: AdapterId, capability: CapabilityKey) -> EncoderIntent {
    let rate_control = match capability.rate_control {
        RateControlKind::ProresProfile => RateControl::ProresProfile(ProresProfile::Standard),
        RateControlKind::DnxhrProfile => RateControl::DnxhrProfile(DnxhrProfile::Sq),
        RateControlKind::ConstantQuality => RateControl::ConstantQuality {
            quality: match adapter.codec() {
                VideoCodec::H264 => 18,
                VideoCodec::Hevc => 22,
                VideoCodec::Av1 => 30,
                VideoCodec::Prores | VideoCodec::Dnxhr => {
                    unreachable!("intermediate codecs use profile rate control")
                }
            },
        },
        RateControlKind::Bitrate => RateControl::Bitrate {
            target_bps: 1_000_000,
            mode: BitrateMode::Variable,
            // A capability probe asks "can this encoder run at all", so it uses
            // the least-constrained shape — a peak/buffer would narrow what the
            // probe proves without narrowing what the cache key covers.
            max_bps: None,
            buffer_bits: None,
        },
    };
    EncoderIntent {
        codec: adapter.codec(),
        bit_depth: capability.bit_depth,
        acceleration: if adapter.is_hardware() {
            Acceleration::Automatic
        } else {
            Acceleration::Software
        },
        rate_control,
        speed: Speed::Medium,
        gop_frames: 30,
        container: if matches!(adapter.codec(), VideoCodec::Prores | VideoCodec::Dnxhr) {
            OutputContainer::Mov
        } else {
            OutputContainer::Matroska
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Mutex as StdMutex;

    use super::*;

    struct FakeProbe {
        supported: HashSet<&'static str>,
        calls: StdMutex<Vec<&'static str>>,
    }

    impl FakeProbe {
        fn new(supported: &[&'static str]) -> Self {
            Self {
                supported: supported.iter().copied().collect(),
                calls: StdMutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl CapabilityProbe for FakeProbe {
        async fn probe(
            &self,
            adapter: AdapterId,
            _capability: CapabilityKey,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push(adapter.name());
            if self.supported.contains(adapter.name()) {
                Ok(())
            } else {
                Err("not installed or unusable".into())
            }
        }
    }

    fn delivery_intent(
        codec: VideoCodec,
        bit_depth: BitDepth,
        acceleration: Acceleration,
    ) -> EncoderIntent {
        EncoderIntent {
            codec,
            bit_depth,
            acceleration,
            rate_control: RateControl::Bitrate {
                target_bps: 8_000_000,
                mode: BitrateMode::Variable,
                max_bps: None,
                buffer_bits: None,
            },
            speed: Speed::Medium,
            gop_frames: 30,
            container: OutputContainer::Mp4,
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2)
            .any(|window| window[0] == flag && window[1] == value)
    }

    #[tokio::test]
    async fn automatic_prefers_the_first_working_platform_adapter() {
        let probe = Arc::new(FakeProbe::new(&["h264_qsv", "libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Windows, probe.clone());
        let plan = registry
            .resolve(delivery_intent(
                VideoCodec::H264,
                BitDepth::Eight,
                Acceleration::Automatic,
            ))
            .await
            .unwrap();

        assert_eq!(plan.encoder_name, "h264_qsv");
        assert_eq!(plan.acceleration, SelectedAcceleration::Hardware);
        assert_eq!(probe.calls(), vec!["h264_nvenc", "h264_qsv"]);
    }

    #[tokio::test]
    async fn software_av1_uses_a_probed_fallback_instead_of_an_assumed_name() {
        let probe = Arc::new(FakeProbe::new(&["libaom-av1"]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let plan = registry
            .resolve(delivery_intent(
                VideoCodec::Av1,
                BitDepth::Ten,
                Acceleration::Software,
            ))
            .await
            .unwrap();

        assert_eq!(plan.encoder_name, "libaom-av1");
        assert_eq!(probe.calls(), vec!["libsvtav1", "libaom-av1"]);
    }

    #[tokio::test]
    async fn all_missing_candidates_return_structured_attempts_and_are_cached() {
        let probe = Arc::new(FakeProbe::new(&[]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let intent = delivery_intent(VideoCodec::Av1, BitDepth::Eight, Acceleration::Software);

        let first = registry.resolve(intent).await.unwrap_err();
        let second = registry.resolve(intent).await.unwrap_err();
        assert_eq!(first, second);
        let EncodeUnavailable::NoCapableEncoder { attempts, .. } = first else {
            panic!("expected a capability failure")
        };
        assert_eq!(
            attempts
                .iter()
                .map(|attempt| attempt.adapter.as_str())
                .collect::<Vec<_>>(),
            vec!["libsvtav1", "libaom-av1"]
        );
        assert_eq!(probe.calls(), vec!["libsvtav1", "libaom-av1"]);
    }

    #[tokio::test]
    async fn constant_quality_automatic_intent_uses_a_software_adapter() {
        let probe = Arc::new(FakeProbe::new(&["h264_nvenc", "libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Windows, probe.clone());
        let mut intent =
            delivery_intent(VideoCodec::H264, BitDepth::Eight, Acceleration::Automatic);
        intent.rate_control = RateControl::ConstantQuality { quality: 18 };
        intent.speed = Speed::Slow;

        let plan = registry.resolve(intent).await.unwrap();
        let args = strings(&plan.ffmpeg_args);
        assert_eq!(plan.encoder_name, "libx264");
        assert_eq!(probe.calls(), vec!["libx264"]);
        assert!(has_pair(&args, "-crf", "18"));
        assert!(has_pair(&args, "-preset", "slow"));
        assert!(!args.iter().any(|value| value == "-b:v"));
    }

    // VBR with no user peak stays plain ABR: a bare `-b:v`, no ceiling and no
    // buffer. This is the shipped default for every existing project, so an
    // accidental derived ceiling here would silently re-rate all of them.
    #[tokio::test]
    async fn uncapped_vbr_emits_no_ceiling_or_buffer() {
        let probe = Arc::new(FakeProbe::new(&["libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let plan = registry
            .resolve(delivery_intent(
                VideoCodec::H264,
                BitDepth::Eight,
                Acceleration::Software,
            ))
            .await
            .unwrap();
        let args = strings(&plan.ffmpeg_args);
        assert!(has_pair(&args, "-b:v", "8000000"));
        assert!(!args.iter().any(|value| value == "-maxrate"));
        assert!(!args.iter().any(|value| value == "-minrate"));
        assert!(!args.iter().any(|value| value == "-bufsize"));
    }

    // A VBR peak caps the stream without flooring it: `-maxrate` + a derived
    // `-bufsize`, and NO `-minrate` (that would make it CBR).
    #[tokio::test]
    async fn vbr_peak_caps_without_flooring_and_derives_the_buffer() {
        let probe = Arc::new(FakeProbe::new(&["libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let mut intent = delivery_intent(VideoCodec::H264, BitDepth::Eight, Acceleration::Software);
        intent.rate_control = RateControl::Bitrate {
            target_bps: 8_000_000,
            mode: BitrateMode::Variable,
            max_bps: Some(12_000_000),
            buffer_bits: None,
        };

        let args = strings(&registry.resolve(intent).await.unwrap().ffmpeg_args);
        assert!(has_pair(&args, "-b:v", "8000000"));
        assert!(has_pair(&args, "-maxrate", "12000000"));
        assert!(has_pair(&args, "-bufsize", "24000000"));
        assert!(!args.iter().any(|value| value == "-minrate"));
    }

    // An explicit buffer wins over the 2×-ceiling derivation, under both modes.
    #[tokio::test]
    async fn explicit_buffer_overrides_the_derived_one() {
        let probe = Arc::new(FakeProbe::new(&["libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let mut vbr = delivery_intent(VideoCodec::H264, BitDepth::Eight, Acceleration::Software);
        vbr.rate_control = RateControl::Bitrate {
            target_bps: 8_000_000,
            mode: BitrateMode::Variable,
            max_bps: Some(12_000_000),
            buffer_bits: Some(6_000_000),
        };
        let mut cbr = vbr;
        cbr.rate_control = RateControl::Bitrate {
            target_bps: 8_000_000,
            mode: BitrateMode::Constant,
            max_bps: None,
            buffer_bits: Some(4_000_000),
        };

        let vbr_args = strings(&registry.resolve(vbr).await.unwrap().ffmpeg_args);
        let cbr_args = strings(&registry.resolve(cbr).await.unwrap().ffmpeg_args);
        assert!(has_pair(&vbr_args, "-bufsize", "6000000"));
        assert!(has_pair(&cbr_args, "-bufsize", "4000000"));
        // CBR still pins the ceiling to the target and floors the stream.
        assert!(has_pair(&cbr_args, "-maxrate", "8000000"));
        assert!(has_pair(&cbr_args, "-minrate", "8000000"));
    }

    // A stale VBR peak carried into CBR must not widen the ceiling: CBR's peak
    // IS its target, so `max_bps` is ignored rather than honored.
    #[tokio::test]
    async fn cbr_ignores_a_carried_over_peak() {
        let probe = Arc::new(FakeProbe::new(&["libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let mut intent = delivery_intent(VideoCodec::H264, BitDepth::Eight, Acceleration::Software);
        intent.rate_control = RateControl::Bitrate {
            target_bps: 8_000_000,
            mode: BitrateMode::Constant,
            max_bps: Some(20_000_000),
            buffer_bits: None,
        };

        let args = strings(&registry.resolve(intent).await.unwrap().ffmpeg_args);
        assert!(has_pair(&args, "-maxrate", "8000000"));
        assert!(has_pair(&args, "-minrate", "8000000"));
        assert!(has_pair(&args, "-bufsize", "16000000"));
    }

    // A ceiling below the average is unsatisfiable — the encoder would abandon
    // the average silently. Rejected before any probe runs.
    #[tokio::test]
    async fn a_peak_below_the_target_is_rejected() {
        let probe = Arc::new(FakeProbe::new(&["libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let mut intent = delivery_intent(VideoCodec::H264, BitDepth::Eight, Acceleration::Software);
        intent.rate_control = RateControl::Bitrate {
            target_bps: 8_000_000,
            mode: BitrateMode::Variable,
            max_bps: Some(4_000_000),
            buffer_bits: None,
        };

        let err = registry.resolve(intent).await.unwrap_err();
        let EncodeUnavailable::InvalidIntent { field, .. } = err else {
            panic!("expected an invalid-intent rejection")
        };
        assert_eq!(field, "maxBitrate");
    }

    // The peak/buffer belong to the Bitrate variant, so CRF mode cannot carry
    // one at all — and constant quality keeps emitting no rate args.
    #[tokio::test]
    async fn constant_quality_emits_no_rate_constraint_args() {
        let probe = Arc::new(FakeProbe::new(&["libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let mut intent = delivery_intent(VideoCodec::H264, BitDepth::Eight, Acceleration::Software);
        intent.rate_control = RateControl::ConstantQuality { quality: 20 };

        let args = strings(&registry.resolve(intent).await.unwrap().ffmpeg_args);
        assert!(has_pair(&args, "-crf", "20"));
        assert!(!args.iter().any(|value| value == "-maxrate"));
        assert!(!args.iter().any(|value| value == "-bufsize"));
    }

    #[tokio::test]
    async fn cached_selection_rebuilds_the_plan_for_each_intent() {
        let probe = Arc::new(FakeProbe::new(&["libx264"]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let mut first = delivery_intent(VideoCodec::H264, BitDepth::Eight, Acceleration::Software);
        first.speed = Speed::Fast;
        let mut second = first;
        second.speed = Speed::Slow;
        second.rate_control = RateControl::Bitrate {
            target_bps: 4_000_000,
            mode: BitrateMode::Constant,
            max_bps: None,
            buffer_bits: None,
        };

        let first_plan = registry.resolve(first).await.unwrap();
        let second_plan = registry.resolve(second).await.unwrap();
        let first_args = strings(&first_plan.ffmpeg_args);
        let second_args = strings(&second_plan.ffmpeg_args);
        assert!(has_pair(&first_args, "-preset", "fast"));
        assert!(has_pair(&second_args, "-preset", "slow"));
        assert!(has_pair(&second_args, "-maxrate", "4000000"));
        assert_eq!(probe.calls(), vec!["libx264"]);
    }

    #[tokio::test]
    async fn intermediate_encoders_are_probed_and_profile_mapped() {
        let probe = Arc::new(FakeProbe::new(&["prores_ks"]));
        let registry = EncoderRegistry::with_probe(Platform::Macos, probe.clone());
        let intent = EncoderIntent {
            codec: VideoCodec::Prores,
            bit_depth: BitDepth::Ten,
            acceleration: Acceleration::Automatic,
            rate_control: RateControl::ProresProfile(ProresProfile::Hq),
            speed: Speed::Medium,
            gop_frames: 30,
            container: OutputContainer::Mov,
        };

        let plan = registry.resolve(intent).await.unwrap();
        let args = strings(&plan.ffmpeg_args);
        assert_eq!(probe.calls(), vec!["prores_ks"]);
        assert!(has_pair(&args, "-profile:v", "3"));
        assert!(has_pair(&args, "-pix_fmt", "yuv422p10le"));
        assert!(!args.iter().any(|value| value == "-b:v" || value == "-g"));
    }

    #[tokio::test]
    async fn missing_intermediate_library_is_not_assumed() {
        let probe = Arc::new(FakeProbe::new(&[]));
        let registry = EncoderRegistry::with_probe(Platform::Macos, probe.clone());
        let intent = EncoderIntent {
            codec: VideoCodec::Dnxhr,
            bit_depth: BitDepth::Eight,
            acceleration: Acceleration::Automatic,
            rate_control: RateControl::DnxhrProfile(DnxhrProfile::Sq),
            speed: Speed::Medium,
            gop_frames: 30,
            container: OutputContainer::Mov,
        };

        let error = registry.resolve(intent).await.unwrap_err();
        let EncodeUnavailable::NoCapableEncoder { attempts, .. } = error else {
            panic!("expected a capability failure")
        };
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].adapter, "dnxhd");
        assert_eq!(probe.calls(), vec!["dnxhd"]);
    }

    #[tokio::test]
    async fn per_adapter_arguments_live_in_the_resolved_plan() {
        let mut x265 = delivery_intent(VideoCodec::Hevc, BitDepth::Ten, Acceleration::Software);
        x265.rate_control = RateControl::ConstantQuality { quality: 22 };
        let x265_registry =
            EncoderRegistry::with_probe(Platform::Linux, Arc::new(FakeProbe::new(&["libx265"])));
        let x265_args = strings(&x265_registry.resolve(x265).await.unwrap().ffmpeg_args);
        assert!(has_pair(&x265_args, "-pix_fmt", "yuv420p10le"));
        assert!(has_pair(&x265_args, "-profile:v", "main10"));
        assert!(has_pair(&x265_args, "-tag:v", "hvc1"));

        let mut aom = delivery_intent(VideoCodec::Av1, BitDepth::Ten, Acceleration::Software);
        aom.rate_control = RateControl::ConstantQuality { quality: 30 };
        let aom_registry = EncoderRegistry::with_probe(
            Platform::Windows,
            Arc::new(FakeProbe::new(&["libaom-av1"])),
        );
        let aom_args = strings(&aom_registry.resolve(aom).await.unwrap().ffmpeg_args);
        assert!(has_pair(&aom_args, "-b:v", "0"));
        assert!(has_pair(&aom_args, "-cpu-used", "6"));
        assert!(has_pair(&aom_args, "-row-mt", "1"));
        assert!(!aom_args.iter().any(|value| value == "-preset"));
    }

    #[tokio::test]
    async fn invalid_combinations_fail_before_adapter_selection() {
        let probe = Arc::new(FakeProbe::new(&[]));
        let registry = EncoderRegistry::with_probe(Platform::Linux, probe.clone());
        let h264_10 = delivery_intent(VideoCodec::H264, BitDepth::Ten, Acceleration::Software);
        assert!(matches!(
            registry.resolve(h264_10).await,
            Err(EncodeUnavailable::InvalidIntent { ref field, .. }) if field == "bitDepth"
        ));

        let mut av1_mov = delivery_intent(VideoCodec::Av1, BitDepth::Eight, Acceleration::Software);
        av1_mov.container = OutputContainer::Mov;
        assert!(matches!(
            registry.resolve(av1_mov).await,
            Err(EncodeUnavailable::InvalidIntent { ref field, .. }) if field == "container"
        ));
        assert!(probe.calls().is_empty());
    }
}
