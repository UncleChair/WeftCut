# Two-Phase Proxy Implementation Plan

> **Status: implemented, with deviations.** The shipped design generalised this
> plan. It adds a *bypass* route for already-decode-safe sources and a small-file
> *full-proxy-only* route (`jobs::proxy_decision`), cross-platform hwaccel with
> software fallback (`jobs::hwaccel`), and a pending-hash → content-hash migration
> so derivative jobs overlap the import copy. The frontend took a simpler path
> than Tasks 7–9 here: no `quickProxyState` map, `optimizing` flag, or progress
> ring — `mediaReadiness` simply treats a quick proxy or a bypass as ready, and a
> preview/export path split (`previewPlaybackPathFor` / `exportPlaybackPathFor`)
> keeps quick proxies out of export. Authoritative design now lives in
> [ADR 0006](../../adr/0006-two-phase-preview-proxy-with-bypass.md) and
> [ADR 0007](../../adr/0007-derivative-jobs-run-against-a-pending-hash.md); this
> plan is kept for history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow video clips to become usable on the timeline as soon as a fast "Phase 1" proxy is ready, while the full-quality proxy generates in the background.

**Architecture:** Add `quick_proxy_path` to `MediaItem` as a session-scoped artifact. Import spawns `QuickProxy` (Phase 1) first — H.264 sources remux in seconds, HEVC/VP9 transcode at 540p ultrafast with d3d11va HW-decode fallback. Phase 1 completion triggers Phase 2 (existing full proxy job). Phase 2 success clears `quick_proxy_path`. The renderer prefers `proxy_path`, falls back to `quick_proxy_path`. Workspace open clears all `quick_proxy_path` fields.

**Tech Stack:** Rust (Tauri 2 + tokio + ffmpeg-sidecar), React + TypeScript (Zustand state, Tauri events)

---

## File Map

| Action | Path |
|--------|------|
| Modify | `apps/desktop/src-tauri/src/state/media.rs` |
| Modify | `apps/desktop/src-tauri/src/state/actor.rs` |
| Modify | `apps/desktop/src-tauri/src/cache/mod.rs` |
| **Create** | `apps/desktop/src-tauri/src/jobs/quick_proxy.rs` |
| Modify | `apps/desktop/src-tauri/src/jobs/mod.rs` |
| Modify | `apps/desktop/src-tauri/src/preview/mod.rs` |
| Modify | `apps/desktop/src-tauri/src/io/mod.rs` |
| Modify | `apps/desktop/src-tauri/src/commands.rs` |
| Modify | All Rust files with `MediaItem` struct literals (see Task 5) |
| Modify | `apps/desktop/src/ipc/index.ts` |
| Modify | `apps/desktop/src/state/projectStore.ts` |
| Modify | `apps/desktop/src/panels/mediaReadiness.ts` |
| Modify | `apps/desktop/src/panels/mediaReadiness.test.ts` |
| Modify | `apps/desktop/src/timeline/Timeline.tsx` |
| Modify | `apps/desktop/src/App.tsx` |

---

## Task 1: Rust data model — `quick_proxy_path` field + cache path

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/media.rs`
- Modify: `apps/desktop/src-tauri/src/state/actor.rs:200-209`
- Modify: `apps/desktop/src-tauri/src/state/actor.rs:2687-2720`
- Modify: `apps/desktop/src-tauri/src/cache/mod.rs`

- [ ] **Step 1: Add `quick_proxy_path` to `MediaItem`**

  In `apps/desktop/src-tauri/src/state/media.rs`, after `proxy_format_version`:

  ```rust
  #[derive(Clone, Debug, Serialize, Deserialize)]
  pub struct MediaItem {
      pub id: MediaId,
      pub label: Option<String>,
      pub path_abs: PathBuf,
      pub path_rel: Option<PathBuf>,
      pub kind: MediaKind,
      pub metadata: MediaMetadata,
      pub proxy_path: Option<PathBuf>,
      #[serde(default)]
      pub proxy_format_version: u32,
      /// Fast Phase-1 proxy generated before the full proxy is ready.
      /// H.264 remux (seconds) or HEVC/VP9 540p ultrafast (minutes).
      /// Cleared on workspace open and when the full proxy completes.
      #[serde(default)]
      pub quick_proxy_path: Option<PathBuf>,
      pub waveform_path: Option<PathBuf>,
      pub thumbnails_dir: Option<PathBuf>,
      pub file_hash_blake3: String,
      pub file_size: u64,
      pub file_mtime: u64,
      pub imported_at: DateTime<Utc>,
  }
  ```

- [ ] **Step 2: Add `quick_proxy_path` to `MediaDerivativesPatch`**

  In `apps/desktop/src-tauri/src/state/actor.rs`, the `MediaDerivativesPatch` struct (currently at line ~201):

  ```rust
  #[derive(Clone, Debug, Default)]
  pub struct MediaDerivativesPatch {
      pub proxy_path: Option<Option<std::path::PathBuf>>,
      pub proxy_format_version: Option<u32>,
      /// `Some(Some(path))` sets quick proxy; `Some(None)` clears it.
      pub quick_proxy_path: Option<Option<std::path::PathBuf>>,
      pub waveform_path: Option<std::path::PathBuf>,
      pub thumbnails_dir: Option<std::path::PathBuf>,
  }
  ```

- [ ] **Step 3: Handle `quick_proxy_path` in `do_set_media_derivatives`**

  In `apps/desktop/src-tauri/src/state/actor.rs`, inside `do_set_media_derivatives` after the `proxy_format_version` block (currently ~line 2707):

  ```rust
  if let Some(p) = patch.quick_proxy_path {
      item.quick_proxy_path = p;
  }
  ```

  Full updated function body context (replace lines 2702–2715):
  ```rust
  if let Some(p) = patch.proxy_path {
      item.proxy_path = p;
  }
  if let Some(v) = patch.proxy_format_version {
      item.proxy_format_version = v;
  }
  if let Some(p) = patch.quick_proxy_path {
      item.quick_proxy_path = p;
  }
  if let Some(p) = patch.waveform_path {
      item.waveform_path = Some(p);
  }
  if let Some(p) = patch.thumbnails_dir {
      item.thumbnails_dir = Some(p);
  }
  ```

- [ ] **Step 4: Add `quick_proxy()` to `CacheLayout`**

  In `apps/desktop/src-tauri/src/cache/mod.rs`, after the `proxy()` method (currently ~line 102):

  ```rust
  /// Fast Phase-1 proxy for a hashed media file.
  pub fn quick_proxy(&self, hash: &str) -> PathBuf {
      self.proxies_dir().join(format!("{hash}.quick.mp4"))
  }
  ```

- [ ] **Step 5: Add cache test for `quick_proxy` path shape**

  In `apps/desktop/src-tauri/src/cache/mod.rs`, inside the `#[cfg(test)]` block, after the `layout_paths_are_content_addressable` test:

  ```rust
  #[test]
  fn quick_proxy_path_in_proxies_dir() {
      let tmp = TempDir::new().unwrap();
      let layout = CacheLayout::new(tmp.path().to_path_buf());
      assert_eq!(
          layout.quick_proxy("abc"),
          tmp.path().join("proxies").join("abc.quick.mp4"),
      );
  }
  ```

- [ ] **Step 6: Run Rust tests to verify step 5 passes**

  ```
  cd apps/desktop/src-tauri
  cargo test -p desktop cache -- --nocapture
  ```

  Expected: the new test passes; all existing cache tests still pass.

- [ ] **Step 7: Commit**

  ```bash
  git add apps/desktop/src-tauri/src/state/media.rs \
          apps/desktop/src-tauri/src/state/actor.rs \
          apps/desktop/src-tauri/src/cache/mod.rs
  git commit -m "feat(proxy): add quick_proxy_path to MediaItem, patch, and cache layout"
  ```

---

## Task 2: Phase 1 job — `jobs/quick_proxy.rs`

**Files:**
- Create: `apps/desktop/src-tauri/src/jobs/quick_proxy.rs`

- [ ] **Step 1: Write Phase 1 codec-routing test (failing)**

  Create `apps/desktop/src-tauri/src/jobs/quick_proxy.rs` with just the test:

  ```rust
  //! Phase-1 "quick proxy": fast path to make a video usable on the
  //! timeline while the full proxy generates in the background.
  //!
  //! Strategy depends on source codec:
  //!   h264 → remux to MP4 + faststart (`-c:v copy`), seconds.
  //!   other (hevc, vp9, …) → 540p libx264 ultrafast, with d3d11va
  //!       HW-decode attempted first then retried in software.
  //!
  //! Output: `<cache>/proxies/<hash>.quick.mp4`

  use std::path::PathBuf;
  use std::process::Stdio;

  use anyhow::{Context, Result};
  use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
  use tokio::process::Command;

  use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
  use crate::state::MediaItem;

  pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
      todo!("implement in next step")
  }

  fn codec(media: &MediaItem) -> &str {
      media
          .metadata
          .video
          .as_ref()
          .map(|v| v.codec.as_str())
          .unwrap_or("")
  }

  #[cfg(test)]
  mod tests {
      use super::*;

      fn media_with_codec(c: &str) -> MediaItem {
          use crate::state::{MediaKind, MediaMetadata, VideoStreamMeta, new_id};
          use chrono::Utc;
          MediaItem {
              id: new_id(),
              label: None,
              path_abs: "x.mp4".into(),
              path_rel: None,
              kind: MediaKind::Video,
              metadata: MediaMetadata {
                  duration_us: Some(1_000_000),
                  video: Some(VideoStreamMeta {
                      width: 1920,
                      height: 1080,
                      fps_num: 30,
                      fps_den: 1,
                      codec: c.into(),
                      pix_fmt: "yuv420p".into(),
                  }),
                  audio: None,
              },
              proxy_path: None,
              proxy_format_version: 0,
              quick_proxy_path: None,
              waveform_path: None,
              thumbnails_dir: None,
              file_hash_blake3: "test".into(),
              file_size: 0,
              file_mtime: 0,
              imported_at: Utc::now(),
          }
      }

      #[test]
      fn h264_codec_identified() {
          assert_eq!(codec(&media_with_codec("h264")), "h264");
      }

      #[test]
      fn hevc_codec_identified() {
          assert_eq!(codec(&media_with_codec("hevc")), "hevc");
      }

      #[test]
      fn vp9_codec_identified() {
          assert_eq!(codec(&media_with_codec("vp9")), "vp9");
      }
  }
  ```

- [ ] **Step 2: Run tests to verify they fail correctly**

  ```
  cd apps/desktop/src-tauri
  cargo test -p desktop quick_proxy -- --nocapture 2>&1 | head -30
  ```

  Expected: `h264_codec_identified`, `hevc_codec_identified`, `vp9_codec_identified` all PASS (they only test `codec()`). The compile of `run` fails because of `todo!` — that's fine for now; test the `codec` helper by commenting out `run` temporarily or verifying the unit tests compile separately.

  Actually the unit tests don't call `run`, so they should compile and pass once the struct literal compiles. If Task 5 (struct literals) is not done yet, this will fail to compile — do Task 5 first if needed.

- [ ] **Step 3: Implement `run()` with remux + fast-transcode paths**

  Replace `todo!("implement in next step")` in `run()`:

  ```rust
  pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
      if !ffmpeg_is_installed() {
          anyhow::bail!("ffmpeg not installed; cannot generate quick proxy");
      }

      let dest = cache.quick_proxy(&media.file_hash_blake3);
      if cached_ok(&dest) {
          return Ok(dest);
      }
      let tmp = temp_path(&dest);
      let _ = tokio::fs::remove_file(&tmp).await;

      if codec(media) == "h264" {
          run_remux(media, &tmp).await?;
      } else {
          run_fast_transcode(media, &tmp).await?;
      }

      if !cached_ok(&tmp) {
          discard_temp(&dest);
          anyhow::bail!(
              "ffmpeg returned success but quick proxy is missing or zero bytes at {}",
              tmp.display()
          );
      }

      promote_temp(&dest)?;
      Ok(dest)
  }

  /// H.264 source: remux only — copy video stream, transcode audio to AAC.
  /// Container: MP4 + faststart. Takes seconds for any duration.
  async fn run_remux(media: &MediaItem, tmp: &PathBuf) -> Result<()> {
      let output = Command::new(ffmpeg_path())
          .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i"])
          .arg(&media.path_abs)
          .args([
              "-c:v", "copy",
              "-c:a", "aac",
              "-b:a", "128k",
              "-movflags", "+faststart",
              "-f", "mp4",
          ])
          .arg(tmp)
          .stdin(Stdio::null())
          .stdout(Stdio::null())
          .stderr(Stdio::piped())
          .output()
          .await
          .context("spawn ffmpeg for quick proxy remux")?;

      if !output.status.success() {
          let stderr = String::from_utf8_lossy(&output.stderr);
          anyhow::bail!(
              "ffmpeg remux exited with {}: {}",
              output.status,
              stderr.trim()
          );
      }
      Ok(())
  }

  /// Non-H.264 source (HEVC, VP9, etc.): fast 540p transcode.
  /// Attempts d3d11va hardware decode first; falls back to software on failure.
  async fn run_fast_transcode(media: &MediaItem, tmp: &PathBuf) -> Result<()> {
      // First attempt: hardware decode (d3d11va)
      let hw_result = run_fast_transcode_inner(media, tmp, true).await;
      if hw_result.is_ok() {
          return hw_result;
      }
      // Retry without hardware decode
      let _ = tokio::fs::remove_file(tmp).await;
      run_fast_transcode_inner(media, tmp, false).await
  }

  async fn run_fast_transcode_inner(
      media: &MediaItem,
      tmp: &PathBuf,
      hw_decode: bool,
  ) -> Result<()> {
      let mut cmd = Command::new(ffmpeg_path());
      cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"]);

      if hw_decode {
          cmd.args(["-hwaccel", "d3d11va"]);
      }

      cmd.arg("-i")
          .arg(&media.path_abs)
          .args([
              "-vf", "scale=-2:'min(ih,540)'",
              "-c:v", "libx264",
              "-preset", "ultrafast",
              "-crf", "30",
              "-c:a", "aac",
              "-b:a", "128k",
              "-movflags", "+faststart",
              "-f", "mp4",
          ])
          .arg(tmp)
          .stdin(Stdio::null())
          .stdout(Stdio::null())
          .stderr(Stdio::piped());

      let output = cmd.output().await.context("spawn ffmpeg for quick proxy transcode")?;

      if !output.status.success() {
          let stderr = String::from_utf8_lossy(&output.stderr);
          anyhow::bail!(
              "ffmpeg fast transcode exited with {}: {}",
              output.status,
              stderr.trim()
          );
      }
      Ok(())
  }
  ```

- [ ] **Step 4: Add integration test for remux path**

  At the bottom of the `#[cfg(test)]` block in `quick_proxy.rs`, add after the unit tests:

  ```rust
      fn ffmpeg_available() -> bool {
          std::process::Command::new("ffmpeg")
              .arg("-version")
              .output()
              .map(|o| o.status.success())
              .unwrap_or(false)
      }

      async fn make_h264_mp4(dest: &std::path::Path) -> Result<()> {
          let status = Command::new("ffmpeg")
              .args([
                  "-y", "-hide_banner", "-loglevel", "error",
                  "-f", "lavfi", "-i", "testsrc=duration=4:size=640x360:rate=30",
                  "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
                  "-c:v", "libx264", "-preset", "ultrafast",
                  "-c:a", "aac", "-pix_fmt", "yuv420p", "-t", "4",
              ])
              .arg(dest)
              .status()
              .await?;
          if !status.success() {
              anyhow::bail!("h264 fixture ffmpeg failed");
          }
          Ok(())
      }

      #[tokio::test]
      async fn quick_proxy_remux_h264() {
          if !ffmpeg_available() {
              eprintln!("ffmpeg not on PATH — skipping quick proxy smoke");
              return;
          }
          let tmp = tempfile::TempDir::new().unwrap();
          let cache = CacheLayout::new(tmp.path().join("cache"));
          cache.ensure_dirs().unwrap();
          let video = tmp.path().join("source.mp4");
          make_h264_mp4(&video).await.expect("h264 fixture");

          let mut media = media_with_codec("h264");
          media.path_abs = video;
          media.file_hash_blake3 = "h264test".into();

          let qp = run(&cache, &media).await.expect("quick proxy remux");
          assert!(cached_ok(&qp), "quick proxy file missing or empty");

          // Must be valid MP4
          let out = Command::new("ffprobe")
              .args(["-v", "quiet", "-print_format", "json", "-show_format"])
              .arg(&qp)
              .output()
              .await
              .expect("ffprobe");
          assert!(out.status.success(), "ffprobe rejected quick proxy output");
      }

      #[tokio::test]
      async fn quick_proxy_skips_when_cached() {
          let tmp = tempfile::TempDir::new().unwrap();
          let cache = CacheLayout::new(tmp.path().join("cache"));
          cache.ensure_dirs().unwrap();
          let hash = "already_cached";
          let dest = cache.quick_proxy(hash);
          tokio::fs::create_dir_all(dest.parent().unwrap()).await.unwrap();
          tokio::fs::write(&dest, b"sentinel").await.unwrap();

          let mut media = media_with_codec("h264");
          media.file_hash_blake3 = hash.into();

          let returned = run(&cache, &media).await.expect("cache hit");
          assert_eq!(returned, dest);
          assert_eq!(tokio::fs::read(&dest).await.unwrap(), b"sentinel");
      }
  ```

- [ ] **Step 5: Run quick_proxy tests**

  ```
  cd apps/desktop/src-tauri
  cargo test -p desktop quick_proxy -- --nocapture
  ```

  Expected: unit tests pass; `quick_proxy_skips_when_cached` passes; `quick_proxy_remux_h264` passes if ffmpeg is on PATH.

- [ ] **Step 6: Register module in `jobs/mod.rs`**

  In `apps/desktop/src-tauri/src/jobs/mod.rs`, add after `mod frame;`:

  ```rust
  pub mod quick_proxy;
  ```

  Also add the re-export after the existing ones:
  ```rust
  pub use quick_proxy::run as run_quick_proxy;
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add apps/desktop/src-tauri/src/jobs/quick_proxy.rs \
          apps/desktop/src-tauri/src/jobs/mod.rs
  git commit -m "feat(proxy): implement Phase-1 quick proxy job (remux / fast transcode)"
  ```

---

## Task 3: Job pipeline wiring

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs`

The goal: `enqueue_for_media` spawns `QuickProxy` instead of `Proxy`. `spawn_quick_proxy` chains to `spawn_proxy` on both success and failure. `spawn_proxy` on success clears the quick proxy file and field.

- [ ] **Step 1: Add `JobKind::QuickProxy`**

  In `jobs/mod.rs`, update the `JobKind` enum (currently ~line 56):

  ```rust
  #[derive(Debug, Clone, Copy, Serialize)]
  #[serde(rename_all = "lowercase")]
  pub enum JobKind {
      Thumbnails,
      Proxy,
      Waveform,
      #[serde(rename = "quick_proxy")]
      QuickProxy,
  }
  ```

- [ ] **Step 2: Update `enqueue_for_media` to call `spawn_quick_proxy`**

  Replace `spawn_proxy(...)` with `spawn_quick_proxy(...)` in the `MediaKind::Video` branch (lines ~93-101):

  ```rust
  MediaKind::Video => {
      spawn_thumbnails(app.clone(), cache.clone(), project.clone(), media.clone());
      spawn_quick_proxy(app.clone(), cache.clone(), project.clone(), media.clone());
      if media.metadata.audio.is_some() {
          spawn_waveform(app.clone(), cache.clone(), project.clone(), media.clone());
      }
  }
  ```

- [ ] **Step 3: Add `spawn_quick_proxy` function**

  Add after `spawn_thumbnails` in `jobs/mod.rs`:

  ```rust
  fn spawn_quick_proxy(
      app: AppHandle,
      cache: CacheLayout,
      project: ProjectHandle,
      media: MediaItem,
  ) {
      tokio::spawn(async move {
          let media_id = media.id;

          // If the full proxy already exists, skip Phase 1 entirely —
          // spawn Phase 2 directly so it cache-hits and returns fast.
          let full_dest = cache.proxy(&media.file_hash_blake3);
          if crate::cache::cached_ok(&full_dest) {
              spawn_proxy(app, cache, project, media);
              return;
          }

          emit(&app, EVENT_STARTED, &JobStarted {
              media_id: media_id.to_string(),
              kind: JobKind::QuickProxy,
          });

          let permit = ffmpeg_sem().acquire().await;
          if permit.is_err() {
              warn!("quick proxy job: semaphore closed; skipping {media_id}");
              return;
          }
          let result = quick_proxy::run(&cache, &media).await;
          drop(permit);

          match result {
              Ok(qp_path) => {
                  let path_str = qp_path.display().to_string();
                  let patch = MediaDerivativesPatch {
                      quick_proxy_path: Some(Some(qp_path)),
                      ..Default::default()
                  };
                  if let Err(e) = project
                      .set_media_derivatives(actor_for_jobs(), media_id, patch)
                      .await
                  {
                      warn!("quick proxy commit failed for {media_id}: {e}");
                      emit(&app, EVENT_ERROR, &JobError {
                          media_id: media_id.to_string(),
                          kind: JobKind::QuickProxy,
                          error: format!("commit: {e}"),
                      });
                  } else {
                      info!("quick proxy ready for {media_id}");
                      emit(&app, EVENT_COMPLETE, &JobComplete {
                          media_id: media_id.to_string(),
                          kind: JobKind::QuickProxy,
                          path: Some(path_str),
                      });
                  }
              }
              Err(e) => {
                  warn!("quick proxy job failed for {media_id}: {e:#}");
                  emit(&app, EVENT_ERROR, &JobError {
                      media_id: media_id.to_string(),
                      kind: JobKind::QuickProxy,
                      error: format!("{e:#}"),
                  });
              }
          }

          // Always chain Phase 2, whether Phase 1 succeeded or failed.
          spawn_proxy(app, cache, project, media);
      });
  }
  ```

- [ ] **Step 4: Update `spawn_proxy` to clear quick proxy on Phase 2 success**

  In the `Ok(proxy_path)` branch of `spawn_proxy` (currently ~line 192), before the `MediaDerivativesPatch` construction, add the quick proxy file deletion, and include `quick_proxy_path: Some(None)` in the patch:

  ```rust
  Ok(proxy_path) => {
      // Phase 2 complete — delete the quick proxy file now that the
      // full proxy is ready. Best-effort; failure is non-fatal.
      let quick_path = cache.quick_proxy(&media.file_hash_blake3);
      if let Err(e) = tokio::fs::remove_file(&quick_path).await {
          if e.kind() != std::io::ErrorKind::NotFound {
              warn!("quick proxy cleanup failed for {media_id}: {e}");
          }
      }

      let path_str = proxy_path.display().to_string();
      let patch = MediaDerivativesPatch {
          proxy_path: Some(Some(proxy_path)),
          proxy_format_version: Some(proxy::PROXY_FORMAT_VERSION),
          quick_proxy_path: Some(None),  // clear quick proxy reference
          ..Default::default()
      };
      // ... rest of existing code unchanged
  ```

- [ ] **Step 5: Build to verify no compile errors**

  ```
  cd apps/desktop/src-tauri
  cargo build -p desktop 2>&1 | tail -20
  ```

  Expected: `Compiling desktop` then `Finished`. If struct literal errors appear, proceed to Task 5 first then return here.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/desktop/src-tauri/src/jobs/mod.rs
  git commit -m "feat(proxy): wire two-phase pipeline — QuickProxy chains to Proxy"
  ```

---

## Task 4: Preview substitution + workspace open cleanup

**Files:**
- Modify: `apps/desktop/src-tauri/src/preview/mod.rs`
- Modify: `apps/desktop/src-tauri/src/io/mod.rs`

- [ ] **Step 1: Write test for `with_proxies_substituted` quick proxy fallback**

  In `apps/desktop/src-tauri/src/preview/mod.rs`, add a `#[cfg(test)]` block at the bottom:

  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use crate::state::{MediaItem, MediaKind, MediaMetadata, ids::new_id};
      use chrono::Utc;
      use tempfile::TempDir;

      fn base_item(tmp: &std::path::Path) -> MediaItem {
          MediaItem {
              id: new_id(),
              label: None,
              path_abs: tmp.join("source.mp4"),
              path_rel: None,
              kind: MediaKind::Video,
              metadata: MediaMetadata::default(),
              proxy_path: None,
              proxy_format_version: 0,
              quick_proxy_path: None,
              waveform_path: None,
              thumbnails_dir: None,
              file_hash_blake3: "abc".into(),
              file_size: 0,
              file_mtime: 0,
              imported_at: Utc::now(),
          }
      }

      #[test]
      fn prefers_proxy_path_over_quick_proxy() {
          let tmp = TempDir::new().unwrap();
          let proxy_file = tmp.path().join("proxy.mp4");
          let quick_file = tmp.path().join("quick.mp4");
          std::fs::write(&proxy_file, b"proxy").unwrap();
          std::fs::write(&quick_file, b"quick").unwrap();

          let mut project = Project::new_blank("test");
          let mut item = base_item(tmp.path());
          item.proxy_path = Some(proxy_file.clone());
          item.quick_proxy_path = Some(quick_file.clone());
          project.media_pool.insert(item.id, item.clone());

          let sub = with_proxies_substituted(&project);
          let substituted = sub.media_pool.get(&item.id).unwrap();
          assert_eq!(substituted.path_abs, proxy_file, "proxy_path should win");
      }

      #[test]
      fn falls_back_to_quick_proxy_when_no_full_proxy() {
          let tmp = TempDir::new().unwrap();
          let quick_file = tmp.path().join("quick.mp4");
          std::fs::write(&quick_file, b"quick").unwrap();

          let mut project = Project::new_blank("test");
          let mut item = base_item(tmp.path());
          item.quick_proxy_path = Some(quick_file.clone());
          project.media_pool.insert(item.id, item.clone());

          let sub = with_proxies_substituted(&project);
          let substituted = sub.media_pool.get(&item.id).unwrap();
          assert_eq!(substituted.path_abs, quick_file, "should fall back to quick_proxy_path");
      }

      #[test]
      fn no_substitution_when_neither_proxy_exists_on_disk() {
          let tmp = TempDir::new().unwrap();
          let source = tmp.path().join("source.mp4");

          let mut project = Project::new_blank("test");
          let mut item = base_item(tmp.path());
          item.path_abs = source.clone();
          item.proxy_path = Some(tmp.path().join("nonexistent.mp4"));
          item.quick_proxy_path = Some(tmp.path().join("nonexistent.quick.mp4"));
          project.media_pool.insert(item.id, item.clone());

          let sub = with_proxies_substituted(&project);
          let substituted = sub.media_pool.get(&item.id).unwrap();
          assert_eq!(substituted.path_abs, source, "no file on disk → keep source path");
      }
  }
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```
  cd apps/desktop/src-tauri
  cargo test -p desktop preview -- --nocapture 2>&1 | tail -20
  ```

  Expected: `falls_back_to_quick_proxy_when_no_full_proxy` FAILS (function not yet updated).

- [ ] **Step 3: Update `with_proxies_substituted`**

  Replace the entire function body in `preview/mod.rs`:

  ```rust
  pub fn with_proxies_substituted(project: &Project) -> Project {
      let mut next = project.clone();
      let updates: Vec<_> = next
          .media_pool
          .iter()
          .filter_map(|(id, item)| {
              // Prefer full proxy; fall back to quick proxy.
              let proxy = item
                  .proxy_path
                  .as_ref()
                  .filter(|p| p.is_file())
                  .or_else(|| item.quick_proxy_path.as_ref().filter(|p| p.is_file()))?;
              let mut swapped = item.clone();
              swapped.path_abs = proxy.clone();
              Some((*id, swapped))
          })
          .collect();
      for (id, item) in updates {
          next.media_pool.insert(id, item);
      }
      next
  }
  ```

- [ ] **Step 4: Run preview tests to verify they pass**

  ```
  cd apps/desktop/src-tauri
  cargo test -p desktop preview -- --nocapture
  ```

  Expected: all 3 new tests PASS.

- [ ] **Step 5: Write test for workspace-open quick proxy clearing**

  In `apps/desktop/src-tauri/src/io/mod.rs`, inside the `#[cfg(test)]` block:

  ```rust
  #[tokio::test]
  async fn workspace_open_clears_quick_proxy_refs() {
      use crate::state::{MediaItem, MediaKind, MediaMetadata, ids::new_id};
      use chrono::Utc;
      let dir = TempDir::new().unwrap();
      let vproj = dir.path().join("qp_test.vproj");

      let mut project = Project::new_blank("qp-clear-test");
      let quick_file = dir.path().join("quick.mp4");
      std::fs::write(&quick_file, b"quick").unwrap();

      let item = MediaItem {
          id: new_id(),
          label: None,
          path_abs: dir.path().join("source.mp4"),
          path_rel: None,
          kind: MediaKind::Video,
          metadata: MediaMetadata::default(),
          proxy_path: None,
          proxy_format_version: 0,
          quick_proxy_path: Some(quick_file.clone()),
          waveform_path: None,
          thumbnails_dir: None,
          file_hash_blake3: "qptest".into(),
          file_size: 0,
          file_mtime: 0,
          imported_at: Utc::now(),
      };
      project.media_pool.insert(item.id, item.clone());
      save_to_dir(&project, &vproj).await.expect("save");

      let loaded = load_from_dir(&vproj).await.expect("load");
      let loaded_item = loaded.media_pool.get(&item.id).unwrap();
      assert!(
          loaded_item.quick_proxy_path.is_none(),
          "quick_proxy_path must be cleared on workspace open"
      );
      assert!(
          !quick_file.exists(),
          "quick proxy file must be deleted on workspace open"
      );
  }
  ```

- [ ] **Step 6: Run the test to verify it fails**

  ```
  cd apps/desktop/src-tauri
  cargo test -p desktop io::tests::workspace_open_clears_quick_proxy_refs -- --nocapture
  ```

  Expected: FAIL (function doesn't clear quick proxies yet).

- [ ] **Step 7: Add `clear_quick_proxy_cache` to `io/mod.rs`**

  Add this function before the existing `invalidate_stale_proxies`:

  ```rust
  /// Clear all `quick_proxy_path` fields on workspace open. Quick proxies
  /// are session-scoped: they are generated again on the next session if
  /// the full proxy hasn't landed yet, so there is no point preserving
  /// stale `.quick.mp4` files across sessions.
  async fn clear_quick_proxy_cache(project: &mut crate::state::Project) {
      for item in project.media_pool.values_mut() {
          if let Some(path) = item.quick_proxy_path.take() {
              if let Err(e) = tokio::fs::remove_file(&path).await {
                  if e.kind() != std::io::ErrorKind::NotFound {
                      warn!(
                          "quick proxy cleanup failed for {} (non-fatal): {e}",
                          path.display()
                      );
                  }
              }
          }
      }
  }
  ```

  Then in `load_from_dir`, after `invalidate_stale_proxies(&mut project).await;` add:

  ```rust
  clear_quick_proxy_cache(&mut project).await;
  ```

- [ ] **Step 8: Run io tests to verify the new test passes**

  ```
  cd apps/desktop/src-tauri
  cargo test -p desktop io -- --nocapture
  ```

  Expected: `workspace_open_clears_quick_proxy_refs` PASSES; all other io tests still pass.

- [ ] **Step 9: Commit**

  ```bash
  git add apps/desktop/src-tauri/src/preview/mod.rs \
          apps/desktop/src-tauri/src/io/mod.rs
  git commit -m "feat(proxy): preview falls back to quick proxy; workspace open clears quick proxy"
  ```

---

## Task 5: `MediaItem` struct literal updates + `MediaSummary` extension

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs`
- Modify: `apps/desktop/src-tauri/src/jobs/proxy.rs` (test fixtures)
- Modify: `apps/desktop/src-tauri/src/jobs/thumbnails.rs` (test fixtures)
- Modify: `apps/desktop/src-tauri/src/jobs/waveform.rs` (test fixtures)
- Modify: `apps/desktop/src-tauri/src/workspace.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs`
- Modify: `apps/desktop/src-tauri/src/ir/mod.rs`
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` (test fixtures)

The new `quick_proxy_path` field has `#[serde(default)]` so JSON deserialization is already backward-compatible. The only thing needed is to add `quick_proxy_path: None` to every Rust struct literal that constructs a `MediaItem`.

- [ ] **Step 1: Try to build to see all compile errors**

  ```
  cd apps/desktop/src-tauri
  cargo build -p desktop 2>&1 | grep "error\[E" | head -40
  ```

  This lists every file with a `MediaItem` struct literal that is missing the new field.

- [ ] **Step 2: Add `quick_proxy_path: None` to all MediaItem struct literals**

  For each file reported above, find every `MediaItem { ... }` literal and add `quick_proxy_path: None,` after `proxy_format_version: 0,`.

  The files known to contain these literals (from earlier grep):
  - `commands.rs` line ~1512 (import_media command)
  - `mcp/mod.rs` lines ~811, ~1341, ~3271 (three MediaItem constructions)
  - `ir/mod.rs` line ~55 (one MediaItem construction)
  - `workspace.rs` line ~70 (one MediaItem construction)
  - `jobs/proxy.rs` test fixtures (lines ~242, ~328, ~364 — `media_with_fps` helper + two inline items)
  - `jobs/thumbnails.rs` test fixtures (lines ~206, ~255, ~287)
  - `jobs/waveform.rs` test fixtures (lines ~290, ~344)
  - `state/actor.rs` test fixtures (lines ~5996–5999, ~6032)

  For each, the pattern is: find `proxy_format_version: 0,` and add the new field on the next line:

  ```rust
  proxy_format_version: 0,
  quick_proxy_path: None,
  ```

- [ ] **Step 3: Add `quick_proxy_path` to the Rust `MediaSummary` struct**

  In `commands.rs`, the `MediaSummary` struct (currently ~line 214):

  ```rust
  #[derive(Serialize, Clone)]
  pub struct MediaSummary {
      pub id: String,
      pub label: String,
      pub path: String,
      pub kind: String,
      pub duration_us: Option<i64>,
      pub width: Option<u32>,
      pub height: Option<u32>,
      pub size_bytes: u64,
      pub available: bool,
      pub proxy_path: Option<String>,
      /// Absolute path of the Phase-1 fast proxy, if generated and present on
      /// disk. `null` once the full proxy is ready (Phase 2 clears this) or
      /// until Phase 1 completes.
      pub quick_proxy_path: Option<String>,
  }
  ```

- [ ] **Step 4: Populate `quick_proxy_path` in the `MediaSummary` mapping**

  In `commands.rs`, inside the `.map(|m| { ... })` closure that builds `MediaSummary` (currently ~line 374), add after the existing `proxy_path` block:

  ```rust
  let quick_proxy_path = m
      .quick_proxy_path
      .as_ref()
      .and_then(|p| p.is_file().then(|| p.to_string_lossy().to_string()));
  ```

  Then include it in the struct literal:
  ```rust
  MediaSummary {
      id: m.id.to_string(),
      label,
      path: m.path_abs.to_string_lossy().to_string(),
      kind: format!("{:?}", m.kind),
      duration_us: m.metadata.duration_us,
      width: m.metadata.video.as_ref().map(|v| v.width),
      height: m.metadata.video.as_ref().map(|v| v.height),
      size_bytes: m.file_size,
      available: m.path_abs.is_file(),
      proxy_path,
      quick_proxy_path,
  }
  ```

- [ ] **Step 5: Build to verify clean compile**

  ```
  cd apps/desktop/src-tauri
  cargo build -p desktop 2>&1 | tail -5
  ```

  Expected: `Finished` with no errors.

- [ ] **Step 6: Run all Rust tests**

  ```
  cd apps/desktop/src-tauri
  cargo test -p desktop 2>&1 | tail -20
  ```

  Expected: all tests pass (0 failures).

- [ ] **Step 7: Commit**

  ```bash
  git add apps/desktop/src-tauri/src/
  git commit -m "feat(proxy): add quick_proxy_path to MediaItem literals and MediaSummary"
  ```

---

## Task 6: Frontend IPC types + playback path fallback

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts`
- Modify: `apps/desktop/src/state/projectStore.ts`

- [ ] **Step 1: Add `quick_proxy_path` to TypeScript `MediaSummary`**

  In `apps/desktop/src/ipc/index.ts`, update `MediaSummary` (currently ~line 25):

  ```typescript
  export interface MediaSummary {
    id: string;
    label: string;
    path: string;
    kind: string;
    duration_us: number | null;
    width: number | null;
    height: number | null;
    size_bytes: number;
    available: boolean;
    /// Full-quality Phase-2 proxy path. null while pending.
    proxy_path: string | null;
    /// Phase-1 fast proxy path. Present while Phase 2 is still generating;
    /// null once Phase 2 completes (Phase 2 clears this).
    quick_proxy_path: string | null;
  }
  ```

- [ ] **Step 2: Update `playbackPathFor` to prefer proxy, fall back to quick proxy**

  In `apps/desktop/src/state/projectStore.ts`, line ~149:

  ```typescript
  export function playbackPathFor(media: MediaSummary | undefined): string | null {
    if (!media) return null;
    return media.proxy_path ?? media.quick_proxy_path ?? media.path;
  }
  ```

- [ ] **Step 3: Run TypeScript type check**

  ```
  cd apps/desktop
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: any type errors are only about the new `quick_proxy_path` field being referenced as `undefined` in places that expect `string | null`. Fix any such occurrences.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/desktop/src/ipc/index.ts \
          apps/desktop/src/state/projectStore.ts
  git commit -m "feat(proxy): add quick_proxy_path to TS MediaSummary and playbackPathFor"
  ```

---

## Task 7: Frontend `mediaReadiness` — two-phase proxy states

**Files:**
- Modify: `apps/desktop/src/panels/mediaReadiness.ts`
- Modify: `apps/desktop/src/panels/mediaReadiness.test.ts`

- [ ] **Step 1: Write failing tests for the new states**

  Replace the full content of `mediaReadiness.test.ts`:

  ```typescript
  import { describe, expect, it } from "vitest";
  import type { MediaSummary } from "../ipc";
  import { mediaReadiness, type ProxyState } from "./mediaReadiness";

  const baseVideo = (over: Partial<MediaSummary> = {}): MediaSummary => ({
    id: "m1",
    label: "clip.mp4",
    path: "C:/m/clip.mp4",
    kind: "Video",
    duration_us: 5_000_000,
    width: 1920,
    height: 1080,
    size_bytes: 10_000_000,
    available: true,
    proxy_path: null,
    quick_proxy_path: null,
    ...over,
  });

  const baseAudio = (over: Partial<MediaSummary> = {}): MediaSummary => ({
    ...baseVideo({ kind: "Audio", width: null, height: null }),
    ...over,
  });

  const empty = new Map<string, ProxyState>();

  describe("mediaReadiness — Phase 2 (full proxy)", () => {
    it("ready when proxy_path is set", () => {
      expect(
        mediaReadiness(baseVideo({ proxy_path: "p.mp4" }), new Set(), empty, empty),
      ).toEqual({ ready: true, optimizing: false });
    });

    it("ready when proxyState map says ready", () => {
      expect(
        mediaReadiness(baseVideo(), new Set(), new Map([["m1", "ready"]]), empty),
      ).toEqual({ ready: true, optimizing: false });
    });
  });

  describe("mediaReadiness — Phase 1 (quick proxy)", () => {
    it("ready with optimizing=true when quick_proxy_path is set and no full proxy", () => {
      expect(
        mediaReadiness(baseVideo({ quick_proxy_path: "q.mp4" }), new Set(), empty, empty),
      ).toEqual({ ready: true, optimizing: true });
    });

    it("ready with optimizing=true when quickProxyState map says ready", () => {
      expect(
        mediaReadiness(baseVideo(), new Set(), empty, new Map([["m1", "ready"]])),
      ).toEqual({ ready: true, optimizing: true });
    });

    it("optimizing=false when full proxy also succeeds (proxy_path wins)", () => {
      expect(
        mediaReadiness(
          baseVideo({ proxy_path: "p.mp4", quick_proxy_path: "q.mp4" }),
          new Set(), empty, empty,
        ),
      ).toEqual({ ready: true, optimizing: false });
    });
  });

  describe("mediaReadiness — failure / pending", () => {
    it("proxy_pending when no path and no map entries", () => {
      expect(mediaReadiness(baseVideo(), new Set(), empty, empty)).toEqual({
        ready: false,
        reason: "proxy_pending",
      });
    });

    it("proxy_pending when proxy explicitly pending in map", () => {
      expect(
        mediaReadiness(baseVideo(), new Set(), new Map([["m1", "pending"]]), empty),
      ).toEqual({ ready: false, reason: "proxy_pending" });
    });

    it("proxy_failed when full proxy fails and no quick proxy available", () => {
      expect(
        mediaReadiness(baseVideo(), new Set(), new Map([["m1", "failed"]]), empty),
      ).toEqual({ ready: false, reason: "proxy_failed" });
    });

    it("still ready (optimizing=false) when full proxy failed but quick proxy exists", () => {
      expect(
        mediaReadiness(
          baseVideo({ quick_proxy_path: "q.mp4" }),
          new Set(), new Map([["m1", "failed"]]), empty,
        ),
      ).toEqual({ ready: true, optimizing: false });
    });
  });

  describe("mediaReadiness — precedence", () => {
    it("importing beats proxy_path", () => {
      expect(
        mediaReadiness(baseVideo({ proxy_path: "p.mp4" }), new Set(["m1"]), empty, empty),
      ).toEqual({ ready: false, reason: "importing" });
    });

    it("missing beats proxy_path", () => {
      expect(
        mediaReadiness(
          baseVideo({ available: false }),
          new Set(), new Map([["m1", "ready"]]), empty,
        ),
      ).toEqual({ ready: false, reason: "missing" });
    });

    it("importing beats missing", () => {
      expect(
        mediaReadiness(baseVideo({ available: false }), new Set(["m1"]), empty, empty),
      ).toEqual({ ready: false, reason: "importing" });
    });
  });

  describe("mediaReadiness — non-video kinds", () => {
    it("audio is ready once import done", () => {
      expect(mediaReadiness(baseAudio(), new Set(), empty, empty)).toEqual({
        ready: true,
        optimizing: false,
      });
    });

    it("image is ready once import done", () => {
      expect(
        mediaReadiness(baseVideo({ kind: "Image", duration_us: null }), new Set(), empty, empty),
      ).toEqual({ ready: true, optimizing: false });
    });

    it("subtitle is ready once import done", () => {
      expect(
        mediaReadiness(baseVideo({ kind: "Subtitle", duration_us: null }), new Set(), empty, empty),
      ).toEqual({ ready: true, optimizing: false });
    });

    it("audio respects importing", () => {
      expect(mediaReadiness(baseAudio(), new Set(["m1"]), empty, empty)).toEqual({
        ready: false,
        reason: "importing",
      });
    });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```
  cd apps/desktop
  npx vitest run src/panels/mediaReadiness.test.ts 2>&1 | tail -20
  ```

  Expected: tests fail because `mediaReadiness` doesn't accept 4 arguments yet and `optimizing` field is missing.

- [ ] **Step 3: Rewrite `mediaReadiness.ts`**

  Replace the full content of `apps/desktop/src/panels/mediaReadiness.ts`:

  ```typescript
  import type { MediaSummary } from "../ipc";

  export type ProxyState = "pending" | "ready" | "failed";

  export type MediaReadiness =
    | { ready: true; optimizing: boolean }
    | {
        ready: false;
        reason: "importing" | "missing" | "proxy_pending" | "proxy_failed";
      };

  /// Single source of truth for "may the user act on this media?"
  ///
  /// `proxyState`      — session-scoped map driven by `kind === "proxy"` events (Phase 2).
  /// `quickProxyState` — session-scoped map driven by `kind === "quick_proxy"` events (Phase 1).
  ///
  /// Precedence: importing > missing > full-proxy-ready > quick-proxy-ready >
  /// full-proxy-failed > pending.
  export function mediaReadiness(
    media: MediaSummary,
    importingIds: ReadonlySet<string>,
    proxyState: ReadonlyMap<string, ProxyState>,
    quickProxyState: ReadonlyMap<string, ProxyState>,
  ): MediaReadiness {
    if (importingIds.has(media.id)) {
      return { ready: false, reason: "importing" };
    }
    if (!media.available) {
      return { ready: false, reason: "missing" };
    }
    if (media.kind === "Video") {
      const fullReady =
        !!media.proxy_path || proxyState.get(media.id) === "ready";
      const fullFailed = proxyState.get(media.id) === "failed";
      const quickReady =
        !!media.quick_proxy_path || quickProxyState.get(media.id) === "ready";

      if (fullReady) return { ready: true, optimizing: false };
      // Quick proxy available; Phase 2 still running (or failed — ring stops).
      if (quickReady) return { ready: true, optimizing: !fullFailed };
      if (fullFailed) return { ready: false, reason: "proxy_failed" };
      return { ready: false, reason: "proxy_pending" };
    }
    return { ready: true, optimizing: false };
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```
  cd apps/desktop
  npx vitest run src/panels/mediaReadiness.test.ts 2>&1 | tail -10
  ```

  Expected: all tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/desktop/src/panels/mediaReadiness.ts \
          apps/desktop/src/panels/mediaReadiness.test.ts
  git commit -m "feat(proxy): extend mediaReadiness for two-phase proxy (optimizing flag)"
  ```

---

## Task 8: Frontend wiring — App.tsx + Timeline.tsx

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/timeline/Timeline.tsx`

### 8a: Timeline.tsx — add `quickProxyState` prop

- [ ] **Step 1: Add `quickProxyState` to the `Timeline` component props**

  In `apps/desktop/src/timeline/Timeline.tsx`, find the props interface (the one containing `proxyState`). Add:

  ```typescript
  quickProxyState: ReadonlyMap<string, ProxyState>;
  ```

- [ ] **Step 2: Pass `quickProxyState` to `mediaReadiness` call in `Timeline.tsx`**

  Find the call at line ~932:
  ```typescript
  const readiness = mediaReadiness(m, importing, proxyState);
  ```

  Replace with:
  ```typescript
  const readiness = mediaReadiness(m, importing, proxyState, quickProxyState);
  ```

  Also update the `useCallback` dependency array on the next line to include `quickProxyState`:
  ```typescript
  [importing, media, onMutated, proxyState, quickProxyState, pxPerSec],
  ```

### 8b: App.tsx — add `quickProxyState` map and event listener

- [ ] **Step 3: Add `quickProxyState` state to `App.tsx`**

  In `apps/desktop/src/App.tsx`, directly after the existing `proxyState` state declaration (~line 160):

  ```tsx
  const [quickProxyState, setQuickProxyState] = useState<Map<string, ProxyState>>(
    () => new Map(),
  );
  ```

- [ ] **Step 4: Extend the job event listener to handle `quick_proxy` events**

  Find the `useEffect` that registers job listeners (currently ~line 410). It has three `listen` calls. Update the `onStarted`, `onComplete`, and `onError` handlers to also handle `kind === "quick_proxy"`:

  ```tsx
  const setProxy = (id: string, s: ProxyState) =>
    setProxyState((prev) => {
      const next = new Map(prev);
      next.set(id, s);
      return next;
    });
  const setQuick = (id: string, s: ProxyState) =>
    setQuickProxyState((prev) => {
      const next = new Map(prev);
      next.set(id, s);
      return next;
    });

  const onStarted = await listen<MediaJobEvent>(
    MEDIA_JOB_EVENTS.started,
    (e) => {
      if (e.payload.kind === "proxy") setProxy(e.payload.media_id, "pending");
      if (e.payload.kind === "quick_proxy") setQuick(e.payload.media_id, "pending");
    },
  );
  const onComplete = await listen<MediaJobEvent>(
    MEDIA_JOB_EVENTS.complete,
    (e) => {
      if (e.payload.kind === "proxy") setProxy(e.payload.media_id, "ready");
      if (e.payload.kind === "quick_proxy") setQuick(e.payload.media_id, "ready");
    },
  );
  const onError = await listen<MediaJobEvent>(
    MEDIA_JOB_EVENTS.error,
    (e) => {
      if (e.payload.kind === "proxy") setProxy(e.payload.media_id, "failed");
      if (e.payload.kind === "quick_proxy") setQuick(e.payload.media_id, "failed");
    },
  );
  ```

- [ ] **Step 5: Pass `quickProxyState` to `<Timeline>`**

  Find `<Timeline ... proxyState={proxyState}` (~line 1094) and add:
  ```tsx
  quickProxyState={quickProxyState}
  ```

- [ ] **Step 6: Pass `quickProxyState` to `<MediaPool>`**

  Find `<MediaPool ... proxyState={proxyState}` (~line 1106) and add:
  ```tsx
  quickProxyState={quickProxyState}
  ```

- [ ] **Step 7: Update `MediaPool` component props and `mediaReadiness` call**

  Find the `MediaPool` function in `App.tsx` (~line 1351). Add `quickProxyState` to its props:
  ```typescript
  quickProxyState: ReadonlyMap<string, ProxyState>;
  ```

  Find its `mediaReadiness` call (~line 1419):
  ```typescript
  const readiness = mediaReadiness(m, importing, proxyState);
  ```
  Update to:
  ```typescript
  const readiness = mediaReadiness(m, importing, proxyState, quickProxyState);
  ```

- [ ] **Step 8: Add the progress ring UI for `optimizing: true` state**

  In `App.tsx`, inside the `MediaPool` render, find the block that renders badges on the media item thumbnail (currently ~line 1493). After the `{reason === "proxy_pending" && ...}` block, add:

  ```tsx
  {readiness.ready && readiness.optimizing && (
    <span
      className="media-optimizing-ring"
      title={t("media_pool.optimizing_hint", {
        defaultValue: "Optimizing preview quality…",
      })}
      aria-label={t("media_pool.optimizing_hint", {
        defaultValue: "Optimizing preview quality…",
      })}
    />
  )}
  ```

  Also add `"is-optimizing"` to the `li` className logic:
  ```typescript
  readiness.ready && readiness.optimizing ? "is-optimizing" : "",
  ```

- [ ] **Step 9: Run TypeScript type check**

  ```
  cd apps/desktop
  npx tsc --noEmit 2>&1 | grep "error TS" | head -20
  ```

  Expected: no errors. Fix any remaining type errors from the signature changes.

- [ ] **Step 10: Run frontend unit tests**

  ```
  cd apps/desktop
  npx vitest run 2>&1 | tail -15
  ```

  Expected: all tests pass.

- [ ] **Step 11: Commit**

  ```bash
  git add apps/desktop/src/App.tsx \
          apps/desktop/src/timeline/Timeline.tsx
  git commit -m "feat(proxy): wire quickProxyState to Timeline and MediaPool; add optimizing ring"
  ```

---

## Task 9: CSS for the optimizing ring

**Files:**
- Modify: whichever CSS/SCSS file contains `.media-proxy-pending-badge` (find with `grep -r "media-proxy-pending" apps/desktop/src`)

- [ ] **Step 1: Find the relevant CSS file**

  ```
  cd apps/desktop
  grep -rl "media-proxy-pending" src/
  ```

- [ ] **Step 2: Add ring styles**

  In the found CSS file, after the `.media-proxy-pending-badge` block, add:

  ```css
  /* Progress ring — shown while Phase-1 quick proxy is ready but Phase-2
     full proxy is still generating in the background. */
  .media-optimizing-ring {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .media-optimizing-ring::before {
    content: "";
    width: 28px;
    height: 28px;
    border: 3px solid rgba(255, 255, 255, 0.25);
    border-top-color: rgba(255, 255, 255, 0.9);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add apps/desktop/src/
  git commit -m "feat(proxy): add optimizing progress ring CSS for Phase-1 ready state"
  ```

---

## Verification Checklist

After all tasks complete, verify these scenarios:

- [ ] Import an H.264 MP4 file → video becomes usable on timeline within seconds; progress ring appears; ring disappears when Phase 2 completes.
- [ ] Import a HEVC MOV file → video blocked briefly (Phase 1 540p ultrafast); then becomes usable with ring; ring disappears after Phase 2.
- [ ] Import any non-video (audio, image) → no change from current behavior.
- [ ] Open an existing workspace that had a quick proxy in the JSON → `quick_proxy_path` is cleared; Phase 1 reruns.
- [ ] Drag-drop an H.264 video onto the timeline while Phase 1 is still running → drag is blocked (proxy_pending); drag works immediately after Phase 1 completes.
- [ ] Export a project while quick proxy is active (no full proxy yet) → export uses quick proxy path as fallback via `with_proxies_substituted`.
