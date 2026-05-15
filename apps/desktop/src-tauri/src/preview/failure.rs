//! Per-segment render failure classification (Phase A3).
//!
//! ffmpeg returns "non-zero exit" for everything from a transient GPU
//! contention up to a permanent filter-graph syntax error. The orchestrator
//! needs to know WHICH so it can decide between auto-retry, surfacing
//! immediately, or pausing the entire queue (disk full).
//!
//! Classification is heuristic — reads stderr substrings against a curated
//! list. We default unknown patterns to `Transient` so the auto-retry
//! catches a one-shot flake; only patterns we've seen recur land in the
//! deterministic buckets.
//!
//! Per the design doc decision rules:
//!   * `Transient` → auto-retry once after 2s backoff
//!   * `HwEncoderRejected` → auto-retry once with SW encoder forced
//!   * `SourceMissing` → surface immediately (user must relink media)
//!   * `DiskFull` → pause the entire queue + show banner (A5)
//!   * `Unrecoverable` → surface immediately, no retry

use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SegmentFailureKind {
    /// ffmpeg crashed for an unclassified reason. Race, resource pressure,
    /// or a pattern we haven't catalogued yet. Auto-retry once.
    Transient,
    /// HW encoder rejected the job. Auto-retry once with software encoder.
    HwEncoderRejected,
    /// A referenced source file is missing. User must relink media.
    SourceMissing { path: PathBuf },
    /// Cache disk full. Pause the queue.
    DiskFull,
    /// Filter graph invalid, drawtext font missing, etc. Bug or env
    /// issue; not retryable.
    Unrecoverable { detail: String },
}

impl SegmentFailureKind {
    /// Should the orchestrator auto-retry this failure once?
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Transient | Self::HwEncoderRejected)
    }
}

/// Read ffmpeg stderr and decide the failure class. Pattern matching is
/// case-insensitive. The first matching pattern wins.
pub fn classify(stderr: &str) -> SegmentFailureKind {
    let s = stderr.to_lowercase();

    // Disk-full: take this BEFORE source-missing because "No space left
    // on device" sometimes appears alongside file-not-found noise from
    // ffmpeg's tmp-file probe.
    if s.contains("no space left") || s.contains("disk full") || s.contains("enospc") {
        return SegmentFailureKind::DiskFull;
    }

    // Source media missing. ffmpeg messages vary by platform.
    if s.contains("no such file or directory")
        || s.contains("does not exist")
        || s.contains("error opening input")
    {
        return SegmentFailureKind::SourceMissing {
            path: extract_path_from_stderr(stderr).unwrap_or_default(),
        };
    }

    // HW encoder rejections. Pattern is `<codec>` + an error indicator.
    if s.contains("h264_nvenc") || s.contains("nvenc") {
        if s.contains("no capable devices")
            || s.contains("encoder not found")
            || s.contains("driver does not support")
            || s.contains("session limit")
        {
            return SegmentFailureKind::HwEncoderRejected;
        }
    }
    if s.contains("h264_qsv") && (s.contains("error") || s.contains("failed")) {
        return SegmentFailureKind::HwEncoderRejected;
    }
    if s.contains("h264_amf") && (s.contains("error") || s.contains("failed")) {
        return SegmentFailureKind::HwEncoderRejected;
    }
    if s.contains("h264_videotoolbox")
        && (s.contains("error") || s.contains("failed"))
    {
        return SegmentFailureKind::HwEncoderRejected;
    }
    if s.contains("h264_vaapi") && (s.contains("error") || s.contains("failed")) {
        return SegmentFailureKind::HwEncoderRejected;
    }

    // Known unrecoverable patterns. Caught by our own emit smoke tests
    // when the bug shipped, kept here so any regression surfaces with a
    // clear classification instead of pretending to be transient.
    if s.contains("trailing garbage after a filter") {
        return SegmentFailureKind::Unrecoverable {
            detail: "filter graph syntax error (missing ';' between clauses?)".into(),
        };
    }
    if s.contains("fontconfig error") || s.contains("cannot find font") {
        return SegmentFailureKind::Unrecoverable {
            detail: "fontconfig / drawtext font lookup failed".into(),
        };
    }
    if s.contains("invalid argument") && s.contains("filter") {
        return SegmentFailureKind::Unrecoverable {
            detail: "filter argument invalid".into(),
        };
    }
    if s.contains("unrecognized option") {
        return SegmentFailureKind::Unrecoverable {
            detail: "ffmpeg flag not recognized — version mismatch?".into(),
        };
    }

    // Default: assume retryable transient.
    SegmentFailureKind::Transient
}

/// Best-effort path extraction from a ffmpeg "No such file or directory"
/// message. ffmpeg formats this as `[in#0] Error opening input file
/// '<path>'.` on recent builds, or as `<path>: No such file or directory`
/// on older ones. If we can't pull a path out, the caller falls back to
/// an empty `PathBuf` and the user gets a generic missing-media message.
fn extract_path_from_stderr(stderr: &str) -> Option<PathBuf> {
    // Try modern-ffmpeg format first: text inside single quotes after
    // "input file" or "Error opening input".
    for needle in ["error opening input file '", "input file '"] {
        if let Some(start) = stderr.to_lowercase().find(needle) {
            let after = &stderr[start + needle.len()..];
            if let Some(end) = after.find('\'') {
                return Some(PathBuf::from(&after[..end]));
            }
        }
    }
    // Older format: `<path>: No such file or directory`
    if let Some(line) = stderr
        .lines()
        .find(|l| l.to_lowercase().contains("no such file"))
    {
        if let Some(colon) = line.find(':') {
            let candidate = line[..colon].trim();
            if !candidate.is_empty() && candidate.contains('/') || candidate.contains('\\') {
                return Some(PathBuf::from(candidate));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_disk_full() {
        assert_eq!(
            classify("av_interleaved_write_frame(): No space left on device"),
            SegmentFailureKind::DiskFull,
        );
        assert_eq!(
            classify("Error: ENOSPC writing output"),
            SegmentFailureKind::DiskFull,
        );
    }

    #[test]
    fn classify_source_missing_modern_format() {
        let stderr = "[in#0/mp4 @ 0x55] Error opening input file '/m/missing.mp4'.\n\
                      Error opening input: No such file or directory";
        match classify(stderr) {
            SegmentFailureKind::SourceMissing { path } => {
                assert_eq!(path, PathBuf::from("/m/missing.mp4"));
            }
            other => panic!("expected SourceMissing, got {other:?}"),
        }
    }

    #[test]
    fn classify_source_missing_no_extractable_path_still_classifies() {
        // Stderr says missing but we can't extract a path. Should still
        // classify as SourceMissing (empty path is OK).
        let stderr = "blah blah does not exist blah";
        assert!(matches!(
            classify(stderr),
            SegmentFailureKind::SourceMissing { .. }
        ));
    }

    #[test]
    fn classify_nvenc_session_limit() {
        let stderr =
            "[h264_nvenc @ 0x55] OpenEncodeSessionEx failed: out of memory (10): \
             Session limit reached.\nError initializing output stream";
        assert_eq!(classify(stderr), SegmentFailureKind::HwEncoderRejected);
    }

    #[test]
    fn classify_nvenc_no_capable_devices() {
        let stderr =
            "[h264_nvenc @ 0x55] No capable devices found\n\
             Error initializing output stream 0:0";
        assert_eq!(classify(stderr), SegmentFailureKind::HwEncoderRejected);
    }

    #[test]
    fn classify_qsv_error() {
        let stderr = "[h264_qsv @ 0x55] Error allocating frames: -3 (Memory error)";
        assert_eq!(classify(stderr), SegmentFailureKind::HwEncoderRejected);
    }

    #[test]
    fn classify_filter_graph_syntax_unrecoverable() {
        // This is the exact bug shape that broke export in Phase 1.12 (see
        // `feedback_emit_smoke_tests` memory). If it ever returns, we
        // want it classified deterministically — NOT as a transient that
        // wastes a retry.
        let stderr = "[Parsed_color_0 @ 0x55] Trailing garbage after a filter: 'color=...'";
        match classify(stderr) {
            SegmentFailureKind::Unrecoverable { detail } => {
                assert!(detail.contains("filter graph"));
            }
            other => panic!("expected Unrecoverable, got {other:?}"),
        }
    }

    #[test]
    fn classify_fontconfig_unrecoverable() {
        let stderr = "Fontconfig error: Cannot load default config file";
        assert!(matches!(
            classify(stderr),
            SegmentFailureKind::Unrecoverable { .. }
        ));
    }

    #[test]
    fn unknown_stderr_defaults_to_transient() {
        // The auto-retry catch-all. A pattern we haven't seen gets one
        // free retry; persistent failures surface as Transient (not
        // perfect, but better than failing fast on flakes).
        let stderr = "Some never-before-seen ffmpeg failure";
        assert_eq!(classify(stderr), SegmentFailureKind::Transient);
    }

    #[test]
    fn is_retryable_classifications() {
        assert!(SegmentFailureKind::Transient.is_retryable());
        assert!(SegmentFailureKind::HwEncoderRejected.is_retryable());
        assert!(!SegmentFailureKind::DiskFull.is_retryable());
        assert!(!SegmentFailureKind::SourceMissing {
            path: PathBuf::new()
        }
        .is_retryable());
        assert!(!SegmentFailureKind::Unrecoverable {
            detail: "x".into()
        }
        .is_retryable());
    }
}
