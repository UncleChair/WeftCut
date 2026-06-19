// DIAGNOSTIC bench (not a CI gate): compares 10-bit export frame-transport
// throughput across native Electron IPC vs the loopback WebSocket. Run manually:
//   npx playwright test transport_bench -c playwright.config.ts
// Flip RES to '4k' to stress per-frame copy cost when 1080p can't separate them.
import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { launchApp } from './helpers/driver'

const RES: '1080p' | '4k' = '1080p'
const DIMS = RES === '4k' ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 }
const FRAME_BYTES = DIMS.w * DIMS.h * 3 // yuv420p10le @ 4:2:0
const N_THROUGHPUT = 90 // frames for the discard (transport-only) runs
const N_ENCODE = 30 // frames for the software-encode correctness run

function mbps(bytes: number, ms: number): number {
  return Math.round(bytes / 1048576 / (ms / 1000))
}

function probe(file: string, entries: string): Record<string, string> {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', `stream=${entries}`,
     '-of', 'default=nw=1', file],
    { encoding: 'utf8' },
  )
  if (r.error) throw new Error('ffprobe not on PATH: ' + r.error.message)
  if (r.status !== 0) throw new Error('ffprobe failed: ' + r.stderr)
  const out: Record<string, string> = {}
  for (const line of r.stdout.trim().split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

// Push N synthetic frames through the invoke transport against an already-started
// sink, timed first-send -> all-acked. Runs entirely in the renderer.
async function pushInvoke(page: import('@playwright/test').Page, frameBytes: number, n: number) {
  return page.evaluate(
    async ({ frameBytes, n }) => {
      const api = (window as any).api
      const payload = new Uint8Array(frameBytes)
      for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff
      const t0 = performance.now()
      for (let i = 0; i < n; i++) {
        // Copy per send so the transferred/cloned buffer is independent.
        await api.videoSinkWrite(payload.slice().buffer)
      }
      return { ms: Math.round(performance.now() - t0) }
    },
    { frameBytes, n },
  )
}

// Push N frames over a loopback WebSocket against a discard-mode sink, timed
// first-send -> bufferedAmount==0. Mirrors the shipping VideoSinkClient protocol
// (token text frame first, then binary frames, close 1000).
async function pushWs(
  page: import('@playwright/test').Page,
  port: number, token: string, frameBytes: number, n: number,
) {
  return page.evaluate(
    async ({ port, token, frameBytes, n }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.binaryType = 'arraybuffer'
      await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws connect')) })
      ws.send(token)
      const payload = new Uint8Array(frameBytes)
      for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff
      const HIGH_WATER = 32 * 1024 * 1024
      const t0 = performance.now()
      for (let i = 0; i < n; i++) {
        while (ws.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 2))
        ws.send(payload)
      }
      while (ws.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 2))
      const ms = Math.round(performance.now() - t0)
      ws.close(1000)
      return { ms }
    },
    { port, token, frameBytes, n },
  )
}

const startArgs = (mode: string, outputPath: string, software: boolean) => ({
  mode, width: DIMS.w, height: DIMS.h, fpsNum: 30, fpsDen: 1,
  codec: 'hevc', bitrate: 0, cbr: false, gop: 30, software, outputPath,
})

test.describe('10-bit export transport bench (diagnostic)', () => {
  test.setTimeout(600_000)

  test('invoke transport: discard throughput + software-encode correctness', async () => {
    const { app, page } = await launchApp()
    try {
      // --- A) discard: pure transport throughput (no ffmpeg) ---
      const startA = await page.evaluate(
        (args) => (window as any).api.invoke('export_video_sink_start', { args }),
        startArgs('ipc', '', false),
      )
      expect(startA).toBeTruthy()
      const pa = await pushInvoke(page, FRAME_BYTES, N_THROUGHPUT)
      const finA = await page.evaluate(() =>
        (window as any).api.invoke('export_video_sink_finish'),
      ) as { bytes: number; frames: number; elapsedMs: number }
      expect(finA.frames).toBe(N_THROUGHPUT)
      expect(finA.bytes).toBe(FRAME_BYTES * N_THROUGHPUT)
      const invokeDiscardMbps = mbps(FRAME_BYTES * N_THROUGHPUT, pa.ms)
      console.log(`[bench] invoke/discard ${RES}: ${invokeDiscardMbps} MB/s (send ${pa.ms}ms, ${finA.frames} frames)`)

      // --- B) encode: real software (libx265 Main10) 10-bit file for correctness ---
      const out = path.join(os.tmpdir(), `wc_bench_invoke_${Date.now()}.mp4`)
      const startB = await page.evaluate(
        (args) => (window as any).api.invoke('export_video_sink_start', { args }),
        startArgs('ipc', out, true),
      )
      expect(startB).toBeTruthy()
      const pb = await pushInvoke(page, FRAME_BYTES, N_ENCODE)
      const finB = await page.evaluate(() =>
        (window as any).api.invoke('export_video_sink_finish'),
      ) as { bytes: number; frames: number; elapsedMs: number }
      expect(finB.frames).toBe(N_ENCODE)
      expect(finB.bytes).toBe(FRAME_BYTES * N_ENCODE)
      console.log(`[bench] invoke/encode ${RES}: send ${pb.ms}ms, sink ${finB.elapsedMs}ms`)

      // Correctness: the IPC byte path produced a valid 10-bit HEVC file.
      try {
        const st = probe(out, 'codec_name,pix_fmt,profile')
        console.log('[bench] invoke/encode output stream:', JSON.stringify(st))
        expect(st.codec_name).toBe('hevc')
        expect(['yuv420p10le', 'p010le']).toContain(st.pix_fmt)
        expect(st.profile).toContain('Main 10')
      } finally {
        fs.rmSync(out, { force: true })
      }
    } finally {
      await app.close()
    }
  })

  test('compare: invoke vs WebSocket (discard throughput)', async () => {
    const { app, page } = await launchApp()
    try {
      // invoke/discard
      await page.evaluate((args) => (window as any).api.invoke('export_video_sink_start', { args }), startArgs('ipc', '', false))
      const invoke = await pushInvoke(page, FRAME_BYTES, N_THROUGHPUT)
      const invokeFin = await page.evaluate(() => (window as any).api.invoke('export_video_sink_finish')) as { frames: number }
      expect(invokeFin.frames).toBe(N_THROUGHPUT)
      const invokeMbps = mbps(FRAME_BYTES * N_THROUGHPUT, invoke.ms)

      // WS/discard (existing "discard" mode = WS transport, no ffmpeg)
      const wsStart = await page.evaluate((args) => (window as any).api.invoke('export_video_sink_start', { args }), startArgs('discard', '', false)) as { port: number; token: string }
      const ws = await pushWs(page, wsStart.port, wsStart.token, FRAME_BYTES, N_THROUGHPUT)
      const wsFin = await page.evaluate(() => (window as any).api.invoke('export_video_sink_finish')) as { frames: number }
      expect(wsFin.frames).toBe(N_THROUGHPUT)
      const wsMbps = mbps(FRAME_BYTES * N_THROUGHPUT, ws.ms)

      const ratio = (invokeMbps / wsMbps).toFixed(2)
      console.log('\n===== 10-bit transport bench (' + RES + ', ' + N_THROUGHPUT + ' frames, ' + (FRAME_BYTES / 1048576).toFixed(1) + ' MB/frame) =====')
      console.log('  invoke (ipc) : ' + invokeMbps + ' MB/s  (' + invoke.ms + ' ms)')
      console.log('  websocket    : ' + wsMbps + ' MB/s  (' + ws.ms + ' ms)')
      console.log('  invoke/WS    : ' + ratio + '×')
      const floorFps = invokeMbps / (FRAME_BYTES / 1048576)
      console.log('  invoke supports ~' + Math.round(floorFps) + ' fps @ ' + RES)
      console.log('  GO if invoke >= WS or invoke >= offline need (~' + Math.round(wsMbps / (FRAME_BYTES / 1048576)) + ' fps reference)')
      console.log('================================================================\n')
      // Diagnostic only: never fail on the comparison itself.
      expect(invokeMbps).toBeGreaterThan(0)
      expect(wsMbps).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })
})
