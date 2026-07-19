import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { launchApp, tmpDir } from './helpers/driver'

test('weftcut-media:// serves a local file with Range', async () => {
  // A 256-byte file of known content.
  const tmp = path.join(tmpDir('wc-proto-'), 'payload.bin')
  const buf = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) buf[i] = i
  fs.writeFileSync(tmp, buf)

  const { app, page } = await launchApp()

  const url = `weftcut-media://localhost/${encodeURIComponent(tmp)}`
  const result = await page.evaluate(async (u) => {
    const res = await fetch(u, { headers: { Range: 'bytes=10-19' } })
    const ab = await res.arrayBuffer()
    return {
      status: res.status,
      contentRange: res.headers.get('Content-Range'),
      bytes: Array.from(new Uint8Array(ab)),
    }
  }, url)

  expect(result.status).toBe(206)
  expect(result.contentRange).toBe('bytes 10-19/256')
  expect(result.bytes).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

  await app.close()
})
