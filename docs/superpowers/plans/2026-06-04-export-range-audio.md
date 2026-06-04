# Export range + audio settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an export range (In/Out timecode fields) and an audio section (include/mute, AAC/Opus codec, bitrate, channels, sample rate) to the export dialog.

**Architecture:** Range is dialog-local ephemeral state threaded through the existing (already range-capable) export Worker, with the Rust audio path trimmed to match via an `atrim` window in the ffmpeg emitter. Audio settings persist in the webview-owned `ExportSettings` schema and flow to Rust as ffmpeg encode args. Pure logic (schema, validity, clamps, ffmpeg-arg builders, the window emitter) is TDD-tested; UI is verified by typecheck + manual smoke (the codebase has no React component-test harness).

**Tech Stack:** TypeScript + React (webview), Rust + Tauri + ffmpeg-sidecar (backend), vitest (TS tests), cargo test (Rust tests).

**Spec:** `docs/superpowers/specs/2026-06-04-export-range-audio-design.md`

**Run all commands from `apps/desktop/` (TS) or `apps/desktop/src-tauri/` (Rust) unless noted.**

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/render/exportSettings.ts` | Webview-owned export schema + pure logic | Modify: audio types/defaults/validity, nested merge, `estimateBytes` sig, `clampExportRange` |
| `src/render/exportSettings.test.ts` | Unit tests for the above | Modify: update `estimateBytes`; add audio/range tests |
| `src-tauri/src/ir/emit_ffmpeg.rs` | ffmpeg filter-graph emitter | Modify: `emit` gains a window param → `atrim` |
| `src-tauri/src/ir/mod.rs` | IR module + integration test | Modify: update the one `emit_ffmpeg(&g)` test call |
| `src-tauri/src/export/mod.rs` | Audio-only export + mux | Modify: `AudioEncodeSpec`, `audio_encode_args`, `export_audio_only` params + window |
| `src-tauri/src/commands.rs` | Tauri command surface | Modify: `export_project_audio_only` gains audio + range args |
| `src/ipc/index.ts` | Typed Tauri invoke wrappers | Modify: `exportProjectAudioOnly` signature + `AudioExportSpec` |
| `src/preview/PreviewSurface.tsx` | Imperative export handle | Modify: `runPixiExport` opts gain `startUs`/`endUs` |
| `src/render/PixiPreview.tsx` | Export entry → Worker | Modify: forward `startUs`/`endUs` to `runExport` |
| `src/App.tsx` | Export orchestration + dialog mount | Modify: thread range + audio; dialog props/onConfirm |
| `src/panels/ExportSettingsDialog.tsx` | Export settings form | Modify: range UI + audio section |
| `src/i18n/locales/{en-US,zh-CN}.ts` | UI strings | Modify: add `export_dialog.*` keys |

---

## Task 1: Audio settings schema, validity, and merge

**Files:**
- Modify: `src/render/exportSettings.ts`
- Test: `src/render/exportSettings.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/render/exportSettings.test.ts`. First add `AudioSettings`, `DEFAULT_AUDIO_SETTINGS`, `isAudioCodecContainerValid`, `audioCodecsForContainer` to the existing import block at the top. Then append:

```ts
describe("audio settings schema", () => {
  it("defaults audio to AAC / 192k / follow-composition", () => {
    expect(DEFAULT_EXPORT_SETTINGS.audio).toEqual({
      include: true,
      codec: "aac",
      bitrate: 192_000,
      sampleRate: null,
      channels: null,
    });
  });

  it("Opus is MKV-only; AAC is valid in every container", () => {
    expect(isAudioCodecContainerValid("opus", "mkv")).toBe(true);
    expect(isAudioCodecContainerValid("opus", "mp4")).toBe(false);
    expect(isAudioCodecContainerValid("opus", "mov")).toBe(false);
    expect(isAudioCodecContainerValid("aac", "mp4")).toBe(true);
    expect(isAudioCodecContainerValid("aac", "mov")).toBe(true);
    expect(isAudioCodecContainerValid("aac", "mkv")).toBe(true);
  });

  it("lists the audio codecs valid for a container", () => {
    expect(audioCodecsForContainer("mkv")).toEqual(["aac", "opus"]);
    expect(audioCodecsForContainer("mp4")).toEqual(["aac"]);
    expect(audioCodecsForContainer("mov")).toEqual(["aac"]);
  });
});

describe("mergeSettings audio back-fill", () => {
  it("back-fills audio from an old blob with no audio key", () => {
    expect(mergeSettings({ codec: "av1" }).audio).toEqual(DEFAULT_AUDIO_SETTINGS);
  });
  it("merges a partial audio object onto the audio defaults", () => {
    const merged = mergeSettings({
      audio: { bitrate: 256_000 } as unknown as ExportSettings["audio"],
    });
    expect(merged.audio).toEqual({ ...DEFAULT_AUDIO_SETTINGS, bitrate: 256_000 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/render/exportSettings.test.ts`
Expected: FAIL — `isAudioCodecContainerValid` / `audioCodecsForContainer` / `DEFAULT_EXPORT_SETTINGS.audio` are not defined.

- [ ] **Step 3: Implement the schema**

In `src/render/exportSettings.ts`, add the audio codec type right after the `Container` type/const (around line 11):

```ts
export type AudioCodecId = "aac" | "opus";
export const AUDIO_CODECS: AudioCodecId[] = ["aac", "opus"];
export const AUDIO_BITRATES = [96_000, 128_000, 192_000, 256_000, 320_000] as const;
export const AUDIO_SAMPLE_RATES = [48_000, 44_100] as const;
export const AUDIO_CHANNELS = [2, 1] as const;

export interface AudioSettings {
  /// Include an audio track in the export. false ⇒ video-only.
  include: boolean;
  codec: AudioCodecId;
  /// Audio bitrate in bits per second.
  bitrate: number;
  /// Output sample rate; null = follow composition.
  sampleRate: number | null;
  /// Output channel count (2 = stereo, 1 = mono); null = follow composition.
  channels: number | null;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  include: true,
  codec: "aac",
  bitrate: 192_000,
  sampleRate: null,
  channels: null,
};
```

Add `audio: AudioSettings;` to the `ExportSettings` interface (after `container`):

```ts
  container: Container;
  /// Audio track settings. Persisted; null/missing back-fills to defaults.
  audio: AudioSettings;
```

Add `audio: DEFAULT_AUDIO_SETTINGS,` to `DEFAULT_EXPORT_SETTINGS` (after `container: "mp4",`).

Add the validity helpers next to `isCodecContainerValid` / `containersForCodec`:

```ts
/// AAC muxes into mp4/mov/mkv. Opus is restricted to MKV — WebView2's Opus-in-
/// MP4/MOV playback is unreliable and WebM is deferred.
export function isAudioCodecContainerValid(
  codec: AudioCodecId,
  container: Container,
): boolean {
  return codec === "opus" ? container === "mkv" : true;
}

/// Audio codecs that can be written into the given container.
export function audioCodecsForContainer(container: Container): AudioCodecId[] {
  return AUDIO_CODECS.filter((c) => isAudioCodecContainerValid(c, container));
}
```

Replace `mergeSettings` with the nested-merge form:

```ts
export function mergeSettings(
  saved: Partial<ExportSettings> | null,
): ExportSettings {
  return {
    ...DEFAULT_EXPORT_SETTINGS,
    ...(saved ?? {}),
    audio: { ...DEFAULT_AUDIO_SETTINGS, ...(saved?.audio ?? {}) },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/render/exportSettings.test.ts`
Expected: PASS (including the pre-existing `mergeSettings` tests — `DEFAULT_EXPORT_SETTINGS` now deep-equals with the `audio` key).

- [ ] **Step 5: Commit**

```bash
git add src/render/exportSettings.ts src/render/exportSettings.test.ts
git commit -m "feat(export): audio settings schema + codec/container validity"
```

---

## Task 2: `estimateBytes` takes an explicit audio bitrate

**Files:**
- Modify: `src/render/exportSettings.ts`
- Test: `src/render/exportSettings.test.ts`

- [ ] **Step 1: Update the failing test**

Replace the existing `estimateBytes / formatBytes` describe block (currently passing a `hasAudio` boolean) with:

```ts
describe("estimateBytes / formatBytes", () => {
  it("adds the given audio bitrate on top of the video bitrate", () => {
    const withAudio = estimateBytes(8_000_000, 10_000_000, 192_000);
    const noAudio = estimateBytes(8_000_000, 10_000_000, 0);
    expect(withAudio).toBeGreaterThan(noAudio);
  });
  it("formats bytes into human units", () => {
    expect(formatBytes(10_500_000)).toBe("10.5 MB");
    expect(formatBytes(2_100_000_000)).toBe("2.10 GB");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/render/exportSettings.test.ts`
Expected: FAIL — `estimateBytes(8_000_000, 10_000_000, 0)` currently treats the 3rd arg as a truthy boolean (`0` is falsy → equal to no-audio, but the type is `boolean` so this is also a type error under `tsc`). The runtime assertion `withAudio > noAudio` fails because `0` and `192_000` both coerce oddly.

- [ ] **Step 3: Change the signature**

In `src/render/exportSettings.ts`, replace `estimateBytes`:

```ts
export function estimateBytes(
  bitrate: number,
  durationUs: number,
  audioBitrate: number,
): number {
  const durationSec = durationUs / 1_000_000;
  return Math.round(((bitrate + audioBitrate) * durationSec) / 8);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/render/exportSettings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/exportSettings.ts src/render/exportSettings.test.ts
git commit -m "refactor(export): estimateBytes takes explicit audio bitrate"
```

---

## Task 3: `clampExportRange` pure helper

**Files:**
- Modify: `src/render/exportSettings.ts`
- Test: `src/render/exportSettings.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `clampExportRange` to the import block, then append:

```ts
describe("clampExportRange", () => {
  it("passes through an ordered, in-bounds range", () => {
    expect(clampExportRange(1_000_000, 5_000_000, 10_000_000)).toEqual({
      startUs: 1_000_000,
      endUs: 5_000_000,
    });
  });
  it("clamps to [0, duration]", () => {
    expect(clampExportRange(-1, 99_000_000, 10_000_000)).toEqual({
      startUs: 0,
      endUs: 10_000_000,
    });
  });
  it("falls back to the whole span when start >= end", () => {
    expect(clampExportRange(8_000_000, 2_000_000, 10_000_000)).toEqual({
      startUs: 0,
      endUs: 10_000_000,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/render/exportSettings.test.ts`
Expected: FAIL — `clampExportRange is not a function`.

- [ ] **Step 3: Implement**

Add to `src/render/exportSettings.ts`:

```ts
/// Clamp an export range to be ordered and within [0, durationUs]. Inputs are
/// already frame-aligned (parseTimecode and the snapped playhead both produce
/// frame-grid values), so this only enforces ordering + bounds; a degenerate
/// range falls back to the whole span.
export function clampExportRange(
  startUs: number,
  endUs: number,
  durationUs: number,
): { startUs: number; endUs: number } {
  const lo = Math.max(0, Math.min(startUs, durationUs));
  const hi = Math.max(0, Math.min(endUs, durationUs));
  if (hi <= lo) return { startUs: 0, endUs: durationUs };
  return { startUs: lo, endUs: hi };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/render/exportSettings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/exportSettings.ts src/render/exportSettings.test.ts
git commit -m "feat(export): clampExportRange helper"
```

---

## Task 4: ffmpeg emitter window trim

The export Worker renders only `[startUs, endUs)` with timestamps from 0. The Rust audio graph renders the whole project, so a sub-range needs the audio trimmed to match. Add an optional window to `emit` that appends `atrim`+`asetpts` after the final audio node.

**Files:**
- Modify: `src-tauri/src/ir/emit_ffmpeg.rs`
- Modify: `src-tauri/src/ir/mod.rs` (the one existing test call), `src-tauri/src/export/mod.rs` (the call site)

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/ir/mod.rs` (reuse the file's `fixture_target` / `fixture_media` helpers):

```rust
#[test]
fn window_trims_the_audio_output() {
    let media_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000ba").unwrap();
    let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000bb").unwrap();
    let layer_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000bc").unwrap();
    let media = fixture_media(media_id, "/m/voice.wav", MediaKind::Audio, 10_000_000);
    let layer = Layer {
        id: layer_id,
        label: None,
        t_start_us: 0,
        t_end_us: 10_000_000,
        enabled: true,
        locked: false,
        metadata: imbl::HashMap::new(),
        params: LayerParams::Audio(AudioParams {
            media: media_id,
            src_in_us: 0,
            src_out_us: 10_000_000,
            gain_db: Animated::Static(0.0),
            pan: Animated::Static(0.0),
            fade_in_us: 0,
            fade_out_us: 0,
            mute: false,
        }),
    };
    let track = Track {
        id: track_id,
        label: None,
        enabled: true,
        locked: false,
        removable: true,
        role: None,
        transient: false,
        height_px: 48,
        layers: imbl::vector![layer],
    };
    let mut p = Project::new_blank("audio-window");
    p.composition.duration_us = 10_000_000;
    p.media_pool.insert(media_id, media);
    p.tracks.push_back(track);

    let g = lower(&p, fixture_target()).expect("lower");

    // No window → map the OutA label directly, no atrim on the final node.
    let plain = emit_ffmpeg(&g, None);
    assert!(plain.maps.contains(&"[aout]".to_string()));
    assert!(!plain.filter_graph.contains("[awin]"));

    // Windowed → final clause trims [2s, 5s) and resets PTS; map [awin].
    let windowed = emit_ffmpeg(&g, Some((2_000_000, 5_000_000)));
    assert!(windowed.maps.contains(&"[awin]".to_string()));
    assert!(windowed.filter_graph.contains(
        "[aout] atrim=start=2:end=5,asetpts=PTS-STARTPTS [awin]"
    ));
}
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/desktop/src-tauri`): `cargo test --lib ir::tests::window_trims_the_audio_output`
Expected: FAIL to COMPILE — `emit_ffmpeg` takes 1 argument, not 2.

- [ ] **Step 3: Add the window param to `emit`**

In `src-tauri/src/ir/emit_ffmpeg.rs`, replace the `emit` function (lines ~49–70) with:

```rust
pub fn emit(graph: &IRGraph, window_us: Option<(i64, i64)>) -> FfmpegPlan {
    let mut emitter = Emitter::new(graph);
    emitter.emit();
    let mut maps = Vec::new();
    if let Some(out) = graph.audio_out {
        // Compute the final audio label under an immutable borrow of `graph`,
        // then release it before the mutable `emitter.write_clause` below.
        let base_label = match graph.node(out) {
            IRNode::OutA { label, .. } => Some(format!("[{label}]")),
            _ => None,
        };
        if let Some(mut final_label) = base_label {
            if let Some((start_us, end_us)) = window_us {
                let win = "[awin]".to_string();
                emitter.write_clause(&format!(
                    "{final_label} atrim=start={s}:end={e},asetpts=PTS-STARTPTS {win}",
                    s = us_to_secs(start_us),
                    e = us_to_secs(end_us),
                ));
                final_label = win;
            }
            maps.push(final_label);
        }
    }
    FfmpegPlan {
        inputs: graph
            .inputs
            .iter()
            .map(|spec| PlanInput {
                path: spec.path.to_string_lossy().into_owned(),
                framerate: spec.framerate,
            })
            .collect(),
        filter_graph: emitter.body,
        maps,
    }
}
```

(`write_clause` and `us_to_secs` already exist in this module and are reused.)

- [ ] **Step 4: Update the two existing call sites**

In `src-tauri/src/ir/mod.rs`, the existing test `audio_layer_emits_amix_with_one_input` calls `emit_ffmpeg(&g)` (line ~114) — change it to:

```rust
        let plan = emit_ffmpeg(&g, None);
```

In `src-tauri/src/export/mod.rs` (line ~53), change:

```rust
    let plan = emit_ffmpeg(&graph);
```
to:
```rust
    let plan = emit_ffmpeg(&graph, None); // window wired in the next task
```

- [ ] **Step 5: Run to verify it passes**

Run (from `apps/desktop/src-tauri`): `cargo test --lib ir::`
Expected: PASS — both `audio_layer_emits_amix_with_one_input` and `window_trims_the_audio_output`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ir/emit_ffmpeg.rs src-tauri/src/ir/mod.rs src-tauri/src/export/mod.rs
git commit -m "feat(export): ffmpeg emitter optional audio window (atrim)"
```

---

## Task 5: Audio encode args + thread codec/bitrate/format/window through the command

**Files:**
- Modify: `src-tauri/src/export/mod.rs` (`AudioEncodeSpec`, `audio_encode_args`, `export_audio_only`)
- Modify: `src-tauri/src/commands.rs` (`export_project_audio_only`)

- [ ] **Step 1: Write the failing test**

In the `#[cfg(test)] mod tests` of `src-tauri/src/export/mod.rs`, add:

```rust
#[test]
fn audio_encode_args_aac_and_opus() {
    let aac = super::audio_encode_args("aac", 192_000);
    let a: Vec<String> = aac.iter().map(|x| x.to_string_lossy().into_owned()).collect();
    assert_eq!(a, vec!["-c:a", "aac", "-b:a", "192000"]);

    let opus = super::audio_encode_args("opus", 128_000);
    let o: Vec<String> = opus.iter().map(|x| x.to_string_lossy().into_owned()).collect();
    assert_eq!(o, vec!["-c:a", "libopus", "-b:a", "128000"]);
}
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/desktop/src-tauri`): `cargo test --lib export::tests::audio_encode_args_aac_and_opus`
Expected: FAIL TO COMPILE — `audio_encode_args` not found.

- [ ] **Step 3: Add the spec struct + arg builder**

In `src-tauri/src/export/mod.rs`, add near the top (after the `use` block):

```rust
/// Audio encode parameters passed from the webview. `sample_rate`/`channels`
/// are `None` to follow the composition. A serde struct so the Tauri command
/// can take it directly.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioEncodeSpec {
    pub codec: String, // "aac" | "opus"
    pub bitrate: u64,  // bits per second
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
}

/// Build the `-c:a … -b:a …` audio-encode args. AAC is the default; "opus"
/// maps to libopus (MKV-only, enforced webview-side).
fn audio_encode_args(codec: &str, bitrate_bps: u64) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let enc = if codec == "opus" { "libopus" } else { "aac" };
    vec![
        "-c:a".into(),
        OsString::from(enc),
        "-b:a".into(),
        bitrate_bps.to_string().into(),
    ]
}
```

- [ ] **Step 4: Thread the spec + window into `export_audio_only`**

Change the `export_audio_only` signature (line ~33) to:

```rust
pub async fn export_audio_only(
    _app: AppHandle,
    project: &Project,
    output: &Path,
    audio: &AudioEncodeSpec,
    window_us: Option<(i64, i64)>,
) -> Result<()> {
```

Inside, replace the `RenderTarget::full(...)` call (lines ~45–51) with sample-rate/channel overrides:

```rust
    let target = RenderTarget::full(
        project.composition.width,
        project.composition.height,
        project.composition.fps,
        audio.sample_rate.unwrap_or(project.composition.sample_rate),
        audio.channels.unwrap_or(project.composition.channels),
    );
    let graph = lower(project, target).context("lower IR")?;
    let plan = emit_ffmpeg(&graph, window_us);
```

Replace the hardcoded audio codec line (line ~83, `cmd.args(["-c:a", "aac", "-b:a", "192k"]);`) with:

```rust
    for arg in audio_encode_args(&audio.codec, audio.bitrate) {
        cmd.arg(arg);
    }
```

- [ ] **Step 5: Update the Tauri command**

In `src-tauri/src/commands.rs`, replace `export_project_audio_only` (lines ~2180–2192) with:

```rust
#[tauri::command]
pub async fn export_project_audio_only(
    app: tauri::AppHandle,
    handle: State<'_, ProjectHandle>,
    output_path: String,
    audio: crate::export::AudioEncodeSpec,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<(), String> {
    let snap = handle.snapshot().await;
    let project = (*snap).clone();
    let path = PathBuf::from(output_path);
    let window = match (start_us, end_us) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    export::export_audio_only(app, &project, &path, &audio, window)
        .await
        .map_err(|e| format!("{e:#}"))
}
```

- [ ] **Step 6: Run to verify it passes**

Run (from `apps/desktop/src-tauri`): `cargo test --lib export::`
Expected: PASS (`audio_encode_args_aac_and_opus` plus the existing `video_encode_args` / `mux_args` tests).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/export/mod.rs src-tauri/src/commands.rs
git commit -m "feat(export): thread audio codec/bitrate/format + window into audio export"
```

---

## Task 6: IPC wrapper for the new audio + range args

**Files:**
- Modify: `src/ipc/index.ts`

- [ ] **Step 1: Update the wrapper**

In `src/ipc/index.ts`, replace `exportProjectAudioOnly` (lines ~692–700) with:

```ts
/// Audio encode parameters. `sampleRate`/`channels` are null to follow the
/// composition. Mirrors Rust `AudioEncodeSpec` (serde camelCase).
export interface AudioExportSpec {
  codec: "aac" | "opus";
  bitrate: number;
  sampleRate: number | null;
  channels: number | null;
}

/// Audio-only export at `outputPath` (extension picks the muxer: .m4a for AAC,
/// .mka for Opus). `range` trims the audio to the export window (null = whole
/// project). Awaitable; emits no events.
export async function exportProjectAudioOnly(
  outputPath: string,
  audio: AudioExportSpec,
  range: { startUs: number; endUs: number } | null,
): Promise<void> {
  return invoke<void>("export_project_audio_only", {
    outputPath,
    audio,
    startUs: range?.startUs ?? null,
    endUs: range?.endUs ?? null,
  });
}
```

- [ ] **Step 2: Verify (typecheck — App.tsx will be a known error until Task 8)**

Run: `npm run typecheck`
Expected: the ONLY new error is in `src/App.tsx` at the `exportProjectAudioOnly(tempAudioPath)` call (now needs 3 args). That call is fixed in Task 8. No errors in `ipc/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/ipc/index.ts
git commit -m "feat(export): IPC wrapper for audio spec + range"
```

---

## Task 7: Range options on the preview export handle

**Files:**
- Modify: `src/preview/PreviewSurface.tsx`
- Modify: `src/render/PixiPreview.tsx`

- [ ] **Step 1: Widen the handle opts type**

In `src/preview/PreviewSurface.tsx`, in the `runPixiExport` opts type (lines ~45–50), add `startUs`/`endUs`:

```ts
  runPixiExport(opts: {
    onProgress?: (encoded: number, total: number) => void;
    encoderConfig?: VideoEncoderConfig;
    outputFps?: { num: number; den: number };
    startUs?: number;
    endUs?: number;
    writeChunk: (data: ArrayBuffer) => Promise<void>;
  }): Promise<PixiExportResult>;
```

- [ ] **Step 2: Widen `handlePixiExport` opts + forward to `runExport`**

In `src/render/PixiPreview.tsx`, in the `handlePixiExport` `opts` type (lines ~259–264), add the two fields:

```ts
  opts: {
    onProgress?: (encoded: number, total: number) => void;
    encoderConfig?: VideoEncoderConfig;
    outputFps?: { num: number; den: number };
    startUs?: number;
    endUs?: number;
    writeChunk: (data: ArrayBuffer) => Promise<void>;
  },
```

In the `runExport({...})` call (lines ~283–292), add the two conditional spreads (matching the existing pattern):

```ts
      ...(opts.outputFps ? { outputFps: opts.outputFps } : {}),
      ...(opts.startUs != null ? { startUs: opts.startUs } : {}),
      ...(opts.endUs != null ? { endUs: opts.endUs } : {}),
    });
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: still only the App.tsx audio-call error from Task 6 (fixed in Task 8). No new errors in the preview files.

- [ ] **Step 4: Commit**

```bash
git add src/preview/PreviewSurface.tsx src/render/PixiPreview.tsx
git commit -m "feat(export): forward export range to the worker"
```

---

## Task 8: Thread range + audio through the App export handler

**Files:**
- Modify: `src/App.tsx` (`runExportWithSettings`)

- [ ] **Step 1: Make the handler accept an optional range**

In `src/App.tsx`, change the `runExportWithSettings` callback signature (line ~788) from:

```ts
    async (settings: ExportSettings, path: string) => {
```
to:
```ts
    async (settings: ExportSettings, path: string, range?: { startUs: number; endUs: number }) => {
```

- [ ] **Step 2: Use the range in the readiness gate**

In the gate block, replace lines ~800–801:

```ts
      const startUs = 0;
      const endUs = proj.duration_us;
```
with:
```ts
      const startUs = range?.startUs ?? 0;
      const endUs = range?.endUs ?? proj.duration_us;
```

- [ ] **Step 3: Resolve the range + codec-specific temp audio path**

Replace the temp audio path line (line ~884):

```ts
    const tempAudioPath = await join(tempBase, `weftcut-pixi-${stamp}.m4a`);
```
with:
```ts
    const audioExt = settings.audio.codec === "opus" ? "mka" : "m4a";
    const tempAudioPath = await join(tempBase, `weftcut-pixi-${stamp}.${audioExt}`);
```

After `const comp = summary.composition;` (line ~887), add:

```ts
    const exportRange = {
      startUs: range?.startUs ?? 0,
      endUs: range?.endUs ?? summary.duration_us,
    };
    const exportSpanUs = exportRange.endUs - exportRange.startUs;
```

- [ ] **Step 4: Pass the range to the video export**

In the `runPixiExport({...})` call (line ~959), add `startUs`/`endUs`:

```ts
      result = await previewRef.current?.runPixiExport({
        onProgress,
        encoderConfig,
        outputFps: { num: fpsNum, den: fpsDen },
        startUs: exportRange.startUs,
        endUs: exportRange.endUs,
        writeChunk,
      });
```

- [ ] **Step 5: Gate audio on `include` + pass spec/range; use span for transcode**

Replace the audio-only export call (line ~1002):

```ts
      await exportProjectAudioOnly(tempAudioPath);
```
with:
```ts
      if (settings.audio.include) {
        await exportProjectAudioOnly(
          tempAudioPath,
          {
            codec: settings.audio.codec,
            bitrate: settings.audio.bitrate,
            sampleRate: settings.audio.sampleRate,
            channels: settings.audio.channels,
          },
          { startUs: exportRange.startUs, endUs: exportRange.endUs },
        );
      }
```

In the transcode spec (line ~1018), change:

```ts
              durationUs: summary.duration_us,
```
to:
```ts
              durationUs: exportSpanUs,
```

In the transcode-progress listener (line ~990), change:

```ts
                currentTimeUs: Math.round(ev.payload * summary.duration_us),
```
to:
```ts
                currentTimeUs: Math.round(ev.payload * exportSpanUs),
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: the Task 6 audio-call error is gone. Remaining error: the `<ExportSettingsDialog onConfirm={(settings, path) => ...}>` site (line ~1524) — the dialog will pass a 3rd `range` arg after Tasks 9–10. (If `onConfirm`'s type hasn't changed yet, there is no error here yet; this becomes consistent in Task 9.)

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(export): thread range + audio settings through export run"
```

---

## Task 9: Pass range + props to the dialog at the mount site

**Files:**
- Modify: `src/App.tsx` (the `<ExportSettingsDialog>` render)

- [ ] **Step 1: Wire props + the 3-arg onConfirm**

In `src/App.tsx`, replace the `<ExportSettingsDialog ...>` block (lines ~1521–1528) with:

```tsx
        <ExportSettingsDialog
          comp={summary.composition}
          currentTimeUs={currentTimeUs}
          durationUs={summary.duration_us}
          onCancel={() => setExportDialogOpen(false)}
          onConfirm={(settings, path, range) => {
            // Don't close — the progress panel takes over the same overlay.
            void runExportWithSettings(settings, path, range);
          }}
        />
```

(`currentTimeUs` is the App-level playhead state at line ~146; `summary` is in scope in this JSX branch.)

- [ ] **Step 2: Verify (dialog prop types land in Task 10)**

Run: `npm run typecheck`
Expected: errors only in `ExportSettingsDialog.tsx` usage here — `currentTimeUs`/`durationUs` props and the 3-arg `onConfirm` don't exist on `Props` yet. Resolved in Task 10. Do not commit a broken typecheck alone; commit together with Task 10 if executing inline. (Subagent runs: commit here is acceptable since the next task immediately follows.)

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(export): pass playhead + range to export dialog"
```

---

## Task 10: Export range UI in the dialog

**Files:**
- Modify: `src/panels/ExportSettingsDialog.tsx`

- [ ] **Step 1: Extend Props + imports**

In `src/panels/ExportSettingsDialog.tsx`, add to the `exportSettings` import block:

```ts
  clampExportRange,
```

Add `formatTimecode` / `parseTimecode` import near the top:

```ts
import { formatTimecode, parseTimecode } from "../frames";
```

Replace the `Props` interface (lines ~33–37) with:

```ts
interface Props {
  comp: Comp;
  currentTimeUs: number;
  durationUs: number;
  onCancel: () => void;
  onConfirm: (
    settings: ExportSettings,
    path: string,
    range: { startUs: number; endUs: number },
  ) => void;
}
```

Update the component params (line ~39):

```ts
export function ExportSettingsDialog({ comp, currentTimeUs, durationUs, onCancel, onConfirm }: Props) {
```

- [ ] **Step 2: Add range state**

After the existing `useState` hooks (around line ~44), add:

```ts
  const [rangeMode, setRangeMode] = useState<"full" | "custom">("full");
  const [rangeStartUs, setRangeStartUs] = useState<number>(0);
  const [rangeEndUs, setRangeEndUs] = useState<number>(durationUs);
  // Keep the default "custom" end in sync if the project duration arrives late.
  useEffect(() => {
    setRangeEndUs((e) => (e === 0 ? durationUs : e));
  }, [durationUs]);
```

- [ ] **Step 3: Resolve range in `onExport` and pass it**

Replace the `onExport` function (lines ~117–123) with:

```ts
  async function onExport() {
    if (!settings || !location || !filename.trim()) return;
    const ext = containerExtension(settings.container);
    const out = await join(location, `${filename.trim()}.${ext}`);
    await exportSettingsSet(settings).catch(() => {});
    const range =
      rangeMode === "full"
        ? { startUs: 0, endUs: durationUs }
        : clampExportRange(rangeStartUs, rangeEndUs, durationUs);
    onConfirm(settings, out, range);
  }
```

Update `canExport` (line ~125) to reject an inverted custom range:

```ts
  const canExport =
    !!location &&
    filename.trim().length > 0 &&
    encodePath !== null &&
    (rangeMode === "full" || rangeStartUs < rangeEndUs);
```

- [ ] **Step 4: Add the range rows to the form**

Insert this block immediately after the fps `export-row` (after the closing `</div>` of the fps row, ~line 233, before the codec row):

```tsx
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.range")}
                  </span>
                  <select
                    className="export-select"
                    value={rangeMode}
                    onChange={(e) =>
                      setRangeMode(e.target.value as "full" | "custom")
                    }
                  >
                    <option value="full">{t("export_dialog.range_full")}</option>
                    <option value="custom">{t("export_dialog.range_custom")}</option>
                  </select>
                </div>
                {rangeMode === "custom" && (
                  <>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.range_in")}
                      </span>
                      <span className="export-range-field">
                        <input
                          type="text"
                          className="settings-input"
                          spellCheck={false}
                          value={formatTimecode(rangeStartUs, comp.fps_num, comp.fps_den)}
                          onChange={(e) => {
                            const us = parseTimecode(e.target.value, comp.fps_num, comp.fps_den);
                            if (us !== null) setRangeStartUs(us);
                          }}
                        />
                        <button
                          onClick={() =>
                            setRangeStartUs(Math.min(currentTimeUs, rangeEndUs))
                          }
                        >
                          {t("export_dialog.set_to_playhead")}
                        </button>
                      </span>
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.range_out")}
                      </span>
                      <span className="export-range-field">
                        <input
                          type="text"
                          className="settings-input"
                          spellCheck={false}
                          value={formatTimecode(rangeEndUs, comp.fps_num, comp.fps_den)}
                          onChange={(e) => {
                            const us = parseTimecode(e.target.value, comp.fps_num, comp.fps_den);
                            if (us !== null) setRangeEndUs(us);
                          }}
                        />
                        <button
                          onClick={() =>
                            setRangeEndUs(Math.max(currentTimeUs, rangeStartUs))
                          }
                        >
                          {t("export_dialog.set_to_playhead")}
                        </button>
                      </span>
                    </div>
                  </>
                )}
```

- [ ] **Step 5: Verify (typecheck + manual)**

Run: `npm run typecheck`
Expected: PASS (App.tsx ↔ dialog Props now consistent; i18n keys resolve at runtime — added in Task 12, missing keys render the key string but don't break typecheck).

Manual (after Task 12, in `npm run tauri:dev`): open Export, switch range to "custom", type/seek In and Out, confirm the exported file's duration matches the window and the frame count in the console export summary equals the window's frame count.

- [ ] **Step 6: Commit**

```bash
git add src/panels/ExportSettingsDialog.tsx
git commit -m "feat(export): In/Out range fields in export dialog"
```

---

## Task 11: Audio section UI + codec/container reconciliation

**Files:**
- Modify: `src/panels/ExportSettingsDialog.tsx`

- [ ] **Step 1: Extend imports**

Add to the `exportSettings` import block in `src/panels/ExportSettingsDialog.tsx`:

```ts
  type AudioCodecId,
  AUDIO_BITRATES,
  AUDIO_SAMPLE_RATES,
  AUDIO_CHANNELS,
  audioCodecsForContainer,
  isAudioCodecContainerValid,
```

- [ ] **Step 2: Reconcile audio codec when the container changes**

The container `<select>` onChange (lines ~276–278) currently does `patch({ container: ... })`. Replace it with a version that also snaps an invalid audio codec back to AAC:

```tsx
                    onChange={(e) => {
                      const container = e.target.value as Container;
                      const audio = isAudioCodecContainerValid(
                        settings.audio.codec,
                        container,
                      )
                        ? settings.audio
                        : { ...settings.audio, codec: "aac" as AudioCodecId };
                      patch({ container, audio });
                    }}
```

Also handle the video-codec→MP4 fallback (lines ~242–250): when that path forces `container: "mp4"`, Opus would become invalid. Replace the codec `<select>` onChange with:

```tsx
                    onChange={(e) => {
                      const codec = e.target.value as CodecId;
                      if (!isCodecContainerValid(codec, settings.container)) {
                        // Falls back to MP4 → Opus (MKV-only) must also reset.
                        const audio = { ...settings.audio, codec: "aac" as AudioCodecId };
                        patch({ codec, container: "mp4", audio });
                      } else {
                        patch({ codec });
                      }
                    }}
```

- [ ] **Step 3: Add the audio section**

Insert after the rate-mode `export-row` (after its closing `</div>`, ~line 356, before `<div className="export-actions">`):

```tsx
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.audio_include")}
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.audio.include}
                    onChange={(e) =>
                      patch({ audio: { ...settings.audio, include: e.target.checked } })
                    }
                  />
                </div>
                {settings.audio.include && (
                  <>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_codec")}
                      </span>
                      <select
                        className="export-select"
                        value={settings.audio.codec}
                        onChange={(e) =>
                          patch({
                            audio: {
                              ...settings.audio,
                              codec: e.target.value as AudioCodecId,
                            },
                          })
                        }
                      >
                        {audioCodecsForContainer(settings.container).map((c) => (
                          <option key={c} value={c}>
                            {c.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_bitrate")}
                      </span>
                      <select
                        className="export-select"
                        value={settings.audio.bitrate}
                        onChange={(e) =>
                          patch({
                            audio: { ...settings.audio, bitrate: Number(e.target.value) },
                          })
                        }
                      >
                        {AUDIO_BITRATES.map((b) => (
                          <option key={b} value={b}>
                            {b / 1000} kbps
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_channels")}
                      </span>
                      <select
                        className="export-select"
                        value={settings.audio.channels ?? ""}
                        onChange={(e) =>
                          patch({
                            audio: {
                              ...settings.audio,
                              channels: e.target.value ? Number(e.target.value) : null,
                            },
                          })
                        }
                      >
                        <option value="">{t("export_dialog.follow_comp")}</option>
                        {AUDIO_CHANNELS.map((c) => (
                          <option key={c} value={c}>
                            {c === 1
                              ? t("export_dialog.channels_mono")
                              : t("export_dialog.channels_stereo")}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_sample_rate")}
                      </span>
                      <select
                        className="export-select"
                        value={settings.audio.sampleRate ?? ""}
                        onChange={(e) =>
                          patch({
                            audio: {
                              ...settings.audio,
                              sampleRate: e.target.value ? Number(e.target.value) : null,
                            },
                          })
                        }
                      >
                        <option value="">{t("export_dialog.follow_comp")}</option>
                        {AUDIO_SAMPLE_RATES.map((r) => (
                          <option key={r} value={r}>
                            {(r / 1000).toFixed(1)} kHz
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
```

- [ ] **Step 4: Verify (typecheck + manual)**

Run: `npm run typecheck`
Expected: PASS.

Manual (after Task 12): open Export → an Audio section appears. Pick MKV container → Opus appears in the audio-codec dropdown; switch container back to MP4 → audio codec snaps to AAC. Untick "include audio" → the codec/bitrate/channel/rate rows hide. Export and confirm: AAC default plays; Opus-in-MKV plays; mute produces a video-only file.

- [ ] **Step 5: Commit**

```bash
git add src/panels/ExportSettingsDialog.tsx
git commit -m "feat(export): audio section (include/codec/bitrate/channels/rate)"
```

---

## Task 12: i18n keys

**Files:**
- Modify: `src/i18n/locales/en-US.ts`, `src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add English keys**

In `src/i18n/locales/en-US.ts`, inside the `export_dialog` object (before the closing `},` at line ~275), add:

```ts
    range: "Range",
    range_full: "Whole project",
    range_custom: "Custom",
    range_in: "In",
    range_out: "Out",
    set_to_playhead: "Set to playhead",
    audio_include: "Include audio",
    audio_codec: "Audio codec",
    audio_bitrate: "Audio bitrate",
    audio_channels: "Channels",
    audio_sample_rate: "Sample rate",
    channels_mono: "Mono",
    channels_stereo: "Stereo",
```

- [ ] **Step 2: Add Chinese keys**

In `src/i18n/locales/zh-CN.ts`, inside the `export_dialog` object (before the closing `},` at line ~270), add:

```ts
    range: "范围",
    range_full: "整段项目",
    range_custom: "自定义",
    range_in: "入点",
    range_out: "出点",
    set_to_playhead: "设为播放头",
    audio_include: "包含音频",
    audio_codec: "音频编码",
    audio_bitrate: "音频码率",
    audio_channels: "声道",
    audio_sample_rate: "采样率",
    channels_mono: "单声道",
    channels_stereo: "立体声",
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS (both locale objects keep matching shapes).

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/en-US.ts src/i18n/locales/zh-CN.ts
git commit -m "i18n(export): range + audio dialog strings"
```

---

## Task 13: Full verification

**Files:** none (verification only)

- [ ] **Step 1: TS unit tests**

Run: `npm test`
Expected: PASS, including `src/render/exportSettings.test.ts`.

- [ ] **Step 2: TS typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Rust tests**

Run (from `apps/desktop/src-tauri`): `cargo test --lib export:: ir::`
Expected: PASS — `audio_encode_args_aac_and_opus`, `window_trims_the_audio_output`, `audio_layer_emits_amix_with_one_input`, and the existing `video_encode_args` / `mux_args` tests.

- [ ] **Step 4: Manual smoke (in `npm run tauri:dev`)**

Import a clip with audio, then:
1. **Range:** set range to custom, In ≈ 2 s, Out ≈ 5 s → exported file is ~3 s, audio aligned (no silence offset, audio not longer than video).
2. **Audio default:** AAC / 192k / MP4 → plays.
3. **Opus:** container MKV, audio codec Opus → plays; verify audio codec is opus (e.g. `ffprobe`).
4. **Mute:** untick include audio → file has no audio track.
5. **Sample rate / channels:** export 48 kHz mono → `ffprobe` shows 48000 Hz, 1 channel.

- [ ] **Step 5: E2E note (optional, follow-up)**

The existing `media_conformance --audio` (Goertzel) harness can verify the non-default-audio exports are frequency-faithful, and `window.__weftcutExportPerf.totalFrames` verifies the range frame count. Only one fps audio fixture exists today; adding an Opus / 48 kHz fixture is a follow-up, not a blocker. Do not silently skip — log the gap if wiring the E2E.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(export): verification fixups for range + audio"
```

---

## Self-review

**Spec coverage:**
- §1 audio schema/validity/merge → Task 1. `estimateBytes` → Task 2. `clampExportRange` → Task 3. ✓
- §2 range dialog (props, state, timecode fields, set-to-playhead, canExport, onConfirm) → Task 10. ✓
- §3 video-side range plumbing (PreviewSurface, PixiPreview, App handler, transcode span) → Tasks 7, 8. ✓
- §4 audio trim via IR window (`emit` window param + `atrim`) → Task 4, wired in Task 5. ✓
- §5 audio plumbing (include-skip, `AudioEncodeSpec`, command params, `audio_encode_args`, temp ext, codec×container reconciliation) → Tasks 5, 6, 8, 11. ✓
- §6 tests + i18n → Tasks 1–5 (unit), 12 (i18n), 13 (verification). ✓

**Note on a spec refinement:** §4 of the spec suggested carrying the window on `RenderTarget`; the plan instead passes the window directly to `emit_ffmpeg` (Task 4). Same audio-graph `atrim` trim, fewer touched layers — `RenderTarget` stays focused on output-format params. `clampExportRange` also drops the fps params from the spec sketch (inputs are already frame-aligned via `parseTimecode` / the snapped playhead).

**Placeholder scan:** No TBD/TODO; every code step has complete code; no "similar to Task N" references. ✓

**Type consistency:** `AudioSettings` fields (`include`, `codec`, `bitrate`, `sampleRate`, `channels`) are identical across `exportSettings.ts` (Task 1), the IPC `AudioExportSpec` (Task 6, camelCase), Rust `AudioEncodeSpec` (Task 5, serde camelCase → snake_case), and the dialog `patch({ audio: ... })` calls (Task 11). `clampExportRange(startUs, endUs, durationUs)` signature matches its caller in Task 10. `emit(graph, window_us)` matches both call sites (Task 4) and the windowed call in Task 5. `exportProjectAudioOnly(outputPath, audio, range)` matches its caller in Task 8. ✓
