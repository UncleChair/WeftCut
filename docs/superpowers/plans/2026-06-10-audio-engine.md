# Audio Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gain_db` / `pan` / fades real in both preview and export via a 48 kHz f32 conform cache, a shared sampled-envelope contract, a buffer-scheduled Web Audio preview graph, and a Rust block-pull export mixer that retires the lavfi audio IR.

**Architecture:** One model, two paths (spec: `docs/audio.md`, ADR 0019). Import conforms every audio-bearing source to canonical PCM (`VCONF` file). The animation engine samples gain/pan envelopes onto a 10 ms grid; the Web Audio preview consumes them via `setValueCurveAtTime`, the Rust mixer lerps them per sample, summing f32 blocks piped to ffmpeg's encode tail (`alimiter` −1 dB, then AAC/Opus). lavfi `atrim/adelay/amix` is deleted.

**Tech Stack:** Rust (tokio, ffmpeg-sidecar, serde), TypeScript (Web Audio, vitest), existing golden-vector twin discipline.

**Worktree:** `.claude/worktrees/audio-engine`, branch `feat/audio-engine` (already created; baseline green: vitest 404/404, cargo test all pass). All paths below are relative to the worktree root.

**Verification commands** (used throughout):
- TS: `npm --workspace apps/desktop run test` (or `-- -t "<name>"` to filter)
- Rust: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>`
- Typecheck: `npm run typecheck`

---

## Phase A — Conform cache (Rust)

### Task A1: CacheLayout audio-conform paths

**Files:**
- Modify: `apps/desktop/src-tauri/src/cache/mod.rs`

- [ ] **Step 1: Write the failing test.** In the `tests` module of `cache/mod.rs`, extend `layout_paths_are_content_addressable` and `ensure_dirs_is_idempotent`, and add a migrate case to `migrate_hash_artifacts_renames_proxy_and_waveform`:

```rust
// inside layout_paths_are_content_addressable, after the waveform assert:
        assert_eq!(
            layout.audio_conform("abc"),
            tmp.path().join("audio").join("abc.conform"),
        );

// inside ensure_dirs_is_idempotent, after the waveforms_dir assert:
        assert!(layout.audio_conform_dir().is_dir());

// inside migrate_hash_artifacts_renames_proxy_and_waveform, alongside the
// proxy/waveform writes + asserts:
        std::fs::write(layout.audio_conform(old), b"pcm").unwrap();
        // ...after migrate:
        assert!(layout.audio_conform(new).is_file());
        assert!(!layout.audio_conform(old).exists());
```

- [ ] **Step 2: Run, verify failure.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cache::` — expect compile error: `audio_conform` not found.

- [ ] **Step 3: Implement.** In `CacheLayout` (next to `waveforms_dir`/`waveform`):

```rust
    /// Canonical conformed PCM for a hashed media file — 48 kHz, f32le,
    /// interleaved, ≤2 channels. See `jobs::conform` for the header format.
    pub fn audio_conform_dir(&self) -> PathBuf {
        self.current_root().join("audio")
    }

    pub fn audio_conform(&self, hash: &str) -> PathBuf {
        self.audio_conform_dir().join(format!("{hash}.conform"))
    }
```

Add `self.audio_conform_dir(),` to the array in `ensure_dirs`. In `migrate_hash_artifacts`, after the waveform line:

```rust
    rename_file(cache.audio_conform(old_hash), cache.audio_conform(new_hash))?;
```

- [ ] **Step 4: Run, verify pass.** Same command. Expected: all `cache::` tests pass.

- [ ] **Step 5: Commit.** `git add apps/desktop/src-tauri/src/cache/mod.rs && git commit -m "feat(audio): CacheLayout audio-conform paths"`

### Task A2: VCONF file format + conform job

**Files:**
- Create: `apps/desktop/src-tauri/src/jobs/conform.rs`
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs` (module decl + re-export only, wiring is Task A3)

The job mirrors `jobs/waveform.rs` end-to-end (same cache/temp/promote discipline, same ffmpeg-sidecar pattern, same test style). File layout (little-endian):

```text
magic        [u8; 8] = b"VCONF\0\0\0"   (8 bytes)
version      u32     = 1                 (CONFORM_FORMAT_VERSION)
sample_rate  u32     = 48000
channels     u32     (1 | 2)
frame_count  u64
data         interleaved f32le samples   (frame_count * channels * 4 bytes)
HEADER_LEN = 28
```

- [ ] **Step 1: Write `conform.rs` with failing tests first.** Create the file with constants, a `ConformHeader` struct, `read_header`, and tests; leave `run` unimplemented (`todo!()`) so tests compile but fail:

```rust
//! Canonical audio conform — decodes any audio-bearing source once, at
//! import, into 48 kHz f32le interleaved PCM (`VCONF` header + raw frames).
//! Both the preview mixer (asset:// Range windows) and the export mixer
//! (direct frame-offset reads) consume this file and never decode audio
//! themselves. Spec: docs/audio.md §The conform cache.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::state::{MediaItem, MediaKind};

pub const MAGIC: &[u8; 8] = b"VCONF\0\0\0";
pub const CONFORM_FORMAT_VERSION: u32 = 1;
pub const CONFORM_SAMPLE_RATE: u32 = 48_000;
pub const HEADER_LEN: u64 = 28;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConformHeader {
    pub version: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: u64,
}

impl ConformHeader {
    pub fn byte_offset_of_frame(&self, frame: u64) -> u64 {
        HEADER_LEN + frame * self.channels as u64 * 4
    }
}

pub fn read_header(path: &Path) -> Result<ConformHeader> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let mut head = [0u8; HEADER_LEN as usize];
    f.read_exact(&mut head)
        .with_context(|| format!("read header of {}", path.display()))?;
    if &head[..8] != MAGIC {
        anyhow::bail!("bad magic in conform file {}", path.display());
    }
    let version = u32::from_le_bytes(head[8..12].try_into().unwrap());
    if version != CONFORM_FORMAT_VERSION {
        anyhow::bail!("unsupported conform version {version}");
    }
    let sample_rate = u32::from_le_bytes(head[12..16].try_into().unwrap());
    let channels = u32::from_le_bytes(head[16..20].try_into().unwrap());
    if channels == 0 || channels > 2 {
        anyhow::bail!("conform channels {channels} out of range");
    }
    let frame_count = u64::from_le_bytes(head[20..28].try_into().unwrap());
    Ok(ConformHeader { version, sample_rate, channels, frame_count })
}

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    todo!()
}
```

Tests (same module, modeled on `waveform.rs::tests` — reuse its `ffmpeg_available()` + `make_test_audio` shape verbatim, and the same `MediaItem` literal but `file_hash_blake3: "deadbeef-cf"`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    use crate::state::{AudioStreamMeta, MediaKind, MediaMetadata, new_id};

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg").arg("-version").output()
            .map(|o| o.status.success()).unwrap_or(false)
    }

    /// 1-second 1 kHz MONO sine at 44.1 kHz — exercises both the resample
    /// (44.1→48k) and the mono-stays-mono channel policy.
    async fn make_test_audio(dest: &std::path::Path) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
                "-ac", "1", "-ar", "44100",
            ])
            .arg(dest).status().await?;
        if !status.success() { anyhow::bail!("fixture ffmpeg failed: {status}"); }
        Ok(())
    }

    fn media_for(path: PathBuf, channels: u8, hash: &str) -> MediaItem {
        MediaItem {
            id: new_id(),
            label: Some("source.wav".into()),
            path_abs: path,
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 44100, channels, codec: "pcm_s16le".into(),
                }),
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn conform_mono_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() { eprintln!("ffmpeg missing — skip"); return; }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let audio = tmp.path().join("source.wav");
        make_test_audio(&audio).await.expect("fixture");

        let path = run(&cache, &media_for(audio, 1, "deadbeef-cf")).await.expect("conform");
        assert!(cached_ok(&path));

        let h = read_header(&path).expect("header");
        assert_eq!(h.sample_rate, CONFORM_SAMPLE_RATE);
        assert_eq!(h.channels, 1, "mono source must stay mono");
        // 1 s at 48 kHz, resampler edge tolerance ±1 frame per 1000.
        assert!((47_900..=48_100).contains(&(h.frame_count as i64)),
            "expected ~48000 frames, got {}", h.frame_count);
        // Body length must match the header exactly.
        let len = std::fs::metadata(&path).unwrap().len();
        assert_eq!(len, h.byte_offset_of_frame(h.frame_count));
        // Sanity on content: a sine's max |sample| is well above silence
        // and below clipping.
        let bytes = std::fs::read(&path).unwrap();
        let mut max = 0.0_f32;
        for c in bytes[HEADER_LEN as usize..].chunks_exact(4) {
            max = max.max(f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs());
        }
        assert!(max > 0.05 && max <= 1.01, "max sample {max}");
    }

    #[tokio::test]
    async fn rejects_media_without_audio() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let mut m = media_for(tmp.path().join("nope.mp4"), 1, "noaudio");
        m.kind = MediaKind::Video;
        m.metadata.audio = None;
        let err = run(&cache, &m).await.expect_err("no audio stream");
        assert!(format!("{err:#}").contains("no audio stream"));
    }
}
```

- [ ] **Step 2: Register the module and run, verify failure.** In `jobs/mod.rs` add `pub mod conform;` after `pub mod import;`. Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml conform` — expect panic at `todo!()` (and the no-audio test failing for the same reason).

- [ ] **Step 3: Implement `run`.** Replace the `todo!()`:

```rust
pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot conform audio");
    }
    let Some(audio_meta) = media.metadata.audio.as_ref() else {
        anyhow::bail!("media has no audio stream");
    };
    if !matches!(media.kind, MediaKind::Video | MediaKind::Audio) {
        anyhow::bail!("conform only valid for Video / Audio media");
    }

    let dest = cache.audio_conform(&media.file_hash_blake3);
    if cached_ok(&dest) {
        // Format-version check: stale versions regenerate.
        if read_header(&dest).map(|h| h.version == CONFORM_FORMAT_VERSION).unwrap_or(false) {
            return Ok(dest);
        }
        let _ = tokio::fs::remove_file(&dest).await;
    }

    // Mono stays mono; everything else (stereo and >2ch) lands stereo.
    let out_channels: u32 = if audio_meta.channels <= 1 { 1 } else { 2 };

    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    let mut child = Command::new(ffmpeg_path())
        .args(["-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(&media.path_abs)
        .args([
            "-vn",
            "-ac", &out_channels.to_string(),
            "-ar", &CONFORM_SAMPLE_RATE.to_string(),
            "-f", "f32le", "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ffmpeg for conform")?;

    let mut stdout = child.stdout.take().expect("stdout was piped");

    // Stream to the temp file with a placeholder frame_count, then patch
    // the header once the byte total is known.
    let mut f = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("create {}", tmp.display()))?;
    let mut head = Vec::with_capacity(HEADER_LEN as usize);
    head.extend_from_slice(MAGIC);
    head.extend_from_slice(&CONFORM_FORMAT_VERSION.to_le_bytes());
    head.extend_from_slice(&CONFORM_SAMPLE_RATE.to_le_bytes());
    head.extend_from_slice(&out_channels.to_le_bytes());
    head.extend_from_slice(&0u64.to_le_bytes()); // frame_count patched below
    f.write_all(&head).await.context("write conform header")?;

    let mut total_bytes: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = stdout.read(&mut buf).await.context("read ffmpeg stdout")?;
        if n == 0 { break; }
        f.write_all(&buf[..n]).await.context("write conform data")?;
        total_bytes += n as u64;
    }

    let output = child.wait_with_output().await.context("await ffmpeg for conform")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        drop(f);
        discard_temp(&dest);
        anyhow::bail!("ffmpeg exited with {} for conform: {}", output.status, stderr.trim());
    }

    let bytes_per_frame = out_channels as u64 * 4;
    if total_bytes % bytes_per_frame != 0 {
        // Truncate a torn trailing frame rather than fail — ffmpeg's f32le
        // stream is frame-aligned in practice; this is belt-and-braces.
        total_bytes -= total_bytes % bytes_per_frame;
    }
    let frame_count = total_bytes / bytes_per_frame;
    if frame_count == 0 {
        drop(f);
        discard_temp(&dest);
        anyhow::bail!("conform produced zero frames for {}", media.path_abs.display());
    }

    use tokio::io::AsyncSeekExt;
    f.seek(std::io::SeekFrom::Start(20)).await.context("seek to frame_count")?;
    f.write_all(&frame_count.to_le_bytes()).await.context("patch frame_count")?;
    f.flush().await.context("flush conform")?;
    drop(f);

    promote_temp(&dest)?;
    Ok(dest)
}
```

- [ ] **Step 4: Run, verify pass.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml conform` — both tests pass (first requires ffmpeg on PATH; it self-skips otherwise).

- [ ] **Step 5: Commit.** `git add apps/desktop/src-tauri/src/jobs/conform.rs apps/desktop/src-tauri/src/jobs/mod.rs && git commit -m "feat(audio): VCONF conform job - 48kHz f32 canonical PCM"`

### Task A3: MediaItem.conform_path + job wiring + ensure_conform

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/media.rs` (MediaItem + MediaDerivativesPatch — locate via `rg "waveform_path" apps/desktop/src-tauri/src/state/`)
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs` (new `ensure_conform` command — mirror `ensure_full_proxy`, locate via `rg -n "ensure_full_proxy" apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register command)

- [ ] **Step 1: Add the field.** In `MediaItem` next to `waveform_path: Option<PathBuf>` add:

```rust
    /// Canonical conformed PCM (VCONF; see `jobs::conform`). `None` until the
    /// conform job lands. Serde-defaulted so pre-conform projects load.
    #[serde(default)]
    pub conform_path: Option<PathBuf>,
```

In `MediaDerivativesPatch` next to `waveform_path`: `pub conform_path: Option<PathBuf>,` and apply it where the patch is merged (same place `waveform_path` is — `rg -n "waveform_path" apps/desktop/src-tauri/src/state/actor.rs`). Every `MediaItem { ... }` literal in tests/mcp now needs `conform_path: None,` — fix all compile errors mechanically (`cargo check` lists them; includes `jobs/waveform.rs`, `jobs/conform.rs` tests from Task A2, `ir/mod.rs`, `mcp/mod.rs`).

- [ ] **Step 2: Wire the job.** In `jobs/mod.rs`:
  - Add `Conform,` to `JobKind` (serde lowercase ⇒ `"conform"`).
  - Add a `spawn_conform` fn — copy `spawn_waveform` verbatim, swapping `waveform::run` → `conform::run`, `JobKind::Waveform` → `JobKind::Conform`, and the patch field → `conform_path: Some(conform_path)` (adjust to the `MediaDerivativesPatch` field shape from Step 1).
  - Call it everywhere waveform spawns for audio-bearing media: in `enqueue_for_media`'s `MediaKind::Audio` arm (after `spawn_waveform(...)` add `spawn_conform(app, cache, project, media);` — clone args as the waveform line does) and in `spawn_decorations` inside the `media.metadata.audio.is_some()` block (same pattern: clone for waveform, move into conform).
  - Re-export: `pub use conform::run as run_conform;` (and keep `conform::read_header` reachable as `jobs::conform::read_header`).

- [ ] **Step 3: `ensure_conform` command.** In `commands.rs`, next to `ensure_full_proxy` (copy its shape exactly — state extraction, media lookup, error mapping):

```rust
/// Kick a conform job for one media if its VCONF file is absent. Used by the
/// export readiness gate and by project-open backfill for media imported
/// before the conform format existed. No-op when already cached.
#[tauri::command]
pub async fn ensure_conform(
    app: tauri::AppHandle,
    project: tauri::State<'_, crate::state::ProjectHandle>,
    cache: tauri::State<'_, crate::cache::CacheLayout>,
    media_id: String,
) -> Result<(), String> {
    let id: crate::state::MediaId = media_id.parse().map_err(|e| format!("bad media id: {e}"))?;
    let snapshot = project.snapshot().await;
    let media = snapshot.media_pool.get(&id).cloned()
        .ok_or_else(|| format!("unknown media {media_id}"))?;
    if media.metadata.audio.is_none() {
        return Ok(()); // nothing to conform
    }
    if crate::cache::cached_ok(&cache.audio_conform(&media.file_hash_blake3)) {
        return Ok(());
    }
    crate::jobs::enqueue_conform(app, cache.inner().clone(), project.inner().clone(), media);
    Ok(())
}
```

Add `pub fn enqueue_conform(...)` in `jobs/mod.rs` delegating to `spawn_conform` (mirror `enqueue_full_proxy`). Register `ensure_conform` in the `tauri::generate_handler![...]` list in `lib.rs` (find it via `rg -n "ensure_full_proxy" apps/desktop/src-tauri/src/lib.rs`). NOTE: adapt the command's state-access details to match `ensure_full_proxy`'s actual signature if it differs — that function is the authoritative template.

- [ ] **Step 4: Build + full Rust suite.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — all green (the compile-error sweep from Step 1 is done when this passes).

- [ ] **Step 5: Commit.** `git add -A apps/desktop/src-tauri && git commit -m "feat(audio): conform_path derivative + job wiring + ensure_conform"`

---

## Phase B — Envelope contract (Rust + TS twins)

### Task B1: Rust envelope sampler

**Files:**
- Create: `apps/desktop/src-tauri/src/audio/mod.rs`
- Create: `apps/desktop/src-tauri/src/audio/envelope.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `mod audio;` — alphabetical with the other module decls)

- [ ] **Step 1: Write failing tests.** `audio/mod.rs`: `pub mod envelope; pub mod mix;` — comment out `mix` until Phase C; or create it now with empty content. Use:

```rust
//! Audio engine: envelope sampling (the preview/export parity contract)
//! and the export block mixer. Spec: docs/audio.md.
pub mod envelope;
```

`audio/envelope.rs` skeleton + tests:

```rust
//! Sampled envelope contract — docs/audio.md §The envelope contract.
//!
//! `sample_gain` composes Animated gain_db (via the golden-locked
//! `Animated::value_at`) with the layer's linear fade ramps, on a fixed
//! 10 ms grid, in LINEAR gain (10^(dB/20)). Both renderers linearly
//! interpolate between the same points: Web Audio `setValueCurveAtTime`
//! on the TS side, `Envelope::eval` per sample on this side. The TS twin
//! is `apps/desktop/src/render/audio/envelope.ts`; the shared fixture is
//! `audioEnvelopeGolden.fixture.json` — keep all three in lockstep.

use crate::state::animated::Animated;

pub const ENVELOPE_STEP_US: i64 = 10_000; // 10 ms grid

/// Control points on the implicit grid: values[k] sits at t = k * step_us,
/// last point clamps to the layer end. len()==1 ⇔ effectively static.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub step_us: i64,
    pub span_us: i64,
    pub values: Vec<f32>,
}

impl Envelope {
    pub fn constant(v: f32, span_us: i64) -> Self {
        Self { step_us: ENVELOPE_STEP_US, span_us, values: vec![v] }
    }

    pub fn is_constant(&self) -> bool { self.values.len() == 1 }

    /// Linear interpolation between grid points, clamped at the ends.
    /// `t_us` is layer-local.
    pub fn eval(&self, t_us: i64) -> f32 {
        match self.values.len() {
            0 => 1.0,
            1 => self.values[0],
            _ => {
                if t_us <= 0 { return self.values[0]; }
                let last = (self.values.len() - 1) as i64;
                let pos = t_us as f64 / self.step_us as f64;
                let i = pos.floor() as i64;
                if i >= last { return *self.values.last().unwrap(); }
                let u = (pos - i as f64) as f32;
                let a = self.values[i as usize];
                let b = self.values[(i + 1) as usize];
                a + (b - a) * u
            }
        }
    }
}

pub fn db_to_linear(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

/// Fade multiplier at layer-local `t_us`: linear 0→1 over fade_in from the
/// layer start, 1→0 over fade_out into the layer end, multiplied when they
/// overlap. Zero-length fades are identity.
pub fn fade_multiplier(t_us: i64, span_us: i64, fade_in_us: i64, fade_out_us: i64) -> f64 {
    let mut m = 1.0f64;
    if fade_in_us > 0 && t_us < fade_in_us {
        m *= (t_us.max(0) as f64) / fade_in_us as f64;
    }
    if fade_out_us > 0 {
        let from_end = span_us - t_us;
        if from_end < fade_out_us {
            m *= (from_end.max(0) as f64) / fade_out_us as f64;
        }
    }
    m
}

/// Gain envelope for one audio layer: linear(value_at(gain_db)) × fades.
/// Static gain + no fades short-circuits to a single point.
pub fn sample_gain(
    gain_db: &Animated<f64>,
    fade_in_us: i64,
    fade_out_us: i64,
    span_us: i64,
) -> Envelope {
    let animated = gain_db.is_animated();
    if !animated && fade_in_us == 0 && fade_out_us == 0 {
        return Envelope::constant(db_to_linear(gain_db.value_at(0, 0.0)), span_us);
    }
    let n = (span_us / ENVELOPE_STEP_US) as usize + 1;
    let mut values = Vec::with_capacity(n + 1);
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        let g = db_to_linear(gain_db.value_at(t, 0.0))
            * fade_multiplier(t, span_us, fade_in_us, fade_out_us) as f32;
        values.push(g);
        if t >= span_us { break; }
        k += 1;
    }
    Envelope { step_us: ENVELOPE_STEP_US, span_us, values }
}

/// Pan envelope: plain sampling of Animated pan, clamped to [-1, 1].
pub fn sample_pan(pan: &Animated<f64>, span_us: i64) -> Envelope {
    if !pan.is_animated() {
        return Envelope::constant(pan.value_at(0, 0.0).clamp(-1.0, 1.0) as f32, span_us);
    }
    let mut values = Vec::new();
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        values.push(pan.value_at(t, 0.0).clamp(-1.0, 1.0) as f32);
        if t >= span_us { break; }
        k += 1;
    }
    Envelope { step_us: ENVELOPE_STEP_US, span_us, values }
}

/// Web Audio StereoPannerNode equal-power pan law (spec §15.5.2 /
/// "processing model"). Returns (gain_into_L, gain_into_R) plus, for the
/// stereo case, how the opposite channel bleeds. Implemented as a direct
/// frame transform so the mixer and goldens share one definition.
///
/// mono:   x = (pan+1)/2;  L = in·cos(xπ/2),            R = in·sin(xπ/2)
/// stereo, pan≤0: x = pan+1; L = l + r·cos(xπ/2),       R = r·sin(xπ/2)
/// stereo, pan>0: x = pan;   L = l·cos(xπ/2),           R = r + l·sin(xπ/2)
pub fn pan_frame(pan: f32, ch: &[f32]) -> (f32, f32) {
    use std::f32::consts::FRAC_PI_2;
    let p = pan.clamp(-1.0, 1.0);
    match ch.len() {
        1 => {
            let x = (p + 1.0) / 2.0;
            (ch[0] * (x * FRAC_PI_2).cos(), ch[0] * (x * FRAC_PI_2).sin())
        }
        _ => {
            let (l, r) = (ch[0], ch[1]);
            if p <= 0.0 {
                let x = p + 1.0;
                (l + r * (x * FRAC_PI_2).cos(), r * (x * FRAC_PI_2).sin())
            } else {
                let x = p;
                (l * (x * FRAC_PI_2).cos(), r + l * (x * FRAC_PI_2).sin())
            }
        }
    }
}
```

Tests in the same file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::animated::{Animated, Interpolation, Keyframe};
    use crate::state::ids::new_id;

    fn kf(t_us: i64, value: f64) -> Keyframe<f64> {
        Keyframe { id: new_id(), t_us, value, interp: Interpolation::Linear }
    }

    #[test]
    fn static_no_fades_is_single_point() {
        let e = sample_gain(&Animated::Static(-6.0), 0, 0, 10_000_000);
        assert!(e.is_constant());
        assert!((e.values[0] - db_to_linear(-6.0)).abs() < 1e-6);
        assert!((e.eval(0) - e.eval(9_999_999)).abs() < 1e-9);
    }

    #[test]
    fn zero_db_is_unity() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 1e-9);
        assert!((db_to_linear(-20.0) - 0.1).abs() < 1e-6);
    }

    #[test]
    fn fade_in_ramps_linearly() {
        // 0 dB gain, 1 s fade-in over a 10 s layer.
        let e = sample_gain(&Animated::Static(0.0), 1_000_000, 0, 10_000_000);
        assert!((e.eval(0) - 0.0).abs() < 1e-6);
        assert!((e.eval(500_000) - 0.5).abs() < 1e-3);
        assert!((e.eval(1_000_000) - 1.0).abs() < 1e-3);
        assert!((e.eval(5_000_000) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn fade_out_ramps_to_zero_at_end() {
        let e = sample_gain(&Animated::Static(0.0), 0, 1_000_000, 10_000_000);
        assert!((e.eval(9_000_000) - 1.0).abs() < 1e-3);
        assert!((e.eval(9_500_000) - 0.5).abs() < 1e-3);
        assert!((e.eval(10_000_000) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn keyframed_gain_samples_the_engine_curve() {
        // -20 dB → 0 dB linear over 1 s: midpoint is -10 dB in dB-space,
        // sampled then linearized.
        let track = Animated::Keyframed(
            vec![kf(0, -20.0), kf(1_000_000, 0.0)].into_iter().collect(),
        );
        let e = sample_gain(&track, 0, 0, 1_000_000);
        assert!(!e.is_constant());
        assert!((e.eval(500_000) - db_to_linear(-10.0)).abs() < 2e-3);
    }

    #[test]
    fn grid_covers_span_inclusive() {
        let e = sample_gain(&Animated::Static(0.0), 0, 100_000, 25_000);
        // span 25 ms → points at 0,10,20,25 ms = 4 points
        assert_eq!(e.values.len(), 4);
    }

    #[test]
    fn pan_law_center_mono_is_equal_power() {
        let (l, r) = pan_frame(0.0, &[1.0]);
        let half = (std::f32::consts::FRAC_PI_4).cos(); // = sin(π/4) ≈ 0.7071
        assert!((l - half).abs() < 1e-6);
        assert!((r - half).abs() < 1e-6);
    }

    #[test]
    fn pan_law_stereo_center_is_identity() {
        // pan = 0, stereo: x = 1 ⇒ cos(π/2)=0, so L = l + r·0 = l; R = r·1 = r.
        let (l, r) = pan_frame(0.0, &[0.3, 0.7]);
        assert!((l - 0.3).abs() < 1e-6);
        assert!((r - 0.7).abs() < 1e-6);
    }

    #[test]
    fn pan_law_hard_left_stereo_folds_right_into_left() {
        let (l, r) = pan_frame(-1.0, &[0.3, 0.7]);
        assert!((l - 1.0).abs() < 1e-6); // 0.3 + 0.7·cos(0) = 1.0
        assert!(r.abs() < 1e-6);
    }
}
```

- [ ] **Step 2: Run, verify failure** (module not registered yet → compile error). Add `mod audio;` to `lib.rs`, run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml audio::envelope` — tests pass or fail on real assertion mismatches; fix until green.

- [ ] **Step 3: Verify the stereo-center identity test passes** — it is the canary for the pan-law formulas. ALSO: open the Web Audio spec (https://webaudio.github.io/web-audio-api/#stereopanner-algorithm) and verify the implemented algorithm matches; if it differs, fix `pan_frame` AND this plan's doc comment, and say so in the commit body.

- [ ] **Step 4: Commit.** `git add apps/desktop/src-tauri/src/audio apps/desktop/src-tauri/src/lib.rs && git commit -m "feat(audio): Rust envelope sampler + Web Audio pan law"`

### Task B2: TS twin + cross-language golden fixture

**Files:**
- Create: `apps/desktop/src/render/audio/envelope.ts`
- Create: `apps/desktop/src/render/audio/audioEnvelopeGolden.fixture.json`
- Create: `apps/desktop/src/render/audio/envelope.golden.test.ts`
- Modify: `apps/desktop/src-tauri/src/audio/envelope.rs` (golden test)

- [ ] **Step 1: TS twin.** `envelope.ts` — line-for-line mirror of the Rust sampler over `AnimTrack` via `resolveAnimated`:

```ts
// TS twin of src-tauri/src/audio/envelope.rs — the sampled envelope
// contract (docs/audio.md). Keep BOTH sides + the golden fixture in
// lockstep; the cross-language test exists to catch drift.

import { type AnimTrack, resolveAnimated } from "../animated";

export const ENVELOPE_STEP_US = 10_000;

export interface Envelope {
  stepUs: number;
  spanUs: number;
  values: number[]; // length 1 ⇔ constant
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function fadeMultiplier(
  tUs: number, spanUs: number, fadeInUs: number, fadeOutUs: number,
): number {
  let m = 1;
  if (fadeInUs > 0 && tUs < fadeInUs) m *= Math.max(0, tUs) / fadeInUs;
  if (fadeOutUs > 0) {
    const fromEnd = spanUs - tUs;
    if (fromEnd < fadeOutUs) m *= Math.max(0, fromEnd) / fadeOutUs;
  }
  return m;
}

function isAnimated(track: AnimTrack<number>): boolean {
  return track.mode === "Keyframed" && track.value.length > 1;
}

export function sampleGain(
  gainDb: AnimTrack<number>, fadeInUs: number, fadeOutUs: number, spanUs: number,
): Envelope {
  if (!isAnimated(gainDb) && fadeInUs === 0 && fadeOutUs === 0) {
    return {
      stepUs: ENVELOPE_STEP_US, spanUs,
      values: [dbToLinear(resolveAnimated(gainDb, 0, 0))],
    };
  }
  const values: number[] = [];
  for (let k = 0; ; k++) {
    const t = Math.min(k * ENVELOPE_STEP_US, spanUs);
    values.push(
      dbToLinear(resolveAnimated(gainDb, t, 0)) *
        fadeMultiplier(t, spanUs, fadeInUs, fadeOutUs),
    );
    if (t >= spanUs) break;
  }
  return { stepUs: ENVELOPE_STEP_US, spanUs, values };
}

export function samplePan(pan: AnimTrack<number>, spanUs: number): Envelope {
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  if (!isAnimated(pan)) {
    return {
      stepUs: ENVELOPE_STEP_US, spanUs,
      values: [clamp(resolveAnimated(pan, 0, 0))],
    };
  }
  const values: number[] = [];
  for (let k = 0; ; k++) {
    const t = Math.min(k * ENVELOPE_STEP_US, spanUs);
    values.push(clamp(resolveAnimated(pan, t, 0)));
    if (t >= spanUs) break;
  }
  return { stepUs: ENVELOPE_STEP_US, spanUs, values };
}

/// Linear interp between grid points — mirrors Envelope::eval. The preview
/// scheduler uses this to cut per-chunk curve windows for
/// setValueCurveAtTime (which lerps between array entries natively).
export function evalEnvelope(e: Envelope, tUs: number): number {
  if (e.values.length === 0) return 1;
  if (e.values.length === 1) return e.values[0]!;
  if (tUs <= 0) return e.values[0]!;
  const last = e.values.length - 1;
  const pos = tUs / e.stepUs;
  const i = Math.floor(pos);
  if (i >= last) return e.values[last]!;
  const u = pos - i;
  return e.values[i]! + (e.values[i + 1]! - e.values[i]!) * u;
}
```

- [ ] **Step 2: Fixture.** `audioEnvelopeGolden.fixture.json` — wire-shape matches `Animated<f64>` serde (`mode`/`value`, `interp.kind`) exactly like `animatedGolden.fixture.json`. Note: keyframe `id`s are arbitrary UUID strings (the Rust side deserializes them as `KeyframeId`):

```json
{
  "cases": [
    {
      "name": "static_minus6_no_fades",
      "gain_db": { "mode": "Static", "value": -6.0 },
      "fade_in_us": 0, "fade_out_us": 0, "span_us": 10000000,
      "samples": [
        { "t_us": 0, "expect": 0.5011872336272722 },
        { "t_us": 9999999, "expect": 0.5011872336272722 }
      ]
    },
    {
      "name": "unity_with_one_second_fades",
      "gain_db": { "mode": "Static", "value": 0.0 },
      "fade_in_us": 1000000, "fade_out_us": 1000000, "span_us": 10000000,
      "samples": [
        { "t_us": 0, "expect": 0.0 },
        { "t_us": 500000, "expect": 0.5 },
        { "t_us": 1000000, "expect": 1.0 },
        { "t_us": 5000000, "expect": 1.0 },
        { "t_us": 9500000, "expect": 0.5 },
        { "t_us": 10000000, "expect": 0.0 }
      ]
    },
    {
      "name": "linear_ramp_minus20_to_0",
      "gain_db": {
        "mode": "Keyframed",
        "value": [
          { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": -20.0, "interp": { "kind": "Linear" } },
          { "id": "00000000-0000-7000-8000-000000000002", "t_us": 1000000, "value": 0.0, "interp": { "kind": "Linear" } }
        ]
      },
      "fade_in_us": 0, "fade_out_us": 0, "span_us": 1000000,
      "samples": [
        { "t_us": 0, "expect": 0.1 },
        { "t_us": 500000, "expect": 0.31622776601683794 },
        { "t_us": 1000000, "expect": 1.0 }
      ]
    },
    {
      "name": "hold_step_quantizes_within_10ms",
      "gain_db": {
        "mode": "Keyframed",
        "value": [
          { "id": "00000000-0000-7000-8000-000000000003", "t_us": 0, "value": 0.0, "interp": { "kind": "Hold" } },
          { "id": "00000000-0000-7000-8000-000000000004", "t_us": 505000, "value": -20.0, "interp": { "kind": "Hold" } }
        ]
      },
      "fade_in_us": 0, "fade_out_us": 0, "span_us": 1000000,
      "samples": [
        { "t_us": 500000, "expect": 1.0 },
        { "t_us": 510000, "expect": 0.1 }
      ]
    }
  ]
}
```

(Expectations are `10^(dB/20)` exactly; `0.5011872336272722 = 10^(-6/20)`, `0.31622776601683794 = 10^(-10/20)`. The hold case samples at grid points 500 ms and 510 ms which straddle the 505 ms step — both sides must agree on the same quantization.)

- [ ] **Step 3: TS golden test.** `envelope.golden.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fixture from "./audioEnvelopeGolden.fixture.json";
import { type Envelope, evalEnvelope, sampleGain } from "./envelope";
import type { AnimTrack } from "../animated";

interface Case {
  name: string;
  gain_db: AnimTrack<number>;
  fade_in_us: number;
  fade_out_us: number;
  span_us: number;
  samples: { t_us: number; expect: number }[];
}

describe("audio envelope golden vectors (cross-language)", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => {
      const e: Envelope = sampleGain(c.gain_db, c.fade_in_us, c.fade_out_us, c.span_us);
      for (const s of c.samples) {
        expect(evalEnvelope(e, s.t_us)).toBeCloseTo(s.expect, 5);
      }
    });
  }
});
```

Run: `npm --workspace apps/desktop run test -- -t "audio envelope"` — expect PASS (fix sampler/fixture mismatches now).

- [ ] **Step 4: Rust golden test.** Append to `audio/envelope.rs` tests (same deserialization pattern as `state/animated.rs::golden_vectors_match_fixture`):

```rust
    #[test]
    fn golden_vectors_match_fixture() {
        #[derive(serde::Deserialize)]
        struct Sample { t_us: i64, expect: f64 }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            gain_db: Animated<f64>,
            fade_in_us: i64,
            fade_out_us: i64,
            span_us: i64,
            samples: Vec<Sample>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture { cases: Vec<Case> }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/render/audio/audioEnvelopeGolden.fixture.json"
        )).expect("fixture parses");
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            let e = sample_gain(&case.gain_db, case.fade_in_us, case.fade_out_us, case.span_us);
            for s in &case.samples {
                let got = e.eval(s.t_us) as f64;
                assert!((got - s.expect).abs() < 1e-5,
                    "case `{}` t_us={}: got {got}, expect {}", case.name, s.t_us, s.expect);
            }
        }
    }
```

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml audio::envelope` — PASS.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/render/audio apps/desktop/src-tauri/src/audio/envelope.rs && git commit -m "feat(audio): TS envelope twin + cross-language golden fixture"`

---

## Phase C — Export mixer (Rust) + lavfi retirement

### Task C1: Conform frame reader

**Files:**
- Create: `apps/desktop/src-tauri/src/audio/conform_reader.rs`
- Modify: `apps/desktop/src-tauri/src/audio/mod.rs` (`pub mod conform_reader;`)

- [ ] **Step 1: Failing test** — write a synthetic VCONF by hand in the test (header bytes per Task A2 layout + known interleaved samples), then read windows:

```rust
//! Random-access frame reads over a VCONF conform file (std::fs — the
//! mixer is synchronous inside spawn_blocking).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Context, Result};

use crate::jobs::conform::{ConformHeader, read_header};

pub struct ConformReader {
    file: File,
    pub header: ConformHeader,
}

impl ConformReader {
    pub fn open(path: &Path) -> Result<Self> {
        let header = read_header(path)?;
        let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
        Ok(Self { file, header })
    }

    /// Read `frames` frames starting at `start_frame` into an interleaved
    /// f32 buffer. Out-of-range portions are zero-filled (silence) so the
    /// mixer never branches on clip edges.
    pub fn read_frames(&mut self, start_frame: i64, frames: usize) -> Result<Vec<f32>> {
        let ch = self.header.channels as usize;
        let mut out = vec![0f32; frames * ch];
        let total = self.header.frame_count as i64;
        let read_start = start_frame.max(0).min(total);
        let read_end = (start_frame + frames as i64).max(0).min(total);
        if read_end <= read_start {
            return Ok(out);
        }
        let n = (read_end - read_start) as usize;
        let mut bytes = vec![0u8; n * ch * 4];
        self.file.seek(SeekFrom::Start(
            self.header.byte_offset_of_frame(read_start as u64),
        )).context("seek conform")?;
        self.file.read_exact(&mut bytes).context("read conform frames")?;
        let dst_off = (read_start - start_frame) as usize * ch;
        for (i, c) in bytes.chunks_exact(4).enumerate() {
            out[dst_off + i] = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::conform::{CONFORM_FORMAT_VERSION, CONFORM_SAMPLE_RATE, MAGIC};
    use tempfile::TempDir;

    fn write_vconf(path: &Path, channels: u32, frames: &[f32]) {
        let mut buf = Vec::new();
        buf.extend_from_slice(MAGIC);
        buf.extend_from_slice(&CONFORM_FORMAT_VERSION.to_le_bytes());
        buf.extend_from_slice(&CONFORM_SAMPLE_RATE.to_le_bytes());
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&((frames.len() as u64 / channels as u64).to_le_bytes()));
        for s in frames { buf.extend_from_slice(&s.to_le_bytes()); }
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn reads_interior_window() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("a.conform");
        write_vconf(&p, 2, &[0.1, -0.1, 0.2, -0.2, 0.3, -0.3]); // 3 stereo frames
        let mut r = ConformReader::open(&p).unwrap();
        assert_eq!(r.header.frame_count, 3);
        let w = r.read_frames(1, 2).unwrap();
        assert_eq!(w, vec![0.2, -0.2, 0.3, -0.3]);
    }

    #[test]
    fn zero_fills_before_start_and_past_end() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("a.conform");
        write_vconf(&p, 1, &[0.5, 0.6]);
        let mut r = ConformReader::open(&p).unwrap();
        // window [-1, +3): silence, 0.5, 0.6, silence
        let w = r.read_frames(-1, 4).unwrap();
        assert_eq!(w, vec![0.0, 0.5, 0.6, 0.0]);
    }
}
```

- [ ] **Step 2: Run** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml audio::conform_reader` — make pass (declare module first; visibility: `read_header`/consts must be `pub` from `jobs::conform`, they are per A2).

- [ ] **Step 3: Commit.** `git add apps/desktop/src-tauri/src/audio && git commit -m "feat(audio): conform frame reader with silence padding"`

### Task C2: MixPlan + block mixer

**Files:**
- Create: `apps/desktop/src-tauri/src/audio/mix.rs`
- Modify: `apps/desktop/src-tauri/src/audio/mod.rs` (`pub mod mix;`)

Time discipline: everything converts to the 48 kHz frame domain ONCE via `us_to_frame(us) = (us * 48 + 500) / 1000` (i64; 48 000 frames / 1 000 000 µs = 48/1000), then all placement/trim math is integer frames — the audio analog of the video `frameGrid` rule.

- [ ] **Step 1: Failing tests.** `mix.rs` with types + `plan_for_project` + `mix_block` and tests:

```rust
//! Export audio mixer — MixPlan construction from the project and the
//! block-pull summing loop. Replaces the lavfi audio IR (ADR 0019).

use std::path::PathBuf;

use anyhow::Result;

use crate::audio::conform_reader::ConformReader;
use crate::audio::envelope::{Envelope, pan_frame, sample_gain, sample_pan};
use crate::state::Project;
use crate::state::layer::LayerParams;

pub const MIX_SAMPLE_RATE: i64 = 48_000;
pub const MIX_BLOCK_FRAMES: usize = 65_536;

pub fn us_to_frame(us: i64) -> i64 {
    // round-half-up in the positive domain; exact for the common 48k grid
    (us * 48 + 500).div_euclid(1000)
}

#[derive(Debug)]
pub struct MixLayer {
    pub label: String,
    pub conform_path: PathBuf,
    /// Layer start on the composition frame grid.
    pub start_frame: i64,
    /// Source in/out on the conform frame grid.
    pub src_in_frame: i64,
    pub src_out_frame: i64,
    pub gain: Envelope,
    pub pan: Envelope,
}

impl MixLayer {
    pub fn end_frame(&self) -> i64 {
        self.start_frame + (self.src_out_frame - self.src_in_frame)
    }
}

#[derive(Debug)]
pub struct MixPlan {
    /// Export window on the composition frame grid (half-open).
    pub window_start_frame: i64,
    pub window_end_frame: i64,
    pub layers: Vec<MixLayer>,
}

#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("audio layer on media \"{0}\" has no conform cache yet — wait for the conform job or run ensure_conform")]
    ConformMissing(String),
    #[error("layer references missing media {0}")]
    MissingMedia(String),
}

/// Walk every enabled, non-locked, non-muted Audio layer — the same
/// skip rules the lavfi lowering used — and resolve envelopes.
pub fn plan_for_project(
    project: &Project,
    window_us: Option<(i64, i64)>,
) -> Result<MixPlan, PlanError> {
    let (w_start_us, w_end_us) = window_us.unwrap_or((0, project.composition.duration_us));
    let mut layers = Vec::new();
    for track in project.tracks.iter() {
        if !track.enabled { continue; }
        for layer in track.layers.iter() {
            if !layer.enabled || layer.locked { continue; }
            let LayerParams::Audio(p) = &layer.params else { continue; };
            if p.mute { continue; }
            let media = project.media_pool.get(&p.media)
                .ok_or_else(|| PlanError::MissingMedia(p.media.to_string()))?;
            let label = media.label.clone()
                .unwrap_or_else(|| media.path_abs.display().to_string());
            let conform_path = media.conform_path.clone()
                .filter(|c| crate::cache::cached_ok(c))
                .ok_or_else(|| PlanError::ConformMissing(label.clone()))?;
            let span_us = p.src_out_us - p.src_in_us;
            layers.push(MixLayer {
                label,
                conform_path,
                start_frame: us_to_frame(layer.t_start_us),
                src_in_frame: us_to_frame(p.src_in_us),
                src_out_frame: us_to_frame(p.src_out_us),
                gain: sample_gain(&p.gain_db, p.fade_in_us as i64, p.fade_out_us as i64, span_us),
                pan: sample_pan(&p.pan, span_us),
            });
        }
    }
    Ok(MixPlan {
        window_start_frame: us_to_frame(w_start_us),
        window_end_frame: us_to_frame(w_end_us),
        layers,
    })
}

/// Sum one output block (stereo interleaved f32) starting at absolute
/// composition frame `block_start`. `readers` parallels `plan.layers`.
pub fn mix_block(
    plan: &MixPlan,
    readers: &mut [ConformReader],
    block_start: i64,
    frames: usize,
    out: &mut [f32], // len == frames * 2, caller zeroes
) -> Result<()> {
    for (layer, reader) in plan.layers.iter().zip(readers.iter_mut()) {
        let layer_end = layer.end_frame();
        if block_start + frames as i64 <= layer.start_frame || block_start >= layer_end {
            continue;
        }
        let src_start = block_start - layer.start_frame + layer.src_in_frame;
        let data = reader.read_frames(src_start, frames)?;
        let ch = reader.header.channels as usize;
        for k in 0..frames {
            let comp_f = block_start + k as i64;
            if comp_f < layer.start_frame || comp_f >= layer_end { continue; }
            // Clip out-of-source-range frames (read_frames zero-fills, but
            // the envelope domain is the layer-local span):
            let local_f = comp_f - layer.start_frame;
            let local_us = local_f * 1_000_000 / MIX_SAMPLE_RATE;
            let g = layer.gain.eval(local_us);
            let p = layer.pan.eval(local_us);
            let frame = &data[k * ch..k * ch + ch];
            let scaled: Vec<f32> = frame.iter().map(|s| s * g).collect();
            let (l, r) = pan_frame(p, &scaled);
            out[k * 2] += l;
            out[k * 2 + 1] += r;
        }
    }
    Ok(())
}
```

Tests (same file; use `conform_reader::tests::write_vconf` — promote it to `pub(crate) fn write_vconf` under `#[cfg(test)]` in `conform_reader.rs` so both test modules share it):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::conform_reader::{ConformReader, write_vconf};
    use tempfile::TempDir;

    fn flat_mono_conform(dir: &std::path::Path, name: &str, value: f32, frames: usize) -> PathBuf {
        let p = dir.join(name);
        write_vconf(&p, 1, &vec![value; frames]);
        p
    }

    fn plain_layer(path: PathBuf, start_frame: i64, n_frames: i64) -> MixLayer {
        MixLayer {
            label: "test".into(),
            conform_path: path,
            start_frame,
            src_in_frame: 0,
            src_out_frame: n_frames,
            gain: Envelope::constant(1.0, n_frames * 1_000_000 / MIX_SAMPLE_RATE),
            pan: Envelope::constant(0.0, n_frames * 1_000_000 / MIX_SAMPLE_RATE),
        }
    }

    #[test]
    fn us_to_frame_is_exact_on_the_grid() {
        assert_eq!(us_to_frame(0), 0);
        assert_eq!(us_to_frame(1_000_000), 48_000);
        assert_eq!(us_to_frame(20_833), 1_000); // 1000 frames = 20833.3µs
    }

    #[test]
    fn single_centered_mono_layer_equal_power() {
        let tmp = TempDir::new().unwrap();
        let p = flat_mono_conform(tmp.path(), "a.conform", 0.5, 100);
        let plan = MixPlan {
            window_start_frame: 0, window_end_frame: 100,
            layers: vec![plain_layer(p.clone(), 0, 100)],
        };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; 100 * 2];
        mix_block(&plan, &mut readers, 0, 100, &mut out).unwrap();
        // mono center: each side = 0.5 · cos(π/4) ≈ 0.35355
        assert!((out[0] - 0.35355).abs() < 1e-4);
        assert!((out[1] - 0.35355).abs() < 1e-4);
    }

    #[test]
    fn placement_offsets_and_silence_gaps() {
        let tmp = TempDir::new().unwrap();
        let p = flat_mono_conform(tmp.path(), "a.conform", 0.4, 10);
        let plan = MixPlan {
            window_start_frame: 0, window_end_frame: 30,
            layers: vec![plain_layer(p.clone(), 10, 10)],
        };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; 30 * 2];
        mix_block(&plan, &mut readers, 0, 30, &mut out).unwrap();
        assert_eq!(out[9 * 2], 0.0, "before layer start: silence");
        assert!(out[10 * 2] > 0.2, "at layer start: signal");
        assert!(out[19 * 2] > 0.2, "last layer frame: signal");
        assert_eq!(out[20 * 2], 0.0, "past layer end: silence");
    }

    #[test]
    fn overlapping_layers_sum() {
        let tmp = TempDir::new().unwrap();
        let p1 = flat_mono_conform(tmp.path(), "a.conform", 0.3, 50);
        let p2 = flat_mono_conform(tmp.path(), "b.conform", 0.2, 50);
        let plan = MixPlan {
            window_start_frame: 0, window_end_frame: 50,
            layers: vec![plain_layer(p1.clone(), 0, 50), plain_layer(p2.clone(), 0, 50)],
        };
        let mut readers = vec![
            ConformReader::open(&p1).unwrap(),
            ConformReader::open(&p2).unwrap(),
        ];
        let mut out = vec![0f32; 50 * 2];
        mix_block(&plan, &mut readers, 0, 50, &mut out).unwrap();
        let expect = (0.3 + 0.2) * (std::f32::consts::FRAC_PI_4).cos();
        assert!((out[0] - expect).abs() < 1e-4);
    }

    #[test]
    fn gain_envelope_applies_per_sample() {
        let tmp = TempDir::new().unwrap();
        let n = 48_000i64; // 1 s
        let p = flat_mono_conform(tmp.path(), "a.conform", 1.0, n as usize);
        let mut layer = plain_layer(p.clone(), 0, n);
        // fade-in across the full second
        layer.gain = crate::audio::envelope::sample_gain(
            &crate::state::animated::Animated::Static(0.0), 1_000_000, 0, 1_000_000,
        );
        let plan = MixPlan { window_start_frame: 0, window_end_frame: n, layers: vec![layer] };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; MIX_BLOCK_FRAMES.min(n as usize) * 2];
        mix_block(&plan, &mut readers, 0, n as usize, &mut out).unwrap();
        let half = (std::f32::consts::FRAC_PI_4).cos();
        assert!(out[0].abs() < 1e-3, "t=0 fade-in is silent");
        let mid = out[(n as usize / 2) * 2];
        assert!((mid - 0.5 * half).abs() < 2e-3, "midpoint ≈ half gain, got {mid}");
    }
}
```

NOTE: `AudioParams.fade_in_us/fade_out_us` are `u64` in `state/layer.rs` — the `as i64` casts in `plan_for_project` are deliberate. If `Project::composition` lacks `duration_us` as a plain field, check `rg -n "duration_us" apps/desktop/src-tauri/src/state/project.rs` and use the accessor it exposes.

- [ ] **Step 2: Run until green.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml audio::mix`

- [ ] **Step 3: Commit.** `git add apps/desktop/src-tauri/src/audio && git commit -m "feat(audio): MixPlan + deterministic block mixer"`

### Task C3: export_audio_only → mixer + ffmpeg encode tail

**Files:**
- Modify: `apps/desktop/src-tauri/src/export/mod.rs`

- [ ] **Step 1: Failing integration test** (append to `export/mod.rs` tests; real-ffmpeg, self-skipping like waveform's): build two synthetic conform files + a minimal `Project` with two overlapping Audio layers (copy the `Project`/layer-literal style from `ir/mod.rs` tests — `rg -n "LayerParams::Audio" apps/desktop/src-tauri/src/ir/mod.rs`), set `media.conform_path`, run the new `export_audio_only`, then decode the `.m4a` back with `ffmpeg -i out.m4a -f f32le -` and assert the decoded peak amplitude is within 10% of the expected sum (encode is lossy — loose tolerance, exact math is covered by C2 unit tests).

- [ ] **Step 2: Rewrite `export_audio_only`.** Keep the signature `(_app, project, output, audio: &AudioEncodeSpec, window_us)`. Replace the lower/emit/filter-script body with:

```rust
    let plan = crate::audio::mix::plan_for_project(project, window_us)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    if plan.layers.is_empty() {
        warn!("audio-only export: project has no audio layers; skipping ffmpeg");
        return Ok(());
    }

    let target_sr = audio.sample_rate.unwrap_or(project.composition.sample_rate);
    let target_ch = audio.channels.unwrap_or(2).clamp(1, 2);

    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(["-y", "-hide_banner", "-nostats"])
        .args(["-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "-"])
        // −1 dB sample-peak ceiling; level=0 disables alimiter's
        // auto-normalize (defaults ON — the known trap).
        .args(["-af", "alimiter=limit=0.891:level=0"])
        .args(["-ar", &target_sr.to_string(), "-ac", &target_ch.to_string()]);
    for arg in audio_encode_args(&audio.codec, audio.bitrate) {
        cmd.arg(arg);
    }
    cmd.arg(output);
    cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped())
        .kill_on_drop(true);

    info!("audio mix+encode starting → {}", output.display());
    let mut child = cmd.spawn().context("spawn ffmpeg")?;
    let mut stdin = child.stdin.take().context("take ffmpeg stdin")?;
    let stderr = child.stderr.take().context("take ffmpeg stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            tail.push(line);
            if tail.len() > 50 { tail.remove(0); }
        }
        tail.join("\n")
    });

    // The mixer is synchronous file I/O — run it on a blocking thread and
    // feed blocks through a channel to the async stdin writer.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<f32>>(4);
    let mix_task = tokio::task::spawn_blocking(move || -> Result<()> {
        use crate::audio::mix::{MIX_BLOCK_FRAMES, mix_block};
        let mut readers = plan.layers.iter()
            .map(|l| crate::audio::conform_reader::ConformReader::open(&l.conform_path))
            .collect::<Result<Vec<_>>>()?;
        let total = (plan.window_end_frame - plan.window_start_frame).max(0);
        let mut done: i64 = 0;
        while done < total {
            let frames = MIX_BLOCK_FRAMES.min((total - done) as usize);
            let mut out = vec![0f32; frames * 2];
            mix_block(&plan, &mut readers, plan.window_start_frame + done, frames, &mut out)?;
            if tx.blocking_send(out).is_err() { break; } // ffmpeg died; stderr tail reports
            done += frames as i64;
        }
        Ok(())
    });

    use tokio::io::AsyncWriteExt;
    while let Some(block) = rx.recv().await {
        let mut bytes = Vec::with_capacity(block.len() * 4);
        for s in &block { bytes.extend_from_slice(&s.to_le_bytes()); }
        if let Err(e) = stdin.write_all(&bytes).await {
            warn!("ffmpeg stdin write failed: {e}");
            break;
        }
    }
    drop(stdin); // EOF → ffmpeg finalizes the file
    mix_task.await.context("join mixer")??;

    let status = child.wait().await.context("await ffmpeg")?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    if !status.success() {
        warn!("ffmpeg exited with {}\nstderr tail:\n{}", status, stderr_tail);
        anyhow::bail!("ffmpeg exited {}. Tail:\n{}", status,
            stderr_tail.lines().rev().take(8).collect::<Vec<_>>().join("\n"));
    }
    info!("audio mix+encode complete → {}", output.display());
    Ok(())
```

Delete the now-unused `RenderTarget`/`lower`/`emit_ffmpeg` imports from `export/mod.rs`. The `RenderTarget::full` width/height/fps args die with them (audio never used them).

- [ ] **Step 3: Run** the new integration test + the whole export module: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml export::` — green.

- [ ] **Step 4: Commit.** `git add apps/desktop/src-tauri/src/export && git commit -m "feat(audio): export mixes in Rust, ffmpeg reduced to limiter+encode tail"`

### Task C4: Retire the lavfi audio IR

**Files:**
- Delete: `apps/desktop/src-tauri/src/ir/` (whole module: `mod.rs`, `lower.rs`, `node.rs`, `graph.rs`, `emit_ffmpeg.rs`, `target.rs` — confirm the list with `ls apps/desktop/src-tauri/src/ir/`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (drop `mod ir;`)
- Modify: any survivors found by `rg -n "crate::ir|use.*\bir::" apps/desktop/src-tauri/src --type rust`

- [ ] **Step 1: Inventory.** Run the rg above. Known consumers: `export/mod.rs` (already cleaned in C3). If `RenderTarget` is used by anything else (check `rg -n "RenderTarget" apps/desktop/src-tauri/src`), move the struct into that consumer or `state/`; if only audio used it, it dies with the module.

- [ ] **Step 2: Delete + fix.** Remove the directory, drop the module decl, fix imports until `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` is clean. The `ir/mod.rs` unit tests (AudioParams literals, lowering tests) die with it — their behavioral coverage was replaced by `audio::mix` tests in C2.

- [ ] **Step 3: Full Rust suite.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — green.

- [ ] **Step 4: Commit.** `git add -A apps/desktop/src-tauri && git commit -m "refactor(audio): delete lavfi audio IR (replaced by audio::mix, ADR 0019)"`

---

## Phase D — Preview mixer (TS)

### Task D1: AudioView fades + conform path over IPC

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/summary.rs` (AudioView builder — locate with `rg -n "gain_db" apps/desktop/src-tauri/src/state/summary.rs`; if the summaries live elsewhere, `rg -rn "struct AudioView" apps/desktop/src-tauri/src`)
- Modify: `apps/desktop/src/ipc/index.ts`

- [ ] **Step 1: Rust summary.** Add to the Rust `AudioView` (mirroring whatever field style `VideoClipView` uses for its fades) `fade_in_us: u64, fade_out_us: u64`, populated from `AudioParams`. Add `conform_path: Option<String>` to the **media** summary struct (the one carrying `waveform_path` — find with `rg -n "waveform_path" apps/desktop/src-tauri/src/state/summary.rs`), populated from `MediaItem.conform_path` as a display string.

- [ ] **Step 2: TS types.** In `ipc/index.ts`, `AudioView` gains `fade_in_us: number; fade_out_us: number;`; the media summary interface gains `conform_path: string | null;`. `AudioPatch` gains `fade_in_us?: number; fade_out_us?: number;` and the matching Rust `LayerParamsPatch` audio arm gains the same two optional fields applied in the actor (locate with `rg -n "AudioPatch|Audio \{" apps/desktop/src-tauri/src/state/actor.rs`).

- [ ] **Step 3: Verify.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` + `npm run typecheck` — green. Existing summary unit tests that assert AudioView shape will name the missing fields; fix them.

- [ ] **Step 4: Commit.** `git add -A apps/desktop && git commit -m "feat(audio): fades + conform path ride the IPC summaries"`

### Task D2: Conform Range source (TS)

**Files:**
- Create: `apps/desktop/src/render/audio/conformSource.ts`
- Create: `apps/desktop/src/render/audio/conformSource.test.ts`

- [ ] **Step 1: Failing tests** for header parse + de-interleave, with `fetch` mocked (vitest `vi.stubGlobal`) returning VCONF bytes built in the test (same layout as Task A2; write a `buildVconf(channels, samples)` helper in the test):

Behavior under test: (a) `openConform(url)` parses the 28-byte header via a `Range: bytes=0-27` request; (b) `readWindow(startFrame, frameCount)` issues Range reads, **looping until the exact byte count arrives** (the asset:// ~1MB cap discipline — simulate a short first response in the mock); (c) returns per-channel `Float32Array`s zero-padded outside `[0, frameCount)`.

```ts
// conformSource.ts
/// Range-reads over a VCONF conform file served via asset://. No decode —
/// the file IS the samples. Loop-read discipline per the asset:// 206 cap
/// (a single Range response may come back short; see AssetRangeSource).

export interface ConformHeader {
  version: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
}

export const CONFORM_HEADER_LEN = 28;

export class ConformSource {
  private constructor(
    readonly url: string,
    readonly header: ConformHeader,
  ) {}

  static async open(url: string): Promise<ConformSource> {
    const head = await rangeRead(url, 0, CONFORM_HEADER_LEN);
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const magic = new TextDecoder().decode(head.subarray(0, 5));
    if (magic !== "VCONF") throw new Error(`bad conform magic at ${url}`);
    const header: ConformHeader = {
      version: dv.getUint32(8, true),
      sampleRate: dv.getUint32(12, true),
      channels: dv.getUint32(16, true),
      frameCount: Number(dv.getBigUint64(20, true)),
    };
    if (header.version !== 1) throw new Error(`conform version ${header.version}`);
    return new ConformSource(url, header);
  }

  /// Read `frameCount` frames starting at `startFrame` (may be negative /
  /// past EOF — zero-filled), de-interleaved per channel.
  async readWindow(startFrame: number, frameCount: number): Promise<Float32Array[]> {
    const ch = this.header.channels;
    const out = Array.from({ length: ch }, () => new Float32Array(frameCount));
    const total = this.header.frameCount;
    const readStart = Math.min(Math.max(startFrame, 0), total);
    const readEnd = Math.min(Math.max(startFrame + frameCount, 0), total);
    if (readEnd <= readStart) return out;
    const bytes = await rangeRead(
      this.url,
      CONFORM_HEADER_LEN + readStart * ch * 4,
      (readEnd - readStart) * ch * 4,
    );
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dstOff = readStart - startFrame;
    const n = readEnd - readStart;
    for (let f = 0; f < n; f++) {
      for (let c = 0; c < ch; c++) {
        out[c]![dstOff + f] = dv.getFloat32((f * ch + c) * 4, true);
      }
    }
    return out;
  }
}

/// Loop until exactly `len` bytes arrive — a single asset:// 206 caps at
/// ~1 MB and short reads otherwise wedge consumers.
async function rangeRead(url: string, offset: number, len: number): Promise<Uint8Array> {
  const out = new Uint8Array(len);
  let got = 0;
  while (got < len) {
    const start = offset + got;
    const end = offset + len - 1;
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok && res.status !== 206) {
      throw new Error(`conform range read failed: HTTP ${res.status}`);
    }
    const chunk = new Uint8Array(await res.arrayBuffer());
    if (chunk.byteLength === 0) throw new Error("conform range read returned 0 bytes");
    out.set(chunk.subarray(0, Math.min(chunk.byteLength, len - got)), got);
    got += Math.min(chunk.byteLength, len - got);
  }
  return out;
}
```

- [ ] **Step 2: Run** `npm --workspace apps/desktop run test -- -t conformSource` — green after implementation.

- [ ] **Step 3: Commit.** `git add apps/desktop/src/render/audio && git commit -m "feat(audio): VCONF Range source for the preview mixer"`

### Task D3: Master bus (AudioGraph)

**Files:**
- Modify: `apps/desktop/src/render/audio/AudioGraph.ts` (replace the P0 master-mute stub; read it first)
- Create: `apps/desktop/src/render/audio/AudioGraph.test.ts`

- [ ] **Step 1:** Rewrite `AudioGraph` as the master bus: owns the shared `AudioContext` (constructed with `{ sampleRate: 48000 }`, resumed on first play), `input: GainNode` → `analyser: AnalyserNode` (fftSize 2048) → `compressor: DynamicsCompressorNode` (threshold −1 dB, ratio 20, attack 0.001, release 0.25) → `destination`. Public surface: `get context()`, `get input()`, `meterSnapshot(): { rmsDb: number; peakDb: number }` (single combined analyser read — per-channel splitting is future work), `setMasterMute(muted: boolean)` (preserve the stub's existing API — check its current callers with `rg -n "AudioGraph" apps/desktop/src`), `dispose()`. Unit tests (mock the AudioContext node factories with vitest stubs): (a) `linearToDb(0) === -Infinity` and `linearToDb(1) === 0` for the exported helper; (b) `meterSnapshot()` over an all-zero mocked analyser buffer returns `rmsDb === -Infinity && peakDb === -Infinity`; (c) `setMasterMute(true)` sets the input gain node's `gain.value` to 0 and `false` restores 1. Graph topology itself is covered by the e2e phase.

- [ ] **Step 2:** `npm --workspace apps/desktop run test` + `npm run typecheck` green.

- [ ] **Step 3: Commit.** `git add apps/desktop/src/render/audio && git commit -m "feat(audio): master bus - meter + soft limiter (preview)"`

### Task D4: Buffer-scheduled AudioMixer

**Files:**
- Rewrite: `apps/desktop/src/render/audio/AudioMixer.ts`
- Create: `apps/desktop/src/render/audio/chunkSchedule.ts` + `chunkSchedule.test.ts` (pure scheduling math, unit-tested; the AudioMixer is the thin Web-Audio-API shell around it)

Scheduling constants: `CHUNK_FRAMES = 48_000` (1 s), `LOOKAHEAD_S = 3`, `MAX_LIVE_CHUNKS = 8`, `REANCHOR_THRESHOLD_S = 0.04`, `MICRO_FADE_S = 0.005`.

- [ ] **Step 1: Pure scheduler first (TDD).** `chunkSchedule.ts` exports:

```ts
export interface ChunkPlanInput {
  /// Playhead in composition µs and the anchor pair.
  masterUs: number;
  anchorCompUs: number;
  anchorCtxTime: number;
  ctxNow: number;
  /// Layer placement (composition µs) and source trim (conform frames).
  layerTStartUs: number;
  layerTEndUs: number;
  srcInFrame: number;
  srcOutFrame: number;
  /// Chunks already scheduled (start frames on the source grid).
  liveChunkStarts: number[];
}

export interface PlannedChunk {
  srcStartFrame: number;
  frames: number;
  /// AudioContext time to start at, and offset into the buffer if late.
  when: number;
  bufferOffsetFrames: number;
}

export function planChunks(input: ChunkPlanInput): PlannedChunk[];
export function shouldReanchor(predictedCompUs: number, engineCompUs: number): boolean;
```

Tests pin: chunk grid alignment to `CHUNK_FRAMES` on the source axis; lookahead window honored; `MAX_LIVE_CHUNKS` cap; late chunk start gets `when = ctxNow` + positive `bufferOffsetFrames`; chunks clamped to `[srcInFrame, srcOutFrame)`; re-anchor fires only past 40 ms. `when` math: `when = anchorCtxTime + (chunkCompUs − anchorCompUs) / 1e6` where `chunkCompUs = layerTStartUs + (srcStartFrame − srcInFrame) * 1e6 / 48000`.

- [ ] **Step 2: AudioMixer shell.** Keep the constructor surface `(init, …)` and `tick(masterUs, playing, layerTEndUs)` / `updateLayerParams` / `dispose` so `Compositor.ts` keeps compiling (D5 extends the init type). Internals per chunk: `AudioBufferSourceNode` over an `AudioBuffer` filled from `ConformSource.readWindow`, → per-layer `GainNode` → `StereoPannerNode` → `graph.input`. Envelope application per chunk span: cut the window from the layer's `Envelope` (via `evalEnvelope` at curve grid points inside the chunk) into a `Float32Array` and `gain.gain.setValueCurveAtTime(curve, when, chunkDurationS)`; constant envelopes set `.value` once. Pan likewise on `panner.pan`. On `updateLayerParams` / summary change: `cancelAndHoldAtTime(ctxNow)` on both params, stop+disconnect live chunks, reschedule from the playhead (the `setValueCurveAtTime` overlap rule makes reschedule the only correct move). On `tick` while playing: run `planChunks`, schedule what it returns; `shouldReanchor(predicted, masterUs)` → teardown + reschedule with a 5 ms gain micro-fade. Paused/out-of-window: stop sources. A failed `readWindow` (Range error) drops that chunk to silence: `console.warn` once per layer, skip scheduling it, retry on the next tick's plan — never throw out of `tick`.

- [ ] **Step 3:** `npm --workspace apps/desktop run test -- -t chunkSchedule` green; full vitest + typecheck green (AudioMixer itself is exercised in e2e, not jsdom).

- [ ] **Step 4: Commit.** `git add apps/desktop/src/render/audio && git commit -m "feat(audio): buffer-scheduled preview mixer over conform PCM"`

### Task D5: Compositor wiring

**Files:**
- Modify: `apps/desktop/src/render/Compositor.ts` (audio sections: ~line 393 host creation, ~544 stale-mixer sweep, ~605–630 ensure/tick pass, ~1644–1676 `ensureAudio`)

- [ ] **Step 1:** Read the four regions. Replace element-host plumbing: the `audioHost` div is no longer needed by the mixer (no `<audio>` elements) — keep it ONLY if JASSUB still gates on it (line ~1603 uses `audioHost === null` as "am I in a DOM context"; preserve that check, rename nothing). Construct one `AudioGraph` in preview mode (`this.audioGraph`), dispose in `dispose()`, and expose it as `getAudioGraph(): AudioGraph | null` (consumed by the PerfHUD meter row in Task E1).

- [ ] **Step 2:** `ensureAudio(layer)` now resolves the **conform URL**: media summary `conform_path` → `convertFileSrc` (same helper the existing code uses for `audioUrl` — reuse its URL plumbing, check how `setMediaSources` URLs are built). Missing conform ⇒ log once (existing `no audio URL` pattern at ~1659) and return null (silent layer). Pass the layer's `AudioView` (gain_db/pan tracks + fades + src trims) and the `AudioGraph` into the new `AudioMixer` init. On each `setProject` diff, when an audio layer's summary changed, call the mixer's `updateLayerParams` with the new view (it reschedules envelopes).

- [ ] **Step 3:** Type-check + full vitest. Manual smoke (deferred to Phase F's live verification — note it in the commit body).

- [ ] **Step 4: Commit.** `git add apps/desktop/src/render/Compositor.ts && git commit -m "feat(audio): Compositor drives the buffer-scheduled mixer"`

### Task D6: Export readiness gate

**Files:**
- Modify: the export readiness gate (find with `rg -n "readiness|preparing" apps/desktop/src/render/runExport.ts apps/desktop/src/App.tsx` — the gate that today "checks only video sources referenced by the export range", per docs/rendering.md)

- [ ] **Step 1:** Extend the gate: for every enabled, non-muted Audio layer in the export range whose media summary has `conform_path === null`, call `ensureConform(mediaId)` (add the thin IPC wrapper in `ipc/index.ts`: `invoke("ensure_conform", { mediaId })`) and hold the export in the existing "preparing" state until the `media:job_complete` (`kind === "conform"`) event lands or `media:job_error` fails the export with the media's label. Follow exactly the proxy-wait pattern already there.

- [ ] **Step 2:** Typecheck + vitest green.

- [ ] **Step 3: Commit.** `git add apps/desktop/src && git commit -m "feat(audio): export waits on conform readiness"`

---

## Phase E — MCP + meter surface

### Task E1: MCP truth + meter resource

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs`

- [ ] **Step 1:** Find every tool description that mentions audio gain/pan/fade (`rg -n "gain" apps/desktop/src-tauri/src/mcp/mod.rs` — the `add_audio` / `update_layer` / `separate_audio` tool doc-comments and schema descriptions around lines 430–460 / 880 / 3536–3557). Remove any "not yet applied" hedges; state plainly: "gain_db (dB, keyframeable), pan (−1..1, keyframeable), fade_in_us/fade_out_us take effect in preview and export."

- [ ] **Step 2:** Add a `composition://meter` MCP resource returning the latest master meter snapshot. Plumbing: the webview pushes meter snapshots to Rust on a ~500 ms timer **only while playing** via a tiny `report_audio_meter` Tauri command storing `Arc<Mutex<Option<MeterSnapshot>>>` in managed state; the MCP resource reads it (stale ⇒ `{"playing": false}`). Use the `ok_json` helper (house rule for rmcp 0.1.x returns).

- [ ] **Step 3:** PerfHUD meter line: find the dev PerfHUD component (`rg -ln "PerfHUD" apps/desktop/src`) and add one row reading `audioGraph.meterSnapshot()` per HUD refresh — `AUD  rms −18.2 dB  peak −6.1 dB` (em-dash-free ASCII, matching the HUD's existing row format). The Compositor exposes its `AudioGraph` for this (`getAudioGraph(): AudioGraph | null`).

- [ ] **Step 4:** `cargo test` green (emit-grammar smoke if the house emit-smoke pattern applies — check `rg -n "smoke" apps/desktop/src-tauri/src/mcp/mod.rs` and follow it). `npm run typecheck` green for the HUD line.

- [ ] **Step 5: Commit.** `git add -A apps/desktop && git commit -m "feat(audio): MCP descriptions tell the truth + meter resource + HUD row"`

---

## Phase F — Conformance + docs + live verification

### Task F1: Conformance e2e fixtures

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs` (add `--audio-envelope` mode: windowed RMS over the decoded output vs an analytic expectation list)
- Create: `apps/desktop/e2e/specs/audio_envelope.e2e.js` (model line-by-line on `export_range_audio.e2e.js` — project setup via the bridge, export, analyze)

- [ ] **Step 1:** Analyzer mode: `--audio-envelope <json>` where the JSON is `[{ "t_s": number, "expect_rms_db_delta": number }]` — decode the exported file to f32 (existing decode path in the analyzer), compute RMS per 100 ms window, assert each listed window's RMS relative to the file's 0-fade reference window is within ±1.5 dB of the expectation. Unit-test the RMS-window math with a synthetic buffer in the same file.

- [ ] **Step 2:** E2E spec (gated on `WEFTCUT_TEST_MEDIA` like the others): four scenarios on the 30 fps audio fixture — (a) fade-in 1 s: windows at 0.25/0.5/0.75 s expect −12/−6/−2.5 dB deltas; (b) keyframed gain −20→0 dB over the clip; (c) two-layer overlap: full-scale tone + itself at −6 dB, assert the limiter holds output peak ≤ −0.9 dBFS (extend the analyzer with a peak check); (d) pan: `pan = −0.8` on a mono tone clip, assert the per-channel RMS ratio L/R matches the mono pan law `cos/sin((p+1)/2 · π/2)` within ±1 dB (analyzer gains a `--audio-pan` per-channel RMS report for this). Run per `docs/conformance.md` (matched msedgedriver, real WebView2).

- [ ] **Step 3:** Run the whole audio e2e set (existing `audio_conformance.e2e.js` + `export_range_audio.e2e.js` must still pass — the Goertzel gates are level-insensitive, see docs/audio.md).

- [ ] **Step 4: Commit.** `git add -A apps/desktop && git commit -m "test(audio): analytic envelope conformance - fades, keyframed gain, limiter"`

### Task F2: Docs sweep

**Files:**
- Modify: `docs/rendering.md` (replace the "Audio IR" / "Audio-only export" sections with the mixer description, pointing at `docs/audio.md`)
- Modify: `docs/audio.md` (delete the "Design note" blockquote — it ships now)
- Modify: `docs/architecture.md` (audio compositor box: "lower → emit_ffmpeg" → "MixPlan → block mixer → ffmpeg encode tail"; lines 70–80, 123, 135–136, 181)
- Modify: `docs/render.md` (directory-layout audio/ entry + the out-of-scope audio line)
- Modify: `docs/adr/0001-audio-compositing-in-ts.md` (superseded banner: point at `docs/audio.md` + ADR 0019 instead of rendering.md)

- [ ] **Step 1:** Make the edits; keep evergreen voice (no dates/phases).
- [ ] **Step 2: Commit.** `git add docs && git commit -m "docs: audio pipeline docs follow the shipped mixer"`

### Task F3: Live verification (real WebView2)

- [ ] **Step 1:** `npm run dev` (tauri dev) in the worktree — second-instance discipline applies if the user's main checkout is also running (alt vite port, identifier-isolated WebView2; see the dev-instance notes in the team memory). Drive via the mcp-bridge (`webview_execute_js`).
- [ ] **Step 2:** Smoke script: import a video with audio → confirm `conform` job events fire and `Cache/audio/*.conform` appears → play: audio audible, scrub/seek snappy, pause/resume clean → set `gain_db` keyframes via MCP `update_layer` → hear the ramp → set fades → hear them → export with audio → play the file → `media_conformance --audio` on it.
- [ ] **Step 3:** Fix anything found (each fix is its own TDD micro-cycle + commit). This step is done only when the full export → analyzer round-trip passes on a real file.

### Task F4: Final gates + handoff

- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — all green
- [ ] `npm --workspace apps/desktop run test` — all green
- [ ] `npm run typecheck` — clean
- [ ] e2e audio set green (F1)
- [ ] Use superpowers:requesting-code-review, then superpowers:finishing-a-development-branch (merge target: `main`; note the duplicate docs commit also rides `feat/desktop-polish` — git dedupes content on merge, but mention it).

---

## Task dependency order

A1 → A2 → A3 → B1 → B2 → C1 → C2 → C3 → C4 → D1 → D2 → D3 → D4 → D5 → D6 → E1 → F1 → F2 → F3 → F4. (B and C can interleave with D1–D3 if parallelizing, but D4 needs B2+D2+D3, C2 needs B1+C1, C3 needs A3+C2.)

## Out of scope (do NOT build)

Audio-master clock, denoise, retime/speed, true-peak oversampled limiting, mixer/fade UI, >stereo output, loudness normalize, scrub audio, preview audio capture assertions. All specified or listed in `docs/audio.md` §Out of scope.
