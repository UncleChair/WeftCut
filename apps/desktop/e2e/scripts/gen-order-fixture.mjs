// Generate the index-encoded, B-frame HEVC clip that the ffmpeg engine's
// hardware-lane frame-CONTENT-order guard (electron/preview-gpu-order.spec.ts)
// decodes.
//
// Each presentation frame N carries a 12-stripe binary barcode of N (stripe b
// white iff bit b of N is set), rendered at 192x108 (fast per-pixel `geq`) then
// nearest-upscaled x6 to 1152x648 so the DECODE path sees a realistic-size
// frame while the stripes stay crisp. Neutral chroma (cb=cr=128) + full-height
// black/white stripes survive NV12 4:2:0 + limited→full-range YUV→RGB, so the
// barcode is machine-readable after the full GPU decode→import→createImageBitmap
// path. A deterministic B-frame GOP (keyint=48, bframes=4, b-adapt=0) makes
// decode order ≠ display order — the reorder-prone case.
//
// Idempotent: skips if the output already exists (mirrors
// gen-decode-bench-fixtures.mjs). Needs an ffmpeg on PATH with libx265.
//
//   node e2e/scripts/gen-order-fixture.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../fixtures/decode-bench/order-hevc-648.mp4')
const FFMPEG = process.env.FFMPEG || 'ffmpeg'

if (existsSync(OUT)) {
  console.log(`order fixture already present: ${OUT}`)
  process.exit(0)
}
mkdirSync(path.dirname(OUT), { recursive: true })

// stripe b (0=LSB) at low-res columns [16b, 16b+16); white iff bit b of N set.
const lum = "255*gte(bitand(N\\,pow(2\\,floor(X/16)))\\,1)"
const vf = `geq=lum='${lum}':cb=128:cr=128,scale=1152:648:flags=neighbor,format=yuv420p`

const r = spawnSync(
  FFMPEG,
  [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=192x108:r=30:d=10',
    '-vf', vf,
    '-c:v', 'libx265',
    '-x265-params', 'keyint=48:min-keyint=48:bframes=4:b-adapt=0:log-level=none',
    '-tag:v', 'hvc1',
    OUT,
  ],
  { encoding: 'utf8', stdio: 'inherit' },
)
if (r.status !== 0) {
  console.error(`ffmpeg failed (status ${r.status}) — is libx265 available in this build?`)
  process.exit(1)
}
console.log(`generated ${OUT}`)
