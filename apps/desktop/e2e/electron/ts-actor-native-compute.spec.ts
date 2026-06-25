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
//   F3: import_media → project_summary shows the media (TS actor has it; stale
//       Rust actor does not — a stale read would return an empty pool).
//   F1/F2: export_project_audio_only reads the mirror correctly (returns the
//       expected false/no-audio boolean rather than erroring on a nil actor).
//   F2b: ensure_export_audio_conform also reads the mirror and returns the
//       correct empty list (no audio layers in a blank project).
//
// The spec intentionally stays thin: the full audio-export pipeline (conform,
// mix, ffmpeg) is exercised by audio.spec.ts and export-range-audio.spec.ts.
// Here we prove the mirror-read path is wired; we do not re-prove ffmpeg.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')

// A small audio fixture (pure audio, no video stream). Exists in the committed
// fixtures; no `npm run fixtures` generation required.
const AUDIO_FIXTURE = path.resolve(MEDIA_DIR, 'test_tones_10s.m4a')

interface Summary {
  tracks: Array<{ id: string; layers: Array<{ id: string; params: { kind: string } }> }>
  media_pool?: Record<string, unknown>
}

const invoke = <T = unknown>(page: Page, cmd: string, args: Record<string, unknown> = {}) =>
  page.evaluate(
    ([c, a]) => (window as any).api.backend.invoke(c, a),
    [cmd, args] as const,
  ) as Promise<T>

test('WEFTCUT_TS_ACTOR native-compute: import_media hybrid + mirror-backed export reads', async () => {
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
    // the file (compute) and the TS host writes the result into its actor.  The
    // stale Rust actor stays empty.  If the mirror-read were broken and the stale
    // Rust actor were consulted, project_summary would return an empty media pool.
    const mediaIdJson = await invoke<string>(page, 'import_media', { path: AUDIO_FIXTURE })
    // import_media returns a string media-id (JSON-encoded).
    const mediaId: string =
      typeof mediaIdJson === 'string' && mediaIdJson.startsWith('"')
        ? JSON.parse(mediaIdJson)
        : mediaIdJson
    expect(typeof mediaId).toBe('string')
    expect(mediaId.length).toBeGreaterThan(0)

    // project_summary must show the imported media in the pool.
    const summaryJson = await invoke<string>(page, 'project_summary', {})
    const summaryStr = typeof summaryJson === 'string' ? summaryJson : JSON.stringify(summaryJson)
    expect(summaryStr).toContain(mediaId)

    // ── F1/F2: export_project_audio_only reads the mirror (snapshot_for_read) ──
    // A blank project (no audio layers) → export returns false (no layers to mix)
    // and leaves no output file.  The key proof is that the function runs without
    // error — a nil/stale actor read would either panic or return wrong data.
    // AudioEncodeSpec: codec "aac", bitrate 128000; sample_rate + channels absent
    // (follow composition defaults).
    const exportResult = await invoke<boolean>(page, 'export_project_audio_only', {
      outputPath,
      audio: { codec: 'aac', bitrate: 128000 },
    })
    // No audio layers → false (no mix, no output file produced). This is the
    // correct mirror-read result: the TS actor's blank project has no audio layers.
    expect(exportResult).toBe(false)
    // No output file when there are no layers to mix.
    expect(fs.existsSync(outputPath)).toBe(false)

    // ── F2b: ensure_export_audio_conform reads the mirror correctly ──
    // The blank project has no audio layers → no waiting media ids.
    const waitingJson = await invoke<string>(page, 'ensure_export_audio_conform', {})
    const waiting: string[] =
      typeof waitingJson === 'string' ? JSON.parse(waitingJson) : waitingJson
    expect(Array.isArray(waiting)).toBe(true)
    expect(waiting).toHaveLength(0)
  } finally {
    await app.close()
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
