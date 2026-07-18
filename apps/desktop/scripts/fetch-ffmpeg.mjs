// Downloads a static ffmpeg + ffprobe for the host OS into resources/ffmpeg/<os>/.
// Sources: Windows = gyan.dev essentials; Linux = BtbN/FFmpeg-Builds (GitHub CDN); macOS = evermeet.
// Used locally and in CI to populate extraResources before packaging.
// CI may inline equivalent commands; this script mirrors them for local use.
import { existsSync, mkdirSync, chmodSync, rmSync, statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const FFMPEG_VERSION = '7.1.1'
// SHA-256 of the version-pinned Windows archive (gyan 7.1.1 essentials build) —
// verified, rejects a tampered/corrupt download. Linux (BtbN `n7.1` asset) and
// macOS (evermeet `getrelease`) are ROLLING WITHIN their pinned major.minor line,
// so a pinned hash there would break on every upstream rebuild; they stay
// size-validated only (rolling upstream builds have no stable hash to pin against).
const FFMPEG_WIN_SHA256 = '04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4'
const MIN_ARCHIVE_BYTES = 1 * 1024 * 1024   // 1 MB — corrupt/truncated guard
const MIN_BINARY_BYTES  = 1 * 1024 * 1024   // 1 MB — incomplete-extract guard
const MAX_ATTEMPTS = 3

const HERE = dirname(fileURLToPath(import.meta.url))
const plat = process.platform
const osDir = plat === 'win32' ? 'win' : plat === 'darwin' ? 'mac' : 'linux'
const dest = join(HERE, '..', 'resources', 'ffmpeg', osDir)
const ext = plat === 'win32' ? '.exe' : ''
const bin      = join(dest, `ffmpeg${ext}`)
const probeBin = join(dest, `ffprobe${ext}`)

mkdirSync(dest, { recursive: true })
if (existsSync(bin) && existsSync(probeBin)) {
  console.log(`ffmpeg + ffprobe already present: ${bin}, ${probeBin}`)
  process.exit(0)
}

const tmp = tmpdir()

/** Download `url` to `outPath`, retrying up to MAX_ATTEMPTS times. Validates the
 *  result is > MIN_ARCHIVE_BYTES and, when `expectedSha256` is given, that its
 *  SHA-256 matches — a tampered/corrupt CDN download is rejected then retried. */
function downloadWithRetry(url, outPath, label, expectedSha256) {
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
    if (size < MIN_ARCHIVE_BYTES) {
      const msg = `download invalid (got ${size} bytes) from ${url}`
      if (attempt === MAX_ATTEMPTS) throw new Error(msg)
      console.warn(`Warning: ${msg} — will retry`)
      continue
    }
    // Verify checksum when a hash is pinned (Windows only — see FFMPEG_WIN_SHA256)
    if (expectedSha256) {
      const got = createHash('sha256').update(readFileSync(outPath)).digest('hex')
      if (got !== expectedSha256) {
        const msg = `checksum mismatch for ${label}: expected ${expectedSha256}, got ${got}`
        if (attempt === MAX_ATTEMPTS) throw new Error(msg)
        console.warn(`Warning: ${msg} — will retry`)
        continue
      }
      console.log(`checksum verified for ${label} (sha256 ${got.slice(0, 12)}…)`)
    }
    return   // success
  }
}

/** Verify the extracted binary exists and is large enough; chmod on Unix. */
function verifyBinary(binPath) {
  if (!existsSync(binPath)) {
    throw new Error(`binary not found after extraction: ${binPath}`)
  }
  const size = statSync(binPath).size
  if (size < MIN_BINARY_BYTES) {
    throw new Error(`binary too small after extraction (${size} bytes): ${binPath}`)
  }
  if (plat !== 'win32') {
    chmodSync(binPath, 0o755)
  }
}

if (plat === 'win32') {
  // gyan.dev essentials build — zip contains bin/ffmpeg.exe + bin/ffprobe.exe (+ ffplay)
  // Check the releases page for the latest: https://github.com/GyanD/codexffmpeg/releases
  const zipName = `ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`
  const url = `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/${zipName}`
  const zipPath = join(tmp, zipName)
  const extractDir = join(tmp, `ffmpeg-${FFMPEG_VERSION}-essentials_build`)

  console.log(`Downloading ffmpeg ${FFMPEG_VERSION} (Windows essentials) from gyan.dev/GitHub...`)
  downloadWithRetry(url, zipPath, 'Windows gyan.dev', FFMPEG_WIN_SHA256)

  mkdirSync(extractDir, { recursive: true })

  // Extract ffmpeg.exe if not already present
  if (!existsSync(bin)) {
    console.log('Extracting ffmpeg.exe...')
    const innerPath = `ffmpeg-${FFMPEG_VERSION}-essentials_build/bin/ffmpeg.exe`
    execSync(`tar -xf "${zipPath}" -C "${tmp}" "${innerPath}"`, { stdio: 'inherit' })
    const extracted = join(extractDir, 'bin', 'ffmpeg.exe')
    execSync(`move "${extracted}" "${bin}"`, { stdio: 'inherit', shell: true })
    verifyBinary(bin)
    console.log(`ffmpeg installed: ${bin}`)
  }

  // Extract ffprobe.exe if not already present
  if (!existsSync(probeBin)) {
    console.log('Extracting ffprobe.exe...')
    const innerProbePath = `ffmpeg-${FFMPEG_VERSION}-essentials_build/bin/ffprobe.exe`
    execSync(`tar -xf "${zipPath}" -C "${tmp}" "${innerProbePath}"`, { stdio: 'inherit' })
    const extractedProbe = join(extractDir, 'bin', 'ffprobe.exe')
    execSync(`move "${extractedProbe}" "${probeBin}"`, { stdio: 'inherit', shell: true })
    verifyBinary(probeBin)
    console.log(`ffprobe installed: ${probeBin}`)
  }

  rmSync(zipPath, { force: true })

} else if (plat === 'linux') {
  // BtbN/FFmpeg-Builds static GPL build (linux64) — GitHub CDN, reliable.
  // Version-pinned to the `n7.1` asset (NOT `master`): it tracks the same 7.1.x
  // line as the Windows build, so libavcodec 61 keeps `-vsync` working (master's
  // avcodec 63 removed it, breaking the conformance e2e), and the GPL build ships
  // libsvtav1 (AV1 8/10-bit export), plus vaapi + ffnvcodec for the hardware lanes.
  // Archive layout: ffmpeg-n7.1-latest-linux64-gpl-7.1/bin/ffmpeg + ffprobe —
  // strip-components=2 drops both the top dir and bin/, leaving binaries in dest.
  const url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz'
  const tarPath = join(tmp, 'ffmpeg-btbn-linux64-gpl.tar.xz')

  console.log('Downloading ffmpeg + ffprobe (Linux static amd64) from BtbN/FFmpeg-Builds (GitHub CDN)...')
  downloadWithRetry(url, tarPath, 'Linux BtbN')

  if (!existsSync(bin)) {
    console.log('Extracting ffmpeg...')
    execSync(
      `tar -xJf "${tarPath}" -C "${dest}" --strip-components=2 --wildcards '*/bin/ffmpeg'`,
      { stdio: 'inherit' }
    )
    verifyBinary(bin)
    console.log(`ffmpeg installed: ${bin}`)
  }

  if (!existsSync(probeBin)) {
    console.log('Extracting ffprobe...')
    execSync(
      `tar -xJf "${tarPath}" -C "${dest}" --strip-components=2 --wildcards '*/bin/ffprobe'`,
      { stdio: 'inherit' }
    )
    verifyBinary(probeBin)
    console.log(`ffprobe installed: ${probeBin}`)
  }

  rmSync(tarPath, { force: true })

} else if (plat === 'darwin') {
  // evermeet.cx static build (universal / arm64+x86_64)
  // ffmpeg and ffprobe are separate downloads on evermeet.
  // Verified URL: https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip (302→200, ffprobe-8.1.2.zip)
  if (!existsSync(bin)) {
    const ffmpegUrl = 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip'
    const ffmpegZip = join(tmp, 'ffmpeg-mac.zip')
    console.log('Downloading ffmpeg (macOS) from evermeet.cx...')
    downloadWithRetry(ffmpegUrl, ffmpegZip, 'macOS evermeet ffmpeg')
    console.log('Extracting ffmpeg...')
    execSync(`unzip -o "${ffmpegZip}" ffmpeg -d "${dest}"`, { stdio: 'inherit' })
    rmSync(ffmpegZip, { force: true })
    verifyBinary(bin)
    console.log(`ffmpeg installed: ${bin}`)
  }

  if (!existsSync(probeBin)) {
    const ffprobeUrl = 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip'
    const ffprobeZip = join(tmp, 'ffprobe-mac.zip')
    console.log('Downloading ffprobe (macOS) from evermeet.cx...')
    downloadWithRetry(ffprobeUrl, ffprobeZip, 'macOS evermeet ffprobe')
    console.log('Extracting ffprobe...')
    execSync(`unzip -o "${ffprobeZip}" ffprobe -d "${dest}"`, { stdio: 'inherit' })
    rmSync(ffprobeZip, { force: true })
    verifyBinary(probeBin)
    console.log(`ffprobe installed: ${probeBin}`)
  }

} else {
  console.error(`fetch-ffmpeg: unsupported platform: ${plat}`)
  process.exit(1)
}
