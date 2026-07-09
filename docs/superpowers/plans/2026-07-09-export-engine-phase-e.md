# Export Engine (Phase E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the export's three inline encode branches into one `EncodeTarget` seam with two engines — NativeSink (the 10-bit ffmpeg videosink generalized to all bit depths, ProRes/DNxHR, CRF/preset, explicit color tags) and WebCodecsSink (today's path A) — then delete the mezzanine path.

**Architecture:** Spec = `docs/superpowers/specs/2026-07-09-dual-engine-decode-export-design.md` §"Export engine (Phase E)". The renderer resolves `ExportSettings × probes → EncodeTarget`; `engine:"native"` streams GPU-packed raw YUV frames over the existing chunk/chunk-ack → `videoSinkWrite` IPC into an ffmpeg sidecar child; `engine:"webcodecs"` keeps the EncoderSink/mediabunny fMP4 path byte-unchanged until E4. Stages: E1 seam (behavior-preserving) → E2 native 8-bit → E3 params/codecs/UI → E4 auto=native-first + mezzanine deletion + gates.

**Tech Stack:** TypeScript (renderer, vitest), Rust (napi addon, `ffmpeg-sidecar` CLI child — never `ffmpeg-next`), PixiJS v8 WebGL2 pack passes, Playwright `_electron` e2e (local-only), i18next (en-US + zh-CN).

## Global Constraints

- Work on branch `feat/export-engine-phase-e` off local `main`; commit per task; stage by EXPLICIT path only (`git add <files>` — another session may edit this checkout; never `git add -A`).
- End every commit message with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Rust tests run with the feature union: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud` (run from `apps/desktop`; `motifs` is NOT a feature). The union must stay matched with `napi:build` in `package.json:25`.
- TS gates: `npm run typecheck` (tsc -b) and `npm run test` (vitest; `--exclude '**/*.browser.test.ts'` is baked into the script) from `apps/desktop`.
- Rebuilding the addon (`npm run napi:build`) requires the dev app CLOSED (the running app locks the `.node`). Only Tasks that changed Rust need it, and only before running the e2e tasks.
- `apps/desktop/src/renderer/render/tenbit/PackYuv420p10.ts` shaders are duplicated byte-identical by the 10-bit GL-parity gate — do NOT edit that file in this plan. New pack formats live in a NEW file.
- Every new ffmpeg `std::process::Command`/`tokio::process::Command` must call `.no_console_window()` (`crate::process::NoConsoleWindow`) — conhost flash regression otherwise.
- All new user-visible strings get BOTH `en-US.ts` and `zh-CN.ts` keys under `export_dialog`.
- `export.json` schema changes must be additive with defaults — `mergeSettings` back-fills; old blobs must load unchanged.
- The 8-bit WebCodecs export path (worker `else` branch, `EncoderSink`, fMP4 append) stays byte-unchanged through E1–E3; it changes only by deletion of the mezzanine in E4.
- e2e specs (`apps/desktop/e2e/electron/export_codecs.spec.ts`) are local-only (self-skip in CI); running them needs: `npm run napi:build`, `npm run fetch-ffmpeg`, `VITE_WEFTCUT_E2E=1 npm run build` (bash), fixtures via the spec's documented generator, then `npx playwright test e2e/electron/export_codecs.spec.ts` from `apps/desktop`.

## File Structure (what exists / what this plan adds)

Existing (verified 2026-07-09):
- `apps/desktop/src/renderer/App.tsx:1288-1520` — export orchestration; the 3-branch decision (`tenBit` at `:1297`, `resolveEncodePath` at `:1325`, mezzanine config at `:1336-1364`, `writeChunk` fork at `:1395`, transcode spec at `:1488`); temp paths at `:1233-1235`.
- `apps/desktop/src/renderer/render/exportSettings.ts` — `ExportSettings` schema + pure helpers (unit-tested in colocated `exportSettings.test.ts`).
- `apps/desktop/src/renderer/render/exportCodecProbe.ts` — `smokeEncode` / `resolveEncodePath`.
- `apps/desktop/src/renderer/render/worker/{protocol.ts,exportWorker.ts,runExport.ts,encoder.ts}` — worker protocol, worker loop (`tenBit` gates at `:109,:133,:240,:256,:415`), main-thread driver, WebCodecs EncoderSink.
- `apps/desktop/src/renderer/render/tenbit/PackYuv420p10.ts` — frozen (parity gate).
- `apps/desktop/src/renderer/preview/PreviewSurface.tsx:483,:518` — `runPixiExport` options (`bitDepth`) + forwarding.
- `apps/desktop/src/renderer/ipc/index.ts:1427-1465` — `VideoSinkStartArgs` + `exportVideoSink*` wrappers.
- `apps/desktop/src/renderer/panels/ExportSettingsDialog.tsx` (882 lines) — `encodePath` probe state `:85,:191`, codec select `:560`, bit-depth `:579`, quality `:611`, rate mode `:652`, hwAccel `:684`.
- `apps/desktop/src/renderer/i18n/locales/{en-US.ts,zh-CN.ts}` — `export_dialog` section (en at `:299`).
- `apps/desktop/native/src/export/videosink.rs` — sink (`VideoSinkStartArgs` `:54-69`, cmd built inline `:118-166`).
- `apps/desktop/native/src/export/hwencoder.rs` — `TargetCodec`, `HwEncoderCache.encoder_for` (8-bit) / `encoder_for_10bit`, `tenbit_encode_args`.
- `apps/desktop/native/src/export/mod.rs` — `video_encode_args` `:409`, `hvc1_tag_args` `:390`, `transcode_and_mux` `:294`, `mux_to_file` `:232`.
- `apps/desktop/native/src/commands/export.rs` — `TranscodeSpec`, `mux_export`.
- `apps/desktop/e2e/electron/export_codecs.spec.ts` — the codec matrix e2e (AV1 direct / HEVC mezzanine / 10-bit native).

New files:
- `apps/desktop/src/renderer/render/encodeTarget.ts` + `encodeTarget.test.ts` — the resolution seam (pure).
- `apps/desktop/src/renderer/render/yuv/yuvPlaneLayout.ts` + `yuvPlaneLayout.test.ts` — pack-pass geometry (pure; handles W%4==2 via row padding).
- `apps/desktop/src/renderer/render/yuv/PackYuvPlanar.ts` — generalized GPU pack (yuv420p / yuv422p / yuv422p10le; NOT yuv420p10le, which stays on the frozen class).

---

# Stage E1 — EncodeTarget seam (pure refactor, behavior-preserving)

### Task 1: `resolveEncodeTarget` pure resolver

**Files:**
- Create: `apps/desktop/src/renderer/render/encodeTarget.ts`
- Test: `apps/desktop/src/renderer/render/encodeTarget.test.ts`

**Interfaces:**
- Consumes: `ExportSettings`, `CodecId` from `./exportSettings`.
- Produces (later tasks rely on these exact names): `type EncodeTarget = WebCodecsTarget | NativeTarget`; `WebCodecsTarget = { engine: "webcodecs"; workerCodec: CodecId; transcodeAfter: boolean }`; `NativeTarget = { engine: "native"; pixFmt: NativePixFmt }`; `type NativePixFmt = "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le"`; `needsEncoderProbe(settings): boolean`; `resolveEncodeTarget(settings, smokeOk: boolean): EncodeTarget`.

- [ ] **Step 1: Create the branch**

```bash
cd apps/desktop && git checkout -b feat/export-engine-phase-e
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/desktop/src/renderer/render/encodeTarget.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "./exportSettings";
import { needsEncoderProbe, resolveEncodeTarget } from "./encodeTarget";

const s = (over: Partial<ExportSettings>): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  ...over,
});

describe("resolveEncodeTarget (E1: mirrors today's three branches)", () => {
  it("8-bit + smoke ok → WebCodecs direct (path A)", () => {
    expect(resolveEncodeTarget(s({ codec: "h264" }), true)).toEqual({
      engine: "webcodecs", workerCodec: "h264", transcodeAfter: false,
    });
    expect(resolveEncodeTarget(s({ codec: "av1" }), true)).toEqual({
      engine: "webcodecs", workerCodec: "av1", transcodeAfter: false,
    });
  });

  it("8-bit + smoke fail → H.264 mezzanine + ffmpeg transcode (path B)", () => {
    expect(resolveEncodeTarget(s({ codec: "hevc" }), false)).toEqual({
      engine: "webcodecs", workerCodec: "h264", transcodeAfter: true,
    });
  });

  it("10-bit HEVC/AV1 → native sink yuv420p10le (path C), probe not needed", () => {
    for (const codec of ["hevc", "av1"] as const) {
      const st = s({ codec, bitDepth: 10 });
      expect(needsEncoderProbe(st)).toBe(false);
      expect(resolveEncodeTarget(st, /* ignored */ false)).toEqual({
        engine: "native", pixFmt: "yuv420p10le",
      });
    }
  });

  it("10-bit H.264 (invalid combo, snapped upstream) probes like 8-bit", () => {
    const st = s({ codec: "h264", bitDepth: 10 });
    expect(needsEncoderProbe(st)).toBe(true);
    expect(resolveEncodeTarget(st, true).engine).toBe("webcodecs");
  });

  it("8-bit paths report needsEncoderProbe", () => {
    expect(needsEncoderProbe(s({ codec: "hevc" }))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npm run test -- render/encodeTarget`
Expected: FAIL — `Cannot find module './encodeTarget'`.

- [ ] **Step 4: Write the implementation**

```ts
// apps/desktop/src/renderer/render/encodeTarget.ts
// The EncodeTarget resolution seam (dual-engine spec §"Export engine").
// Pure: probe results are injected, never awaited here. E1 mirrors the three
// legacy branches exactly; E2 adds the encoderEngine pin, E4 flips auto.

import type { CodecId, ExportSettings } from "./exportSettings";

export type NativePixFmt = "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";

export interface WebCodecsTarget {
  engine: "webcodecs";
  /// Codec the worker's VideoEncoder actually encodes. Differs from
  /// settings.codec on the mezzanine path (H.264 intermediate).
  workerCodec: CodecId;
  /// ffmpeg re-encodes the mezzanine to settings.codec after the worker.
  transcodeAfter: boolean;
}

export interface NativeTarget {
  engine: "native";
  /// rawvideo format the worker packs and the ffmpeg sink consumes.
  pixFmt: NativePixFmt;
}

export type EncodeTarget = WebCodecsTarget | NativeTarget;

/// The 10-bit native route needs no WebCodecs smoke-encode; everything else
/// consults it. Callers skip the (async) probe when this is false.
export function needsEncoderProbe(settings: ExportSettings): boolean {
  return !(settings.bitDepth === 10 && settings.codec !== "h264");
}

export function resolveEncodeTarget(
  settings: ExportSettings,
  smokeOk: boolean,
): EncodeTarget {
  if (!needsEncoderProbe(settings)) {
    return { engine: "native", pixFmt: "yuv420p10le" };
  }
  if (smokeOk) {
    return { engine: "webcodecs", workerCodec: settings.codec, transcodeAfter: false };
  }
  return { engine: "webcodecs", workerCodec: "h264", transcodeAfter: true };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- render/encodeTarget`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/render/encodeTarget.ts src/renderer/render/encodeTarget.test.ts
git commit -m "feat(export): EncodeTarget resolution seam (pure, mirrors legacy branches)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Rewire `App.tsx` onto the resolver

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx:1294-1336` (and the import block at `:66-79`)

**Interfaces:**
- Consumes: `needsEncoderProbe`, `resolveEncodeTarget`, `EncodeTarget` (Task 1); existing `resolveEncodePath`.
- Produces: local `target: EncodeTarget` in `runExportWithSettings`; `tenBit`/`encodePath`/`workerCodec` become DERIVED from it (all downstream code at `:1337-1520` unchanged this task).

- [ ] **Step 1: Add imports**

In the import block (next to `resolveEncodePath` at `App.tsx:79`):

```ts
import { needsEncoderProbe, resolveEncodeTarget } from "./render/encodeTarget";
```

- [ ] **Step 2: Replace the decision block**

Replace `App.tsx:1297` and `:1320-1336` — the lines

```ts
    const tenBit = settings.bitDepth === 10 && settings.codec !== "h264";
```
and
```ts
    const encodePath = tenBit
      ? ("webcodecs" as const)
      : await resolveEncodePath(
          settings.codec,
          dims.width,
          dims.height,
          outFps,
        );

    // WebCodecs path → worker encodes the target codec directly. ffmpeg path →
    // worker encodes a high-quality H.264 mezzanine; Rust transcodes it.
    const workerCodec = encodePath === "ffmpeg" ? "h264" : settings.codec;
```

with (the sink-start `if (tenBit)` block at `:1298-1318` stays where it is; move it BELOW this so `target` exists first):

```ts
    // One resolution seam for the encode engine (dual-engine spec §Export).
    // Probe injected: the smoke-encode only runs when the target needs it.
    const smokeOk = needsEncoderProbe(settings)
      ? (await resolveEncodePath(settings.codec, dims.width, dims.height, outFps)) ===
        "webcodecs"
      : true;
    const target = resolveEncodeTarget(settings, smokeOk);
    const tenBit = target.engine === "native";
    const encodePath =
      target.engine === "webcodecs" && target.transcodeAfter
        ? ("ffmpeg" as const)
        : ("webcodecs" as const);
    const workerCodec =
      target.engine === "webcodecs" ? target.workerCodec : settings.codec;
```

Concretely: the final order in the function is `dims/fps` → this resolution block → the `if (tenBit) { await exportVideoSinkStart(...) }` block (unchanged text) → the `workerBitrate` line onward (unchanged).

- [ ] **Step 3: Verify behavior-preservation by type + tests**

Run: `npm run typecheck && npm run test`
Expected: typecheck 0 errors; full vitest suite passes (no behavior change — `tenBit`, `encodePath`, `workerCodec` values are identical for every input by Task 1's tests).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "refactor(export): derive tenBit/encodePath/workerCodec from EncodeTarget

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Stage E2 — Native 8-bit direct encode (H.264/HEVC/AV1)

### Task 3: Rust — extract pure `sink_cmd_args` (behavior-preserving)

**Files:**
- Modify: `apps/desktop/native/src/export/videosink.rs` (`export_video_sink_start` `:118-166`; tests module)

**Interfaces:**
- Consumes: `VideoSinkStartArgs`, `super::video_encode_args`, `super::hwencoder::tenbit_encode_args`, `super::hvc1_tag_args`, `TargetCodec`.
- Produces: `pub(crate) fn sink_cmd_args(args: &VideoSinkStartArgs, codec: TargetCodec, encoder: &str) -> Vec<std::ffi::OsString>` — the FULL ffmpeg argv minus the program name. Task 4 extends it; Task 11 rewrites its rate/preset section.

- [ ] **Step 1: Write the failing test** (in `videosink.rs` `mod tests`)

```rust
    fn args_10bit() -> VideoSinkStartArgs {
        VideoSinkStartArgs {
            width: 1920, height: 1080, fps_num: 30, fps_den: 1,
            codec: "hevc".into(), bitrate: 8_000_000, cbr: false, gop: 30,
            software: true, output_path: "C:/tmp/out.mp4".into(),
        }
    }

    // Locks the exact argv the inline builder produced before extraction.
    #[test]
    fn sink_cmd_args_matches_legacy_10bit_shape() {
        let argv = sink_cmd_args(&args_10bit(), super::super::TargetCodec::Hevc, "libx265");
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        // rawvideo input header
        assert!(s.windows(2).any(|w| w[0] == "-f" && w[1] == "rawvideo"));
        assert!(s.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv420p10le"));
        assert!(s.windows(2).any(|w| w[0] == "-video_size" && w[1] == "1920x1080"));
        assert!(s.windows(2).any(|w| w[0] == "-framerate" && w[1] == "30/1"));
        // frame tagging vf + encoder + 10-bit profile + color tags + hvc1 + output
        assert!(s.iter().any(|a| a.starts_with("setparams=colorspace=bt709")));
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx265"));
        assert!(s.windows(2).any(|w| w[0] == "-profile:v" && w[1] == "main10"));
        assert!(s.windows(2).any(|w| w[0] == "-color_range" && w[1] == "tv"));
        assert!(s.windows(2).any(|w| w[0] == "-tag:v" && w[1] == "hvc1"));
        assert_eq!(s.last().unwrap(), "C:/tmp/out.mp4");
        // input marker present exactly once, before the encoder args
        let i_pos = s.iter().position(|a| a == "-i").unwrap();
        let cv_pos = s.iter().position(|a| a == "-c:v").unwrap();
        assert!(i_pos < cv_pos);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud sink_cmd_args`
Expected: FAIL — `cannot find function sink_cmd_args`.

- [ ] **Step 3: Extract the builder**

In `videosink.rs`, above `export_video_sink_start`:

```rust
/// The full ffmpeg argv (minus program name) for one sink run. Pure — unit
/// tests lock the shape without spawning. `encoder` is already resolved
/// (HW-probed or software).
pub(crate) fn sink_cmd_args(
    args: &VideoSinkStartArgs,
    codec: super::hwencoder::TargetCodec,
    encoder: &str,
) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let mut a: Vec<OsString> = vec![
        "-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-f".into(), "rawvideo".into(),
        "-pix_fmt".into(), "yuv420p10le".into(),
        "-video_size".into(), format!("{}x{}", args.width, args.height).into(),
        "-framerate".into(), format!("{}/{}", args.fps_num, args.fps_den).into(),
        "-i".into(), "-".into(),
        // Tag the FRAMES (rawvideo carries no colour metadata) so every encoder
        // family emits the full bt709/limited 4-tuple (export_10bit gate).
        "-vf".into(),
        "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv".into(),
    ];
    a.extend(super::video_encode_args(encoder, args.bitrate, args.cbr, args.gop));
    a.extend(super::hwencoder::tenbit_encode_args(encoder));
    a.extend::<Vec<OsString>>(vec![
        "-colorspace".into(), "bt709".into(), "-color_primaries".into(), "bt709".into(),
        "-color_trc".into(), "bt709".into(), "-color_range".into(), "tv".into(),
    ]);
    a.extend(super::hvc1_tag_args(codec, std::path::Path::new(&args.output_path)));
    a.push(OsString::from(&args.output_path));
    a
}
```

Then in `export_video_sink_start`, replace the inline `cmd.args([...])`/loop block (`:134-158`, everything between `cmd.no_console_window();` and `cmd.stdin(...)`) with:

```rust
        for arg in sink_cmd_args(&args, codec, &encoder) {
            cmd.arg(arg);
        }
```

(The `codec` parse + hevc/av1 gate + `encoder` selection lines above it stay.)

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud videosink`
Expected: PASS (new test + the 3 existing videosink tests).

- [ ] **Step 5: Commit**

```bash
git add native/src/export/videosink.rs
git commit -m "refactor(export): extract pure sink_cmd_args from videosink start

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: Rust — sink accepts `pixFmt` + 8-bit codecs

**Files:**
- Modify: `apps/desktop/native/src/export/videosink.rs`
- Modify: `apps/desktop/native/src/export/hwencoder.rs` (add `eightbit_encode_args`)
- Modify: `apps/desktop/src/renderer/ipc/index.ts:1427-1438` (TS mirror)

**Interfaces:**
- Consumes: `HwEncoderCache::encoder_for` (8-bit probe cache — already exists for the transcode path).
- Produces: `VideoSinkStartArgs.pix_fmt: String` (serde camelCase `pixFmt`; default `"yuv420p10le"` for back-compat); `pub fn eightbit_encode_args(encoder: &str) -> Vec<OsString>`; sink accepts codec `"h264"|"hevc"|"av1"` at 8-bit, `"hevc"|"av1"` at 10-bit. TS `VideoSinkStartArgs` gains `pixFmt: string`.

- [ ] **Step 1: Write the failing tests** (in `videosink.rs` `mod tests`)

```rust
    fn args_8bit(codec: &str) -> VideoSinkStartArgs {
        VideoSinkStartArgs {
            width: 1920, height: 1080, fps_num: 30, fps_den: 1,
            codec: codec.into(), bitrate: 8_000_000, cbr: false, gop: 30,
            software: true, output_path: "C:/tmp/out.mp4".into(),
            pix_fmt: "yuv420p".into(),
        }
    }

    #[test]
    fn sink_cmd_args_8bit_h264_shape() {
        let argv = sink_cmd_args(&args_8bit("h264"), super::super::TargetCodec::H264, "libx264");
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        // input is 8-bit rawvideo; output pix_fmt is yuv420p; NO main10 profile.
        let pf: Vec<usize> = s.iter().enumerate()
            .filter(|(_, a)| *a == "-pix_fmt").map(|(i, _)| i).collect();
        assert_eq!(pf.len(), 2, "input + output pix_fmt: {s:?}");
        assert_eq!(s[pf[0] + 1], "yuv420p");
        assert_eq!(s[pf[1] + 1], "yuv420p");
        assert!(!s.iter().any(|a| a == "main10"));
        // color tags apply at 8-bit too (the point of the native exit).
        assert!(s.windows(2).any(|w| w[0] == "-color_range" && w[1] == "tv"));
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
    }

    #[test]
    fn tenbit_pix_fmt_still_defaults_and_gates() {
        // serde default keeps old TS callers valid.
        let v: VideoSinkStartArgs =
            serde_json::from_str(r#"{"width":64,"height":64,"fpsNum":30,"fpsDen":1,
              "codec":"hevc","bitrate":0,"cbr":false,"gop":30,"software":true,
              "outputPath":""}"#).unwrap();
        assert_eq!(v.pix_fmt, "yuv420p10le");
    }
```

And in `hwencoder.rs` `mod tests`:

```rust
    #[test]
    fn eightbit_args_pin_yuv420p() {
        let s = |v: &Vec<std::ffi::OsString>| -> Vec<String> {
            v.iter().map(|o| o.to_string_lossy().into_owned()).collect()
        };
        assert_eq!(s(&eightbit_encode_args("libx264")), vec!["-pix_fmt", "yuv420p"]);
        assert_eq!(s(&eightbit_encode_args("hevc_nvenc")), vec!["-pix_fmt", "yuv420p"]);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud export`
Expected: FAIL — missing field `pix_fmt` / `eightbit_encode_args` not found.

- [ ] **Step 3: Implement**

`hwencoder.rs` (below `tenbit_encode_args`):

```rust
/// Output pixel-format flags for an 8-bit encode. Pinned explicitly so libx264
/// never auto-picks High 4:4:4 from an odd input and HW encoders convert
/// deterministically.
pub fn eightbit_encode_args(_encoder: &str) -> Vec<std::ffi::OsString> {
    vec!["-pix_fmt".into(), "yuv420p".into()]
}
```

`videosink.rs` — `VideoSinkStartArgs` gains:

```rust
    /// rawvideo input format the renderer packs: "yuv420p" | "yuv420p10le"
    /// (E3 adds "yuv422p" | "yuv422p10le"). Defaults to the legacy 10-bit
    /// format so pre-E2 callers keep working.
    #[serde(default = "default_sink_pix_fmt")]
    pub pix_fmt: String,
```

with, at module level:

```rust
fn default_sink_pix_fmt() -> String {
    "yuv420p10le".to_string()
}
```

In `sink_cmd_args`: replace the input line `"-pix_fmt".into(), "yuv420p10le".into(),` with `"-pix_fmt".into(), OsString::from(&args.pix_fmt),` and replace `a.extend(super::hwencoder::tenbit_encode_args(encoder));` with:

```rust
    if args.pix_fmt.ends_with("10le") {
        a.extend(super::hwencoder::tenbit_encode_args(encoder));
    } else {
        a.extend(super::hwencoder::eightbit_encode_args(encoder));
    }
```

In `export_video_sink_start`, replace the codec gate + encoder selection (`:119-131`) with:

```rust
        let codec = super::hwencoder::TargetCodec::parse(&args.codec)
            .ok_or_else(|| format!("unknown codec {}", args.codec))?;
        let ten_bit = args.pix_fmt.ends_with("10le");
        if !matches!(args.pix_fmt.as_str(), "yuv420p" | "yuv420p10le") {
            return Err(format!("unsupported sink pix_fmt {}", args.pix_fmt));
        }
        if ten_bit
            && !matches!(
                codec,
                super::hwencoder::TargetCodec::Hevc | super::hwencoder::TargetCodec::Av1
            )
        {
            return Err(format!("10-bit export supports hevc/av1, got {}", args.codec));
        }
        let encoder = if args.software {
            codec.software_encoder().to_string()
        } else if ten_bit {
            hw.encoder_for_10bit(codec).await.as_ref().clone()
        } else {
            hw.encoder_for(codec).await.as_ref().clone()
        };
```

Update the two existing test constructors (`ipc_write_counts_and_finish_reaps` uses struct literal — add `pix_fmt: "yuv420p10le".into(),`; same for `args_10bit()` from Task 3).

`apps/desktop/src/renderer/ipc/index.ts` — extend the interface (after `software: boolean;` at `:1436`):

```ts
  /// rawvideo format the worker packs: "yuv420p" | "yuv420p10le"
  /// (E3: "yuv422p" | "yuv422p10le"). Mirrors videosink.rs (serde default
  /// keeps omission = yuv420p10le, but callers should always set it).
  pixFmt: string;
```

and add `pixFmt: "yuv420p10le",` to the `exportVideoSinkStart({...})` call in `App.tsx:1300-1311` (explicit, even though the serde default covers it — Task 8 makes it dynamic).

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud export && npm run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add native/src/export/videosink.rs native/src/export/hwencoder.rs src/renderer/ipc/index.ts src/renderer/App.tsx
git commit -m "feat(export): videosink accepts pixFmt + 8-bit codecs via the encoder_for cache

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: TS — `yuvPlaneLayout` pack geometry (pure)

**Files:**
- Create: `apps/desktop/src/renderer/render/yuv/yuvPlaneLayout.ts`
- Test: `apps/desktop/src/renderer/render/yuv/yuvPlaneLayout.test.ts`

**Interfaces:**
- Consumes: `NativePixFmt` from `../encodeTarget`.
- Produces: `interface PlanePass { passW: number; passH: number; rowBytes: number; planeBytes: number }`; `interface YuvLayout { bytesPerSample: 1 | 2; samplesPerTexel: 2 | 4; y: PlanePass; c: PlanePass; frameBytes: number }`; `yuvPlaneLayout(pixFmt: NativePixFmt, outW: number, outH: number): YuvLayout`. Task 6's readback + buffer sizing use exactly these.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/render/yuv/yuvPlaneLayout.test.ts
import { describe, expect, it } from "vitest";
import { yuvPlaneLayout } from "./yuvPlaneLayout";

describe("yuvPlaneLayout", () => {
  it("yuv420p10le 1920x1080 matches the frozen PackYuv420p10 geometry", () => {
    const l = yuvPlaneLayout("yuv420p10le", 1920, 1080);
    expect(l).toEqual({
      bytesPerSample: 2, samplesPerTexel: 2,
      y: { passW: 960, passH: 1080, rowBytes: 3840, planeBytes: 3840 * 1080 },
      c: { passW: 480, passH: 540, rowBytes: 1920, planeBytes: 1920 * 540 },
      frameBytes: 3840 * 1080 + 2 * 1920 * 540,
    });
  });

  it("yuv420p 1920x1080 — dense 4-samples-per-texel", () => {
    const l = yuvPlaneLayout("yuv420p", 1920, 1080);
    expect(l.bytesPerSample).toBe(1);
    expect(l.samplesPerTexel).toBe(4);
    expect(l.y).toEqual({ passW: 480, passH: 1080, rowBytes: 1920, planeBytes: 1920 * 1080 });
    expect(l.c).toEqual({ passW: 240, passH: 540, rowBytes: 960, planeBytes: 960 * 540 });
    expect(l.frameBytes).toBe(1920 * 1080 * 1.5);
  });

  it("yuv420p 1366x768 — W%4==2 pads the pass row, plane rows stay exact", () => {
    const l = yuvPlaneLayout("yuv420p", 1366, 768);
    // Y row = 1366 samples = 1366 bytes; pass row = ceil(1366/4)=342 texels = 1368 bytes.
    expect(l.y.passW).toBe(342);
    expect(l.y.rowBytes).toBe(1366);
    // C row = 683 samples; pass = ceil(683/4)=171 texels = 684 bytes vs 683 valid.
    expect(l.c.passW).toBe(171);
    expect(l.c.rowBytes).toBe(683);
    expect(l.c.passH).toBe(384);
    expect(l.frameBytes).toBe(1366 * 768 + 2 * 683 * 384);
  });

  it("yuv422p keeps full-height chroma", () => {
    const l = yuvPlaneLayout("yuv422p", 1920, 1080);
    expect(l.c).toEqual({ passW: 240, passH: 1080, rowBytes: 960, planeBytes: 960 * 1080 });
    expect(l.frameBytes).toBe(1920 * 1080 * 2);
  });

  it("yuv422p10le — ProRes shape", () => {
    const l = yuvPlaneLayout("yuv422p10le", 1920, 1080);
    expect(l.y).toEqual({ passW: 960, passH: 1080, rowBytes: 3840, planeBytes: 3840 * 1080 });
    expect(l.c).toEqual({ passW: 480, passH: 1080, rowBytes: 1920, planeBytes: 1920 * 1080 });
  });

  it("rejects odd dimensions", () => {
    expect(() => yuvPlaneLayout("yuv420p", 1921, 1080)).toThrow(/even/);
    expect(() => yuvPlaneLayout("yuv420p", 1920, 1081)).toThrow(/even/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- yuv/yuvPlaneLayout`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/renderer/render/yuv/yuvPlaneLayout.ts
// Geometry for the GPU byte-pack passes (PackYuvPlanar). Each pack pass
// renders into an RGBA8 target whose 4-byte texels carry either two u16LE
// samples (10-bit) or four u8 samples (8-bit). Widths that don't divide the
// samples-per-texel get a PADDED pass row (ceil), and the CPU readback trims
// each row to `rowBytes` — this is what admits W%4==2 outputs (e.g. 1366)
// that the frozen PackYuv420p10 rejects.

import type { NativePixFmt } from "../encodeTarget";

export interface PlanePass {
  /// Pack-pass render-target size in texels.
  passW: number;
  passH: number;
  /// VALID bytes per plane row (= samples * bytesPerSample). passW*4 may
  /// exceed this by up to 3 bytes (pad, trimmed on readback).
  rowBytes: number;
  planeBytes: number;
}

export interface YuvLayout {
  bytesPerSample: 1 | 2;
  samplesPerTexel: 2 | 4;
  y: PlanePass;
  c: PlanePass;
  frameBytes: number;
}

export function yuvPlaneLayout(
  pixFmt: NativePixFmt,
  outW: number,
  outH: number,
): YuvLayout {
  if (outW % 2 !== 0 || outH % 2 !== 0) {
    throw new Error(`yuvPlaneLayout: even dimensions required, got ${outW}x${outH}`);
  }
  const tenBit = pixFmt.endsWith("10le");
  const bytesPerSample: 1 | 2 = tenBit ? 2 : 1;
  const samplesPerTexel: 2 | 4 = tenBit ? 2 : 4;
  const is420 = pixFmt.startsWith("yuv420");
  const cW = outW / 2;
  const cH = is420 ? outH / 2 : outH;
  const plane = (samplesW: number, h: number): PlanePass => {
    const rowBytes = samplesW * bytesPerSample;
    return {
      passW: Math.ceil(samplesW / samplesPerTexel),
      passH: h,
      rowBytes,
      planeBytes: rowBytes * h,
    };
  };
  const y = plane(outW, outH);
  const c = plane(cW, cH);
  return { bytesPerSample, samplesPerTexel, y, c, frameBytes: y.planeBytes + 2 * c.planeBytes };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- yuv/yuvPlaneLayout`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/render/yuv/yuvPlaneLayout.ts src/renderer/render/yuv/yuvPlaneLayout.test.ts
git commit -m "feat(export): yuv plane/pass geometry for the generalized pack (pure)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: TS — `PackYuvPlanar` GPU pack class

**Files:**
- Create: `apps/desktop/src/renderer/render/yuv/PackYuvPlanar.ts`

**Interfaces:**
- Consumes: `yuvPlaneLayout` (Task 5); PixiJS `WebGLRenderer`/`RenderTexture`/`Mesh`/`Shader` (same imports as `PackYuv420p10.ts`).
- Produces: `class PackYuvPlanar { constructor(renderer: WebGLRenderer, outW: number, outH: number, pixFmt: Exclude<NativePixFmt, "yuv420p10le">); pack(composite: Texture): Uint8Array; dispose(): void }` — the same `pack`/`dispose` duck type as `PackYuv420p10`, so the worker holds either behind one variable (Task 8).
- Note: `"yuv420p10le"` is deliberately excluded — that format stays on the frozen, parity-gated `PackYuv420p10`.

- [ ] **Step 1: Implement** (GL code has no vitest cycle; geometry is covered by Task 5's tests and pixel correctness by the e2e SSIM gate in Task 9. Typecheck is this task's gate.)

```ts
// apps/desktop/src/renderer/render/yuv/PackYuvPlanar.ts
// Generalized GPU byte-pack: f16/rgba8 composite → planar YUV bytes for the
// native ffmpeg sink. Covers yuv420p / yuv422p (8-bit, 4 samples per RGBA8
// texel) and yuv422p10le (two u16LE samples per texel). yuv420p10le stays on
// the frozen PackYuv420p10 (its shaders are duplicated byte-identical by the
// 10-bit GL-parity gate). Structure mirrors PackYuv420p10: three passes
// (Y/Cb/Cr) sampled bilinearly at output resolution (encoder downscale folds
// in), BT.709 limited-range quantization in-shader, readPixels per plane.
// Rows may be padded to the texel boundary (yuvPlaneLayout.passW*4 >
// rowBytes); readback trims per row.

import { Mesh, MeshGeometry, RenderTexture, Shader } from "pixi.js";
import type { Texture, TextureSource, WebGLRenderer } from "pixi.js";
import type { NativePixFmt } from "../encodeTarget";
import { yuvPlaneLayout, type PlanePass, type YuvLayout } from "./yuvPlaneLayout";

export type PackablePixFmt = Exclude<NativePixFmt, "yuv420p10le">;

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;

// ---- 8-bit fragments: four samples per RGBA8 texel --------------------------
// Y' = 16 + 219*Y, C = 128 + 224*C (BT.709 limited, 8-bit quantization).
const FRAG_Y_8 = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float q(float y) { return clamp(floor(16.0 + y * 219.0 + 0.5), 0.0, 255.0); }
float lum(float px, float row) {
  return q(dot(texture(uC, vec2((px + 0.5) / uOut.x, (row + 0.5) / uOut.y)).rgb, KY));
}
void main() {
  float px = (gl_FragCoord.x - 0.5) * 4.0;
  float row = gl_FragCoord.y - 0.5;
  o = vec4(lum(px, row), lum(px + 1.0, row), lum(px + 2.0, row), lum(px + 3.0, row)) / 255.0;
}`;

// uSub: 2.0 = 4:2:0 (2x2 block midpoint), 1.0 = 4:2:2 (2x1 midpoint).
const FRAG_C_8 = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
uniform float uSel;
uniform float uSub;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float qc(float c) { return clamp(floor(128.0 + c * 224.0 + 0.5), 0.0, 255.0); }
float chroma(float cx, float cy) {
  vec2 mid = vec2((2.0 * cx + 1.0) / uOut.x, (uSub * cy + 0.5 * uSub) / uOut.y);
  vec3 rgb = texture(uC, mid).rgb;
  float y = dot(rgb, KY);
  return qc(uSel < 0.5 ? (rgb.b - y) / 1.8556 : (rgb.r - y) / 1.5748);
}
void main() {
  float cx = (gl_FragCoord.x - 0.5) * 4.0;
  float cy = gl_FragCoord.y - 0.5;
  o = vec4(chroma(cx, cy), chroma(cx + 1.0, cy), chroma(cx + 2.0, cy), chroma(cx + 3.0, cy)) / 255.0;
}`;

// ---- 10-bit fragments (yuv422p10le): two u16LE samples per texel ------------
const FRAG_Y_10 = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float q(float y) { return clamp(floor(64.0 + y * 876.0 + 0.5), 0.0, 1023.0); }
void main() {
  float px = (gl_FragCoord.x - 0.5) * 2.0;
  float row = gl_FragCoord.y - 0.5;
  float y0 = q(dot(texture(uC, vec2((px + 0.5) / uOut.x, (row + 0.5) / uOut.y)).rgb, KY));
  float y1 = q(dot(texture(uC, vec2((px + 1.5) / uOut.x, (row + 0.5) / uOut.y)).rgb, KY));
  o = vec4(mod(y0, 256.0) / 255.0, floor(y0 / 256.0) / 255.0,
           mod(y1, 256.0) / 255.0, floor(y1 / 256.0) / 255.0);
}`;

const FRAG_C_10 = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
uniform float uSel;
uniform float uSub;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float qc(float c) { return clamp(floor(512.0 + c * 896.0 + 0.5), 0.0, 1023.0); }
float chroma(float cx, float cy) {
  vec2 mid = vec2((2.0 * cx + 1.0) / uOut.x, (uSub * cy + 0.5 * uSub) / uOut.y);
  vec3 rgb = texture(uC, mid).rgb;
  float y = dot(rgb, KY);
  return uSel < 0.5 ? (rgb.b - y) / 1.8556 : (rgb.r - y) / 1.5748;
}
void main() {
  float cx = (gl_FragCoord.x - 0.5) * 2.0;
  float cy = gl_FragCoord.y - 0.5;
  float c0 = qc(chroma(cx, cy));
  float c1 = qc(chroma(cx + 1.0, cy));
  o = vec4(mod(c0, 256.0) / 255.0, floor(c0 / 256.0) / 255.0,
           mod(c1, 256.0) / 255.0, floor(c1 / 256.0) / 255.0);
}`;

interface Pass { rt: RenderTexture; mesh: Mesh<MeshGeometry, Shader>; plane: PlanePass }

export class PackYuvPlanar {
  private layout: YuvLayout;
  private y: Pass | null = null;
  private u: Pass | null = null;
  private v: Pass | null = null;
  private out: Uint8Array | null = null;
  private scratch: Uint8Array | null = null;
  private boundSource: TextureSource | null = null;

  constructor(
    private renderer: WebGLRenderer,
    private outW: number,
    private outH: number,
    private pixFmt: PackablePixFmt,
  ) {
    this.layout = yuvPlaneLayout(pixFmt, outW, outH); // throws on odd dims
  }

  private buildPass(frag: string, plane: PlanePass, sel: number | null, composite: Texture): Pass {
    const rt = RenderTexture.create({ width: plane.passW, height: plane.passH, format: "rgba8unorm" });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, plane.passW, 0, plane.passW, plane.passH, 0, plane.passH]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const sub = this.pixFmt.startsWith("yuv420") ? 2 : 1;
    const shader = Shader.from({
      gl: { vertex: VERT, fragment: frag },
      resources: {
        uC: composite.source,
        uCSampler: composite.source.style,
        pack: {
          uOut: { value: new Float32Array([this.outW, this.outH]), type: "vec2<f32>" },
          uSub: { value: sub, type: "f32" },
          ...(sel !== null ? { uSel: { value: sel, type: "f32" } } : {}),
        },
      },
    });
    return { rt, mesh: new Mesh<MeshGeometry, Shader>({ geometry, shader }), plane };
  }

  /// Render the three pack passes off `composite` and return one buffer in
  /// planar order (Y, Cb, Cr). The returned view is REUSED across calls —
  /// the caller must consume (send/copy) it before the next pack().
  pack(composite: Texture): Uint8Array {
    if (this.boundSource === null) {
      this.boundSource = composite.source;
    } else if (composite.source !== this.boundSource) {
      throw new Error("PackYuvPlanar: composite texture changed after first pack() — recreate the packer");
    }
    const tenBit = this.layout.bytesPerSample === 2;
    this.y ??= this.buildPass(tenBit ? FRAG_Y_10 : FRAG_Y_8, this.layout.y, null, composite);
    this.u ??= this.buildPass(tenBit ? FRAG_C_10 : FRAG_C_8, this.layout.c, 0, composite);
    this.v ??= this.buildPass(tenBit ? FRAG_C_10 : FRAG_C_8, this.layout.c, 1, composite);
    this.out ??= new Uint8Array(this.layout.frameBytes);
    let offset = 0;
    for (const pass of [this.y, this.u, this.v]) {
      this.renderer.render({ container: pass.mesh, target: pass.rt });
      this.readPlane(pass, this.out.subarray(offset, offset + pass.plane.planeBytes));
      offset += pass.plane.planeBytes;
    }
    return this.out;
  }

  private readPlane(pass: Pass, dst: Uint8Array): void {
    this.renderer.renderTarget.bind(pass.rt, false);
    const gl = this.renderer.gl;
    const { passW, passH, rowBytes } = pass.plane;
    const paddedRow = passW * 4;
    if (paddedRow === rowBytes) {
      gl.readPixels(0, 0, passW, passH, gl.RGBA, gl.UNSIGNED_BYTE, dst);
      return;
    }
    // Padded pass rows (W not divisible by samples-per-texel): read the padded
    // target, then trim each row to the plane's valid byte count.
    const need = paddedRow * passH;
    if (!this.scratch || this.scratch.length < need) this.scratch = new Uint8Array(need);
    const tmp = this.scratch.subarray(0, need);
    gl.readPixels(0, 0, passW, passH, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
    for (let r = 0; r < passH; r++) {
      dst.set(tmp.subarray(r * paddedRow, r * paddedRow + rowBytes), r * rowBytes);
    }
  }

  dispose(): void {
    for (const p of [this.y, this.u, this.v]) {
      if (p) {
        const { geometry, shader } = p.mesh;
        p.mesh.destroy();
        geometry.destroy();
        shader?.destroy();
        p.rt.destroy(true);
      }
    }
    this.y = this.u = this.v = null;
    this.boundSource = null;
    this.out = null;
    this.scratch = null;
  }
}
```

- [ ] **Step 2: Gate**

Run: `npm run typecheck && npm run test`
Expected: 0 errors; suite green (no runtime consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/render/yuv/PackYuvPlanar.ts
git commit -m "feat(export): PackYuvPlanar GPU pack (yuv420p/yuv422p/yuv422p10le)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: Schema — `encoderEngine` + resolver pins

**Files:**
- Modify: `apps/desktop/src/renderer/render/exportSettings.ts` (interface `:40-74`, defaults `:76-90`)
- Modify: `apps/desktop/src/renderer/render/encodeTarget.ts`
- Test: `apps/desktop/src/renderer/render/encodeTarget.test.ts`, `exportSettings.test.ts`

**Interfaces:**
- Produces: `type EncoderEngine = "auto" | "native" | "webcodecs"`; `ExportSettings.encoderEngine: EncoderEngine` (default `"auto"`); `nativePixFmtFor(settings): NativePixFmt` in `encodeTarget.ts`. Resolver honors pins; `"auto"` stays legacy until E4 (Task 15).

- [ ] **Step 1: Write the failing tests**

Append to `encodeTarget.test.ts`:

```ts
describe("encoderEngine pins (E2)", () => {
  it("native pin → native sink with bit-depth-matched pixFmt", () => {
    expect(resolveEncodeTarget(s({ codec: "h264", encoderEngine: "native" }), true))
      .toEqual({ engine: "native", pixFmt: "yuv420p" });
    expect(resolveEncodeTarget(s({ codec: "hevc", bitDepth: 10, encoderEngine: "native" }), true))
      .toEqual({ engine: "native", pixFmt: "yuv420p10le" });
    expect(needsEncoderProbe(s({ codec: "hevc", encoderEngine: "native" }))).toBe(false);
  });

  it("webcodecs pin keeps legacy probe behavior (mezzanine until E4)", () => {
    expect(resolveEncodeTarget(s({ codec: "hevc", encoderEngine: "webcodecs" }), false))
      .toEqual({ engine: "webcodecs", workerCodec: "h264", transcodeAfter: true });
  });

  it("auto is unchanged legacy behavior in E2", () => {
    expect(resolveEncodeTarget(s({ codec: "av1", encoderEngine: "auto" }), true).engine)
      .toBe("webcodecs");
  });
});
```

Append to `exportSettings.test.ts`:

```ts
  it("mergeSettings back-fills encoderEngine for old blobs", () => {
    const merged = mergeSettings({ codec: "h264" } as Partial<ExportSettings>);
    expect(merged.encoderEngine).toBe("auto");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- render/encodeTarget render/exportSettings`
Expected: FAIL — `encoderEngine` unknown property / `nativePixFmtFor` missing.

- [ ] **Step 3: Implement**

`exportSettings.ts` — after `export type RateMode ...` add:

```ts
/// Which encode engine writes the video stream. "auto" resolves per machine
/// (E2: legacy behavior; E4: native-first). "native" = the ffmpeg sink;
/// "webcodecs" = the in-renderer VideoEncoder + fMP4 path.
export type EncoderEngine = "auto" | "native" | "webcodecs";
```

In `interface ExportSettings` (after `hwAccel`): `encoderEngine: EncoderEngine;` with the doc comment `/// Encode engine. Persisted per project; "auto" re-resolves on each machine.` In `DEFAULT_EXPORT_SETTINGS`: `encoderEngine: "auto",`.

`encodeTarget.ts` — replace `needsEncoderProbe` and `resolveEncodeTarget` bodies, and add `nativePixFmtFor`:

```ts
/// rawvideo format the native sink consumes for these settings. E3 extends
/// this for the intermediate codecs (ProRes → yuv422p10le, DNxHR → yuv422p).
export function nativePixFmtFor(settings: ExportSettings): NativePixFmt {
  return settings.bitDepth === 10 ? "yuv420p10le" : "yuv420p";
}

/// True when resolution depends on the WebCodecs smoke-encode. Pinned-native
/// and the 10-bit native route never consult it.
export function needsEncoderProbe(settings: ExportSettings): boolean {
  if (settings.encoderEngine === "native") return false;
  return !(settings.bitDepth === 10 && settings.codec !== "h264");
}

export function resolveEncodeTarget(
  settings: ExportSettings,
  smokeOk: boolean,
): EncodeTarget {
  if (!needsEncoderProbe(settings)) {
    return { engine: "native", pixFmt: nativePixFmtFor(settings) };
  }
  // "webcodecs" pin and "auto" share the legacy probe behavior until E4
  // flips auto to native-first (the mezzanine still backstops smoke failures).
  if (smokeOk) {
    return { engine: "webcodecs", workerCodec: settings.codec, transcodeAfter: false };
  }
  return { engine: "webcodecs", workerCodec: "h264", transcodeAfter: true };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- render/encodeTarget render/exportSettings && npm run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/render/exportSettings.ts src/renderer/render/exportSettings.test.ts src/renderer/render/encodeTarget.ts src/renderer/render/encodeTarget.test.ts
git commit -m "feat(export): encoderEngine setting (auto/native/webcodecs) + resolver pins

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: Thread the native sink through worker/protocol/App

**Files:**
- Modify: `apps/desktop/src/renderer/render/worker/protocol.ts` (`ExportRequest.start`, `:88-97`)
- Modify: `apps/desktop/src/renderer/render/worker/exportWorker.ts` (`:104-263`, frame loop `:415-459`, cleanup types `:585-612`)
- Modify: `apps/desktop/src/renderer/render/worker/runExport.ts` (`RunExportInit` `:60-63`, `startReq` `:182-196`)
- Modify: `apps/desktop/src/renderer/preview/PreviewSurface.tsx` (`:483`, `:518`)
- Modify: `apps/desktop/src/renderer/App.tsx` (`:1297-1318`, `:1395-1401`, `:1406-1416`, `:1420-1467`)

**Interfaces:**
- Consumes: `EncodeTarget`/`NativePixFmt` (Task 1/7), `PackYuvPlanar` (Task 6), sink `pixFmt` (Task 4).
- Produces: `ExportRequest.start.nativeSink?: { pixFmt: NativePixFmt }`; `RunExportInit.nativeSinkPixFmt?: NativePixFmt`; PreviewSurface option `nativeSinkPixFmt?: NativePixFmt`. Worker rule: `nativeSink` ⇒ WebGL2 + RenderTexture composite + pack + chunk/ack streaming; `bitDepth===10` ⇒ f16 precision (independent flags).

- [ ] **Step 1: protocol.ts** — replace the `bitDepth` doc block (`:88-90`) and add the sink field after it:

```ts
      /// 10 ⇒ f16/WebGL2 composite precision. Whether frames go to the native
      /// sink is `nativeSink` below — the two are independent (8-bit native
      /// composites RGBA8 but still packs + streams).
      bitDepth?: 8 | 10;
      /// Present ⇒ pack each frame to `pixFmt` and stream raw frames over the
      /// chunk/ack channel to the ffmpeg video sink (no WebCodecs encoder).
      /// Absent ⇒ the WebCodecs EncoderSink/fMP4 path.
      nativeSink?: { pixFmt: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le" };
```

- [ ] **Step 2: exportWorker.ts** — mechanical replacement of the `tenBit` gates:

At `:44` add `import { PackYuvPlanar } from "../yuv/PackYuvPlanar";` (keep the PackYuv420p10 import).

At `:109` replace `const tenBit = req.bitDepth === 10;` with:

```ts
  const tenBit = req.bitDepth === 10;
  const sinkFmt = req.nativeSink?.pixFmt ?? null;
  const nativeSink = sinkFmt !== null;
```

Then update each gate (exact substitutions):
- `:133` `preference: tenBit ? "webgl" : "webgpu",` → `preference: nativeSink || tenBit ? "webgl" : "webgpu",` (native sink always composites on WebGL2 — single pack-pass implementation, per spec).
- `:136-159` f16 capability probe: keep condition `if (tenBit)` (precision concern only).
- `:161-169` TexturePool f16: keep `if (tenBit)`.
- `:240-249` encoder creation: `const encoder = tenBit ? null : new EncoderSink({...})` → `const encoder = nativeSink ? null : new EncoderSink({...})`.
- `:254-263` pack resources:

```ts
  let compositeRT: RenderTexture | null = null;
  let pack: PackYuv420p10 | PackYuvPlanar | null = null;
  if (nativeSink) {
    compositeRT = RenderTexture.create({
      width: req.project.width,
      height: req.project.height,
      format: tenBit ? "rgba16float" : "rgba8unorm",
    });
    pack =
      sinkFmt === "yuv420p10le"
        ? new PackYuv420p10(app.renderer as WebGLRenderer, outWidth, outHeight)
        : new PackYuvPlanar(app.renderer as WebGLRenderer, outWidth, outHeight, sinkFmt!);
  }
```

- `:292` scaleCanvas guard: `const scaleCanvas = !tenBit && needsScale` → `!nativeSink && needsScale`.
- `:415` frame-loop branch: `if (tenBit) {` → `if (nativeSink) {` (body unchanged — render to compositeRT, pack, `await postChunk(bytes.slice())`).
- `:486` queue wait: `if (!tenBit) {` → `if (!nativeSink) {`.
- `:557` finalize: `if (!tenBit) {` → `if (!nativeSink) {`.
- `:351` ten-bit media lane condition stays `tenBit && req.tenBitMedia?.[g.mediaId] === true` (source-decode concern, unrelated to the sink).
- `CleanupArgs.pack` type (`:590`): `pack: PackYuv420p10 | PackYuvPlanar | null;`.

- [ ] **Step 3: runExport.ts** — `RunExportInit` gains (after `bitDepth?: 8 | 10;` at `:62`):

```ts
  /// Present ⇒ the worker packs frames to this format and streams them to the
  /// native ffmpeg sink instead of WebCodecs-encoding.
  nativeSinkPixFmt?: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";
```

and `startReq` (after `bitDepth: init.bitDepth ?? 8,` at `:193`):

```ts
    ...(init.nativeSinkPixFmt ? { nativeSink: { pixFmt: init.nativeSinkPixFmt } } : {}),
```

- [ ] **Step 4: PreviewSurface.tsx** — options interface at `:483` gains `nativeSinkPixFmt?: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";` and the forwarding spread at `:518` gains, next to the bitDepth line:

```ts
      ...(opts.nativeSinkPixFmt != null ? { nativeSinkPixFmt: opts.nativeSinkPixFmt } : {}),
```

- [ ] **Step 5: App.tsx** — generalize the sink calls (all inside `runExportWithSettings`):
- Rename the local `tenBit` to `nativeSink` at the Task-2 block (`const nativeSink = target.engine === "native";`) and update its five uses (`:1298`, `:1395`, `:1415`, `:1420/1425`, `:1456`) — they are engine questions, not depth questions.
- The sink start call becomes:

```ts
    if (nativeSink) {
      try {
        await exportVideoSinkStart({
          width: dims.width,
          height: dims.height,
          fpsNum,
          fpsDen,
          codec: settings.codec,
          pixFmt: (target as { pixFmt: string }).pixFmt,
          bitrate: computeBitrate(settings, dims.width, dims.height, outFps),
          cbr: settings.rateMode === "cbr",
          gop: gopFrames(settings.keyframeIntervalSec, outFps),
          software: settings.hwAccel === "software",
          outputPath: tempVideoPath,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] video sink start failed:", e);
        setExportState({ kind: "error", detail: `Failed to start the native encoder: ${msg}` });
        return;
      }
    }
```

- The `runPixiExport` options (`:1406-1416`) change `bitDepth: tenBit ? 10 : 8,` to:

```ts
        bitDepth: settings.bitDepth === 10 ? 10 : 8,
        ...(nativeSink
          ? { nativeSinkPixFmt: (target as { pixFmt: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le" }).pixFmt }
          : {}),
```

(TypeScript narrows `target` to `NativeTarget` inside `if (nativeSink)` blocks when you test `target.engine === "native"` directly — prefer `const sinkTarget = target.engine === "native" ? target : null;` at the top and use `sinkTarget.pixFmt` in both places instead of casts.)

- [ ] **Step 6: Gate**

Run: `npm run typecheck && npm run test`
Expected: 0 errors; suite green. (The 10-bit flow is unchanged observationally: `settings.bitDepth === 10 && codec !== "h264"` still yields `nativeSink=true`, `bitDepth:10`, `pixFmt:"yuv420p10le"`.)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/render/worker/protocol.ts src/renderer/render/worker/exportWorker.ts src/renderer/render/worker/runExport.ts src/renderer/preview/PreviewSurface.tsx src/renderer/App.tsx
git commit -m "feat(export): nativeSink lane through protocol/worker; 8-bit native reachable via encoderEngine pin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9: e2e — pinned-native H.264 cell (local verification)

**Files:**
- Modify: `apps/desktop/e2e/electron/export_codecs.spec.ts`

**Interfaces:**
- Consumes: the spec's existing helpers (`exportWithSettings`-style runner at `:63`, `probeVideoStream`, `analyze`, `SSIM_FLOOR`).

- [ ] **Step 1: Add the cell** (mirror the AV1 test block at `:102-141`; new test in the same describe):

```ts
  // Native 8-bit H.264 (pinned): encoderEngine:'native' → PackYuvPlanar yuv420p
  // → chunk/ack IPC → ffmpeg (libx264 or HW). Asserts codec shape, EXPLICIT
  // bt709/limited color tags (the native exit's assertable property), and SSIM.
  test('pinned-native H.264 export is conformant with explicit color tags (Electron)', async () => {
    const OUTPUT = path.join(OUT_DIR, 'native-h264.mp4')
    await runExportViaHook(
      { codec: 'h264', encoderEngine: 'native', container: 'mp4', audio: { include: false } },
      OUTPUT,
      'native H.264',
    )
    const st = probeVideoStream(
      OUTPUT,
      'codec_name,pix_fmt,color_space,color_transfer,color_primaries,color_range',
    )
    expect(st.codec_name).toBe('h264')
    expect(st.pix_fmt).toBe('yuv420p')
    expect(st.color_space).toBe('bt709')
    expect(st.color_primaries).toBe('bt709')
    expect(st.color_transfer).toBe('bt709')
    expect(st.color_range).toBe('tv')
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: SSIM_FLOOR })
    console.log('[e2e] native H.264 conformance report:', JSON.stringify(report))
  })
```

Adapt the runner call to the file's ACTUAL helper name/signature (read the AV1 test at `:102` — it constructs settings and calls the shared run helper; keep identical structure, only settings + assertions differ). If the settings type rejects `encoderEngine` before Task 7's schema lands in the built app, this is the signal the build is stale — rebuild.

- [ ] **Step 2: Run locally** (needs a real GPU box; skip on CI by existing mechanisms)

```bash
cd apps/desktop
npm run napi:build          # close the dev app first (.node lock)
npm run fetch-ffmpeg
VITE_WEFTCUT_E2E=1 npm run build
npx playwright test e2e/electron/export_codecs.spec.ts
```

Expected: all existing cells + the new native H.264 cell PASS (SSIM ≥ floor, tags asserted).

- [ ] **Step 3: Commit**

```bash
git add e2e/electron/export_codecs.spec.ts
git commit -m "test(export): pinned-native H.264 e2e cell with color-tag assertions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Stage E3 — ProRes/DNxHR + CRF/preset + dialog UI

### Task 10: Schema v2 — intermediate codecs, quality mode, preset

**Files:**
- Modify: `apps/desktop/src/renderer/render/exportSettings.ts`
- Modify: `apps/desktop/src/renderer/render/encodeTarget.ts` (`nativePixFmtFor`, probe/pins for intermediates)
- Modify: `apps/desktop/src/renderer/render/exportCodecProbe.ts` (type guard)
- Test: `exportSettings.test.ts`, `encodeTarget.test.ts`

**Interfaces (produced — later tasks use these exact names):**
- `type CodecId = "h264" | "av1" | "hevc" | "prores" | "dnxhr"`; `type WebCodecsCodecId = "h264" | "av1" | "hevc"`; `isIntermediateCodec(c: CodecId): c is "prores" | "dnxhr"`.
- `type ProresProfile = "proxy" | "lt" | "422" | "hq"` (default `"422"`); `type DnxhrProfile = "lb" | "sq" | "hq"` (default `"sq"`); fields `proresProfile: ProresProfile; dnxhrProfile: DnxhrProfile` on `ExportSettings`.
- `type RateMode = "vbr" | "cbr" | "quality"`; fields `crf: number | null` (null ⇒ per-codec default), `preset: "fast" | "medium" | "slow"` (default `"medium"`).
- `defaultCrf(codec: CodecId): number` → h264 18, hevc 22, av1 30 (intermediates: unused, return 0).
- `compositeBitDepth(s: ExportSettings): 8 | 10` → 10 iff `bitDepth === 10 || codec === "prores"`.

- [ ] **Step 1: Write the failing tests** (append to `exportSettings.test.ts`)

```ts
describe("E3 schema", () => {
  it("intermediates are MOV-only and native-implied", () => {
    expect(containersForCodec("prores")).toEqual(["mov"]);
    expect(containersForCodec("dnxhr")).toEqual(["mov"]);
    expect(isIntermediateCodec("prores")).toBe(true);
    expect(isIntermediateCodec("h264")).toBe(false);
  });

  it("bit depth is implied: prores=10, dnxhr=8", () => {
    expect(isBitDepthValid("prores", 10)).toBe(true);
    expect(isBitDepthValid("prores", 8)).toBe(false);
    expect(isBitDepthValid("dnxhr", 8)).toBe(true);
    expect(isBitDepthValid("dnxhr", 10)).toBe(false);
  });

  it("mergeSettings snaps stale blobs onto valid combos", () => {
    const m = mergeSettings({ codec: "prores", container: "mp4", bitDepth: 8 } as Partial<ExportSettings>);
    expect(m.container).toBe("mov");
    expect(m.bitDepth).toBe(10);
    const d = mergeSettings({ codec: "dnxhr" } as Partial<ExportSettings>);
    expect(d.bitDepth).toBe(8);
    expect(d.proresProfile).toBe("422");
    expect(d.dnxhrProfile).toBe("sq");
    expect(d.rateMode === "vbr" || d.rateMode === "cbr" || d.rateMode === "quality").toBe(true);
    expect(d.preset).toBe("medium");
    expect(d.crf).toBeNull();
  });

  it("quality rate mode has per-codec CRF defaults", () => {
    expect(defaultCrf("h264")).toBe(18);
    expect(defaultCrf("hevc")).toBe(22);
    expect(defaultCrf("av1")).toBe(30);
  });

  it("computeBitrate for intermediates estimates from the profile table", () => {
    // 1080p30 ProRes 422 ≈ 147 Mbps (Apple whitepaper nominal; size-estimate only).
    const br = computeBitrate(
      mergeSettings({ codec: "prores", proresProfile: "422" } as Partial<ExportSettings>),
      1920, 1080, 30,
    );
    expect(br).toBeGreaterThan(100_000_000);
    expect(br).toBeLessThan(200_000_000);
  });

  it("compositeBitDepth: prores composites f16, dnxhr stays 8", () => {
    expect(compositeBitDepth(mergeSettings({ codec: "prores" } as Partial<ExportSettings>))).toBe(10);
    expect(compositeBitDepth(mergeSettings({ codec: "dnxhr" } as Partial<ExportSettings>))).toBe(8);
    expect(compositeBitDepth(mergeSettings({ codec: "hevc", bitDepth: 10 } as Partial<ExportSettings>))).toBe(10);
  });
});
```

Append to `encodeTarget.test.ts`:

```ts
describe("intermediates route native with 422 formats (E3)", () => {
  it("prores → yuv422p10le, dnxhr → yuv422p; no probe", () => {
    const p = s({ codec: "prores", bitDepth: 10, container: "mov" });
    expect(needsEncoderProbe(p)).toBe(false);
    expect(resolveEncodeTarget(p, false)).toEqual({ engine: "native", pixFmt: "yuv422p10le" });
    const d = s({ codec: "dnxhr", container: "mov" });
    expect(needsEncoderProbe(d)).toBe(false);
    expect(resolveEncodeTarget(d, false)).toEqual({ engine: "native", pixFmt: "yuv422p" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- render/exportSettings render/encodeTarget`
Expected: FAIL — types don't admit `"prores"` etc.

- [ ] **Step 3: Implement in `exportSettings.ts`**

```ts
export type CodecId = "h264" | "av1" | "hevc" | "prores" | "dnxhr";
/// Codecs a WebCodecs VideoEncoder can emit; intermediates are native-only.
export type WebCodecsCodecId = "h264" | "av1" | "hevc";
export function isIntermediateCodec(c: CodecId): c is "prores" | "dnxhr" {
  return c === "prores" || c === "dnxhr";
}

export type ProresProfile = "proxy" | "lt" | "422" | "hq";
export type DnxhrProfile = "lb" | "sq" | "hq";
export type RateMode = "vbr" | "cbr" | "quality";
export type SpeedPreset = "fast" | "medium" | "slow";
```

`ExportSettings` gains (with doc comments in the file's style):

```ts
  /// ProRes flavor (prores_ks profile). Only meaningful when codec === "prores".
  proresProfile: ProresProfile;
  /// DNxHR flavor. Only meaningful when codec === "dnxhr".
  dnxhrProfile: DnxhrProfile;
  /// Constant-quality value for rateMode === "quality" (native engine only;
  /// forces a software encoder). null ⇒ defaultCrf(codec).
  crf: number | null;
  /// Software-encoder speed/quality preset (native engine; HW encoders and
  /// intermediates ignore it). "medium" matches the pre-E3 hardcoded value.
  preset: SpeedPreset;
```

Defaults: `proresProfile: "422", dnxhrProfile: "sq", crf: null, preset: "medium",`.

New helpers:

```ts
export function defaultCrf(codec: CodecId): number {
  switch (codec) {
    case "h264": return 18;
    case "hevc": return 22;
    case "av1": return 30;
    default: return 0; // intermediates: fixed-quality by profile, CRF unused
  }
}

/// Composite precision: ProRes is a 10-bit family (f16 composite) even though
/// the user-facing bitDepth control is hidden for it; DNxHR LB/SQ/HQ are 8-bit.
export function compositeBitDepth(s: ExportSettings): 8 | 10 {
  if (s.codec === "prores") return 10;
  if (s.codec === "dnxhr") return 8;
  return s.bitDepth;
}

/// Nominal profile bitrates at 1080p30 (bits/px/frame), SIZE-ESTIMATE ONLY —
/// intra codecs are quality-fixed; these never feed encoder args. Sources:
/// Apple ProRes whitepaper / Avid DNxHR spec sheets, rounded.
const INTERMEDIATE_BPF: Record<ProresProfile | `dnxhr_${DnxhrProfile}`, number> = {
  proxy: 45_000_000 / 62_208_000,
  lt: 102_000_000 / 62_208_000,
  "422": 147_000_000 / 62_208_000,
  hq: 220_000_000 / 62_208_000,
  dnxhr_lb: 45_000_000 / 62_208_000,
  dnxhr_sq: 115_000_000 / 62_208_000,
  dnxhr_hq: 175_000_000 / 62_208_000,
};
```

`computeBitrate` gains a leading branch:

```ts
  if (settings.codec === "prores") {
    return Math.round(width * height * fps * INTERMEDIATE_BPF[settings.proresProfile]);
  }
  if (settings.codec === "dnxhr") {
    return Math.round(width * height * fps * INTERMEDIATE_BPF[`dnxhr_${settings.dnxhrProfile}`]);
  }
```

(and `CODEC_BPP_MULTIPLIER` stays keyed on the delivery codecs only — change its type to `Record<WebCodecsCodecId, number>` and index it with a narrowed codec).

`isBitDepthValid`:

```ts
export function isBitDepthValid(codec: CodecId, d: BitDepth): boolean {
  if (codec === "prores") return d === 10;
  if (codec === "dnxhr") return d === 8;
  return d === 8 || codec !== "h264";
}
```

`isCodecContainerValid`:

```ts
export function isCodecContainerValid(codec: CodecId, container: Container): boolean {
  if (isIntermediateCodec(codec)) return container === "mov";
  return !(container === "mov" && codec === "av1");
}
```

`mergeSettings` — after the existing bit-depth snap, add:

```ts
  // Intermediates imply container + bit depth; snap stale/hand-edited blobs.
  if (isIntermediateCodec(merged.codec) && merged.container !== "mov") {
    merged.container = "mov";
  }
  if (!isBitDepthValid(merged.codec, merged.bitDepth)) {
    merged.bitDepth = merged.codec === "prores" ? 10 : 8;
  }
```

(The existing `if (!isBitDepthValid(...)) merged.bitDepth = 8;` at `:231` is replaced by this codec-aware snap. Keep exactly one snap.)

`codecString(codec)` — narrow the parameter to `WebCodecsCodecId` and fix call sites: `exportCodecProbe.ts` functions take `WebCodecsCodecId` now (probe/smoke never see intermediates), and `App.tsx`'s `codecString(workerCodec)` is safe because `workerCodec` only comes from `WebCodecsTarget` (type it `WebCodecsCodecId` in `encodeTarget.ts`: `workerCodec: WebCodecsCodecId`, and in the resolver return `settings.codec as WebCodecsCodecId` ONLY on the probe path — intermediates never reach it because `needsEncoderProbe` returns false for them, enforced next).

`encodeTarget.ts`:

```ts
export function nativePixFmtFor(settings: ExportSettings): NativePixFmt {
  if (settings.codec === "prores") return "yuv422p10le";
  if (settings.codec === "dnxhr") return "yuv422p";
  return settings.bitDepth === 10 ? "yuv420p10le" : "yuv420p";
}

export function needsEncoderProbe(settings: ExportSettings): boolean {
  if (settings.encoderEngine === "native") return false;
  if (isIntermediateCodec(settings.codec)) return false; // native-only codecs
  return !(settings.bitDepth === 10 && settings.codec !== "h264");
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test && npm run typecheck`
Expected: PASS / 0 errors (fix any call-site narrowing the compiler flags — the dialog's `probeEncoderSupported(settings.codec, ...)` at `ExportSettingsDialog.tsx:191` gains a `if (isIntermediateCodec(settings.codec))` guard that sets the path state to `"native"`-ish placeholder; final UI lands in Task 13, a minimal guard keeps typecheck green here).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/render/exportSettings.ts src/renderer/render/exportSettings.test.ts src/renderer/render/encodeTarget.ts src/renderer/render/encodeTarget.test.ts src/renderer/render/exportCodecProbe.ts src/renderer/panels/ExportSettingsDialog.tsx
git commit -m "feat(export): schema v2 — prores/dnxhr, quality(CRF) rate mode, speed preset

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 11: Rust — sink owns rate/preset/profile args

**Files:**
- Modify: `apps/desktop/native/src/export/videosink.rs`

**Interfaces:**
- Produces: `VideoSinkStartArgs` gains `#[serde(default)] pub crf: Option<u32>`, `#[serde(default)] pub preset: Option<String>`, `#[serde(default)] pub profile: Option<String>` (carries `proresProfile`/`dnxhrProfile` when codec is an intermediate). Codec strings `"prores"`/`"dnxhr"` accepted. `sink_cmd_args` stops delegating to `super::video_encode_args` and owns its encoder/rate/gop/preset section (`video_encode_args` remains for the mezzanine transcode until E4 deletes it).

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn sink_args_quality_mode_uses_crf_not_bitrate() {
        let mut a = args_8bit("h264");
        a.crf = Some(18);
        a.preset = Some("slow".into());
        let argv = sink_cmd_args(&a, Some(super::super::TargetCodec::H264), "libx264");
        let s: Vec<String> = argv.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-crf" && w[1] == "18"));
        assert!(!s.iter().any(|x| x == "-b:v"));
        assert!(s.windows(2).any(|w| w[0] == "-preset" && w[1] == "slow"));
    }

    #[test]
    fn sink_args_svtav1_preset_mapping() {
        let mut a = args_8bit("av1");
        a.crf = Some(30);
        a.preset = Some("fast".into());
        let argv = sink_cmd_args(&a, Some(super::super::TargetCodec::Av1), "libsvtav1");
        let s: Vec<String> = argv.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-crf" && w[1] == "30"));
        assert!(s.windows(2).any(|w| w[0] == "-preset" && w[1] == "10")); // fast→10, medium→8, slow→6
    }

    #[test]
    fn sink_args_prores_profile() {
        let mut a = args_8bit("prores");
        a.pix_fmt = "yuv422p10le".into();
        a.profile = Some("hq".into());
        a.output_path = "C:/tmp/out.mov".into();
        let argv = sink_cmd_args(&a, None, "prores_ks");
        let s: Vec<String> = argv.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "prores_ks"));
        assert!(s.windows(2).any(|w| w[0] == "-profile:v" && w[1] == "3")); // proxy0 lt1 std2 hq3
        assert!(s.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv422p10le"));
        assert!(s.windows(2).any(|w| w[0] == "-vendor" && w[1] == "apl0"));
        assert!(!s.iter().any(|x| x == "-b:v" || x == "-g")); // intra, quality-fixed
    }

    #[test]
    fn sink_args_dnxhr_profile() {
        let mut a = args_8bit("dnxhr");
        a.pix_fmt = "yuv422p".into();
        a.profile = Some("sq".into());
        a.output_path = "C:/tmp/out.mov".into();
        let argv = sink_cmd_args(&a, None, "dnxhd");
        let s: Vec<String> = argv.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "dnxhd"));
        assert!(s.windows(2).any(|w| w[0] == "-profile:v" && w[1] == "dnxhr_sq"));
        assert!(s.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv422p"));
    }
```

(Signature note: `sink_cmd_args`'s second parameter widens to `Option<TargetCodec>` — `None` for intermediates, which have no `TargetCodec`/fourcc concern. Update Task 3/4's existing tests: wrap their codec arg in `Some(...)`.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud videosink`
Expected: FAIL (missing fields/signature).

- [ ] **Step 3: Implement**

`VideoSinkStartArgs` gains:

```rust
    /// Constant-quality value (rateMode "quality"). Some ⇒ CRF/quality args
    /// replace -b:v. Only sent with software=true by the renderer.
    #[serde(default)]
    pub crf: Option<u32>,
    /// Software-encoder speed preset: "fast" | "medium" | "slow".
    #[serde(default)]
    pub preset: Option<String>,
    /// Intermediate-codec profile: prores proxy|lt|422|hq, dnxhr lb|sq|hq.
    #[serde(default)]
    pub profile: Option<String>,
```

Replace `sink_cmd_args`'s encoder/rate section (`a.extend(super::video_encode_args(...)); a.extend(tenbit/eightbit...)`) with a self-owned builder:

```rust
    a.push("-c:v".into());
    a.push(encoder.into());
    match args.codec.as_str() {
        // Intra, quality-fixed families: profile IS the rate control; no -b:v,
        // no GOP pinning (every frame is a keyframe).
        "prores" => {
            let p = match args.profile.as_deref() {
                Some("proxy") => "0",
                Some("lt") => "1",
                Some("hq") => "3",
                _ => "2", // "422"
            };
            a.extend::<Vec<OsString>>(vec![
                "-profile:v".into(), p.into(),
                "-vendor".into(), "apl0".into(),
                "-pix_fmt".into(), "yuv422p10le".into(),
            ]);
        }
        "dnxhr" => {
            let p = match args.profile.as_deref() {
                Some("lb") => "dnxhr_lb",
                Some("hq") => "dnxhr_hq",
                _ => "dnxhr_sq",
            };
            a.extend::<Vec<OsString>>(vec![
                "-profile:v".into(), p.into(),
                "-pix_fmt".into(), "yuv422p".into(),
            ]);
        }
        _ => {
            // Delivery codecs: CRF (quality mode) XOR bitrate, pinned GOP,
            // speed preset for software encoders.
            match args.crf {
                Some(crf) => {
                    a.push("-crf".into());
                    a.push(crf.to_string().into());
                }
                None => {
                    a.push("-b:v".into());
                    a.push(args.bitrate.to_string().into());
                    if args.cbr {
                        a.extend::<Vec<OsString>>(vec![
                            "-maxrate".into(), args.bitrate.to_string().into(),
                            "-minrate".into(), args.bitrate.to_string().into(),
                            "-bufsize".into(), (args.bitrate * 2).to_string().into(),
                        ]);
                    }
                }
            }
            let g = args.gop.max(1).to_string();
            a.extend::<Vec<OsString>>(vec![
                "-g".into(), g.clone().into(), "-keyint_min".into(), g.into(),
            ]);
            let preset = args.preset.as_deref().unwrap_or("medium");
            match encoder {
                "libsvtav1" => {
                    let p = match preset { "fast" => "10", "slow" => "6", _ => "8" };
                    a.extend::<Vec<OsString>>(vec!["-preset".into(), p.into()]);
                }
                "libx265" | "libx264" => {
                    a.extend::<Vec<OsString>>(vec![
                        "-preset".into(), preset.into(),
                        "-sc_threshold".into(), "0".into(),
                    ]);
                }
                _ => {} // HW encoders: defaults
            }
            if args.pix_fmt.ends_with("10le") {
                a.extend(super::hwencoder::tenbit_encode_args(encoder));
            } else {
                a.extend(super::hwencoder::eightbit_encode_args(encoder));
            }
        }
    }
```

(Ordering note: `tenbit_encode_args` also re-emits `-c:v`? No — it emits only pix_fmt/profile flags; `-c:v` is now emitted once at the top. Delete the old duplicate `-c:v` emission that lived inside `video_encode_args` usage.)

In `export_video_sink_start`: accept intermediates before the `TargetCodec` path:

```rust
        let (codec_enum, encoder): (Option<super::hwencoder::TargetCodec>, String) =
            match args.codec.as_str() {
                "prores" => (None, "prores_ks".to_string()),
                "dnxhr" => (None, "dnxhd".to_string()),
                other => {
                    let c = super::hwencoder::TargetCodec::parse(other)
                        .ok_or_else(|| format!("unknown codec {other}"))?;
                    let ten_bit = args.pix_fmt.ends_with("10le");
                    if ten_bit && !matches!(c, super::hwencoder::TargetCodec::Hevc | super::hwencoder::TargetCodec::Av1) {
                        return Err(format!("10-bit export supports hevc/av1, got {other}"));
                    }
                    let e = if args.software {
                        c.software_encoder().to_string()
                    } else if ten_bit {
                        hw.encoder_for_10bit(c).await.as_ref().clone()
                    } else {
                        hw.encoder_for(c).await.as_ref().clone()
                    };
                    (Some(c), e)
                }
            };
```

pix_fmt whitelist widens to the four values; `hvc1_tag_args` call becomes `if let Some(c) = codec_enum { a.extend(super::hvc1_tag_args(c, ...)) }` inside `sink_cmd_args` (signature `Option<TargetCodec>`).

- [ ] **Step 4: Run tests + TS mirror**

`ipc/index.ts` `VideoSinkStartArgs` gains `crf?: number; preset?: string; profile?: string;` (optional).
Run: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud export && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/src/export/videosink.rs src/renderer/ipc/index.ts
git commit -m "feat(export): sink args own CRF/preset + prores_ks/dnxhd profiles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 12: Wire intermediates + quality mode through App/worker

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx` (`:1233` temp path; sink start; runPixiExport opts)

**Interfaces:**
- Consumes: `compositeBitDepth`, `isIntermediateCodec`, `defaultCrf` (Task 10); sink `crf/preset/profile` (Task 11); worker `nativeSink.pixFmt` already generic (Task 8) — `yuv422p*` flows with no worker change.

- [ ] **Step 1: Temp video path follows codec container** (`App.tsx:1233`):

```ts
    const tempVideoExt =
      settings.codec === "prores" || settings.codec === "dnxhr" ? "mov" : "mp4";
    const tempVideoPath = await join(tempBase, `weftcut-pixi-${stamp}.${tempVideoExt}`);
```

(ProRes/DNxHR must land in MOV — the sink's ffmpeg writes container-by-extension, and `hvc1_tag_args` never applies to them.)

- [ ] **Step 2: Sink start gains the E3 fields** (extend the Task-8 call):

```ts
          software:
            settings.hwAccel === "software" || settings.rateMode === "quality",
          ...(settings.rateMode === "quality" && !isIntermediateCodec(settings.codec)
            ? { crf: settings.crf ?? defaultCrf(settings.codec) }
            : {}),
          preset: settings.preset,
          ...(settings.codec === "prores" ? { profile: settings.proresProfile } : {}),
          ...(settings.codec === "dnxhr" ? { profile: settings.dnxhrProfile } : {}),
```

(Quality mode forces the software encoder — the v1 simplification recorded in the spec/schema comment; HW CQ modes are out of scope.)

- [ ] **Step 3: Composite precision** — the `runPixiExport` `bitDepth` option (Task 8) becomes:

```ts
        bitDepth: compositeBitDepth(settings),
```

(import `compositeBitDepth`; ProRes composites f16 + packs `yuv422p10le`; DNxHR composites RGBA8 + packs `yuv422p`.)

- [ ] **Step 4: Gate + commit**

Run: `npm run typecheck && npm run test`
Expected: green.

```bash
git add src/renderer/App.tsx
git commit -m "feat(export): intermediates + quality mode wired (MOV temp, f16 for ProRes)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 13: Export dialog UI + i18n

**Files:**
- Modify: `apps/desktop/src/renderer/panels/ExportSettingsDialog.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/en-US.ts` (`export_dialog` at `:299`), `zh-CN.ts` (same section)

**Interfaces:**
- Consumes: everything from Tasks 7/10 (`EncoderEngine`, `isIntermediateCodec`, `ProresProfile`, `DnxhrProfile`, `defaultCrf`, `containersForCodec` already codec-aware).

- [ ] **Step 1: Engine row** — insert ABOVE the codec row (`:555` area), same `export-row`/`AppSelect` pattern:

```tsx
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.encoder_engine")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={settings.encoderEngine}
                    onValueChange={(v) =>
                      patch({ encoderEngine: v as EncoderEngine })
                    }
                    options={[
                      { value: "auto", label: t("export_dialog.engine_auto") },
                      { value: "native", label: t("export_dialog.engine_native") },
                      {
                        value: "webcodecs",
                        label: t("export_dialog.engine_webcodecs"),
                        disabled: isIntermediateCodec(settings.codec) || settings.bitDepth === 10,
                      },
                    ]}
                  />
                </div>
```

- [ ] **Step 2: Codec options** — extend the codec `AppSelect` (`:560-564`):

```tsx
                    options={[
                      { value: "h264", label: "H.264" },
                      { value: "av1", label: "AV1" },
                      { value: "hevc", label: "HEVC" },
                      {
                        value: "prores",
                        label: "ProRes 422",
                        disabled: settings.encoderEngine === "webcodecs",
                      },
                      {
                        value: "dnxhr",
                        label: "DNxHR",
                        disabled: settings.encoderEngine === "webcodecs",
                      },
                    ]}
```

On codec change, snap dependent fields in the same patch (the dialog exposes `patch`, not a whole-object setter). Reuse the schema validators so the dialog can never hold an invalid combo:

```tsx
                    onValueChange={(v) => {
                      const codec = v as CodecId;
                      patch({
                        codec,
                        ...(isIntermediateCodec(codec)
                          ? {
                              container: "mov" as Container,
                              bitDepth: (codec === "prores" ? 10 : 8) as BitDepth,
                              rateMode: "vbr" as RateMode,
                            }
                          : {}),
                        ...(!isCodecContainerValid(codec, settings.container)
                          ? { container: containersForCodec(codec)[0]! }
                          : {}),
                        ...(!isBitDepthValid(codec, settings.bitDepth)
                          ? { bitDepth: (codec === "prores" ? 10 : 8) as BitDepth }
                          : {}),
                      });
                    }}
```

- [ ] **Step 3: Conditional rows**
- Profile row (after codec row):

```tsx
                {settings.codec === "prores" && (
                  <div className="export-row">
                    <span className="settings-toggle-label">{t("export_dialog.prores_profile")}</span>
                    <AppSelect className="export-select" value={settings.proresProfile}
                      onValueChange={(v) => patch({ proresProfile: v as ProresProfile })}
                      options={[
                        { value: "proxy", label: "Proxy" }, { value: "lt", label: "LT" },
                        { value: "422", label: "422" }, { value: "hq", label: "422 HQ" },
                      ]} />
                  </div>
                )}
                {settings.codec === "dnxhr" && (
                  <div className="export-row">
                    <span className="settings-toggle-label">{t("export_dialog.dnxhr_profile")}</span>
                    <AppSelect className="export-select" value={settings.dnxhrProfile}
                      onValueChange={(v) => patch({ dnxhrProfile: v as DnxhrProfile })}
                      options={[
                        { value: "lb", label: "LB" }, { value: "sq", label: "SQ" }, { value: "hq", label: "HQ" },
                      ]} />
                  </div>
                )}
```

- Rate-mode select (`:656-664`) gains a third option, disabled off-native:

```tsx
                      { value: "quality", label: t("export_dialog.rate_quality"),
                        disabled: settings.encoderEngine === "webcodecs" || isIntermediateCodec(settings.codec) },
```

- CRF row (after rate-mode row):

```tsx
                {settings.rateMode === "quality" && !isIntermediateCodec(settings.codec) && (
                  <div className="export-row">
                    <span className="settings-toggle-label">{t("export_dialog.crf")}</span>
                    <AppNumberField
                      value={settings.crf ?? defaultCrf(settings.codec)}
                      min={0} max={51} step={1} align="center"
                      className="settings-input-narrow"
                      ariaLabel={t("export_dialog.crf")}
                      onValueChange={(v) => patch({ crf: Math.round(v) })}
                      onClear={() => patch({ crf: null })}
                    />
                  </div>
                )}
```

- Preset row (after the hwAccel row `:684-702`; hidden for intermediates):

```tsx
                {!isIntermediateCodec(settings.codec) && (
                  <div className="export-row">
                    <span className="settings-toggle-label">{t("export_dialog.speed_preset")}</span>
                    <AppSelect className="export-select" value={settings.preset}
                      onValueChange={(v) => patch({ preset: v as SpeedPreset })}
                      options={[
                        { value: "fast", label: t("export_dialog.preset_fast") },
                        { value: "medium", label: t("export_dialog.preset_medium") },
                        { value: "slow", label: t("export_dialog.preset_slow") },
                      ]} />
                  </div>
                )}
```

- Quality/rate rows hide entirely for intermediates (wrap the quality select `:611-628`, custom-bitrate `:629-650`, rate-mode, keyframe-interval and hwAccel rows in `{!isIntermediateCodec(settings.codec) && (...)}` — intra intermediates are profile-driven).
- The blurb (`:567-577`) becomes engine-aware:

```tsx
                <p className="settings-blurb">
                  {settings.encoderEngine === "native" || isIntermediateCodec(settings.codec) || settings.bitDepth === 10
                    ? t("export_dialog.path_native")
                    : encodePath === null
                      ? t("export_dialog.checking_codec")
                      : encodePath === "ffmpeg"
                        ? t("export_dialog.path_ffmpeg")
                        : t("export_dialog.path_webcodecs")}
                </p>
```

and the probe effect (`:191`) skips intermediates (Task 10's guard).

- [ ] **Step 4: i18n keys** — `en-US.ts` `export_dialog` additions:

```ts
    encoder_engine: "Encoder engine",
    engine_auto: "Auto",
    engine_native: "Native (FFmpeg)",
    engine_webcodecs: "WebCodecs",
    path_native: "Encoder: native FFmpeg (full control, explicit color tags)",
    prores_profile: "ProRes profile",
    dnxhr_profile: "DNxHR profile",
    rate_quality: "Quality (CRF)",
    crf: "CRF",
    speed_preset: "Encoder preset",
    preset_fast: "Fast",
    preset_medium: "Medium",
    preset_slow: "Slow (best quality/size)",
```

`zh-CN.ts` mirror:

```ts
    encoder_engine: "编码引擎",
    engine_auto: "自动",
    engine_native: "原生 (FFmpeg)",
    engine_webcodecs: "WebCodecs",
    path_native: "编码器：原生 FFmpeg（完整参数控制，显式色彩标记）",
    prores_profile: "ProRes 档位",
    dnxhr_profile: "DNxHR 档位",
    rate_quality: "质量优先 (CRF)",
    crf: "CRF",
    speed_preset: "编码器预设",
    preset_fast: "快速",
    preset_medium: "中等",
    preset_slow: "慢速（最佳质量/体积）",
```

- [ ] **Step 5: Gate + commit**

Run: `npm run typecheck && npm run test` — green. Manual smoke: `npm run dev`, open the export dialog, flip engine/codec combos, confirm snaps + disables.

```bash
git add src/renderer/panels/ExportSettingsDialog.tsx src/renderer/i18n/locales/en-US.ts src/renderer/i18n/locales/zh-CN.ts
git commit -m "feat(export): dialog engine selector, intermediates, CRF + preset rows (en/zh)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 14: e2e — ProRes + DNxHR cells

**Files:**
- Modify: `apps/desktop/e2e/electron/export_codecs.spec.ts`

- [ ] **Step 1: Add two cells** (same structure as Task 9's cell):

```ts
  test('ProRes 422 export lands in MOV with 10-bit 4:2:2 (Electron)', async () => {
    const OUTPUT = path.join(OUT_DIR, 'native-prores.mov')
    await runExportViaHook(
      { codec: 'prores', proresProfile: '422', container: 'mov', audio: { include: false } },
      OUTPUT, 'ProRes',
    )
    const st = probeVideoStream(OUTPUT, 'codec_name,profile,pix_fmt,color_range')
    expect(st.codec_name).toBe('prores')
    expect(st.pix_fmt).toBe('yuv422p10le')
    expect(st.color_range).toBe('tv')
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: SSIM_FLOOR })
    console.log('[e2e] ProRes conformance report:', JSON.stringify(report))
  })

  test('DNxHR SQ export lands in MOV as 8-bit 4:2:2 (Electron)', async () => {
    const OUTPUT = path.join(OUT_DIR, 'native-dnxhr.mov')
    await runExportViaHook(
      { codec: 'dnxhr', dnxhrProfile: 'sq', container: 'mov', audio: { include: false } },
      OUTPUT, 'DNxHR',
    )
    const st = probeVideoStream(OUTPUT, 'codec_name,profile,pix_fmt')
    expect(st.codec_name).toBe('dnxhd')
    expect(st.pix_fmt).toBe('yuv422p')
    expect(String(st.profile)).toMatch(/DNXHR SQ/i)
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: SSIM_FLOOR })
    console.log('[e2e] DNxHR conformance report:', JSON.stringify(report))
  })
```

(Adapt helper names to the file's actual runner as in Task 9. If the analyzer rejects MOV/ProRes inputs, extend `e2e/lib/analyze.mjs`'s demux expectations — flag it in the task report rather than weakening assertions.)

- [ ] **Step 2: Run locally** (same prerequisites as Task 9; requires a fresh `napi:build` since Task 11 changed Rust)

Run: `npx playwright test e2e/electron/export_codecs.spec.ts`
Expected: all cells PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/electron/export_codecs.spec.ts
git commit -m "test(export): ProRes/DNxHR e2e conformance cells

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Stage E4 — auto = native-first, delete the mezzanine, complete the gates

### Task 15: Flip `auto` to native-first + explicit fallback dialog

**Files:**
- Modify: `apps/desktop/src/renderer/render/encodeTarget.ts` + test
- Modify: `apps/desktop/src/renderer/App.tsx` (sink-start catch block)
- Modify: locales (2 keys)

**Interfaces:**
- Produces: `auto` resolves `{ engine: "native", pixFmt: nativePixFmtFor(s) }` unconditionally (probe only consulted for the `webcodecs` pin). Sink-start failure under `auto` no longer hard-errors: it surfaces a `window.confirm`-style choice (the app's existing dialog affordance) offering the WebCodecs fallback when the combo permits (8-bit h264/av1/hevc), else errors.

- [ ] **Step 1: Failing tests** (replace the E2 "auto is unchanged" test):

```ts
  it("auto prefers native for every codec (E4)", () => {
    expect(resolveEncodeTarget(s({ codec: "h264" }), true))
      .toEqual({ engine: "native", pixFmt: "yuv420p" });
    expect(resolveEncodeTarget(s({ codec: "hevc" }), false))
      .toEqual({ engine: "native", pixFmt: "yuv420p" });
    expect(needsEncoderProbe(s({ codec: "h264" }))).toBe(false);
  });

  it("webcodecs pin without smoke → stays webcodecs direct (dialog gates combos; no mezzanine)", () => {
    expect(resolveEncodeTarget(s({ codec: "hevc", encoderEngine: "webcodecs" }), false))
      .toEqual({ engine: "webcodecs", workerCodec: "hevc", transcodeAfter: false });
  });
```

- [ ] **Step 2: Implement resolver**

```ts
export function needsEncoderProbe(settings: ExportSettings): boolean {
  return settings.encoderEngine === "webcodecs" && !isIntermediateCodec(settings.codec);
}

export function resolveEncodeTarget(
  settings: ExportSettings,
  smokeOk: boolean,
): EncodeTarget {
  void smokeOk; // probe result now only informs the dialog's live gating
  if (needsEncoderProbe(settings)) {
    return {
      engine: "webcodecs",
      workerCodec: settings.codec as WebCodecsCodecId,
      transcodeAfter: false,
    };
  }
  return { engine: "native", pixFmt: nativePixFmtFor(settings) };
}
```

`transcodeAfter` is now ALWAYS false — the field stays on the type this task
(so `App.tsx` still compiles); Task 16 deletes the field together with every
consumer. Delete the two mezzanine resolver tests (`"8-bit + smoke fail →
H.264 mezzanine..."` and the E2 webcodecs-pin-mezzanine test) — they assert
the behavior this task removes.

- [ ] **Step 3: App fallback dialog** — extend the sink-start `catch` (Task 8's block): on failure, when `settings.encoderEngine === "auto"` and `!isIntermediateCodec(settings.codec)` and `settings.bitDepth === 8`, show a confirm and retry via WebCodecs:

```ts
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] video sink start failed:", e);
        const canFallBack =
          settings.encoderEngine === "auto" &&
          !isIntermediateCodec(settings.codec) &&
          settings.bitDepth === 8;
        if (canFallBack && window.confirm(t("export_dialog.native_unavailable_fallback"))) {
          target = { engine: "webcodecs", workerCodec: settings.codec as WebCodecsCodecId };
          nativeSink = false;
        } else {
          setExportState({ kind: "error", detail: `Failed to start the native encoder: ${msg}` });
          return;
        }
      }
```

(`target`/`nativeSink` become `let` bindings. The explicit-consent dialog satisfies the spec's "never a silent encoder change" rule. When the retry proceeds, the WebCodecs path needs `smokeOk` — run `resolveEncodePath` here and error out with `t("export_dialog.native_unavailable_no_fallback")` if it fails.)

Locale keys — en: `native_unavailable_fallback: "The native FFmpeg encoder is unavailable. Export with the WebCodecs encoder instead? (Bitrate mode only; color tags rely on defaults.)"`, `native_unavailable_no_fallback: "The native FFmpeg encoder is unavailable and this format has no WebCodecs fallback."`; zh: `native_unavailable_fallback: "原生 FFmpeg 编码器不可用。改用 WebCodecs 编码器导出？（仅码率模式；色彩标记依赖默认值。）"`, `native_unavailable_no_fallback: "原生 FFmpeg 编码器不可用，且该格式没有 WebCodecs 兜底。"`.

- [ ] **Step 4: Gate + commit**

Run: `npm run test -- render/encodeTarget && npm run typecheck` — expected: resolver tests green, typecheck 0 errors (`transcodeAfter` still exists, always false; `App.tsx`'s mezzanine branch is now dead code that Task 16 deletes).

```bash
git add src/renderer/render/encodeTarget.ts src/renderer/render/encodeTarget.test.ts src/renderer/App.tsx src/renderer/i18n/locales/en-US.ts src/renderer/i18n/locales/zh-CN.ts
git commit -m "feat(export): auto engine resolves native-first with consent-gated fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 16: Delete the mezzanine path

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx` (`encodePath` derivation, transcode listener `:1436-1451`, transcode spec `:1488-1503`, `EXPORT_TRANSCODE_PROGRESS` import)
- Modify: `apps/desktop/src/renderer/render/exportSettings.ts` (delete `mezzanineBitrate` `:329-349`) + its tests
- Modify: `apps/desktop/src/renderer/render/exportCodecProbe.ts` (delete `EncodePath`/`resolveEncodePath`; keep `probeEncoderSupported`/`smokeEncode` for dialog gating)
- Modify: `apps/desktop/src/renderer/panels/ExportSettingsDialog.tsx` (probe state now boolean `webcodecsOk`; blurb keys)
- Modify: `apps/desktop/src/renderer/ipc/index.ts` (muxExport signature: drop the transcode param) + its `EXPORT_TRANSCODE_PROGRESS` const
- Modify: `apps/desktop/native/src/commands/export.rs` (delete `TranscodeSpec`, `mux_export` transcode arm) and the napi dispatch that parses it
- Modify: `apps/desktop/native/src/export/mod.rs` (delete `transcode_and_mux`, `EVENT_TRANSCODE_PROGRESS`, `video_encode_args` + their tests; keep `mux_to_file`, `hvc1_tag_args`, `audio_encode_args`)
- Modify: locales (delete `path_ffmpeg`, `checking_codec` if unused)

- [ ] **Step 1: Renderer sweep** — in `App.tsx`: `workerCodec`/`workerBitrate` collapse (`mezzanineBitrate` gone → `workerBitrate = computeBitrate(...)` always); `hwHint` branch loses the `encodePath !== "ffmpeg"` condition; delete `encodePath`, the `offTranscode` listener block, and the `transcode` object → `await muxExport(tempVideoPath, tempAudioPath, path)`. In `runExportWithSettings` the progress state type loses the `"transcode"` phase if it is a closed union (check `setExportState` typing; delete the arm).
- [ ] **Step 2: Rust sweep** — delete `TranscodeSpec` + the `Some(spec)` arm in `commands/export.rs::mux_export` (signature drops the param; update the napi command parser that deserializes it — grep `"mux_export"` under `native/src/` for the dispatch site); delete `transcode_and_mux`, `EVENT_TRANSCODE_PROGRESS`, `video_encode_args` and tests `video_encode_args_*` in `mod.rs`.
- [ ] **Step 3: Verify nothing references the deleted symbols**

From the REPO ROOT (not apps/desktop):

```bash
rg -n "mezzanine|transcode_and_mux|TranscodeSpec|EXPORT_TRANSCODE_PROGRESS|resolveEncodePath|EncodePath" apps/desktop/src apps/desktop/native/src apps/desktop/e2e docs
```

Expected: hits only in dated `docs/superpowers/{specs,plans}` files and this plan (leave those; Task 18 refreshes the evergreen docs). Then, back in `apps/desktop`:

Run: `npm run typecheck && npm run test && cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -u src/renderer native/src
git commit -m "feat(export)!: delete the H.264 mezzanine transcode path (subsumed by NativeSink)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`git add -u` is acceptable here only because Step 3's grep verified the change surface; list the files explicitly in the commit body if any unrelated modification shows in `git status`.)

### Task 17: e2e matrix completion

**Files:**
- Modify: `apps/desktop/e2e/electron/export_codecs.spec.ts`

- [ ] **Step 1: Update the HEVC 8-bit cell** — its comment/expectations (`:29,:175-185`) currently describe the mezzanine. Under E4-auto it exports via NativeSink: assertions gain the explicit color-tag 4-tuple (as in Task 9) and keep `codec_name === 'hevc'` + 8-bit pix_fmt. Update the AV1 cell's comment: AV1 now also rides native under auto; add `encoderEngine: 'webcodecs'` to ONE cell (keep H.264) so the WebCodecs engine keeps a living e2e (pin it explicitly — that's the compat floor's regression guard).
- [ ] **Step 2: Rebuild + run the whole matrix locally**

```bash
npm run napi:build && VITE_WEFTCUT_E2E=1 npm run build
npx playwright test e2e/electron/export_codecs.spec.ts e2e/electron/export_eos_tail.spec.ts e2e/electron/export_overlap_same_source.spec.ts e2e/electron/export-range-audio.spec.ts
```

Expected: all PASS (EOS/overlap/audio suites prove the orchestration survived the E4 sweep).

- [ ] **Step 3: Commit**

```bash
git add e2e/electron/export_codecs.spec.ts
git commit -m "test(export): matrix reflects native-first auto; WebCodecs pin keeps a living cell

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 18: Evergreen docs refresh

**Files:**
- Modify: `docs/export-ipc-transport.md` (no longer 10-bit-only)
- Modify: `docs/render.md` ("Encode exits" section)
- Modify: `docs/rendering.md` / `docs/architecture.md` IF they describe the mezzanine (grep `mezzanine` under `docs/` and update hits)

- [ ] **Step 1: `export-ipc-transport.md`** — retitle/reword the opening to describe the generalized native exit. Replace the first two paragraphs with:

```markdown
# Export frame transport (native encode engine)

The native encode engine composites in a Web Worker, packs each frame to the
target's rawvideo format (yuv420p, yuv422p, yuv420p10le, or yuv422p10le), and
streams it to a native `ffmpeg` encode over Electron main↔renderer IPC. The
WebCodecs engine is separate (VideoEncoder → mediabunny → fragmented-MP4 to
disk) and does not use this transport.
```

(Keep the rest — the flow, backpressure, "Why IPC", and deferred-copy sections are engine-generic already; fix any remaining "10-bit"-only phrasing in place.)

- [ ] **Step 2: `render.md` Encode exits** — rewrite that section to describe: the `EncodeTarget` seam (`encodeTarget.ts`), the two engines, auto = native-first with consent-gated fallback, explicit color tags as the native exit's assertable property, intermediates (ProRes/DNxHR, MOV-coupled), and the deleted mezzanine (one sentence of history maximum, per the evergreen no-phases discipline). Also update `docs/conformance.md` if it names the HEVC mezzanine flow (grep).
- [ ] **Step 3: Gate + commit**

```bash
rg -n "mezzanine" docs/ | rg -v superpowers   # expect: no hits outside dated specs/plans
git add docs/export-ipc-transport.md docs/render.md docs/rendering.md docs/architecture.md docs/conformance.md
git commit -m "docs: encode exits describe the dual-engine seam; transport doc covers all formats

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Stage only the files actually modified.)

---

## Self-review checklist (ran at authoring)

- **Spec coverage:** E1→Tasks 1-2; E2→3-9 (pack family: 420p8 here, 422 in E3 per spec staging); E3→10-14 (CRF/preset/color-tags/UI/MOV coupling; color tags were already emitted by the sink for all formats — asserted in Tasks 9/14/17); E4→15-18 (auto flip, consent dialog, mezzanine deletion, matrix + docs). Render&Play stays WebCodecs-pinned automatically (it calls the export pipeline with its own fixed config, not `ExportSettings` — verify during Task 16's grep that it doesn't reference deleted symbols). Export-side decode untouched (spec boundary) — no task touches `ExportDecoderPool` routing.
- **Placeholders:** none — every code step carries the code; e2e helper-name adaptation instructions are explicit about the source of truth (the AV1 cell).
- **Type consistency:** `EncodeTarget`/`NativePixFmt`/`nativePixFmtFor`/`compositeBitDepth`/`WebCodecsCodecId` names match across Tasks 1/7/8/10/12/15; sink field names (`pixFmt`,`crf`,`preset`,`profile`) match TS mirror ↔ serde camelCase.
