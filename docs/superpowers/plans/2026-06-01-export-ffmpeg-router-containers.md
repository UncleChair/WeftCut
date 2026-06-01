# Export Encoder Router + MP4/MOV/MKV Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every offered video codec exportable by routing each one to its best path — WebCodecs when the browser can encode it (hardware or software, automatically), ffmpeg transcode when it can't (HEVC today) — and let the user pick the output container (MP4 / MOV / MKV).

**Architecture:** Per-codec router in `App`. If a one-frame WebCodecs smoke succeeds for the chosen codec, the worker encodes it directly (today's path) and Rust stream-copies into the chosen container. If the smoke fails, the worker encodes a high-quality **H.264 mezzanine** and Rust ffmpeg **transcodes** it to the target codec — hardware encoder first (`hevc_nvenc`/`av1_nvenc`/…), software fallback (`libx265`/`libsvtav1`) — then muxes audio and writes the chosen container. Containers are realized **only at the Rust mux/transcode step** via the output extension; ffmpeg remuxes the worker's MP4 into `.mp4`/`.mov`/`.mkv`, and all three codecs are valid in all three containers, so no worker/mediabunny change and no codec↔container restriction in this tier. ffmpeg transcode progress is parsed from `-progress pipe:1` and emitted as a Tauri event so the export panel shows a real "transcoding" phase.

**Tech Stack:** TypeScript (App router + dialog), Rust + Tauri (ffmpeg transcode, generalized HW-encoder probe, progress events), vitest (node unit tests), cargo test.

---

## Background: what exists now (read before starting)

- **AV1 already works via WebCodecs software encode** (fixed in commit `fix(export): enable AV1 via WebCodecs software encode`). The dropdown offers H.264 + AV1; HEVC is currently hidden because `probeEncoderSupported` returns false for it. This plan makes HEVC selectable by routing it to ffmpeg.
- The export flow: `App.runExportWithSettings(settings, path)` → `buildConfig(codec)` builds a `VideoEncoderConfig` → worker WebCodecs-encodes → `writeFile(tempVideoPath)` → `exportProjectAudioOnly(tempAudioPath)` (Rust AAC) → `muxExport(tempVideoPath, tempAudioPath, path)` (Rust `ffmpeg -c copy`).
- Rust mux: `export::mux_to_file` + `mux_args` (`src-tauri/src/export/mod.rs`), command `mux_export` (`commands.rs:2173`), TS binding `muxExport` (`ipc/index.ts:689`). Today it stream-copies only.
- ffmpeg is the Gyan full build (verified): software `libsvtav1`/`libx265`/`libvpx-vp9` **and** hardware `av1_nvenc`/`av1_qsv`/`av1_amf`/`hevc_nvenc`/`hevc_qsv` are all present.
- The pre-Pixi pipeline had `export/hwencoder.rs` (HW-encoder probe, NVENC>QSV>AMF, synthetic-encode probe, cached) — deleted in commit `b6a5832`. Recover it from git: `git show b6a5832^:apps/desktop/src-tauri/src/export/hwencoder.rs`. It was H.264-only; this plan generalizes the encoder names per target codec.
- Probe helpers: `src/render/exportCodecProbe.ts` — `probeEncoderSupported` (relaxed `isConfigSupported`, no hw hint) and `smokeEncode` (one real frame, no hw hint after the AV1 fix). `smokeEncode` returns `true` immediately for `"h264"`.
- Settings logic: `src/render/exportSettings.ts` — `ExportSettings`, `CodecId = "h264"|"av1"|"hevc"`, `resolveOutputDims`, `computeBitrate`, `codecString`.

## Key decisions (resolved with the user)

1. Router: WebCodecs-first (hw/sw auto), ffmpeg fallback for codecs WebCodecs can't encode.
2. ffmpeg path = transcode a high-quality H.264 mezzanine (accepted: double-encode, negligible loss at high mezzanine bitrate; the raw-frame single-encode alternative is impractical on this stack).
3. HW-encoder-first in ffmpeg (crib the deleted `hwencoder.rs`), software fallback.
4. Containers MP4/MOV/MKV (audio stays AAC). **WebM deferred** (needs Opus audio + VP9/AV1 restriction).
5. Codec menu: H.264 + AV1 + HEVC, all always shown (ffmpeg guarantees producibility). The smoke decides the *path*, not availability.

## Test reality (no automated merge gate)

`npm run typecheck`, `npm run build`, and `npm run fixtures:render` are red on clean `main` for pre-existing reasons — NOT gates. What works:
- **`npm test`** (`vitest run --exclude '**/*.browser.test.ts'`, from `apps/desktop/`) — node unit tests. Use for all TS pure-logic tasks.
- **`cargo test`** (from `apps/desktop/src-tauri/`) — Rust unit tests.
- ffmpeg transcode + the router integration have no automated test → verified via the **`tauri dev` smoke** (Task 9) in real WebView2. After touching a file, confirm `npx tsc -b --force 2>&1 | grep <file>` shows no NEW errors (the only known pre-existing one is `App.tsx … TS6133 'error' is declared but never read`).

## File structure

- **Modify** `src/render/exportSettings.ts` — add `Container` type + `container` field + `containerExtension()` + `mezzanineBitrate()`.
- **Modify** `src/render/exportCodecProbe.ts` — add `resolveEncodePath()`.
- **Modify** `src/render/exportSettings.test.ts` / **create** `src/render/exportCodecProbe.test.ts` additions — unit tests.
- **Create** `src-tauri/src/export/hwencoder.rs` — generalized HW-encoder probe + per-codec cache.
- **Modify** `src-tauri/src/export/mod.rs` — `video_encode_args()` (pure, tested) + `transcode_and_mux()` (encode + mux + progress).
- **Modify** `src-tauri/src/commands.rs` — extend `mux_export` with an optional transcode spec; thread `AppHandle` + `HwEncoderCache`.
- **Modify** `src-tauri/src/lib.rs` — manage `HwEncoderCache` in Tauri state.
- **Modify** `src/ipc/index.ts` — extend `muxExport` binding + a `TranscodeProgress` event type.
- **Modify** `src/App.tsx` — the router (webcodecs vs ffmpeg), container extension, transcode-progress wiring.
- **Modify** `src/panels/ExportSettingsDialog.tsx` — container dropdown, always-show HEVC, encode-path badge, container-aware Browse extension.
- **Modify** `src/i18n/locales/en-US.ts` + `zh-CN.ts` — container labels, path badge, transcoding-progress strings.

---

## Task 1: Container + mezzanine logic (TS pure)

**Files:**
- Modify: `apps/desktop/src/render/exportSettings.ts`
- Test: `apps/desktop/src/render/exportSettings.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `exportSettings.test.ts`:

```ts
import {
  type Container,
  containerExtension,
  mezzanineBitrate,
  CONTAINERS,
} from "./exportSettings";

describe("containers", () => {
  it("lists mp4, mov, mkv (webm deferred)", () => {
    expect(CONTAINERS).toEqual(["mp4", "mov", "mkv"]);
  });
  it("maps container to file extension", () => {
    expect(containerExtension("mp4")).toBe("mp4");
    expect(containerExtension("mov")).toBe("mov");
    expect(containerExtension("mkv")).toBe("mkv");
  });
  it("defaults container to mp4", () => {
    expect(DEFAULT_EXPORT_SETTINGS.container).toBe("mp4");
  });
});

describe("mezzanineBitrate", () => {
  it("is a high, near-transparent H.264 bitrate (>= target*2, floored)", () => {
    // 1080p30, AV1 'high' target ~3.6 Mbps → mezzanine must be far higher.
    const bps = mezzanineBitrate(1920, 1080, 30);
    expect(bps).toBeGreaterThanOrEqual(20_000_000);
  });
  it("scales with resolution", () => {
    expect(mezzanineBitrate(3840, 2160, 30)).toBeGreaterThan(
      mezzanineBitrate(1920, 1080, 30),
    );
  });
});
```

- [ ] **Step 2: Run to verify fail** — Run (from `apps/desktop/`): `npm test -- exportSettings`. Expected: FAIL ("Container" / `containerExtension` / `CONTAINERS` / `mezzanineBitrate` not exported; `container` missing on defaults).

- [ ] **Step 3: Implement** — in `exportSettings.ts`, add the `Container` type, the `container` field, and the helpers:

In the `ExportSettings` interface, add the field after `rateMode`:

```ts
  rateMode: RateMode;
  /// Output container. Audio stays AAC for all three (WebM deferred).
  container: Container;
```

Add the type + default near the top (after `RateMode`):

```ts
export type Container = "mp4" | "mov" | "mkv";
export const CONTAINERS: Container[] = ["mp4", "mov", "mkv"];
```

Add `container: "mp4",` to `DEFAULT_EXPORT_SETTINGS` (after `rateMode: "vbr",`).

Add the helpers at the end of the file:

```ts
export function containerExtension(c: Container): string {
  return c;
}

/// High, near-transparent H.264 bitrate for the ffmpeg-path mezzanine. The
/// worker encodes this; ffmpeg then transcodes it to the target codec, so it
/// must be visually lossless. ~0.2 bits/pixel/frame, floored at 20 Mbps.
export function mezzanineBitrate(
  width: number,
  height: number,
  fps: number,
): number {
  return Math.max(20_000_000, Math.round(width * height * fps * 0.2));
}
```

- [ ] **Step 4: Run to verify pass** — `npm test -- exportSettings`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/exportSettings.ts apps/desktop/src/render/exportSettings.test.ts
git commit -m "feat(export): container type (mp4/mov/mkv) + mezzanine bitrate helper"
```

---

## Task 2: Encode-path resolver (TS)

**Files:**
- Modify: `apps/desktop/src/render/exportCodecProbe.ts`
- Test: `apps/desktop/src/render/exportCodecProbe.test.ts`

- [ ] **Step 1: Write the failing test** — append to `exportCodecProbe.test.ts`:

```ts
import { resolveEncodePath } from "./exportCodecProbe";

describe("resolveEncodePath", () => {
  it("routes H.264 to webcodecs without touching VideoEncoder", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await resolveEncodePath("h264", 1920, 1080, 30)).toBe("webcodecs");
  });
  it("routes to ffmpeg when WebCodecs can't encode (no VideoEncoder)", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await resolveEncodePath("hevc", 1920, 1080, 30)).toBe("ffmpeg");
    expect(await resolveEncodePath("av1", 1920, 1080, 30)).toBe("ffmpeg");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- exportCodecProbe`. Expected: FAIL (`resolveEncodePath` not exported).

- [ ] **Step 3: Implement** — append to `exportCodecProbe.ts`:

```ts
export type EncodePath = "webcodecs" | "ffmpeg";

/// Decide the export path for a codec: if a one-frame WebCodecs encode
/// succeeds (hardware or software — no hw hint is forced), the browser
/// encodes it directly; otherwise ffmpeg transcodes a mezzanine. H.264 is
/// always WebCodecs (smokeEncode short-circuits true).
export async function resolveEncodePath(
  codec: CodecId,
  width: number,
  height: number,
  fps: number,
): Promise<EncodePath> {
  const ok = await smokeEncode(codec, width, height, fps);
  return ok ? "webcodecs" : "ffmpeg";
}
```

- [ ] **Step 4: Run to verify pass** — `npm test -- exportCodecProbe`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/exportCodecProbe.ts apps/desktop/src/render/exportCodecProbe.test.ts
git commit -m "feat(export): encode-path resolver (webcodecs vs ffmpeg per codec)"
```

---

## Task 3: Generalized HW-encoder probe (Rust)

**Files:**
- Create: `apps/desktop/src-tauri/src/export/hwencoder.rs`

Revives the deleted probe, generalized to per-target-codec encoder names. Reference the original: `git show b6a5832^:apps/desktop/src-tauri/src/export/hwencoder.rs`.

- [ ] **Step 1: Write the file with unit tests**

Create `apps/desktop/src-tauri/src/export/hwencoder.rs`:

```rust
//! Hardware-encoder probing, generalized per target codec.
//!
//! `ffmpeg -encoders` lists every encoder ffmpeg was built with — including
//! ones the host can't actually drive. So we run a 0.1s synthetic encode per
//! candidate and only treat it as available if ffmpeg returns 0. Results are
//! cached per target codec for the process lifetime.
//!
//! Selection order per platform: Windows NVENC > QSV > AMF; macOS
//! VideoToolbox; Linux NVENC > VAAPI. Software fallback (libx265/libsvtav1/
//! libvpx-vp9/libx264) is chosen by the caller when no HW encoder is found.

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

/// Per-codec cache of the chosen ffmpeg encoder name (HW if probed-good,
/// else the software encoder). Held in Tauri state so each export reads from
/// memory.
#[derive(Default)]
pub struct HwEncoderCache {
    inner: Mutex<HashMap<TargetCodec, Arc<String>>>,
}

impl HwEncoderCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
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

/// 0.1s synthetic encode through `encoder_name`; true iff ffmpeg returns 0.
/// Time-boxed at 4s (some HW init can hang).
async fn probe_encoder(encoder_name: &str) -> bool {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=128x128:d=0.1:r=30",
        "-c:v", encoder_name, "-frames:v", "1", "-f", "null", "-",
    ]);
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

#[cfg(test)]
mod tests {
    use super::*;

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
```

- [ ] **Step 2: Declare the submodule** — in `apps/desktop/src-tauri/src/export/mod.rs`, add at the top of the file (after the module doc, before `use`):

```rust
mod hwencoder;
pub use hwencoder::{HwEncoderCache, TargetCodec};
```

- [ ] **Step 3: Run the Rust tests** — Run (from `apps/desktop/src-tauri/`): `cargo test export::hwencoder`. Expected: PASS — `parse_codec_strings`, `software_encoders`, `nvenc_encoder_names`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/export/hwencoder.rs apps/desktop/src-tauri/src/export/mod.rs
git commit -m "feat(export): generalized per-codec HW-encoder probe + cache"
```

---

## Task 4: ffmpeg video-encode args (Rust, pure + tested)

**Files:**
- Modify: `apps/desktop/src-tauri/src/export/mod.rs`

- [ ] **Step 1: Write the failing test** — add to the `#[cfg(test)] mod tests` block in `export/mod.rs`:

```rust
#[test]
fn video_encode_args_vbr_software() {
    let argv = super::video_encode_args("libx265", 8_000_000, false);
    let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx265"));
    assert!(s.windows(2).any(|w| w[0] == "-b:v" && w[1] == "8000000"));
    // VBR must NOT pin maxrate=minrate.
    assert!(!s.iter().any(|a| a == "-minrate"));
}

#[test]
fn video_encode_args_cbr_pins_rate() {
    let argv = super::video_encode_args("hevc_nvenc", 8_000_000, true);
    let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "hevc_nvenc"));
    assert!(s.windows(2).any(|w| w[0] == "-maxrate" && w[1] == "8000000"));
    assert!(s.windows(2).any(|w| w[0] == "-minrate" && w[1] == "8000000"));
    assert!(s.windows(2).any(|w| w[0] == "-bufsize" && w[1] == "16000000"));
}

#[test]
fn video_encode_args_sets_software_preset() {
    // Software encoders get a speed preset so AV1/HEVC don't run forever.
    let argv = super::video_encode_args("libsvtav1", 4_000_000, false);
    let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    assert!(s.windows(2).any(|w| w[0] == "-preset" && w[1] == "8"));
}
```

- [ ] **Step 2: Run to verify fail** — Run (from `apps/desktop/src-tauri/`): `cargo test video_encode_args`. Expected: FAIL (`video_encode_args` not found).

- [ ] **Step 3: Implement** — add to `export/mod.rs` (above the `#[cfg(test)]` block):

```rust
/// Build the ffmpeg `-c:v …` video-encode args for a transcode. `encoder` is
/// the resolved ffmpeg encoder name (HW like `hevc_nvenc` or software like
/// `libx265`). VBR uses `-b:v` as the average target; CBR additionally pins
/// maxrate/minrate + a 2× bufsize. Software encoders get a speed preset so
/// AV1/HEVC don't take minutes.
fn video_encode_args(encoder: &str, bitrate: u64, cbr: bool) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let mut a: Vec<OsString> = vec!["-c:v".into(), encoder.into()];
    a.push("-b:v".into());
    a.push(bitrate.to_string().into());
    if cbr {
        a.push("-maxrate".into());
        a.push(bitrate.to_string().into());
        a.push("-minrate".into());
        a.push(bitrate.to_string().into());
        a.push("-bufsize".into());
        a.push((bitrate * 2).to_string().into());
    }
    // Speed presets for the slow software encoders only.
    match encoder {
        "libsvtav1" => {
            a.push("-preset".into());
            a.push("8".into());
        }
        "libx265" | "libx264" => {
            a.push("-preset".into());
            a.push("medium".into());
        }
        "libvpx-vp9" => {
            a.push("-deadline".into());
            a.push("good".into());
            a.push("-cpu-used".into());
            a.push("4".into());
        }
        _ => {} // HW encoders: no preset (their defaults are already fast)
    }
    a
}
```

- [ ] **Step 4: Run to verify pass** — `cargo test video_encode_args`. Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/export/mod.rs
git commit -m "feat(export): ffmpeg video-encode arg builder (vbr/cbr + sw presets)"
```

---

## Task 5: transcode_and_mux + progress (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/export/mod.rs`

- [ ] **Step 1: Add the progress event constant + transcode function** — add to `export/mod.rs` (after `mux_to_file`):

```rust
/// Tauri event emitted while ffmpeg transcodes the video (ffmpeg-path codecs
/// like HEVC). Payload: `{ percent: f64 }` in 0.0..=1.0.
pub const EVENT_TRANSCODE_PROGRESS: &str = "export:transcode_progress";

/// Transcode `video_path` (the WebCodecs H.264 mezzanine) to `encoder` and
/// mux with `audio_path` into `output` (container = output extension). Parses
/// `-progress pipe:1` and emits `EVENT_TRANSCODE_PROGRESS` against `duration_us`.
pub async fn transcode_and_mux(
    app: &AppHandle,
    encoder: &str,
    bitrate: u64,
    cbr: bool,
    duration_us: i64,
    video_path: &Path,
    audio_path: &Path,
    output: &Path,
) -> Result<()> {
    use tauri::Emitter;
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg is not installed");
    }
    let has_audio = audio_path.exists();
    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y").arg("-hide_banner").arg("-nostats");
    cmd.arg("-i").arg(video_path);
    if has_audio {
        cmd.arg("-i").arg(audio_path);
    }
    for arg in video_encode_args(encoder, bitrate, cbr) {
        cmd.arg(arg);
    }
    // Audio is already AAC from export_audio_only → stream-copy it.
    if has_audio {
        cmd.args(["-c:a", "copy"]);
    }
    // Machine-readable progress on stdout.
    cmd.args(["-progress", "pipe:1"]);
    cmd.arg(output);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!("ffmpeg transcode ({encoder}): {} -> {}", video_path.display(), output.display());
    let mut child = cmd.spawn().context("spawn ffmpeg transcode")?;

    // Parse `-progress` key=value lines from stdout; emit percent.
    let stdout = child.stdout.take().context("take ffmpeg stdout")?;
    let app_for_progress = app.clone();
    let total_us = duration_us.max(1) as f64;
    let progress_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<f64>() {
                    let pct = (us / total_us).clamp(0.0, 1.0);
                    let _ = app_for_progress.emit(EVENT_TRANSCODE_PROGRESS, pct);
                }
            }
        }
    });

    let stderr = child.stderr.take().context("take ffmpeg stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            tail.push(line);
            if tail.len() > 50 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });

    let status = child.wait().await.context("await ffmpeg transcode")?;
    let _ = progress_task.await;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    if !status.success() {
        anyhow::bail!(
            "ffmpeg transcode exited {}. Tail:\n{}",
            status,
            stderr_tail.lines().rev().take(8).collect::<Vec<_>>().join("\n")
        );
    }
    let _ = app.emit(EVENT_TRANSCODE_PROGRESS, 1.0_f64);
    Ok(())
}
```

- [ ] **Step 2: Verify the crate compiles** — Run (from `apps/desktop/src-tauri/`): `cargo build 2>&1 | grep -E "error" | head` — expect no errors (warnings ok). The existing `cargo test video_encode_args` from Task 4 still passes.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/export/mod.rs
git commit -m "feat(export): transcode_and_mux with ffmpeg -progress event emission"
```

---

## Task 6: Wire the transcode command + HW cache state (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs:2170-2185`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Replace `mux_export` with a transcode-aware version** — in `commands.rs`, replace the `mux_export` command (lines ~2170-2185):

```rust
/// Transcode spec for the ffmpeg export path. Absent ⇒ stream-copy mux.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeSpec {
    pub video_codec: String, // "h264" | "hevc" | "av1" | "vp9"
    pub bitrate: u64,
    pub cbr: bool,
    pub duration_us: i64,
}

/// Mux `video_path` + `audio_path` into `output_path`. With no `transcode`,
/// stream-copies (`-c copy`). With a `transcode`, re-encodes the video to the
/// target codec (HW encoder first, software fallback) and emits
/// `export:transcode_progress` events.
#[tauri::command]
pub async fn mux_export(
    app: tauri::AppHandle,
    hw_cache: State<'_, crate::export::HwEncoderCache>,
    video_path: String,
    audio_path: String,
    output_path: String,
    transcode: Option<TranscodeSpec>,
) -> Result<(), String> {
    let video = PathBuf::from(video_path);
    let audio = PathBuf::from(audio_path);
    let out = PathBuf::from(output_path);
    match transcode {
        None => export::mux_to_file(&video, &audio, &out)
            .await
            .map_err(|e| format!("{e:#}")),
        Some(spec) => {
            let codec = crate::export::TargetCodec::parse(&spec.video_codec)
                .ok_or_else(|| format!("unknown codec {}", spec.video_codec))?;
            let encoder = hw_cache.encoder_for(codec).await;
            export::transcode_and_mux(
                &app, &encoder, spec.bitrate, spec.cbr, spec.duration_us,
                &video, &audio, &out,
            )
            .await
            .map_err(|e| format!("{e:#}"))
        }
    }
}
```

- [ ] **Step 2: Register the HW cache in Tauri state** — in `lib.rs`, find the `.manage(...)` chain in the builder setup (where other state like `AppSettingsStore` is managed) and add:

```rust
        .manage(export::HwEncoderCache::new())
```

(If unsure where: search `lib.rs` for `.manage(` and add the line alongside the others, before `.invoke_handler`.)

- [ ] **Step 3: Verify the crate compiles + tests pass** — Run (from `apps/desktop/src-tauri/`): `cargo test 2>&1 | tail -15`. Expected: build succeeds; `export::hwencoder` + `video_encode_args` tests PASS; no new failures.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(export): transcode-aware mux_export command + HW cache state"
```

---

## Task 7: IPC binding + progress listener (TS)

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts:687-695`

- [ ] **Step 1: Extend the `muxExport` binding + add the event name** — replace the `muxExport` function in `ipc/index.ts`:

```ts
/// Optional video transcode spec for the ffmpeg export path. Omit for a
/// stream-copy mux.
export interface TranscodeSpec {
  videoCodec: "h264" | "av1" | "hevc" | "vp9";
  bitrate: number;
  cbr: boolean;
  durationUs: number;
}

/// Tauri event emitted (0.0..=1.0) while ffmpeg transcodes the video.
export const EXPORT_TRANSCODE_PROGRESS = "export:transcode_progress";

/// Mux `video` + `audio` into `output`. With `transcode`, re-encodes the
/// video to the target codec (HW-first) instead of stream-copying.
export async function muxExport(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  transcode?: TranscodeSpec,
): Promise<void> {
  return invoke<void>("mux_export", {
    videoPath,
    audioPath,
    outputPath,
    transcode: transcode ?? null,
  });
}
```

- [ ] **Step 2: Typecheck** — Run (from `apps/desktop/`): `npx tsc -b --force 2>&1 | grep -E "ipc/index"` — expect no output (clean). Existing callers of `muxExport` pass 3 args (transcode optional) so they still compile.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/ipc/index.ts
git commit -m "feat(export): muxExport transcode param + transcode-progress event name"
```

---

## Task 8: App router + dialog + i18n

**Files:**
- Modify: `apps/desktop/src/App.tsx` (router in `runExportWithSettings`)
- Modify: `apps/desktop/src/panels/ExportSettingsDialog.tsx` (container dropdown, all codecs, path badge)
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts`

### 8a — App router

- [ ] **Step 1: Import the resolver + helpers** — in `App.tsx`, extend the existing `./render/exportSettings` import and the probe import:

```ts
import {
  type ExportSettings,
  codecString,
  computeBitrate,
  containerExtension,
  mezzanineBitrate,
  resolveOutputDims,
} from "./render/exportSettings";
import { resolveEncodePath } from "./render/exportCodecProbe";
```

Also import `listen` if not already imported (it is — used elsewhere) and `EXPORT_TRANSCODE_PROGRESS`, `muxExport` from `./ipc` (extend the existing ipc import list to include `EXPORT_TRANSCODE_PROGRESS`).

- [ ] **Step 2: Route in `runExportWithSettings`** — replace the body from `const comp = useProjectStore.getState().summary!.composition;` through the `muxExport(tempVideoPath, tempAudioPath, path)` call. The new shape:

```ts
    const comp = useProjectStore.getState().summary!.composition;
    const dims = resolveOutputDims(comp, settings);
    const fpsNum = settings.fps != null ? settings.fps : comp.fps_num;
    const fpsDen = settings.fps != null ? 1 : comp.fps_den;
    const outFps = fpsNum / fpsDen;
    const ext = containerExtension(settings.container);
    // `path` came from the dialog already carrying the chosen extension.

    // Decide the path for the chosen codec.
    const encodePath = await resolveEncodePath(
      settings.codec,
      dims.width,
      dims.height,
      outFps,
    );

    // WebCodecs path → worker encodes the target codec. ffmpeg path → worker
    // encodes a high-quality H.264 mezzanine; Rust transcodes it.
    const workerCodec = encodePath === "ffmpeg" ? "h264" : settings.codec;
    const workerBitrate =
      encodePath === "ffmpeg"
        ? mezzanineBitrate(dims.width, dims.height, outFps)
        : computeBitrate(settings, dims.width, dims.height, outFps);
    const encoderConfig: VideoEncoderConfig = {
      codec: codecString(workerCodec),
      width: dims.width,
      height: dims.height,
      bitrate: workerBitrate,
      framerate: outFps,
      bitrateMode: settings.rateMode === "cbr" ? "constant" : "variable",
      ...(workerCodec === "h264"
        ? { hardwareAcceleration: "prefer-hardware" as const }
        : {}),
    };

    const startedAtMs = performance.now();
    const onProgress = (encoded: number, total: number) => {
      if (total <= 0) return;
      const elapsedSec = (performance.now() - startedAtMs) / 1000;
      const fps = elapsedSec > 0 ? encoded / elapsedSec : 0;
      const fdUs = Math.round((1_000_000 * fpsDen) / fpsNum);
      const currentTimeUs = encoded * fdUs;
      const speed = elapsedSec > 0 ? currentTimeUs / 1e6 / elapsedSec : 0;
      setExportState({
        kind: "progress",
        progress: {
          progress: encoded / total,
          currentTimeUs,
          frame: encoded,
          fps,
          speed,
        },
      });
    };

    setExportState({ kind: "starting" });
    let result;
    try {
      result = await previewRef.current?.runPixiExport({
        onProgress,
        encoderConfig,
        outputFps: { num: fpsNum, den: fpsDen },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[weftcut/pixi] export failed:", e);
      setExportState({ kind: "error", detail: msg });
      return;
    }
    if (!result) {
      setExportState({ kind: "error", detail: "Preview not initialized." });
      return;
    }

    // Transcode-progress listener (ffmpeg path only). Maps 0..1 onto the
    // panel's progress phase. Detached after the mux resolves.
    let offTranscode: (() => void) | null = null;
    if (encodePath === "ffmpeg") {
      void listen<number>(EXPORT_TRANSCODE_PROGRESS, (e) => {
        setExportState({
          kind: "progress",
          progress: {
            progress: e.payload,
            currentTimeUs: Math.round(e.payload * comp.duration_us),
            frame: 0,
            fps: 0,
            speed: 0,
          },
        });
      }).then((u) => {
        offTranscode = u;
      });
    }

    try {
      await writeFile(tempVideoPath, new Uint8Array(result.videoBytes));
      await exportProjectAudioOnly(tempAudioPath);
      const transcode =
        encodePath === "ffmpeg"
          ? {
              videoCodec: settings.codec,
              bitrate: computeBitrate(settings, dims.width, dims.height, outFps),
              cbr: settings.rateMode === "cbr",
              durationUs: comp.duration_us,
            }
          : undefined;
      await muxExport(tempVideoPath, tempAudioPath, path, transcode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[weftcut/pixi] finalize failed:", e);
      setExportState({ kind: "error", detail: `Finalize failed: ${msg}` });
      return;
    } finally {
      offTranscode?.();
      void remove(tempVideoPath).catch(() => {});
      void remove(tempAudioPath).catch(() => {});
    }

    const durationUs = Math.round(
      (result.totalFrames * 1_000_000 * result.fpsDen) / result.fpsNum,
    );
    setExportState({ kind: "complete", payload: { outputPath: path, durationUs } });
```

Notes for the implementer: this replaces the old `buildConfig`/fallback block. The H.264 runtime fallback is no longer needed — the router never sends a codec WebCodecs can't encode to the worker (HEVC always routes to ffmpeg; AV1 only routes to WebCodecs when its smoke passed). Delete the old `buildConfig` closure and the try/catch fallback entirely; the code above is the whole render+finalize body. Keep the temp-path allocation (`tempBase`/`stamp`/`tempVideoPath`/`tempAudioPath`) above this block and the readiness gate above that — both unchanged.

- [ ] **Step 3: Typecheck** — Run (from `apps/desktop/`): `npx tsc -b --force 2>&1 | grep -E "App.tsx"` — expect only the pre-existing `App.tsx(…) TS6133 'error' is declared but never read`, no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(export): per-codec router (webcodecs vs ffmpeg) + container ext + transcode progress"
```

### 8b — Dialog: container dropdown, all codecs, path badge

- [ ] **Step 5: Replace the codec/probe logic + add container** — in `ExportSettingsDialog.tsx`:

Change the import to add container helpers + the resolver:

```ts
import {
  type CodecId,
  type Container,
  type ExportSettings,
  type QualityPreset,
  type RateMode,
  CONTAINERS,
  computeBitrate,
  containerExtension,
  downscaleFpsOptions,
  downscaleHeightOptions,
  estimateBytes,
  formatBytes,
  mergeSettings,
  resolveOutputDims,
} from "../render/exportSettings";
import {
  type EncodePath,
  resolveEncodePath,
} from "../render/exportCodecProbe";
```

Replace the codec-support state with path state. Remove `supported`/`smokeFailed`/`probeEncoderSupported` usage and the codec-filter `useEffect`. Add:

```ts
  const [encodePath, setEncodePath] = useState<EncodePath | null>(null);
```

Replace the codec-probe `useEffect` and `onSelectCodec` with a path resolver that runs whenever the codec (or dims/fps) changes:

```ts
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    setEncodePath(null);
    const d = resolveOutputDims(comp, settings);
    const fps = settings.fps != null ? settings.fps : compFps;
    void resolveEncodePath(settings.codec, d.width, d.height, fps).then((p) => {
      if (!cancelled) setEncodePath(p);
    });
    return () => {
      cancelled = true;
    };
  }, [settings, comp, compFps]);
```

The codec `<select>` now lists all three unconditionally (no `supported` filter):

```tsx
                  <select
                    className="export-select"
                    value={settings.codec}
                    onChange={(e) => patch({ codec: e.target.value as CodecId })}
                  >
                    <option value="h264">H.264</option>
                    <option value="av1">AV1</option>
                    <option value="hevc">HEVC</option>
                  </select>
```

Replace the old `busy`/`smokeFailed` lines under the codec row with a path badge:

```tsx
                {encodePath === null ? (
                  <p className="settings-blurb">{t("export_dialog.checking_codec")}</p>
                ) : (
                  <p className="settings-blurb">
                    {encodePath === "ffmpeg"
                      ? t("export_dialog.path_ffmpeg")
                      : t("export_dialog.path_webcodecs")}
                  </p>
                )}
```

Add a container `<select>` row (after the codec row, before quality):

```tsx
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.container")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.container}
                    onChange={(e) =>
                      patch({ container: e.target.value as Container })
                    }
                  >
                    {CONTAINERS.map((c) => (
                      <option key={c} value={c}>
                        {c.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
```

- [ ] **Step 6: Make Browse + export use the container extension** — update `onBrowse` and `onExport`/`canExport`:

```ts
  async function onBrowse() {
    const ext = containerExtension(settings!.container);
    const chosen = await saveDialog({
      title: t("export_dialog.choose_path"),
      defaultPath: `weftcut-export.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (typeof chosen === "string") setPath(chosen);
  }
```

And gate export on the path being resolved (no more `smokeFailed`):

```ts
  const canExport = !!path && encodePath !== null;
```

Also: when the container changes after a path was chosen, rewrite the path's extension so they stay consistent. Add inside the container `onChange` (replace the simple `patch`):

```tsx
                    onChange={(e) => {
                      const c = e.target.value as Container;
                      patch({ container: c });
                      if (path) {
                        const ext = containerExtension(c);
                        setPath(path.replace(/\.[^.\\/]+$/, `.${ext}`));
                      }
                    }}
```

- [ ] **Step 7: Typecheck** — Run (from `apps/desktop/`): `npx tsc -b --force 2>&1 | grep -E "ExportSettingsDialog"` — expect no output.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/panels/ExportSettingsDialog.tsx
git commit -m "feat(export): dialog container dropdown + all-codecs + encode-path badge"
```

### 8c — i18n

- [ ] **Step 9: Add strings** — in `en-US.ts`, inside the `export_dialog` block, add:

```ts
    container: "Container",
    path_webcodecs: "Encoder: WebCodecs (hardware if available)",
    path_ffmpeg: "Encoder: ffmpeg transcode (slower)",
```

In `zh-CN.ts`, the same keys:

```ts
    container: "容器",
    path_webcodecs: "编码器：WebCodecs(有硬件则用硬件)",
    path_ffmpeg: "编码器：ffmpeg 转码(较慢)",
```

(The existing `checking_codec` key is reused for the "resolving path" state; the old `codec_unsupported` key is now unused but harmless — leave it.)

- [ ] **Step 10: Typecheck both locales** — Run (from `apps/desktop/`): `npx tsc -b --force 2>&1 | grep -E "locales"` — expect no output.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(export): i18n for container + encode-path badge"
```

---

## Task 9: Manual smoke (`tauri dev`, real WebView2)

No automated gate for the transcode/router integration. Run the app and walk the checklist.

- [ ] **Step 1: Launch** — Run (from `apps/desktop/`): `npm run tauri dev` (free port 1420 first if held). Open a project with video + audio.

- [ ] **Step 2: WebCodecs path unchanged** — Export H.264 (MP4) and AV1 (MP4). Both: panel shows "WebCodecs" badge, exports complete, play with audio, correct dims/duration. (Regression check: behaves like before this plan.)

- [ ] **Step 3: HEVC via ffmpeg** — Select HEVC. Badge shows "ffmpeg transcode". Export. Confirm: (a) the panel's **transcode progress advances** (watch it climb 0→100; a frozen 0% that jumps straight to complete means the `out_time_us=` progress key is wrong — fall back to parsing `out_time=` HH:MM:SS); (b) the output is real HEVC **with the `hvc1` tag** — `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,codec_tag_string out.mp4` must report `hevc` + **`hvc1`** (NOT `hev1`, which is silently unplayable on Apple/Premiere/WebView2 — judge by this, never by "it played in VLC"); (c) plays with audio. First run also triggers the one-time HW-encoder probe (a few seconds) — subsequent HEVC exports skip it.

- [ ] **Step 4: Containers** — Export the same project to **MOV** and **MKV** (codec H.264 and AV1). Confirm output extension matches, file plays, `ffprobe` shows the right container + codec + AAC audio. Verify AV1-in-MOV and AV1-in-MKV specifically (newer combos): `ffprobe out.mov`/`out.mkv` report `av1` video.

- [ ] **Step 5: HEVC into MOV/MKV** — Export HEVC to MOV and MKV. Confirm both report `hevc`; the **MOV** must report `hvc1` (`ffprobe … codec_tag_string`), the **MKV** has no fourcc tag (that's correct — MKV doesn't use one).

- [ ] **Step 6: Container ↔ path extension** — In the dialog, pick a path via Browse, then change the container dropdown; confirm the shown path's extension updates to match.

- [ ] **Step 7: Record results + fix** — If any step fails, debug (systematic-debugging skill), fix, re-run the affected step, commit referencing it.

---

## Self-Review checklist

1. **Spec coverage:** ffmpeg fallback for WebCodecs-can't codecs ✓ (T2 resolver routes, T8a sends mezzanine + transcode); HW-first + sw fallback ✓ (T3 cache, T4 args); progress ✓ (T5 emit, T7 event, T8a listener); containers MP4/MOV/MKV ✓ (T1 type, T8a ext, T8b dropdown); HEVC selectable ✓ (T8b all-codecs); WebM deferred ✓ (not in `CONTAINERS`).
2. **Placeholder scan:** every code step has complete code; the only "find the right line" note is the `lib.rs` `.manage(` site, with a search hint.
3. **Type consistency:** `Container`/`CONTAINERS`/`containerExtension`/`mezzanineBitrate` (T1), `EncodePath`/`resolveEncodePath` (T2), `TargetCodec`/`HwEncoderCache`/`encoder_for` (T3), `video_encode_args(encoder,bitrate,cbr)` (T4), `transcode_and_mux(app,encoder,bitrate,cbr,duration_us,…)` + `EVENT_TRANSCODE_PROGRESS` (T5), `TranscodeSpec{videoCodec,bitrate,cbr,durationUs}` + `mux_export(…,transcode)` (T6), `muxExport(…,transcode?)` + `EXPORT_TRANSCODE_PROGRESS` (T7) — all used identically in T8. The Rust `TranscodeSpec` is `camelCase`-renamed so `videoCodec`/`durationUs` match the TS payload.

## Notes for the implementer

- **Mezzanine double-encode is intentional** — the ffmpeg path encodes H.264 (high bitrate, near-transparent) then transcodes; this is the only practical option on the WebCodecs/Tauri stack (raw-frame single-encode is ~8 MB/frame and fights the webview throughput ceiling). Don't "optimize" it into a raw-frame pipe.
- **The router removes the old `buildConfig` + H.264 runtime fallback** (T8a). That fallback existed because the worker could be handed a codec it couldn't encode; the router guarantees the worker only ever gets H.264 or a smoke-verified WebCodecs codec, so the fallback is dead code.
- **CBR caveat** unchanged from the prior plan: some encoders may not honor `bitrateMode:"constant"` / `-minrate`; treat a playable file as a pass.
