// Deterministic media-fixture producer. This is intentionally dependency-free:
// Node writes the small source charts/manifests and ffmpeg produces the media.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const WIDTH = 1920
const HEIGHT = 1080
const DURATION_SECONDS = 10
const AUDIO_BASE_HZ = 400
const AUDIO_STEP_HZ = 120
const AUDIO_SAMPLE_RATE = 48_000

const PATCH_VALUES = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255],
  [255, 255, 0], [255, 255, 255], [0, 0, 0], [16, 16, 16], [235, 235, 235],
  [128, 128, 128], [64, 64, 64], [192, 192, 192], [255, 128, 0], [128, 0, 255],
  [200, 150, 120], [30, 60, 90], [120, 200, 60], [245, 245, 245], [10, 10, 10],
]

const PATCH_IDS = [
  'red', 'green', 'blue', 'cyan', 'magenta',
  'yellow', 'white', 'black', 'near_black_16', 'near_white_235',
  'gray_128', 'gray_64', 'gray_192', 'orange', 'violet',
  'skin', 'navy', 'lime', 'near_white_245', 'near_black_10',
]

const COLOR_ENCODINGS = {
  '709ltd': {
    matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'tv', outputRange: 'tv',
  },
  '601ltd': {
    matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', range: 'tv', outputRange: 'tv',
  },
  '709full': {
    matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'pc', outputRange: 'pc',
  },
  '601full': {
    matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', range: 'pc', outputRange: 'pc',
  },
}

const GRADIENT_FILTER = "format=yuv420p10le,geq=lum='(X/(W-1))*1023':cb=512:cr=512,scale=out_color_matrix=bt709:out_range=tv"
const COLOR_TAGS = [
  '-colorspace', 'bt709',
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-color_range', 'tv',
]

export function outputName({
  fps,
  format,
  audio,
  color,
  colorProres,
  colorProresEnc,
  gradient,
  gradientH264,
  gradientH264Bf,
  gradientAv1,
  gradientH2644k,
  eostail,
  imageset,
  audiotones,
  aformat,
  audioTiming,
  audioTimingLong,
  ptsOffsetMs,
}) {
  if (imageset) return 'test_chart_320x240.png'
  if (audiotones) return `test_tones_10s.${aformat ?? 'wav'}`
  if (audioTiming) {
    const offsetMs = ptsOffsetMs ?? 0
    return offsetMs === 0
      ? 'test_audio_timing_zero_pts.mkv'
      : `test_audio_timing_offset_${offsetMs}ms.mkv`
  }
  if (audioTimingLong) return 'test_audio_timing_long_125s.mkv'
  if (color) return `test_1080p_color_${color}.mp4`
  if (colorProres) return `test_1080p_color_${colorProresEnc ?? '709ltd'}_prores.mov`
  if (gradient) return 'test_1080p_gradient10.mp4'
  if (gradientH264) return 'test_1080p_gradient10_h264.mp4'
  if (gradientH264Bf) return 'test_1080p_gradient10_h264_bf.mp4'
  if (gradientAv1) return 'test_1080p_gradient10_av1.mp4'
  if (gradientH2644k) return 'test_2160p_gradient10_h264.mp4'
  const container = format ?? 'mp4'
  if (container === 'prores') return `test_1080p_${fps}fps_prores.mov`
  if (eostail) return `test_1080p_${fps}fps_eostail.${container}`
  if (audio) return `test_1080p_${fps}fps_audio.${container}`
  return `test_1080p_${fps}fps.${container}`
}

export function colorPatches(width, height) {
  const columns = 5
  const rows = 4
  const cellWidth = Math.floor(width / columns)
  const cellHeight = Math.floor(height / rows)

  return PATCH_IDS.map((id, index) => ({
    id,
    x: (index % columns) * cellWidth,
    y: Math.floor(index / columns) * cellHeight,
    w: cellWidth,
    h: cellHeight,
    rgb: PATCH_VALUES[index],
  }))
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBuffer.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return chunk
}

function encodeChartPng(width, height, patches) {
  // RGBA matches the Go image.RGBA source that this replaces.
  const bytesPerPixel = 4
  const stride = 1 + width * bytesPerPixel
  const raw = Buffer.alloc(stride * height)

  for (const patch of patches) {
    const [red, green, blue] = patch.rgb
    for (let y = patch.y; y < patch.y + patch.h; y += 1) {
      const rowStart = y * stride
      raw[rowStart] = 0 // PNG filter: None
      for (let x = patch.x; x < patch.x + patch.w; x += 1) {
        const offset = rowStart + 1 + x * bytesPerPixel
        raw[offset] = red
        raw[offset + 1] = green
        raw[offset + 2] = blue
        raw[offset + 3] = 255
      }
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND'),
  ])
}

/// Rename a uniquely-named temp sibling into place. POSIX rename is atomic, and
/// on Windows it also works for an absent dest — but Windows refuses to replace
/// a dest another process holds open. A dest that exists by then was published
/// through this same rename, so it is already complete and the redundant temp
/// can simply be dropped.
function renameIntoPlace(tempPath, destPath) {
  try {
    renameSync(tempPath, destPath)
  } catch (error) {
    if (!existsSync(destPath)) throw error
  } finally {
    rmSync(tempPath, { force: true })
  }
}

/// Write via a unique temp sibling + rename, so a racing (or crashing)
/// generator can never leave a torn file at the final path.
function writeFileAtomic(destPath, data) {
  const tempPath = `${destPath}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(tempPath, data)
  renameIntoPlace(tempPath, destPath)
}

function writeChartPng(outputDir, name, width, height) {
  const patches = colorPatches(width, height)
  writeFileAtomic(path.join(outputDir, name), encodeChartPng(width, height, patches))
  return patches
}

function writeManifest(outputDir, name, width, height, patches) {
  const manifest = { width, height, patches }
  writeFileAtomic(path.join(outputDir, name), `${JSON.stringify(manifest, null, 2)}\n`)
}

function writeColorChart(outputDir, width, height) {
  const patches = writeChartPng(outputDir, 'color_chart.png', width, height)
  writeManifest(outputDir, 'color_manifest.json', width, height, patches)
  return 'color_chart.png'
}

/// Run ffmpeg without a command shell. Keeping every argument separate is what
/// makes output directories and Windows paths safe when they contain spaces.
export function runFfmpeg(args, { cwd = process.cwd(), spawn = spawnSync } = {}) {
  const result = spawn('ffmpeg', args, {
    cwd,
    shell: false,
    stdio: 'inherit',
  })

  if (result.error) {
    throw new Error(`could not start ffmpeg: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0) {
    const suffix = result.signal ? `, signal ${result.signal}` : ''
    throw new Error(`ffmpeg failed (exit ${result.status ?? 'unknown'}${suffix})`)
  }
}

/// Pick the AV1 encoder the ffmpeg on PATH actually ships. SVT-AV1 is the
/// preferred 10-bit AV1 encoder, but lean builds may lack it (the old macOS
/// evermeet sidecar had none; the pinned martin-riedl arm64 build ships it) —
/// fall back to libaom-av1 in constant-quality mode. Either produces the same
/// AV1 10-bit ramp shape; the gates key on codec/depth, not the encoder.
/// Probed once per process.
let av1EncoderCache
function pickAv1Encoder({ spawn = spawnSync } = {}) {
  if (av1EncoderCache) return av1EncoderCache
  const probe = spawn('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  const encoders = probe.error ? '' : String(probe.stdout)
  av1EncoderCache = /\blibsvtav1\b/.test(encoders)
    ? {
        codec: 'libsvtav1',
        args: ['-preset', '6', '-crf', '18'],
        description: '10-bit BT.709 gradient, AV1 10-bit SVT-AV1',
      }
    : {
        codec: 'libaom-av1',
        args: ['-crf', '18', '-b:v', '0', '-cpu-used', '4'],
        description: '10-bit BT.709 gradient, AV1 10-bit (libaom-av1 fallback)',
      }
  return av1EncoderCache
}

/// Wrap `run` so every recipe publishes its output atomically: the output file
/// (always the last ffmpeg argument) is redirected to a unique temp sibling and
/// renamed into place only after a successful run. Parallel generators then
/// never see a torn media file at the final name; a crash just leaks the
/// uniquely-named temp next to it, which is harmless.
function atomicOutputs(run, outputDir) {
  return (args, options = {}) => {
    const cwd = options.cwd ?? outputDir
    const output = args.at(-1)
    // Keep the original extension LAST: ffmpeg picks the output muxer from the
    // filename extension, so the unique marker has to go before it (a bare
    // `foo.mp4.tmp-…` suffix leaves ffmpeg unable to choose a format).
    const ext = path.extname(output)
    const temp = `${output.slice(0, output.length - ext.length)}.tmp-${process.pid}-${randomUUID()}${ext}`
    run([...args.slice(0, -1), temp], options)
    renameIntoPlace(path.join(cwd, temp), path.join(cwd, output))
  }
}

function escapeDrawtextPath(fontPath) {
  return fontPath
    .replaceAll('\\', '/')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
}

/// Return an ffmpeg-drawtext-safe monospace font path for each desktop OS.
/// WINDIR/SystemRoot is respected so Windows is not assumed to live on C:.
export function drawtextFontFile({
  platform = process.platform,
  env = process.env,
  fileExists = existsSync,
} = {}) {
  let candidates
  if (platform === 'win32') {
    const windowsDir = env.WINDIR || env.SystemRoot || String.raw`C:\Windows`
    candidates = [
      path.win32.join(windowsDir, 'Fonts', 'consola.ttf'),
      path.win32.join(windowsDir, 'Fonts', 'cour.ttf'),
    ]
  } else if (platform === 'darwin') {
    candidates = [
      '/System/Library/Fonts/Menlo.ttc',
      '/System/Library/Fonts/Monaco.ttf',
      '/Library/Fonts/Courier New.ttf',
    ]
  } else {
    candidates = [
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
      '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
      '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
    ]
  }

  return escapeDrawtextPath(candidates.find(fileExists) ?? candidates[0])
}

function appendToneInputs(args, seconds, startAt = 0) {
  for (let index = 0; index < seconds; index += 1) {
    const frequency = AUDIO_BASE_HZ + AUDIO_STEP_HZ * index
    args.push(
      '-f', 'lavfi', '-i',
      `sine=frequency=${frequency}:duration=1:sample_rate=${AUDIO_SAMPLE_RATE}`,
    )
  }
  return Array.from({ length: seconds }, (_, index) => `[${index + startAt}:a]`).join('')
}

function generateImageSet(outputDir, run) {
  const width = 320
  const height = 240
  const base = `test_chart_${width}x${height}`
  const patches = writeChartPng(outputDir, `${base}.png`, width, height)
  writeManifest(outputDir, `${base}_manifest.json`, width, height, patches)

  const conversions = [
    ['-q:v', '2', `${base}.jpg`],
    ['-c:v', 'libwebp', '-lossless', '1', `${base}.webp`],
    [`${base}.bmp`],
    [`${base}.tiff`],
    [`${base}.gif`],
  ]
  for (const conversion of conversions) {
    run(
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', `${base}.png`, ...conversion],
      { cwd: outputDir },
    )
  }
  console.log('Done: still-image chart set')
}

function generateAudioTones(entry, outputDir, run) {
  const seconds = 10
  const format = entry.aformat ?? 'wav'
  const output = `test_tones_${seconds}s.${format}`
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  const concatInputs = appendToneInputs(args, seconds)
  const withCover = format === 'mp3'
  // Unique per process: a racing generator's cleanup must not delete our input.
  const cover = `tones_cover_${process.pid}_${randomUUID()}.png`

  if (withCover) {
    writeChartPng(outputDir, cover, 320, 240)
    args.push('-i', cover)
  }
  args.push(
    '-filter_complex', `${concatInputs}concat=n=${seconds}:v=0:a=1[a]`,
    '-map', '[a]',
  )

  switch (format) {
    case 'wav':
    case 'flac':
      break
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', '192k')
      break
    case 'm4a':
      args.push('-c:a', 'aac', '-b:a', '192k')
      break
    case 'ogg':
      args.push('-c:a', 'libvorbis', '-q:a', '5')
      break
    default:
      throw new Error(`unsupported --aformat ${JSON.stringify(format)} (wav|mp3|flac|m4a|ogg)`)
  }

  if (withCover) {
    args.push('-map', `${seconds}:v`, '-c:v', 'mjpeg', '-disposition:v', 'attached_pic')
  }
  args.push(output)

  console.log(`Generating ${output} (${seconds}s tone steps, audio-only)`)
  try {
    run(args, { cwd: outputDir })
  } finally {
    if (withCover) rmSync(path.join(outputDir, cover), { force: true })
  }
}

function timingAudioInputs(args, segments, firstInputIndex) {
  for (const segment of segments) {
    const duration = (segment.durationMs / 1000).toFixed(3)
    const source = segment.tone
      ? `sine=frequency=1000:sample_rate=${AUDIO_SAMPLE_RATE}:duration=${duration}`
      : `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=mono:d=${duration}`
    args.push('-f', 'lavfi', '-i', source)
  }
  return segments.map((_, index) => `[${index + firstInputIndex}:a]`).join('')
}

function generateAudioTiming(entry, outputDir, run) {
  const offsetMs = entry.ptsOffsetMs ?? 0
  if (!Number.isInteger(offsetMs) || offsetMs < 0) {
    throw new Error('--pts-offset-ms must be a non-negative integer')
  }
  const suffix = offsetMs === 0 ? 'zero_pts' : `offset_${offsetMs}ms`
  const output = `test_audio_timing_${suffix}.mkv`
  const segments = [
    { tone: false, durationMs: 1000 },
    { tone: true, durationMs: 250 },
    { tone: false, durationMs: 1750 },
    { tone: true, durationMs: 250 },
    { tone: false, durationMs: 1750 },
    { tone: true, durationMs: 250 },
    { tone: false, durationMs: 750 },
  ]
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x203040:size=320x180:rate=30:duration=6',
  ]
  const concatInputs = timingAudioInputs(args, segments, 1)
  args.push(
    '-filter_complex', `${concatInputs}concat=n=${segments.length}:v=0:a=1[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le',
  )
  if (offsetMs !== 0) args.push('-output_ts_offset', (offsetMs / 1000).toFixed(3))
  args.push('-shortest', output)

  console.log(`Generating ${output} (sound at 1s, 3s, 5s; PTS offset ${offsetMs}ms)`)
  run(args, { cwd: outputDir })
}

function generateLongAudioTiming(outputDir, run) {
  const duration = 125
  const output = 'test_audio_timing_long_125s.mkv'
  const segments = [
    { tone: false, durationMs: 5000 },
    { tone: true, durationMs: 500 },
    { tone: false, durationMs: 54_500 },
    { tone: true, durationMs: 500 },
    { tone: false, durationMs: 59_500 },
    { tone: true, durationMs: 500 },
    { tone: false, durationMs: 4500 },
  ]
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=0x203040:size=320x180:rate=1:duration=${duration}`,
  ]
  const concatInputs = timingAudioInputs(args, segments, 1)
  args.push(
    '-filter_complex', `${concatInputs}concat=n=${segments.length}:v=0:a=1[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-shortest', output,
  )

  console.log(`Generating ${output} (500ms sound islands at 5s, 60s, 120s)`)
  run(args, { cwd: outputDir })
}

function generateColor(entry, outputDir, run) {
  const encoding = COLOR_ENCODINGS[entry.color]
  if (!encoding) {
    throw new Error(`unknown --color ${JSON.stringify(entry.color)} (709ltd|601ltd|709full|601full)`)
  }
  const chart = writeColorChart(outputDir, WIDTH, HEIGHT)
  const output = outputName(entry)
  const filter = `format=rgb24,scale=out_color_matrix=${encoding.matrix}:out_range=${encoding.outputRange},format=yuv420p`
  const args = [
    '-y', '-loop', '1', '-i', chart, '-t', '1', '-r', '30',
    '-vf', filter, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
    '-colorspace', encoding.matrix,
    '-color_primaries', encoding.primaries,
    '-color_trc', encoding.transfer,
    '-color_range', encoding.range,
    '-an', output,
  ]

  console.log(`Generating ${output} (${entry.color})`)
  run(args, { cwd: outputDir })
  console.log(`Done: ${output}`)
}

function generateColorProres(entry, outputDir, run) {
  const encoding = entry.colorProresEnc ?? '709ltd'
  const matrix = encoding === '709ltd'
    ? 'bt709'
    : encoding === '601ltd'
      ? 'smpte170m'
      : undefined
  if (!matrix) {
    throw new Error(`unknown --color-prores-enc ${JSON.stringify(encoding)} (709ltd|601ltd)`)
  }
  const chart = writeColorChart(outputDir, WIDTH, HEIGHT)
  const output = outputName({ ...entry, colorProresEnc: encoding })
  const filter = `format=rgb24,scale=out_color_matrix=${matrix}:out_range=tv,format=yuv422p10le`
  const args = [
    '-y', '-loop', '1', '-i', chart, '-t', '1', '-r', '30',
    '-vf', filter, '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0',
    '-colorspace', matrix, '-color_primaries', matrix, '-color_trc', matrix, '-color_range', 'tv',
    // Keep the tags visible to ffprobe 7.x as well as 8.x.
    '-movflags', 'write_colr',
    '-an', output,
  ]

  console.log(`Generating ${output} (${encoding} chart, ProRes 422 HQ 10-bit)`)
  run(args, { cwd: outputDir })
  console.log(`Done: ${output}`)
}

function gradientArgs({
  width,
  height,
  duration,
  codec,
  output,
  beforePixelFormat = [],
  afterPixelFormat = [],
  filter = GRADIENT_FILTER,
}) {
  return [
    '-y', '-f', 'lavfi', '-i', `nullsrc=size=${width}x${height}:rate=30:duration=${duration}`,
    '-vf', filter,
    '-c:v', codec,
    ...beforePixelFormat,
    '-pix_fmt', 'yuv420p10le',
    ...afterPixelFormat,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-an', output,
  ]
}

function generateGradient(entry, outputDir, run) {
  let args
  let description
  const output = outputName(entry)

  if (entry.gradient) {
    args = gradientArgs({
      width: WIDTH,
      height: HEIGHT,
      duration: 1,
      codec: 'libx265',
      output,
      beforePixelFormat: [
        '-x265-params', 'profile=main10:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited',
      ],
    })
    args.splice(-2, 0, '-tag:v', 'hvc1')
    description = '10-bit BT.709 gradient, HEVC Main10'
  } else if (entry.gradientH264 || entry.gradientH2644k) {
    const fourK = Boolean(entry.gradientH2644k)
    args = gradientArgs({
      width: fourK ? 3840 : WIDTH,
      height: fourK ? 2160 : HEIGHT,
      duration: 1,
      codec: 'libx264',
      output,
      beforePixelFormat: ['-profile:v', 'high10'],
      afterPixelFormat: ['-crf', '18'],
    })
    description = fourK
      ? '4K 10-bit BT.709 gradient, H.264 High10'
      : '10-bit BT.709 gradient, H.264 High10'
  } else if (entry.gradientAv1) {
    const av1 = pickAv1Encoder()
    args = gradientArgs({
      width: WIDTH,
      height: HEIGHT,
      duration: 1,
      codec: av1.codec,
      output,
      beforePixelFormat: av1.args,
    })
    description = av1.description
  } else {
    const animatedFilter = "format=yuv420p10le,geq=lum='mod((X/(W-1))*1023+N*4,1024)':cb=512:cr=512,scale=out_color_matrix=bt709:out_range=tv"
    args = gradientArgs({
      width: WIDTH,
      height: HEIGHT,
      duration: 10,
      codec: 'libx264',
      output,
      filter: animatedFilter,
      beforePixelFormat: ['-profile:v', 'high10'],
      afterPixelFormat: [
        '-x264-params', 'keyint=120:bframes=3:b-adapt=0:scenecut=0',
      ],
    })
    description = '10s animated 10-bit ramp, H.264 High10 long-GOP+B-frames'
  }

  console.log(`Generating ${output} (${description})`)
  run(args, { cwd: outputDir })
  console.log(`Done: ${output}`)
}

function drawtextFilters(fps, font) {
  const common = `fontfile='${font}':fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`
  return [
    `drawtext=${common}:text='FRAME %{eif\\:n+1\\:d\\:5}':fontsize=42:x=20:y=20`,
    `drawtext=${common}:timecode='00\\:00\\:00\\:00':timecode_rate=${fps}:fontsize=42:x=20:y=85`,
    `drawtext=${common}:text='${fps} fps  1920x1080':fontsize=42:x=20:y=150`,
    `drawtext=${common}:text='%{eif\\:mod(n\\,${fps})+1\\:d\\:2}':fontsize=300:x=(w-text_w)/2:y=(h-text_h)/2`,
  ]
}

function generateVideo(entry, outputDir, run, fontOptions) {
  const fps = Number(entry.fps)
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error('--fps must be a positive integer')
  }
  const format = entry.format ?? 'mp4'
  let output = outputName({ ...entry, fps, format })
  const font = drawtextFontFile(fontOptions)
  const filterChain = drawtextFilters(fps, font).join(',')
  const colorFilter = 'format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'
  const input = [
    '-y', '-f', 'lavfi', '-i',
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${fps}:duration=${DURATION_SECONDS}`,
  ]
  let args

  switch (format) {
    case 'mp4':
    case 'mkv':
    case 'mov': {
      if (entry.eostail || entry.audio) {
        const audioSeconds = entry.eostail ? DURATION_SECONDS + 1 : DURATION_SECONDS
        args = [...input]
        const concatInputs = appendToneInputs(args, audioSeconds, 1)
        const complexFilter = `[0:v]${filterChain},${colorFilter}[v];${concatInputs}concat=n=${audioSeconds}:v=0:a=1[a]`
        args.push(
          '-filter_complex', complexFilter,
          '-map', '[v]', '-map', '[a]',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'medium',
        )
        if (entry.eostail) {
          const gop = String(5 * fps)
          args.push('-g', gop, '-keyint_min', gop, '-sc_threshold', '0')
        }
        args.push(...COLOR_TAGS, '-c:a', 'aac', '-b:a', '192k', output)
      } else {
        args = [
          ...input,
          '-vf', `${filterChain},${colorFilter}`,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'medium',
          ...COLOR_TAGS,
          '-an', output,
        ]
      }
      break
    }
    case 'webm':
      args = [
        ...input,
        '-vf', filterChain,
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', '32', '-b:v', '0',
        '-an', output,
      ]
      break
    case 'gif': {
      const complexFilter = `${filterChain},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`
      args = [...input, '-filter_complex', complexFilter, '-an', output]
      break
    }
    case 'prores': {
      output = `test_1080p_${fps}fps_prores.mov`
      const colorFilter422 = 'format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le'
      args = [
        ...input,
        '-vf', `${filterChain},${colorFilter422}`,
        '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0',
        ...COLOR_TAGS,
        '-an', output,
      ]
      break
    }
    default:
      throw new Error(`unsupported --format ${JSON.stringify(format)} (supported: mp4, mkv, mov, webm, gif, prores)`)
  }

  console.log(`Generating ${output} (${WIDTH}x${HEIGHT}, ${fps} fps, ${DURATION_SECONDS}s)`)
  run(args, { cwd: outputDir })
  console.log(`Done: ${output}`)
}

/// Generate one matrix entry in outputDir. `run` is injectable so every ffmpeg
/// recipe and path boundary can be tested without encoding large media files.
export function generateFixture(entry, {
  outputDir = process.cwd(),
  run = runFfmpeg,
  fontOptions,
} = {}) {
  mkdirSync(outputDir, { recursive: true })
  const atomicRun = atomicOutputs(run, outputDir)

  if (entry.imageset) return generateImageSet(outputDir, atomicRun)
  if (entry.audiotones) return generateAudioTones(entry, outputDir, atomicRun)
  if (entry.audioTiming) return generateAudioTiming(entry, outputDir, atomicRun)
  if (entry.audioTimingLong) return generateLongAudioTiming(outputDir, atomicRun)
  if (entry.color) return generateColor(entry, outputDir, atomicRun)
  if (entry.colorProres) return generateColorProres(entry, outputDir, atomicRun)
  if (
    entry.gradient
    || entry.gradientH264
    || entry.gradientH264Bf
    || entry.gradientAv1
    || entry.gradientH2644k
  ) {
    return generateGradient(entry, outputDir, atomicRun)
  }
  return generateVideo(entry, outputDir, atomicRun, fontOptions)
}

const VALUE_FLAGS = new Map([
  ['--fps', ['fps', Number]],
  ['--format', ['format', String]],
  ['--aformat', ['aformat', String]],
  ['--pts-offset-ms', ['ptsOffsetMs', Number]],
  ['--color', ['color', String]],
  ['--color-prores-enc', ['colorProresEnc', String]],
])

const BOOLEAN_FLAGS = new Map([
  ['--audio', 'audio'],
  ['--imageset', 'imageset'],
  ['--audiotones', 'audiotones'],
  ['--audio-timing', 'audioTiming'],
  ['--audio-timing-long', 'audioTimingLong'],
  ['--eostail', 'eostail'],
  ['--color-prores', 'colorProres'],
  ['--gradient', 'gradient'],
  ['--gradient-h264', 'gradientH264'],
  ['--gradient-h264-bf', 'gradientH264Bf'],
  ['--gradient-av1', 'gradientAv1'],
  ['--gradient-h264-4k', 'gradientH2644k'],
])

export function parseArgs(argv) {
  const entry = { format: 'mp4', aformat: 'wav', ptsOffsetMs: 0 }
  let outputDir = process.cwd()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') return { help: true, entry, outputDir }

    const equalsAt = token.indexOf('=')
    const flag = equalsAt === -1 ? token : token.slice(0, equalsAt)
    const inlineValue = equalsAt === -1 ? undefined : token.slice(equalsAt + 1)

    if (flag === '--output-dir') {
      const value = inlineValue ?? argv[++index]
      if (!value) throw new Error('--output-dir requires a value')
      outputDir = path.resolve(value)
      continue
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== undefined) throw new Error(`${flag} does not take a value`)
      entry[BOOLEAN_FLAGS.get(flag)] = true
      continue
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = inlineValue ?? argv[++index]
      if (value === undefined) throw new Error(`${flag} requires a value`)
      const [key, convert] = VALUE_FLAGS.get(flag)
      entry[key] = convert(value)
      continue
    }
    throw new Error(`unknown option: ${token}`)
  }

  return { help: false, entry, outputDir }
}

function printHelp() {
  console.log(`Usage: node generate.mjs [options]

Generate one deterministic fixture in the current directory.

  --fps N --format mp4|mkv|mov|webm|gif|prores [--audio] [--eostail]
  --imageset
  --audiotones --aformat wav|mp3|flac|m4a|ogg
  --audio-timing [--pts-offset-ms N]
  --audio-timing-long
  --color 709ltd|601ltd|709full|601full
  --color-prores [--color-prores-enc 709ltd|601ltd]
  --gradient | --gradient-h264 | --gradient-h264-bf
  --gradient-av1 | --gradient-h264-4k
  --output-dir PATH`)
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const parsed = parseArgs(process.argv.slice(2))
    if (parsed.help) {
      printHelp()
    } else {
      generateFixture(parsed.entry, { outputDir: parsed.outputDir })
    }
  } catch (error) {
    console.error('[fixtures]', error.message)
    process.exitCode = 1
  }
}
