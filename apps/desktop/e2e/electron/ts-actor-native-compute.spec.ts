import { test, expect, _electron as electron, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// Phase 3d-e — native-compute flag-on gate. Under WEFTCUT_TS_ACTOR=1 the five
// write hybrids (import_media, apply_subtitles, install_motif,
// acknowledge_motif_staleness, synthesize_speech) route Rust-compute → TS-write
// and the seven mirror-backed reads (export_project_audio_only,
// ensure_export_audio_conform, get_media_thumbnail, get_waveform_peaks,
// ensure_full_proxy, ensure_conform, motif_staleness_report) call
// snapshot_for_read() instead of the stale Rust actor. This spec drives the
// production window.api.backend.invoke bridge under the flag and asserts:
//
//   F3 (import_media hybrid): import a fixture → project_summary shows the media
//      in the pool. The TS actor has it; the stale Rust actor stays empty, so a
//      broken read would return an empty pool.
//   F1/F2 (export inputs are read from the mirror): place an Audio layer that
//      references the imported media, then assert project_summary shows that
//      Audio layer. This proves the EXPORT INPUTS that export_project_audio_only
//      / ensure_export_audio_conform read via snapshot_for_read() are present in
//      the mirror under the flag. Combined with the Part-1 Rust source-scan
//      (export.rs uses snapshot_for_read, never .project()?.snapshot()), that is
//      the full F1/F2 chain. The export call itself is kept as a labeled SMOKE
//      assertion (does not throw) — its boolean return value is NOT the proof.
//
// The spec intentionally stays thin: the full audio-export pipeline (conform,
// mix, ffmpeg) is exercised by audio.spec.ts and export-range-audio.spec.ts.
// Here we prove the mirror-read INPUT path is wired; we do not re-prove ffmpeg.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')

// A small audio fixture (pure audio, no video stream). Exists in the committed
// fixtures; no `npm run fixtures` generation required.
const AUDIO_FIXTURE = path.resolve(MEDIA_DIR, 'test_tones_10s.m4a')

// project_summary shape (mirrors src/main/state/summary.ts ProjectSummary):
// `media` is an array of MediaSummary ({ id, ... }); an Audio layer's params
// view is { kind: 'Audio', media_id, ... } (layerParamsView).
interface Summary {
  media: Array<{ id: string }>
  tracks: Array<{ id: string; layers: Array<{ id: string; params: { kind: string; media_id?: string } }> }>
}

// Under WEFTCUT_TS_ACTOR the TS host returns PARSED values from handleInvoke
// (ts-actor-host.ts): project_summary → a Summary object, add_media_layer → the
// new layer-id string, import_media (hybrid) → the bare media-id string. Mirrors
// ts-actor-flip.spec.ts, which consumes project_summary as a parsed Summary.
const invoke = <T = unknown>(page: Page, cmd: string, args: Record<string, unknown> = {}) =>
  page.evaluate(
    ([c, a]) => (window as any).api.backend.invoke(c, a),
    [cmd, args] as const,
  ) as Promise<T>

test('WEFTCUT_TS_ACTOR native-compute: import_media hybrid + audio layer visible in mirror-backed summary', async () => {
  // Skip gracefully when the audio fixture is absent (e.g. a stripped CI run
  // that prunes fixtures — the full conformance suite guards this more tightly).
  test.skip(!fs.existsSync(AUDIO_FIXTURE), `audio fixture not found at ${AUDIO_FIXTURE}`)

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-native-compute-'))
  const outputPath = path.join(ws, 'export-gate.m4a')

  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      WEFTCUT_TS_ACTOR: '1',
      WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1',
    } as Record<string, string>,
  })

  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    // Production bridge available on the startup screen — no editor/test hooks.
    await page.waitForFunction(() => !!(window as any).api?.backend?.invoke, undefined, {
      timeout: 30_000,
    })

    // New workspace — TS persistence orchestrator under the flag.
    const projectDir = await invoke<string>(page, 'project_new_workspace', {
      parentFolder: ws,
      name: 'native-compute',
      width: 1920,
      height: 1080,
      fpsNum: 30,
      fpsDen: 1,
    })
    expect(typeof projectDir).toBe('string')

    // ── F3: import_media hybrid adds to the TS actor; project_summary reflects it ──
    // Under the flag, import_media routes via the hybrid orchestrator: Rust probes
    // the file (compute) and the TS host writes the result into its actor via
    // add_media_item. The stale Rust actor stays empty. The hybrid returns the
    // bare media-id string (hybrids.ts runHybrid). If the mirror-backed read were
    // broken and the stale Rust actor were consulted, the media pool would be empty.
    const mediaId = await invoke<string>(page, 'import_media', { path: AUDIO_FIXTURE })
    expect(typeof mediaId).toBe('string')
    expect(mediaId.length).toBeGreaterThan(0)

    // project_summary (mirror-backed read) must show the imported media in the pool.
    const afterImport = await invoke<Summary>(page, 'project_summary')
    expect(afterImport.media.map((m) => m.id)).toContain(mediaId)

    // ── F1/F2: the EXPORT INPUTS (audio layers) are present in the mirror ──
    // Place an Audio layer referencing the imported audio media via the production
    // add_media_layer channel (PRODUCTION_OP → TS actor command under the flag).
    // Arg shape verified against AddMediaLayerArgs (#[serde(rename_all="camelCase")]
    // → trackId/mediaId/tStartUs) and the renderer's addMediaLayer invoke
    // (ipc/index.ts:454). A pure-Audio media item yields an Audio-kind layer with
    // no auto-pair (commands.ts prodMediaLayer).
    const trackId = afterImport.tracks[0]?.id
    expect(typeof trackId).toBe('string')
    const newLayerId = await invoke<string>(page, 'add_media_layer', {
      trackId,
      mediaId,
      tStartUs: 0,
    })
    expect(typeof newLayerId).toBe('string')
    expect(newLayerId.length).toBeGreaterThan(0)

    // project_summary (mirror-backed read) must now show an Audio layer that
    // references the imported media. This is the export-input the F1/F2 readers
    // (export_project_audio_only / ensure_export_audio_conform) consult via
    // snapshot_for_read() — proven present in the TS mirror, not the stale actor.
    const afterPlace = await invoke<Summary>(page, 'project_summary')
    const audioLayers = afterPlace.tracks.flatMap((t) => t.layers).filter((l) => l.params.kind === 'Audio')
    expect(audioLayers.length).toBeGreaterThan(0)
    expect(audioLayers.some((l) => l.params.media_id === mediaId)).toBe(true)

    // ── SMOKE: the mirror-backed export readers run without throwing ──────────
    // F1/F2's mirror-read correctness is guarded by the Part-1 Rust source-scan
    // (export.rs uses snapshot_for_read, never .project()?.snapshot()) PLUS the
    // audio layer being visible in the mirror-backed summary above — NOT by these
    // return values. We only assert the readers run against the mirror without
    // throwing (a nil/stale-actor read would reject). We do not assert a full
    // ffmpeg export here (conform/mix timing is flaky; covered by audio.spec.ts);
    // await alone fails the test on a rejected IPC promise.
    await invoke<boolean>(page, 'export_project_audio_only', {
      outputPath,
      audio: { codec: 'aac', bitrate: 128000 },
    })
    await invoke<string[]>(page, 'ensure_export_audio_conform')
  } finally {
    await app.close()
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
