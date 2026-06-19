import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'

function gray(png) {
  const { width, height, data } = png
  const out = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }
  return { g: out, width, height }
}

// Global SSIM (single window over the whole image). Sufficient for a
// same-engine software-render comparison; returns 1.0 for identical inputs.
export function ssimOfPngFiles(pathA, pathB) {
  const a = gray(PNG.sync.read(readFileSync(pathA)))
  const b = gray(PNG.sync.read(readFileSync(pathB)))
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const n = a.g.length
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a.g[i]; mb += b.g[i] }
  ma /= n; mb /= n
  let va = 0, vb = 0, cov = 0
  for (let i = 0; i < n; i++) {
    const da = a.g[i] - ma, db = b.g[i] - mb
    va += da * da; vb += db * db; cov += da * db
  }
  va /= n - 1; vb /= n - 1; cov /= n - 1
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
}
