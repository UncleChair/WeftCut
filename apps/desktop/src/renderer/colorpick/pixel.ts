// CPU-side sampling math for the color-pick session. Pure — the overlay and
// the preview sampler both build on these, so every coordinate rule is
// testable without a renderer. Spec:
// docs/features.md#color-picker-eyedropper

export interface FrameBuffer {
  pixels: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/// Clamped single-pixel read → "#rrggbb". Alpha is deliberately ignored
/// (design: samples take RGB; transparent regions show whatever the buffer holds).
export function sampleHex(buf: FrameBuffer, x: number, y: number): string {
  const px = Math.max(0, Math.min(buf.width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(buf.height - 1, Math.floor(y)));
  const i = (py * buf.width + px) * 4;
  return rgbToHex(buf.pixels[i] ?? 0, buf.pixels[i + 1] ?? 0, buf.pixels[i + 2] ?? 0);
}

/// (2·radius+1)² patch around (cx,cy) for the magnifier, edge-clamped so the
/// cursor can ride the buffer border without the patch shrinking.
export function samplePatch(buf: FrameBuffer, cx: number, cy: number, radius: number): FrameBuffer {
  const size = radius * 2 + 1;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const sx = Math.max(0, Math.min(buf.width - 1, Math.floor(cx) + dx));
      const sy = Math.max(0, Math.min(buf.height - 1, Math.floor(cy) + dy));
      const si = (sy * buf.width + sx) * 4;
      const di = ((dy + radius) * size + (dx + radius)) * 4;
      out[di] = buf.pixels[si] ?? 0;
      out[di + 1] = buf.pixels[si + 1] ?? 0;
      out[di + 2] = buf.pixels[si + 2] ?? 0;
      out[di + 3] = 255;
    }
  }
  return { pixels: out, width: size, height: size };
}

/// `object-fit: contain` inverse: client point → content pixel, or null when
/// the point lands in the letterbox bars (not content) or the rect is degenerate.
export function containMap(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  contentW: number,
  contentH: number,
): { x: number; y: number } | null {
  const scale = Math.min(rect.width / contentW, rect.height / contentH);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offX = rect.left + (rect.width - contentW * scale) / 2;
  const offY = rect.top + (rect.height - contentH * scale) / 2;
  const x = Math.floor((clientX - offX) / scale);
  const y = Math.floor((clientY - offY) / scale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= contentW || y >= contentH) return null;
  return { x, y };
}
