//! `SceneDescriber` capability surface — a set of timed frames in, a
//! format-tagged [`RawDescription`](super::parser::RawDescription) out.
//!
//! Twin of [`speech::transcriber`](crate::speech): the trait is deliberately
//! thin (a backend produces one raw output style, it does NOT normalize —
//! normalization is [`super::parser`]) and `Send + Sync + dyn`-compatible so the
//! resolver hands back a `Box<dyn SceneDescriber>` regardless of backend.
//!
//! **Input contract = a set of timed frames, not a video file.** The tool layer
//! samples frames from the source at `fps`, attaches each frame's window-relative
//! timestamp, and hands the same [`TimedFrame`] list to every backend (local
//! sidecar, BYO endpoint, cloud) — the per-backend adapter presents them the way
//! that engine expects. Keeping timestamps window-relative (0-based) here mirrors
//! how [`speech`](crate::speech) parsers emit slice-relative times and the tool
//! shifts onto the timeline; here the tool shifts onto source-absolute time.

use std::path::PathBuf;

use async_trait::async_trait;

use super::error::VlmError;
use super::parser::RawDescription;

/// One sampled frame: its window-relative timestamp (0 = start of the requested
/// window) and the on-disk image the backend feeds to the model. The local
/// sidecar passes the path to `--image`; the HTTP backends read the file and
/// base64-encode it into an `image_url` content part.
#[derive(Debug, Clone)]
pub struct TimedFrame {
    /// Window-relative microseconds (0-based). The prompt renders this as
    /// `Frame at <t>s:` — the plain-text time signal Qwen3-VL / MiniCPM-V honor
    /// verbatim (ticket 06 spike). The parser echoes these back; the tool shifts
    /// them by the source-window start to reach source-absolute time.
    pub t_us: i64,
    /// Extracted still (PNG) for this timestamp.
    pub path: PathBuf,
}

/// Which prompt template to use — selects what the model is asked to emphasize
/// and, therefore, what populates `tags`. Part of the cache key (a different
/// focus is a different description). `General` is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    /// General timeline description (subjects, setting, action, shot type).
    General,
    /// Camera / shot-type emphasis — biases `tags` toward shot type, camera
    /// motion, framing.
    ShotType,
}

impl Focus {
    /// Stable key fragment (part of the description cache key).
    pub fn as_str(self) -> &'static str {
        match self {
            Focus::General => "general",
            Focus::ShotType => "shot-type",
        }
    }

    /// Parse the tool's optional `focus` arg; unknown / absent → `General`.
    pub fn parse(s: Option<&str>) -> Focus {
        match s {
            Some("shot-type") | Some("shot_type") | Some("shot") => Focus::ShotType,
            _ => Focus::General,
        }
    }
}

/// A fully-specified describe request: the sampled frames + the prompt focus.
#[derive(Debug, Clone)]
pub struct DescribeRequest {
    pub frames: Vec<TimedFrame>,
    pub focus: Focus,
}

#[async_trait]
pub trait SceneDescriber: Send + Sync {
    /// Describe the request's frames and return one raw output style. Which
    /// style (which [`RawDescription`] variant) is the backend's choice — the
    /// parser layer normalizes it.
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError>;
}
