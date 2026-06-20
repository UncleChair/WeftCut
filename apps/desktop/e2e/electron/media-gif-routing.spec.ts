import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
// Animated (multi-frame) gif. `probe::detect_kind` must classify it VIDEO, and
// because the gif codec is not WebCodecs-decodable the proxy decision can't
// bypass it — it must route through the FULL-proxy pipeline. This is the
// routing leg from the retired wdio `image_support.e2e.js`, re-homed here.
// ffmpeg-gated on fixture presence (run: `cd apps/desktop/e2e && npm run
// fixtures`); the full-proxy transcode also needs ffmpeg at runtime.
const GIF = path.resolve(MEDIA_DIR, 'test_1080p_10fps.gif')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-gif-proj')

// Subset of MediaSummary (commands::MediaSummary) the routing assertion reads.
interface MediaEntry {
  id: string
  kind: string
  proxy_path: string | null
  proxy_bypassed: boolean
  export_uses_original: boolean
}

test.describe('animated gif routes through the full-proxy pipeline (Electron)', () => {
  test.skip(!existsSync(GIF), `gif fixture not found at ${GIF} (run: cd apps/desktop/e2e && npm run fixtures)`)

  test.beforeAll(() => {
    mkdirSync(PROJECT_PARENT, { recursive: true })
  })

  test('multi-frame gif classifies as Video and reaches an export-ready full proxy', async () => {
    test.setTimeout(220000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-gif-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })

      // Import + place 1:1. detect_kind classifies the multi-frame gif as Video.
      const { mediaId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: GIF, tStartUs: 0 })
      expect(kind, 'multi-frame gif must classify as Video').toBe('Video')

      // Wait until the proxy decision produces an export playback path
      // (exportPlaybackPathFor != null) — i.e. the full-proxy job completed.
      const ready = (await page.evaluate(
        (id) =>
          (window as any).__weftcutTest
            .waitMediaExportReady({ mediaId: id, timeoutMs: 180000 })
            .then(() => ({ ok: true }))
            .catch((e: unknown) => ({ ok: false, error: String(e) })),
        mediaId,
      )) as { ok: boolean; error?: string }
      if (!ready.ok) throw new Error('gif never became export-ready (full-proxy route): ' + ready.error)

      // Prove the route taken is FULL-PROXY, not a bypass / DirectExport: a
      // generated proxy exists and neither original-route escape hatch is set.
      const sum = await invokeCmd<{ media: MediaEntry[] }>(page, 'project_summary', {})
      const entry = sum.media.find((m) => m.id === mediaId)
      expect(entry, `media ${mediaId} present in pool`).toBeTruthy()
      expect(entry!.kind).toBe('Video')
      expect(entry!.proxy_path, 'gif must have a generated full proxy').toBeTruthy()
      expect(entry!.proxy_bypassed, 'gif must NOT bypass the proxy').toBe(false)
      expect(entry!.export_uses_original, 'gif must NOT export from the original').toBe(false)
    } finally {
      await app.close()
    }
  })
})
