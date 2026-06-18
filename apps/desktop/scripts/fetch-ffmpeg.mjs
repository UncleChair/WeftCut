// Downloads a static ffmpeg for the host OS into resources/ffmpeg/<os>/.
// Sources: Windows = gyan.dev essentials; Linux = BtbN/FFmpeg-Builds (GitHub CDN); macOS = evermeet.
// Used locally and in CI to populate extraResources before packaging.
// CI may inline equivalent commands; this script mirrors them for local use.
import { existsSync, mkdirSync, chmodSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const FFMPEG_VERSION = '7.1.1'
const MIN_ARCHIVE_BYTES = 1 * 1024 * 1024   // 1 MB — corrupt/truncated guard
const MIN_BINARY_BYTES  = 1 * 1024 * 1024   // 1 MB — incomplete-extract guard
const MAX_ATTEMPTS = 3

const HERE = dirname(fileURLToPath(import.meta.url))
const plat = process.platform
const osDir = plat === 'win32' ? 'win' : plat === 'darwin' ? 'mac' : 'linux'
const dest = join(HERE, '..', 'resources', 'ffmpeg', osDir)
const bin = join(dest, plat === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

mkdirSync(dest, { recursive: true })
if (existsSync(bin)) {
  console.log(`ffmpeg already present: ${bin}`)
  process.exit(0)
}

const tmp = tmpdir()

/** Download `url` to `outPath`, retrying up to MAX_ATTEMPTS times.
 *  Validates that the resulting file is > MIN_ARCHIVE_BYTES before returning. */
function downloadWithRetry(url, outPath, label) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`Retry ${attempt}/${MAX_ATTEMPTS} for ${label}...`)
      // Remove partial file from previous attempt
      rmSync(outPath, { force: true })
    }
    try {
      execSync(`curl -L --progress-bar -o "${outPath}" "${url}"`, { stdio: 'inherit' })
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`curl failed after ${MAX_ATTEMPTS} attempts for ${label}: ${err.message}`)
      continue
    }
    // Validate size
    let size = 0
    try { size = statSync(outPath).size } catch (_) { /* file may not exist */ }
    if (size >= MIN_ARCHIVE_BYTES) return   // success
    const msg = `ffmpeg download invalid (got ${size} bytes) from ${url}`
    if (attempt === MAX_ATTEMPTS) throw new Error(msg)
    console.warn(`Warning: ${msg} — will retry`)
  }
}

/** Verify the extracted binary exists and is large enough; chmod on Unix. */
function verifyBinary(binPath) {
  if (!existsSync(binPath)) {
    throw new Error(`ffmpeg binary not found after extraction: ${binPath}`)
  }
  const size = statSync(binPath).size
  if (size < MIN_BINARY_BYTES) {
    throw new Error(`ffmpeg binary too small after extraction (${size} bytes): ${binPath}`)
  }
  if (plat !== 'win32') {
    chmodSync(binPath, 0o755)
  }
}

if (plat === 'win32') {
  // gyan.dev essentials build — small (~75 MB zip, ffmpeg.exe only + deps)
  // Check the releases page for the latest: https://github.com/GyanD/codexffmpeg/releases
  const zipName = `ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`
  const url = `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/${zipName}`
  const zipPath = join(tmp, zipName)

  console.log(`Downloading ffmpeg ${FFMPEG_VERSION} (Windows essentials) from gyan.dev/GitHub...`)
  downloadWithRetry(url, zipPath, 'Windows gyan.dev')

  console.log('Extracting ffmpeg.exe...')
  // Windows 10+ tar supports .zip; extract just the ffmpeg.exe from the nested bin/ dir
  const extractDir = join(tmp, `ffmpeg-${FFMPEG_VERSION}-essentials_build`)
  mkdirSync(extractDir, { recursive: true })
  const innerPath = `ffmpeg-${FFMPEG_VERSION}-essentials_build/bin/ffmpeg.exe`
  execSync(`tar -xf "${zipPath}" -C "${tmp}" "${innerPath}"`, { stdio: 'inherit' })

  const extracted = join(extractDir, 'bin', 'ffmpeg.exe')
  execSync(`move "${extracted}" "${bin}"`, { stdio: 'inherit', shell: true })
  rmSync(zipPath, { force: true })
  verifyBinary(bin)
  console.log(`ffmpeg installed: ${bin}`)

} else if (plat === 'linux') {
  // BtbN/FFmpeg-Builds static GPL build (linux64) — GitHub CDN, reliable
  // Archive layout: ffmpeg-master-latest-linux64-gpl/bin/ffmpeg
  // strip-components=2 drops both the top dir and bin/, leaving ffmpeg in dest
  const url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz'
  const tarPath = join(tmp, 'ffmpeg-btbn-linux64-gpl.tar.xz')

  console.log('Downloading ffmpeg (Linux static amd64) from BtbN/FFmpeg-Builds (GitHub CDN)...')
  downloadWithRetry(url, tarPath, 'Linux BtbN')

  console.log('Extracting ffmpeg...')
  execSync(
    `tar -xJf "${tarPath}" -C "${dest}" --strip-components=2 --wildcards '*/bin/ffmpeg'`,
    { stdio: 'inherit' }
  )

  rmSync(tarPath, { force: true })
  verifyBinary(bin)
  console.log(`ffmpeg installed: ${bin}`)

} else if (plat === 'darwin') {
  // evermeet.cx static build (universal / arm64+x86_64)
  // Check https://evermeet.cx/ffmpeg/ for latest version
  const url = 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip'
  const zipPath = join(tmp, 'ffmpeg-mac.zip')

  console.log('Downloading ffmpeg (macOS) from evermeet.cx...')
  downloadWithRetry(url, zipPath, 'macOS evermeet')

  console.log('Extracting ffmpeg...')
  execSync(`unzip -o "${zipPath}" ffmpeg -d "${dest}"`, { stdio: 'inherit' })
  rmSync(zipPath, { force: true })
  verifyBinary(bin)
  console.log(`ffmpeg installed: ${bin}`)

} else {
  console.error(`fetch-ffmpeg: unsupported platform: ${plat}`)
  process.exit(1)
}
