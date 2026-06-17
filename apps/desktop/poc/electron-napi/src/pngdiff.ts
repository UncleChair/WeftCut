import { PNG } from 'pngjs'

export interface PngDiff { maxChannelDiff: number; pctPixelsDiffering: number }

export function pngDiff(a: Buffer, b: Buffer): PngDiff {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  const n = Math.min(pa.data.length, pb.data.length)
  let maxChannelDiff = 0
  let differingPixels = 0
  const totalPixels = Math.min(pa.width * pa.height, pb.width * pb.height)
  for (let i = 0; i < n; i += 4) {
    let pixelDiff = 0
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(pa.data[i + c] - pb.data[i + c])
      if (d > maxChannelDiff) maxChannelDiff = d
      if (d > pixelDiff) pixelDiff = d
    }
    if (pixelDiff > 8) differingPixels++
  }
  return { maxChannelDiff, pctPixelsDiffering: (differingPixels / totalPixels) * 100 }
}

export function hasAlpha(png: Buffer): boolean {
  const p = PNG.sync.read(png)
  for (let i = 3; i < p.data.length; i += 4) {
    if (p.data[i] < 255) return true
  }
  return false
}
