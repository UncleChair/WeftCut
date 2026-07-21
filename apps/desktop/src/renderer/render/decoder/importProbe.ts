// E2E-only investigation probe for GitHub issue #7 boundary #1: a HARDWARE-
// decoded (GPU-backed) `VideoFrame` drawn into a 2D canvas is a silent no-op on
// Linux/NVIDIA-GL → black export frames (the `preferSoftware` workaround at
// exportWorker.ts). Web research (Chromium graphics-dev: accelerated 2D canvas
// is blacklisted on Linux; iOS16 Safari: video→2D-canvas went black on the GPU
// path, forcing software fixed it; WebKit "painting a VideoFrame in a canvas
// does nothing") points at the 2D-canvas GL import being the broken path, while
// WebGL `texImage2D` / `createImageBitmap` are the *supported* GPU-import paths.
// The preview lane already goes VideoFrame → `createImageBitmap` → drawImage and
// is HW-verified green on this host.
//
// This probe decodes the first frame of a clip TWICE (prefer-hardware and
// prefer-software) and, for each, tries all three import paths, reading pixels
// back and reporting mean luma + non-zero coverage. A black import reads ~0; a
// faithful one reads the clip's real luma. Run in both the renderer main thread
// AND a dedicated Worker (the export bug's actual context) via
// `importProbe.worker.ts`. Imported only from the e2e hook surface, so prod
// bundles tree-shake it out.
//
// Decisive matrix: {main, worker} × {hardware, software} × {drawImage,
// createImageBitmap, texImage2D}. If worker+hardware+drawImage is the ONLY black
// cell, the fix is to route the export snapshot through the surviving path.

import { openMediaInput } from "./mediaInput";

/// Downscale readback dims. Cheap, and the mean-luma signal is dimension
/// independent — a black frame reads ~0 at any size, a real one reads its luma.
const RB_W = 320;
const RB_H = 180;
/// Luma above this counts a pixel as "lit" for the coverage stat.
const LIT_THRESHOLD = 8;

export interface MethodResult {
  /// Mean luma over the read-back region, 0..255. Black import ≈ 0.
  meanLuma: number;
  /// Percentage of pixels with luma > LIT_THRESHOLD. Black import ≈ 0%.
  litPct: number;
  /// Non-null if this import path threw (kept isolated so one failure doesn't
  /// mask the others).
  error: string | null;
}

export interface DecodeProbeResult {
  /// The `hardwareAcceleration` hint we asked the decoder for.
  hwAccel: "prefer-hardware" | "prefer-software";
  /// `VideoDecoder.isConfigSupported` verdict for that hint (was HW even
  /// available? — a false here on prefer-hardware means Chromium would fall to
  /// software regardless, so a "black" reading would be meaningless).
  isConfigSupported: boolean;
  /// `frame.format` the decoder stamped (NV12 / I420 / RGBA / …). null if the
  /// probe failed before a frame arrived.
  frameFormat: string | null;
  drawImage: MethodResult;
  createImageBitmap: MethodResult;
  texImage2D: MethodResult;
  /// Path D — `VideoFrame.copyTo()` (the decoder's own GPU→CPU plane readback).
  /// If the canvas/GL import paths are all black but copyTo returns real pixels,
  /// the Linux HW export unlock is "HW-decode → copyTo → upload the CPU buffer"
  /// (the shape the native NV12 ingest already uses).
  copyTo: MethodResult;
  /// Non-null if the decode itself failed (no frame to probe).
  error: string | null;
}

export interface BothModesResult {
  hardware: DecodeProbeResult;
  software: DecodeProbeResult;
}

function emptyMethod(): MethodResult {
  return { meanLuma: 0, litPct: 0, error: "not run" };
}

/// Compute mean luma + lit coverage over an RGBA byte buffer.
function statsFromRGBA(data: Uint8Array | Uint8ClampedArray): {
  meanLuma: number;
  litPct: number;
} {
  const n = data.length / 4;
  if (n === 0) return { meanLuma: 0, litPct: 0 };
  let sum = 0;
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    sum += luma;
    if (luma > LIT_THRESHOLD) lit++;
  }
  return { meanLuma: sum / n, litPct: (lit / n) * 100 };
}

async function runMethod(fn: () => Promise<{ meanLuma: number; litPct: number }>): Promise<MethodResult> {
  try {
    const s = await fn();
    return { meanLuma: s.meanLuma, litPct: s.litPct, error: null };
  } catch (e) {
    return { meanLuma: 0, litPct: 0, error: String(e) };
  }
}

/// Path A — the export lane's current path: draw the raw VideoFrame straight
/// into a 2D canvas, then read pixels back. This is the one observed black on
/// Linux/NVIDIA-GL under hardware decode.
async function methodDrawImage(frame: VideoFrame): Promise<{ meanLuma: number; litPct: number }> {
  const canvas = new OffscreenCanvas(RB_W, RB_H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(frame, 0, 0, RB_W, RB_H);
  return statsFromRGBA(ctx.getImageData(0, 0, RB_W, RB_H).data);
}

/// Path B — the preview lane's path: VideoFrame → createImageBitmap → drawImage.
/// createImageBitmap is one of Chromium's supported GPU-import entry points and
/// may resolve the frame's pixels where a direct 2D drawImage cannot.
async function methodCreateImageBitmap(frame: VideoFrame): Promise<{ meanLuma: number; litPct: number }> {
  const bmp = await createImageBitmap(frame);
  try {
    const canvas = new OffscreenCanvas(RB_W, RB_H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bmp, 0, 0, RB_W, RB_H);
    return statsFromRGBA(ctx.getImageData(0, 0, RB_W, RB_H).data);
  } finally {
    bmp.close();
  }
}

/// Path C — the WebGL zero-copy-ish path: upload the VideoFrame straight into a
/// GL texture via texImage2D and read it back. WebGL is the GPU-import path
/// Chromium keeps working on Linux (mandatory context-loss recovery), so this is
/// the candidate that could keep HW decode AND render correctly.
async function methodTexImage2D(frame: VideoFrame): Promise<{ meanLuma: number; litPct: number }> {
  const canvas = new OffscreenCanvas(RB_W, RB_H);
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("no webgl2 context");

  const vsSrc = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
  const fsSrc = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D tex;
out vec4 outColor;
void main() {
  outColor = texture(tex, uv);
}`;

  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (!sh) throw new Error("createShader failed");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("shader compile: " + log);
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram failed");
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error("program link: " + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  // Full-clip-space quad (two triangles).
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // The overload that takes a TexImageSource (VideoFrame is one at runtime; the
  // DOM lib's union may lag, so cast).
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    frame as unknown as TexImageSource,
  );
  const uploadErr = gl.getError();
  if (uploadErr !== gl.NO_ERROR) throw new Error("texImage2D glError " + uploadErr);

  gl.uniform1i(gl.getUniformLocation(prog, "tex"), 0);
  gl.viewport(0, 0, RB_W, RB_H);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  const px = new Uint8Array(RB_W * RB_H * 4);
  gl.readPixels(0, 0, RB_W, RB_H, gl.RGBA, gl.UNSIGNED_BYTE, px);

  gl.deleteTexture(tex);
  gl.deleteBuffer(buf);
  gl.deleteProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return statsFromRGBA(px);
}

/// Path D — copy the frame's planes to a CPU buffer via the WebCodecs
/// `copyTo()` readback, then compute luma from the copied bytes (format-aware:
/// Y plane for YUV, channel mix for RGB/BGR). Real pixels → non-zero; an opaque
/// HW handle that can't be read back → all zero (or copyTo throws).
async function methodCopyTo(frame: VideoFrame): Promise<{ meanLuma: number; litPct: number }> {
  const fmt = frame.format;
  if (!fmt) throw new Error("frame has no format");
  const w = frame.codedWidth;
  const h = frame.codedHeight;
  const size = frame.allocationSize();
  const buf = new Uint8Array(size);
  const layout = await frame.copyTo(buf);
  const p0 = layout[0];
  if (!p0) throw new Error("copyTo returned no plane layout");

  let sum = 0;
  let lit = 0;
  let count = 0;
  if (fmt.startsWith("I4") || fmt.startsWith("NV")) {
    // Plane 0 is the luma (Y) plane.
    for (let y = 0; y < h; y++) {
      const row = p0.offset + y * p0.stride;
      for (let x = 0; x < w; x++) {
        const Y = buf[row + x]!;
        sum += Y;
        if (Y > LIT_THRESHOLD) lit++;
        count++;
      }
    }
  } else if (fmt.startsWith("RGB") || fmt.startsWith("BGR")) {
    const bgr = fmt.startsWith("BGR");
    for (let y = 0; y < h; y++) {
      const row = p0.offset + y * p0.stride;
      for (let x = 0; x < w; x++) {
        const o = row + x * 4;
        const c0 = buf[o]!;
        const c1 = buf[o + 1]!;
        const c2 = buf[o + 2]!;
        const R = bgr ? c2 : c0;
        const G = c1;
        const B = bgr ? c0 : c2;
        const Y = 0.299 * R + 0.587 * G + 0.114 * B;
        sum += Y;
        if (Y > LIT_THRESHOLD) lit++;
        count++;
      }
    }
  } else {
    // Unknown format: whole-buffer liveness (zero vs non-zero) as a fallback.
    for (let i = 0; i < buf.length; i++) {
      sum += buf[i]!;
      if (buf[i]! > LIT_THRESHOLD) lit++;
      count++;
    }
  }
  return { meanLuma: sum / Math.max(1, count), litPct: (lit / Math.max(1, count)) * 100 };
}

/// Decode the first frame of `assetUrl` under a fixed `hwAccel` hint. Feeds from
/// the opening keyframe and flushes so a frame is guaranteed to emerge; resolves
/// with the FIRST output frame. Caller owns closing the frame.
function decodeFirstFrame(
  opened: Awaited<ReturnType<typeof openMediaInput>>,
  config: VideoDecoderConfig,
  hwAccel: "prefer-hardware" | "prefer-software",
): Promise<VideoFrame> {
  return new Promise<VideoFrame>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (settled) {
          frame.close();
          return;
        }
        finish(() => resolve(frame));
        try {
          decoder.close();
        } catch {
          // already closing
        }
      },
      error: (e: unknown) => {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      },
    });
    decoder.configure({ ...config, hardwareAcceleration: hwAccel });

    const timer = setTimeout(() => {
      finish(() => reject(new Error("decodeFirstFrame: no frame within 20s")));
    }, 20_000);

    void (async () => {
      try {
        let pkt = await opened.packetSink.getFirstPacket();
        let n = 0;
        while (pkt && n < 30 && !settled) {
          decoder.decode(pkt.toEncodedVideoChunk());
          n++;
          pkt = await opened.packetSink.getNextPacket(pkt);
        }
        if (!settled) await decoder.flush().catch(() => {});
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      } finally {
        clearTimeout(timer);
      }
    })();
  });
}

async function probeOneDecode(
  assetUrl: string,
  hwAccel: "prefer-hardware" | "prefer-software",
): Promise<DecodeProbeResult> {
  const result: DecodeProbeResult = {
    hwAccel,
    isConfigSupported: false,
    frameFormat: null,
    drawImage: emptyMethod(),
    createImageBitmap: emptyMethod(),
    texImage2D: emptyMethod(),
    copyTo: emptyMethod(),
    error: null,
  };
  let opened: Awaited<ReturnType<typeof openMediaInput>> | null = null;
  let frame: VideoFrame | null = null;
  try {
    opened = await openMediaInput(assetUrl);
    const config = await opened.videoTrack.getDecoderConfig();
    if (!config) throw new Error("no decoder config");
    try {
      const s = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: hwAccel });
      result.isConfigSupported = !!s.supported;
    } catch {
      // isConfigSupported can throw on some configs; leave false.
    }
    frame = await decodeFirstFrame(opened, config, hwAccel);
    result.frameFormat = frame.format ?? null;
    // Same frame, three import paths — none of these consume/close it.
    result.drawImage = await runMethod(() => methodDrawImage(frame!));
    result.createImageBitmap = await runMethod(() => methodCreateImageBitmap(frame!));
    result.texImage2D = await runMethod(() => methodTexImage2D(frame!));
    result.copyTo = await runMethod(() => methodCopyTo(frame!));
  } catch (e) {
    result.error = String(e);
  } finally {
    try {
      frame?.close();
    } catch {
      // already closed
    }
    opened?.dispose();
  }
  return result;
}

/// Probe both hardware and software decode for one clip. Sequential (not
/// parallel) so the two decoders never contend for the same GPU decode slots.
export async function probeBothModes(assetUrl: string): Promise<BothModesResult> {
  const hardware = await probeOneDecode(assetUrl, "prefer-hardware");
  const software = await probeOneDecode(assetUrl, "prefer-software");
  return { hardware, software };
}
