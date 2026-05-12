//! Content-addressable cache layout for media derivatives — proxies,
//! thumbnails, waveforms, on-demand extracted frames.
//!
//! Lives in the OS app-cache directory rather than per-`.vproj` (data-model.md
//! "On-disk format" originally specified the latter). Rationale: derivatives
//! are content-addressed by `file_hash_blake3`; the same imported file across
//! two projects hits the same cache entry, and re-imports of an unchanged
//! file (mtime same, content same) skip work entirely. Per-project caches
//! would duplicate that work. Per-`.vproj` mirroring is a future polish move
//! when "consolidate to project folder" lands; the layout below stays
//! identical so it's a copy, not a rewrite.
//!
//! Atomicity: every writer must write to `<final>.tmp` then rename. Skip-if-
//! cached checks must verify both `exists()` AND non-zero size — interrupted
//! ffmpeg leaves zero-byte files that look "done" to a naive check.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct CacheLayout {
    root: PathBuf,
}

impl CacheLayout {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn proxies_dir(&self) -> PathBuf {
        self.root.join("proxies")
    }

    pub fn thumbnails_root(&self) -> PathBuf {
        self.root.join("thumbnails")
    }

    pub fn waveforms_dir(&self) -> PathBuf {
        self.root.join("waveforms")
    }

    pub fn frames_root(&self) -> PathBuf {
        self.root.join("frames")
    }

    /// Materialized inline-subtitle bodies (`SubtitlesSource::InlineSrt` /
    /// `InlineAss`). Hash-addressed by blake3 of the body so identical text
    /// in two projects (or the same project across reloads) hits the same
    /// file. Lifetime is the cache lifetime — never deleted by the
    /// materialization pass; user can wipe via "Clear cache".
    pub fn inline_subs_dir(&self) -> PathBuf {
        self.root.join("inline-subs")
    }

    pub fn inline_subs(&self, hash: &str, ext: &str) -> PathBuf {
        self.inline_subs_dir().join(format!("{hash}.{ext}"))
    }

    /// MP4 proxy for a hashed media file.
    pub fn proxy(&self, hash: &str) -> PathBuf {
        self.proxies_dir().join(format!("{hash}.mp4"))
    }

    /// Per-media thumbnail directory; individual thumbnails sit inside as
    /// `000.jpg`, `001.jpg`, ...
    pub fn thumbnails(&self, hash: &str) -> PathBuf {
        self.thumbnails_root().join(hash)
    }

    pub fn thumbnail(&self, hash: &str, idx: usize) -> PathBuf {
        self.thumbnails(hash).join(format!("{idx:03}.jpg"))
    }

    /// Audio peaks file. Format: little-endian f32 samples, one per peak window.
    /// See `jobs::waveform` for the window size + header convention.
    pub fn waveform(&self, hash: &str) -> PathBuf {
        self.waveforms_dir().join(format!("{hash}.peaks"))
    }

    /// On-demand extracted frame, lazy-cached. Used by
    /// `media://{id}/frame/{t_us}` MCP resource.
    pub fn frames(&self, hash: &str) -> PathBuf {
        self.frames_root().join(hash)
    }

    pub fn frame(&self, hash: &str, t_us: i64) -> PathBuf {
        self.frames(hash).join(format!("{t_us}.jpg"))
    }

    /// Audio slices extracted for cloud transcription (mono 16 kHz WAV).
    /// Hash composition is `blake3([source_hash_bytes, in_us.to_le_bytes(),
    /// out_us.to_le_bytes()].concat())` — see `cloud::audio_extract`.
    pub fn transcribe_audio_dir(&self) -> PathBuf {
        self.root.join("transcribe-audio")
    }

    pub fn transcribe_audio(&self, hash: &str) -> PathBuf {
        self.transcribe_audio_dir().join(format!("{hash}.wav"))
    }

    /// Synthesized TTS output. Content-addressed by `blake3(model || '\0' ||
    /// voice || '\0' || speed || '\0' || text)` so repeated requests with the
    /// same parameters skip the API call entirely — see
    /// `cloud::providers::openai::tts_cache_key` and the `synthesize_speech`
    /// MCP tool.
    pub fn voiceover_dir(&self) -> PathBuf {
        self.root.join("voiceover")
    }

    pub fn voiceover(&self, hash: &str, ext: &str) -> PathBuf {
        self.voiceover_dir().join(format!("{hash}.{ext}"))
    }

    /// Per-render PNG sequence directory for the rasterizer. Content-addressed
    /// by blake3 of the canonical render inputs — see `raster::cache_key`. A
    /// hit means we already have every frame on disk and can skip the
    /// expensive webview rasterization entirely.
    pub fn raster_root(&self) -> PathBuf {
        self.root.join("raster")
    }

    pub fn raster_dir(&self, key: &str) -> PathBuf {
        self.raster_root().join(key)
    }

    /// Create the top-level cache directory tree. Idempotent.
    pub fn ensure_dirs(&self) -> Result<()> {
        for p in [
            self.root.clone(),
            self.proxies_dir(),
            self.thumbnails_root(),
            self.waveforms_dir(),
            self.frames_root(),
            self.inline_subs_dir(),
            self.transcribe_audio_dir(),
            self.voiceover_dir(),
            self.raster_root(),
        ] {
            fs::create_dir_all(&p)
                .with_context(|| format!("create cache dir {}", p.display()))?;
        }
        Ok(())
    }
}

/// True when the path exists and is non-zero size — the right "skip if cached"
/// predicate. Naive `exists()` will return true for an interrupted-ffmpeg
/// zero-byte file, which a worker would then skip and leave broken.
pub fn cached_ok(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Atomic write helper: write into `<dest>.tmp` then rename onto `dest`. Caller
/// supplies the writer function that produces the temp file (e.g. an ffmpeg
/// invocation pointed at the temp path). On error, removes the partial temp
/// file before bubbling up.
pub fn temp_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

/// Promote a successfully-written `<dest>.tmp` to `dest`. The caller is
/// responsible for ensuring the temp file is fully flushed to disk before
/// calling — `tokio::process::Child` waits already cover that.
pub fn promote_temp(dest: &Path) -> Result<()> {
    let tmp = temp_path(dest);
    fs::rename(&tmp, dest)
        .with_context(|| format!("promote {} -> {}", tmp.display(), dest.display()))
}

/// Best-effort cleanup of a `<dest>.tmp` that was never promoted. Used in the
/// error path of a job. Ignores file-not-found.
pub fn discard_temp(dest: &Path) {
    let tmp = temp_path(dest);
    let _ = fs::remove_file(tmp);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn layout_paths_are_content_addressable() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().to_path_buf());
        assert_eq!(
            layout.proxy("abc"),
            tmp.path().join("proxies").join("abc.mp4"),
        );
        assert_eq!(
            layout.thumbnail("abc", 5),
            tmp.path().join("thumbnails").join("abc").join("005.jpg"),
        );
        assert_eq!(
            layout.waveform("abc"),
            tmp.path().join("waveforms").join("abc.peaks"),
        );
        assert_eq!(
            layout.frame("abc", 1_500_000),
            tmp.path().join("frames").join("abc").join("1500000.jpg"),
        );
        assert_eq!(
            layout.transcribe_audio("abc"),
            tmp.path().join("transcribe-audio").join("abc.wav"),
        );
        assert_eq!(
            layout.voiceover("abc", "mp3"),
            tmp.path().join("voiceover").join("abc.mp3"),
        );
    }

    #[test]
    fn ensure_dirs_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().join("nested"));
        layout.ensure_dirs().unwrap();
        layout.ensure_dirs().unwrap(); // second call is a no-op
        assert!(layout.proxies_dir().is_dir());
        assert!(layout.thumbnails_root().is_dir());
        assert!(layout.waveforms_dir().is_dir());
        assert!(layout.frames_root().is_dir());
        assert!(layout.inline_subs_dir().is_dir());
        assert!(layout.transcribe_audio_dir().is_dir());
        assert!(layout.voiceover_dir().is_dir());
    }

    #[test]
    fn inline_subs_path_includes_extension() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().to_path_buf());
        assert_eq!(
            layout.inline_subs("abc", "srt"),
            tmp.path().join("inline-subs").join("abc.srt"),
        );
        assert_eq!(
            layout.inline_subs("abc", "ass"),
            tmp.path().join("inline-subs").join("abc.ass"),
        );
    }

    #[test]
    fn cached_ok_rejects_zero_byte_files() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("partial.mp4");
        fs::write(&path, b"").unwrap(); // simulate interrupted ffmpeg
        assert!(!cached_ok(&path));
        fs::write(&path, b"x").unwrap();
        assert!(cached_ok(&path));
    }

    #[test]
    fn cached_ok_rejects_missing_files() {
        let tmp = TempDir::new().unwrap();
        assert!(!cached_ok(&tmp.path().join("nope.mp4")));
    }

    #[test]
    fn promote_and_discard_temp() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("out.mp4");
        let temp = temp_path(&dest);
        fs::write(&temp, b"data").unwrap();
        promote_temp(&dest).unwrap();
        assert!(dest.is_file());
        assert!(!temp.exists());

        // discard_temp on a fresh round
        let dest2 = tmp.path().join("out2.mp4");
        let temp2 = temp_path(&dest2);
        fs::write(&temp2, b"partial").unwrap();
        discard_temp(&dest2);
        assert!(!temp2.exists());
        // discard on missing is fine
        discard_temp(&dest2);
    }
}
