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

pub mod disk_lru;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};

/// Which decode source produced a filmstrip tile's pixels. Part of the tile's
/// disk key: when a media's decode route changes (e.g. Bypass ->
/// route-corrected Proxied), tiles from the old source stop matching and
/// re-extract; the stale-source orphans age out via the disk LRU. The tag
/// deliberately does NOT carry the proxy recipe version (see the design
/// spec's non-goals).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilmstripSrc {
    Orig,
    Quick,
    Full,
}

impl FilmstripSrc {
    /// The exhaustive set of valid tag dir names under `filmstrip/{hash}/`.
    /// The disk-LRU sweep treats anything else there as pre-provenance
    /// layout and deletes it.
    pub const DIR_NAMES: [&'static str; 3] = ["orig", "quick", "full"];

    pub fn as_str(self) -> &'static str {
        match self {
            FilmstripSrc::Orig => "orig",
            FilmstripSrc::Quick => "quick",
            FilmstripSrc::Full => "full",
        }
    }
}

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

    /// On-demand filmstrip tiles for the timeline, lazy-cached per source hash.
    /// Keys mirror the renderer's time grid: `{tag}/{lod}/{index:06}.jpg` (tag =
    /// decode source: orig/quick/full) where the tile samples source time
    /// `index * (250ms << lod)`. Growth is bounded by the disk-cache LRU
    /// (follow-up plan); tiles are ~15-25 KB JPGs.
    pub fn filmstrip_root(&self) -> PathBuf {
        self.current_root().join("filmstrip")
    }

    /// Reserved scaffolding for materializing caption text bodies to a
    /// blake3-addressed file when a code path needs a real on-disk path.
    /// Currently UNUSED: kept for a future ffmpeg subtitle burn-in export path,
    /// where `subtitles=<file>` needs a filename.
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

    /// Fast preview-first proxy for a hashed media file. The `q4` segment is
    /// the recipe version — bumped when the quick-proxy ffmpeg args change
    /// (540p → 720p was q2; q3 switches to a short scrub GOP, ADR 0008; q4
    /// asserts source color tags + writes the mp4 colr atom so proxy decodes
    /// aren't misread as bt709/limited) so stale cached proxies are
    /// regenerated, not reused.
    pub fn quick_proxy(&self, hash: &str) -> PathBuf {
        self.proxies_dir().join(format!("{hash}.quick-q4.mp4"))
    }

    /// Per-media thumbnail directory; individual thumbnails sit inside as
    /// `000.jpg`, `001.jpg`, ...
    pub fn thumbnails(&self, hash: &str) -> PathBuf {
        self.thumbnails_root().join(hash)
    }

    pub fn thumbnail(&self, hash: &str, idx: usize) -> PathBuf {
        self.thumbnails(hash).join(format!("{idx:03}.jpg"))
    }

    /// Multi-resolution audio peaks file (VPEAKS). The version segment in the
    /// filename is bumped when the on-disk layout changes, so a stale cache
    /// from an older layout is regenerated rather than misread (mirrors
    /// `quick_proxy`'s recipe tag).
    pub fn waveform(&self, hash: &str) -> PathBuf {
        self.waveforms_dir().join(format!("{hash}.v3.peaks"))
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

    pub fn filmstrip_tile(&self, hash: &str, src: FilmstripSrc, lod: u32, index: u32) -> PathBuf {
        self.filmstrip_root()
            .join(hash)
            .join(src.as_str())
            .join(lod.to_string())
            .join(format!("{index:06}.jpg"))
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
    /// the cached + segmented preview paths and the offscreen rasterizer no
    /// longer exist. Existing workspaces may have orphan trees from a prior
    /// version; they're left in place rather than auto-deleted so a user
    /// reverting to an older build keeps their cache.
    pub fn ensure_dirs(&self) -> Result<()> {
        let root = self.current_root();
        for p in [
            root.clone(),
            self.proxies_dir(),
            self.thumbnails_root(),
            self.waveforms_dir(),
            self.audio_conform_dir(),
            self.frames_root(),
            self.filmstrip_root(),
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
            tmp.path().join("proxies").join("abc.quick-q4.mp4"),
        );
        assert_eq!(
            layout.thumbnail("abc", 5),
            tmp.path().join("thumbnails").join("abc").join("005.jpg"),
        );
        assert_eq!(
            layout.waveform("abc"),
            tmp.path().join("waveforms").join("abc.v3.peaks"),
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
        assert_eq!(
            layout.filmstrip_tile("abc", FilmstripSrc::Quick, 3, 7),
            tmp.path().join("filmstrip").join("abc").join("quick").join("3").join("000007.jpg"),
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
        assert!(layout.filmstrip_root().is_dir());
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
