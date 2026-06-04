# Export range + audio settings — design

Adds two capabilities to the export flow:

1. **Export range** — render only a `[startUs, endUs)` slice of the composition instead of the whole project, set via In/Out timecode fields in the export dialog.
2. **Audio settings** — the export dialog currently has *zero* audio controls (AAC / 192 kbps is hardcoded in `export_audio_only`, sample-rate/channels inherit from `composition.*`). Add an audio section: include/mute, codec (AAC / Opus), bitrate, channels, sample rate.

## Goals / non-goals

**Goals**
- Let the user export an arbitrary frame-aligned sub-range, audio trimmed to match.
- Let the user choose whether audio is included, and its codec/bitrate/channels/sample-rate.
- Keep the webview as the sole owner of the `ExportSettings` schema; Rust keeps persisting it as an opaque blob.

**Non-goals (this pass)**
- Timeline In/Out markers / work-area bar (chosen against in favor of dialog fields).
- Loudness normalization, audio filters, per-track audio routing.
- Video color-space / HDR / 10-bit / CRF / two-pass (separate web-ceiling concerns).

## 1. Data model — `src/render/exportSettings.ts`

Audio settings persist in `export.json` (webview-owned schema). Range does **not** persist — it is dialog-local and tied to the current edit.

```ts
export type AudioCodecId = "aac" | "opus";

export interface AudioSettings {
  include: boolean;           // default true
  codec: AudioCodecId;        // default "aac"
  bitrate: number;            // bps, default 192_000
  sampleRate: number | null;  // null = follow composition; else 44100 | 48000
  channels: number | null;    // null = follow composition; else 2 (stereo) | 1 (mono)
}

export interface ExportSettings {
  // ...existing video fields (resolutionHeight, fps, codec, quality,
  //    customBitrate, rateMode, container)...
  audio: AudioSettings;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  include: true,
  codec: "aac",
  bitrate: 192_000,
  sampleRate: null,
  channels: null,
};
// DEFAULT_EXPORT_SETTINGS gains: audio: DEFAULT_AUDIO_SETTINGS

export const AUDIO_CODECS: AudioCodecId[] = ["aac", "opus"];
export const AUDIO_BITRATES = [96_000, 128_000, 192_000, 256_000, 320_000] as const;
export const AUDIO_SAMPLE_RATES = [48_000, 44_100] as const;
export const AUDIO_CHANNELS = [2, 1] as const;
```

**`mergeSettings`** does a one-level nested merge so an old `export.json` with no `audio` key (or a partial one) back-fills:

```ts
return {
  ...DEFAULT_EXPORT_SETTINGS,
  ...(saved ?? {}),
  audio: { ...DEFAULT_AUDIO_SETTINGS, ...(saved?.audio ?? {}) },
};
```

**Audio codec × container validity** (mirrors the existing `isCodecContainerValid` AV1+MOV exclusion, inverted direction):

```ts
// AAC: mp4 / mov / mkv. Opus: mkv only (WebView2-safe; MP4/MOV Opus playback
// is unreliable in WebView2, WebM is deferred).
export function isAudioCodecContainerValid(c: AudioCodecId, k: Container): boolean {
  return c === "opus" ? k === "mkv" : true;
}
export function audioCodecsForContainer(k: Container): AudioCodecId[] {
  return AUDIO_CODECS.filter((c) => isAudioCodecContainerValid(c, k));
}
```

**`estimateBytes`** changes signature from `(bitrate, durationUs, hasAudio)` to `(bitrate, durationUs, audioBitrate)`, where the caller passes `audio.include ? audio.bitrate : 0`. This replaces the hardcoded `192_000`. NOTE: the size estimate is **not currently rendered** in the dialog (`estimateBytes`/`formatBytes` from this module are not imported by `ExportSettingsDialog.tsx`; the `formatBytes` in `App.tsx` is a separate media-size helper). This change keeps the tested logic honest for when the estimate is surfaced; it is not on a live UI path.

**Range clamp helper** (pure, unit-tested):

```ts
// Frame-aligned, ordered, within [0, durationUs]. Reuses the frame-snap rule.
export function clampExportRange(
  startUs: number, endUs: number, durationUs: number,
  fpsNum: number, fpsDen: number,
): { startUs: number; endUs: number };
```

## 2. Export range — dialog (`src/panels/ExportSettingsDialog.tsx`)

Range is dialog-local ephemeral state.

- New props: `currentTimeUs: number`, `durationUs: number`.
- New local state: `rangeMode: "full" | "custom"`, `startUs` (default `0`), `endUs` (default `durationUs`).
- UI: a "whole / custom" select. When `custom`, show two SMPTE timecode text inputs (In / Out) plus a "set to playhead" button beside each.
  - Format/parse via existing `formatTimecode(us, fpsNum, fpsDen)` / `parseTimecode(input, fpsNum, fpsDen)` in `src/frames.ts` (uses `comp.fps_num/fps_den`).
  - On blur / button press, run `clampExportRange` so values stay frame-aligned, ordered, and in-bounds.
- `canExport` gains: `rangeMode === "full" || startUs < endUs`.
- `onConfirm(settings, path)` → `onConfirm(settings, path, range)` where `range = { startUs, endUs }` (`"full"` resolves to `{ 0, durationUs }`).

## 3. Range plumbing — video side (thin)

The export Worker (`runExport.ts`) already accepts `startUs`/`endUs`. Three connect points:

1. `PreviewSurfaceHandle.runPixiExport` opts type: add `startUs?: number; endUs?: number`.
2. `PixiPreview.handlePixiExport` opts type: add the same; forward into the `runExport({...})` call via the existing conditional-spread pattern (`...(opts.startUs != null ? { startUs: opts.startUs } : {})`).
3. `App.tsx` export handler: pass `range.startUs` / `range.endUs` into the opts. Also change the ffmpeg-path transcode progress denominator from `summary.duration_us` to the **range span** `range.endUs - range.startUs` (both the `TranscodeSpec.durationUs` and the `currentTimeUs` mapping in the transcode-progress listener), so sub-range progress is correct.

## 4. Range — audio trim (the one non-trivial backend change)

The video Worker renders only `[startUs, endUs)` with timestamps starting at 0. The Rust audio path renders the **whole** project via the IR, so a sub-range export would mux a too-long, misaligned audio track under `-c copy`. Audio must be trimmed to the same window, sample-accurate, starting at 0.

**Approach: carry the window in the IR via `RenderTarget`.**
- Add `window_us: Option<(i64, i64)>` to `RenderTarget` (`src-tauri/src/ir/target.rs`). `full(...)` and `proxy(...)` default it to `None` (whole composition — back-compat). Add a builder/param so the export path can set it.
- In `emit_ffmpeg` (`src-tauri/src/ir/emit_ffmpeg.rs`), when `window_us` is `Some((s, e))`, append `atrim=start={s_sec}:end={e_sec},asetpts=PTS-STARTPTS` to the final audio output node so the produced file covers exactly the window and starts at PTS 0. Downstream `-c copy` then aligns with the video.

Rationale: `RenderTarget` is the established "same IR, two output targets" seam; trimming inside the audio graph is sample-accurate and robust across ffmpeg versions, unlike output-side `-ss`/`-to` (whose timestamp-reset behavior varies by version).

## 5. Audio plumbing — audio side

- **Audio excluded** (`audio.include === false`): `App.tsx` simply **skips** the `exportProjectAudioOnly` call. The existing video-only mux path (`mux_args` / `transcode_and_mux` omit `-i audio` when the file is absent) handles it with no new logic.
- **Audio included**: thread an audio spec + the range from JS to Rust.
  - IPC: `exportProjectAudioOnly(path)` → `exportProjectAudioOnly(path, audioSpec, range)`, where
    `audioSpec = { codec: "aac" | "opus", bitrate: number, sampleRate: number | null, channels: number | null }`.
  - Rust command `export_project_audio_only` + `export_audio_only` gain matching params:
    - Build the target with `sample_rate = audioSpec.sampleRate ?? composition.sample_rate`, `channels = audioSpec.channels ?? composition.channels`, and `window_us` from `range`.
    - Replace the hardcoded `["-c:a", "aac", "-b:a", "192k"]` with `audio_encode_args(codec, bitrate)`:
      `aac → ["-c:a", "aac"]`, `opus → ["-c:a", "libopus"]`, then `["-b:a", bitrate.to_string()]`. Extracted as a pure fn in `export/mod.rs`, unit-tested like `video_encode_args`.
  - **Temp audio file extension follows the codec** (ffmpeg selects the muxer by extension): `aac → .m4a`, `opus → .mka`. `App.tsx` picks the temp path by `audio.codec`.
  - Downstream `transcode_and_mux` / `mux_to_file` keep `-c:a copy` / `-c copy` — both AAC and Opus stream-copy into their permitted containers.

**Dialog codec × container reconciliation** (mirrors the existing AV1+MOV fallback, opposite direction):
- The audio-codec dropdown lists only `audioCodecsForContainer(settings.container)`.
- When the container changes (including the existing video-codec→MP4 auto-fallback) and the current `audio.codec` becomes invalid, snap `audio.codec` back to `"aac"`.
- The container dropdown stays driven by the video codec's `containersForCodec`; audio codec only adapts to the chosen container (it does not further narrow the container list), so the two codec axes don't both crowd the container dropdown.

## 6. Tests & i18n

**Pure-logic unit tests** (`exportSettings.test.ts`):
- `mergeSettings` back-fills `audio` from an old blob (missing key + partial object).
- `isAudioCodecContainerValid` / `audioCodecsForContainer` (Opus⇒MKV-only; AAC⇒all).
- `estimateBytes` with an explicit audio bitrate (and 0 when excluded).
- `clampExportRange` (ordering, bounds, frame alignment).

**Rust unit tests** (`export/mod.rs`, `ir/emit_ffmpeg.rs`):
- `audio_encode_args` for aac and opus.
- `emit_ffmpeg` appends `atrim`+`asetpts` when `window_us` is set, and does not when `None`.

**E2E** (existing harness):
- `media_conformance --audio` (Goertzel) verifies a non-default sample-rate / channel / codec export stays frequency-faithful.
- A range export verifies frame count via `window.__weftcutExportPerf.totalFrames` == range frame count.
- Known limitation: only one fps audio fixture exists today; an Opus / 48 kHz fixture may need adding before the audio-config E2E is meaningful. Flag rather than silently skip.

**i18n**: add `export_dialog.*` keys (range mode, In/Out, set-to-playhead, audio section, include, audio codec, audio bitrate, channels, sample rate, follow-comp) to `src/i18n/locales/en-US.ts` and `zh-CN.ts`.

## Risks / tradeoffs

- The only backend surface touched is the IR window for audio trim (§4) — inherent to range correctness, not scope creep. Everything else is schema + ffmpeg-arg + UI.
- Opus support widens the codec×container matrix; contained by the same validity-function pattern already used for video.
- Multi-config audio is under-tested (single fixture) — noted as a follow-up, not a blocker for the feature.
