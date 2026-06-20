import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
// Animated (multi-frame) gif. detect_kind must now classify it IMAGE (an
// animated image looped by the renderer, NO proxy), and it must animate + loop
// + export. ffmpeg-gated on fixture presence (run: cd apps/desktop/e2e && npm
// run fixtures); the export leg also needs ffmpeg/ffprobe at runtime.
const GIF = path.resolve(MEDIA_DIR, 'test_1080p_10fps.gif')
const FFPROBE = process.env.FFPROBE || 'ffprobe'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-gif-proj')

interface MediaEntry {
  id: string
  kind: string
  proxy_path: string | null
  proxy_bypassed: boolean
}
interface LayerEntry {
  id: string
  t_start_us: number
  t_end_us: number
  params: { kind: string }
}

test.describe('animated gif is a looping Image (Electron)', () => {
  test.skip(!existsSync(GIF), `gif fixture not found at ${GIF} (run: cd apps/desktop/e2e && npm run fixtures)`)

  test.beforeAll(() => {
    mkdirSync(PROJECT_PARENT, { recursive: true })
  })

  test('multi-frame gif classifies Image, has no proxy, and defaults to one native loop', async () => {
    test.setTimeout(120000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-gif-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })

      const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: GIF, tStartUs: 0 })
      expect(kind, 'multi-frame gif must classify as Image').toBe('Image')

      const sum = await invokeCmd<{ media: MediaEntry[]; tracks: { layers: LayerEntry[] }[] }>(
        page, 'project_summary', {},
      )
      const entry = sum.media.find((m) => m.id === mediaId)
      expect(entry, `media ${mediaId} present in pool`).toBeTruthy()
      expect(entry!.kind).toBe('Image')
      expect(entry!.proxy_path, 'animated image must NOT get a proxy').toBeNull()

      // Placed layer is an ImageOverlay spanning exactly one native loop.
      const layer = sum.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
      expect(layer, 'placed layer present').toBeTruthy()
      expect(layer!.params.kind).toBe('ImageOverlay')
      const meta = await invokeCmd<{ media: { id: string; duration_us: number | null }[] }>(
        page, 'project_summary', {},
      )
      const nativeDurUs = meta.media.find((m) => m.id === mediaId)!.duration_us
      expect(nativeDurUs, 'gif reports a native duration').toBeTruthy()
      expect(layer!.t_end_us - layer!.t_start_us).toBe(nativeDurUs)
    } finally {
      await app.close()
    }
  })

  test('animated gif animates and loops through the real sprite', async () => {
    test.setTimeout(120000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-gif-anim-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      const { mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: GIF, tStartUs: 0 })

      // First call: discover the loop period + frame count.
      const probe = await page.evaluate(
        (id) =>
          (window as any).__weftcutTest.renderImageOverlaySpriteFrames({
            mediaId: id,
            durationUs: 10_000_000,
            maxWidth: 1920,
            maxHeight: 1080,
            times: [{ tInLayerUs: 0 }],
          }),
        mediaId,
      )
      expect(probe.frameCount, 'gif decoded to multiple frames').toBeGreaterThan(1)
      expect(probe.totalUs, 'gif has a positive loop period').toBeGreaterThan(0)

      const total = probe.totalUs as number
      const mid = Math.floor(total / 2)
      const res = await page.evaluate(
        ({ id, total, mid }) =>
          (window as any).__weftcutTest.renderImageOverlaySpriteFrames({
            mediaId: id,
            durationUs: 10_000_000,
            maxWidth: 1920,
            maxHeight: 1080,
            times: [{ tInLayerUs: 0 }, { tInLayerUs: mid }, { tInLayerUs: total }],
          }),
        { id: mediaId, total, mid },
      )
      const [s0, sMid, sLoop] = res.samples
      // Animates: a mid-loop frame differs from frame 0.
      expect(sMid.checksum, 'mid-loop frame differs from frame 0').not.toBe(s0.checksum)
      // Loops: one full period later lands back on frame 0's content.
      expect(sLoop.checksum, 't = totalUs loops back to frame 0').toBe(s0.checksum)
    } finally {
      await app.close()
    }
  })

  test('animated gif exports with motion (no proxy)', async () => {
    test.setTimeout(180000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-gif-export-' + Date.now(),
        canvas: { width: 640, height: 480, fpsNum: 15, fpsDen: 1 },
      })
      await importAndPlaceMedia(page, { mediaAbsPath: GIF, tStartUs: 0 })

      const outPath = path.resolve(PROJECT_PARENT, `gif-export-${Date.now()}.mp4`)
      await page.evaluate(
        (out) => (window as any).__weftcutTest.exportTimeline({ outputAbsPath: out }),
        outPath,
      )
      expect(existsSync(outPath), 'export produced a file').toBe(true)

      // Per-frame md5s: a static export would repeat one hash; an animated one
      // has at least two distinct frames.
      const md5s = execFileSync(FFMPEG, ['-i', outPath, '-f', 'framemd5', '-'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.trim().split(/[, ]+/).pop())
        .filter(Boolean)
      expect(md5s.length, 'export has multiple frames').toBeGreaterThan(1)
      expect(new Set(md5s).size, 'exported gif shows motion (distinct frames)').toBeGreaterThan(1)
      void FFPROBE // reserved for an optional duration assertion
    } finally {
      await app.close()
    }
  })
})
