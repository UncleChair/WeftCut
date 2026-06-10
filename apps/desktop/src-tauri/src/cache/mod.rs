//! Content-addressable cache layout for media derivatives — proxies,
//! thumbnails, waveforms, on-demand extracted frames.
//!
//! **Per `docs/data-model.md`** (decision Q3), the cache is now
//! rooted at `<workspace>/Cache/`. At app boot, before any workspace is
//! opened or saved, `CacheLayout` points at the OS app-cache as a
//! transitional fallback. When `project_save_as` or `project_open` lands,
//! `set_workspace()` re-points the layout at the workspace's `Cache/` dir.
//! Interior mutability via `RwLock<PathBuf>` lets consumers keep their
//! existing `State<CacheLayout>` signatures while the root underneath
//! moves; reads clone the current root each time, so the cost is one
//! lock-acquire-and-clone per `proxies_dir()` / `thumbnail()` / ... call.
//!
//! Atomicity: every writer must write to `<final>.tmp` then rename. Skip-if-
//! cached checks must verify both `exists()` AND non-zero size — interrupted
//! ffmpeg leaves zero-byte files that look "done" to a naive check.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct CacheLayout {
    /// Current cache root. Swapped by `set_workspace` when the user opens or
    /// saves a project to a folder. Reads clone-by-value; never hand out a
    /// borrowed reference to the locked value or callers will deadlock on
    /// the next swap.
    root: Arc<RwLock<PathBuf>>,
}

impl CacheLayout {
    /// Construct a layout rooted at `root`. Use this for the OS app-cache
    /// fallback at boot. `set_workspace` re-points at a workspace folder
    /// the first time a project is opened or saved.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Arc::new(RwLock::new(root)),
        }
    }

    /// Swap the cache root to `<workspace>/Cache/` and create the dir tree
    /// at the new location. Idempotent: calling with the same workspace
    /// twice does nothing extra. Per workspace-redesign Q3 this fires on
    /// every `project_save_as` / `project_open`.
    pub fn set_workspace(&self, workspace_root: &Path) -> Result<()> {
        let new_root = workspace_root.join("Cache");
        {
            let mut guard = self.root.write().expect("cache root lock poisoned");
            if *guard == new_root {
                return Ok(());
            }
            *guard = new_root;
        }
        self.ensure_dirs()
    }

    fn current_root(&self) -> PathBuf {
        self.root.read().expect("cache root lock poisoned").clone()
    }

    /// Current cache root, cloned by value. Callers that need to compose
    /// further paths under the root should still prefer the typed methods
    /// (`proxies_dir`, etc.) rather than reaching for `root()`.
    pub fn root(&self) -> PathBuf {
        self.current_root()
    }

    pub fn proxies_dir(&self) -> PathBuf {
        self.current_root().join("proxies")
    }

    pub fn thumbnails_root(&self) -> PathBuf {
        self.current_root().join("thumbnails")
    }

    pub fn waveforms_dir(&self) -> PathBuf {
        self.current_root().join("waveforms")
    }

    pub fn frames_root(&self) -> PathBuf {
        self.current_root().join("frames")
    }

    /// Materialized inline-subtitle bodies (`SubtitlesSource::InlineSrt` /
    /// `InlineAss`). Hash-addressed by blake3 of the body so identical text
    /// in two projects (or the same project across reloads) hits the same
    /// file. Lifetime is the cache lifetime — never deleted by the
    /// materialization pass; user can wipe via "Clear cache".
    pub fn inline_subs_dir(&self) -> PathBuf {
        self.current_root().join("inline-subs")
    }

    pub fn inline_subs(&self, hash: &str, ext: &str) -> PathBuf {
        self.inline_subs_dir().join(format!("{hash}.{ext}"))
    }

    /// MP4 proxy for a hashed media file.
    pub fn proxy(&self, hash: &str) -> PathBuf {
        self.proxies_dir().join(format!("{hash}.mp4"))
    }

    /// Fast preview-first proxy for a hashed media file. The `q3` segment is
    /// the recipe version — bumped when the quick-proxy ffmpeg args change
    /// (540p → 720p was q2; q3 switches to a short scrub GOP, ADR 0008) so
    /// stale cached proxies are regenerated, not reused.
    pub fn quick_proxy(&self, hash: &str) -> PathBuf {
        self.proxies_dir().join(format!("{hash}.quick-q3.mp4"))
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

    /// Canonical conformed PCM for a hashed media file — 48 kHz, f32le,
    /// interleaved, ≤2 channels. See `jobs::conform` for the header format.
    pub fn audio_conform_dir(&self) -> PathBuf {
        self.current_root().join("audio")
    }

    pub fn audio_conform(&self, hash: &str) -> PathBuf {
        self.audio_conform_dir().join(format!("{hash}.conform"))
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
        self.current_root().join("transcribe-audio")
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
        self.current_root().join("voiceover")
    }

    pub fn voiceover(&self, hash: &str, ext: &str) -> PathBuf {
        self.voiceover_dir().join(format!("{hash}.{ext}"))
    }

    /// Create the top-level cache directory tree. Idempotent. Called
    /// implicitly by `set_workspace`; the boot fallback also calls it once.
    ///
    /// `Cache/preview/` and `Cache/raster/` are intentionally NOT created —
    /// the cached + segmented preview paths and the offscreen-webview
    /// rasterizer were deleted in preview-dom Phase F and pixi-renderer
    /// P12-c respectively. Existing workspaces may have orphan trees from
    /// a prior version; they're left in place rather than auto-deleted so
    /// a user reverting to an older build keeps their cache.
    pub fn ensure_dirs(&self) -> Result<()> {
        let root = self.current_root();
        for p in [
            root.clone(),
            self.proxies_dir(),
            self.thumbnails_root(),
            self.waveforms_dir(),
            self.audio_conform_dir(),
            self.frames_root(),
            self.inline_subs_dir(),
            self.transcribe_audio_dir(),
            self.voiceover_dir(),
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

/// Rename derivative artifacts keyed by `old_hash` to `new_hash`. Used when
/// import finishes hashing after derivative jobs started against a temporary
/// `pending-{media_id}` cache key. Missing entries are ignored.
pub fn migrate_hash_artifacts(cache: &CacheLayout, old_hash: &str, new_hash: &str) -> Result<()> {
    if old_hash == new_hash {
        return Ok(());
    }

    let rename_file = |from: PathBuf, to: PathBuf| -> Result<()> {
        if !from.is_file() {
            return Ok(());
        }
        if to.is_file() {
            let _ = fs::remove_file(&from);
            return Ok(());
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        fs::rename(&from, &to).with_context(|| {
            format!(
                "migrate cache {} -> {}",
                from.display(),
                to.display()
            )
        })
    };

    let rename_dir = |from: PathBuf, to: PathBuf| -> Result<()> {
        if !from.is_dir() {
            return Ok(());
        }
        if to.exists() {
            let _ = fs::remove_dir_all(&from);
            return Ok(());
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        fs::rename(&from, &to).with_context(|| {
            format!(
                "migrate cache dir {} -> {}",
                from.display(),
                to.display()
            )
        })
    };

    rename_file(cache.proxy(old_hash), cache.proxy(new_hash))?;
    rename_file(cache.quick_proxy(old_hash), cache.quick_proxy(new_hash))?;
    rename_dir(cache.thumbnails(old_hash), cache.thumbnails(new_hash))?;
    rename_file(cache.waveform(old_hash), cache.waveform(new_hash))?;
    rename_file(cache.audio_conform(old_hash), cache.audio_conform(new_hash))?;
    rename_dir(cache.frames(old_hash), cache.frames(new_hash))?;

    Ok(())
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
            layout.quick_proxy("abc"),
            tmp.path().join("proxies").join("abc.quick-q3.mp4"),
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
            layout.audio_conform("abc"),
            tmp.path().join("audio").join("abc.conform"),
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
        assert!(layout.audio_conform_dir().is_dir());
        assert!(layout.frames_root().is_dir());
        assert!(layout.inline_subs_dir().is_dir());
        assert!(layout.transcribe_audio_dir().is_dir());
        assert!(layout.voiceover_dir().is_dir());
    }

    #[test]
    fn set_workspace_swaps_root_and_creates_dirs() {
        // Boot fallback: layout points at an OS-app-cache-ish location.
        let boot = TempDir::new().unwrap();
        let layout = CacheLayout::new(boot.path().to_path_buf());
        assert_eq!(layout.proxies_dir(), boot.path().join("proxies"));

        // User opens a workspace; cache moves under `<workspace>/Cache/`.
        let ws = TempDir::new().unwrap();
        layout.set_workspace(ws.path()).unwrap();
        assert_eq!(
            layout.proxies_dir(),
            ws.path().join("Cache").join("proxies"),
        );
        assert!(layout.proxies_dir().is_dir());

        // Idempotent: re-setting to the same workspace is a no-op.
        layout.set_workspace(ws.path()).unwrap();
        assert!(layout.proxies_dir().is_dir());
    }

    // The preview/* paths (`preview_dir`, `preview`, `preview_segments_dir`,
    // `preview_segment`, `preview_manifest`, `preview_init`, `preview_audio`)
    // were deleted at the Phase F cutover (commit 5a4879d) alongside the
    // cached + segmented + B.3 paths. Their tests are gone.

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

    #[test]
    fn migrate_hash_artifacts_renames_proxy_and_waveform() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().join("cache"));
        layout.ensure_dirs().unwrap();

        let old = "pending-old";
        let new = "realhash";
        std::fs::write(layout.proxy(old), b"proxy").unwrap();
        std::fs::write(layout.waveform(old), b"peaks").unwrap();
        std::fs::write(layout.audio_conform(old), b"pcm").unwrap();

        migrate_hash_artifacts(&layout, old, new).unwrap();

        assert!(layout.proxy(new).is_file());
        assert!(layout.waveform(new).is_file());
        assert!(layout.audio_conform(new).is_file());
        assert!(!layout.proxy(old).exists());
        assert!(!layout.waveform(old).exists());
        assert!(!layout.audio_conform(old).exists());
    }

    #[test]
    fn migrate_hash_artifacts_noop_for_same_hash() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().join("cache"));
        layout.ensure_dirs().unwrap();
        migrate_hash_artifacts(&layout, "abc", "abc").unwrap();
    }
}
