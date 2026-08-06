// Downloads a static ffmpeg + ffprobe for the host OS into resources/ffmpeg/<os>/.
// Sources: Windows = gyan.dev essentials; Linux = BtbN/FFmpeg-Builds (GitHub CDN);
// macOS = martin-riedl.de (arm64).
// Used locally and in CI to populate extraResources before packaging.
//
// LICENSING (project licensing model, docs/licensing.md): these are the GPL
// SIDECAR binaries — run strictly as subprocesses, so they never affect
// WeftCut's MIT license, but DISTRIBUTING them owes GPLv3 compliance. This
// script captures each binary's `-version` banner, rejects `--enable-nonfree`
// (nonfree builds are non-redistributable under ANY license), and records the
// provenance in manifest.json + SOURCE-OFFER.txt beside the binaries. The GPL
// license text itself ships from resources/licenses/GPL-3.0.txt via
// electron-builder extraResources; after-pack-licensing.mjs re-asserts the
// whole set at package time.
import { existsSync, mkdirSync, chmodSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const FFMPEG_VERSION = '7.1.1'
// SHA-256 of the version-pinned Windows archive (gyan 7.1.1 essentials build) —
// verified, rejects a tampered/corrupt download. Linux (BtbN `n7.1` asset) is
// ROLLING WITHIN its pinned major.minor line, so a pinned hash there would
// break on every upstream rebuild; it stays size-validated only. macOS pins a
// versioned martin-riedl build + hash (see FFMPEG_MAC_* below).
const FFMPEG_WIN_SHA256 = '04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4'
// macOS: martin-riedl.de arm64 static build, pinned by build id AND SHA-256
// (the /download/<os>/<arch>/<id>/ URLs are stable, unlike evermeet's rolling
// `getrelease`). arm64-only BY DESIGN — WeftCut supports Apple Silicon only.
// Bump: resolve https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip
// to its versioned URL, download both zips, and update the three constants.
const FFMPEG_MAC_BUILD = '1783011502_8.1.2'
const FFMPEG_MAC_FFMPEG_SHA256 = 'ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c'
const FFMPEG_MAC_FFPROBE_SHA256 = 'c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf'
const MIN_ARCHIVE_BYTES = 1 * 1024 * 1024   // 1 MB — corrupt/truncated guard
const MIN_BINARY_BYTES  = 1 * 1024 * 1024   // 1 MB — incomplete-extract guard
const MAX_ATTEMPTS = 3

// GPLv3 §6 source pointers per OS, recorded into SOURCE-OFFER.txt. `upstream`
// is the FFmpeg source for the pinned version (Linux is a rolling git snapshot
// within n7.1 — the exact commit is embedded in the captured version string,
// e.g. `n7.1.1-14-gXXXXXXX`); `builder` is where the binary provider publishes
// its build scripts/configuration.
const SOURCES = {
  win: {
    archiveUrl: `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`,
    archiveSha256: FFMPEG_WIN_SHA256,
    upstream: `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`,
    builder: 'https://www.gyan.dev/ffmpeg/builds/ (build provenance: https://github.com/GyanD/codexffmpeg)',
  },
  linux: {
    archiveUrl: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz',
    upstream: 'https://git.ffmpeg.org/ffmpeg.git (checkout the commit named in the version string above)',
    builder: 'https://github.com/BtbN/FFmpeg-Builds (build scripts + per-release source snapshots)',
  },
  mac: {
    archiveUrl: `https://ffmpeg.martin-riedl.de/download/macos/arm64/${FFMPEG_MAC_BUILD}/ffmpeg.zip`,
    archiveSha256: FFMPEG_MAC_FFMPEG_SHA256,
    upstream: `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_MAC_BUILD.split('_')[1]}.tar.xz`,
    builder: 'https://ffmpeg.martin-riedl.de/ (build configuration published per build id)',
  },
}
const PROJECT_ISSUES_URL = 'https://github.com/UncleChair/WeftCut/issues'

/** Pure gate, exported for the packaging assert (after-pack-licensing.mjs):
 *  throws unless the sidecar's configuration banner is redistributable. GPL is
 *  EXPECTED here (x264/x265 power proxy + export lanes) — the only hard
 *  blocker is `--enable-nonfree`, which makes a binary non-redistributable
 *  under any license (GPL-incompatible pieces like fdk-aac get compiled IN). */
export function assertSidecarBanner(configuration) {
  if (!configuration || typeof configuration !== 'string') {
    throw new Error('ffmpeg-sidecar: empty configuration banner')
  }
  if (configuration.includes('--enable-nonfree')) {
    throw new Error(
      'ffmpeg-sidecar: banner contains --enable-nonfree — this build is NOT ' +
        'redistributable and must never ship (pick a GPL-only build source)',
    )
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const plat = process.platform
const osDir = plat === 'win32' ? 'win' : plat === 'darwin' ? 'mac' : 'linux'
const dest = join(HERE, '..', 'resources', 'ffmpeg', osDir)
const ext = plat === 'win32' ? '.exe' : ''
const bin      = join(dest, `ffmpeg${ext}`)
const probeBin = join(dest, `ffprobe${ext}`)

/** Run the fetched ffmpeg once, capture its `ffmpeg version …` +
 *  `configuration: …` lines, gate the banner, and write manifest.json +
 *  SOURCE-OFFER.txt beside the binaries. Idempotent — back-fills a tree that
 *  has binaries but no manifest. */
function stageCompliance() {
  const manifestPath = join(dest, 'manifest.json')
  if (existsSync(manifestPath)) {
    // Re-assert even the cached manifest — mirrors fetch-ffmpeg-lgpl.mjs.
    assertSidecarBanner(JSON.parse(readFileSync(manifestPath, 'utf8')).configuration)
    return
  }
  const src = SOURCES[osDir]
  const versionOut = execSync(`"${bin}" -version`, { encoding: 'utf8' })
  const lines = versionOut.split(/\r?\n/)
  const version = lines.find((l) => l.startsWith('ffmpeg version')) ?? ''
  const configuration = (lines.find((l) => l.startsWith('configuration:')) ?? '')
    .replace(/^configuration:\s*/, '')
  assertSidecarBanner(configuration)

  writeFileSync(manifestPath, JSON.stringify({
    os: osDir,
    version,
    configuration,
    url: src.archiveUrl,
    ...(src.archiveSha256 ? { sha256: src.archiveSha256 } : {}),
    source: { upstream: src.upstream, builder: src.builder },
    fetchedAt: new Date().toISOString(),
  }, null, 2))

  writeFileSync(join(dest, 'SOURCE-OFFER.txt'), `WeftCut bundles the following FFmpeg build as standalone command-line tools
(ffmpeg, ffprobe), executed strictly as separate subprocesses. These binaries
are licensed under the GNU General Public License version 3 — the license text
ships beside them as LICENSE.txt. Their license covers these binaries only; it
does not extend to WeftCut itself (MIT, see the application's LICENSE).

Exact build:
  ${version}
  configuration: ${configuration}
  binary origin: ${src.archiveUrl}

Complete corresponding source code:
  - FFmpeg source: ${src.upstream}
  - Builder scripts / build configuration: ${src.builder}

If you are unable to obtain the corresponding source from the locations
above, open an issue at ${PROJECT_ISSUES_URL} and we will provide it.
`)
  console.log(`ffmpeg sidecar compliance staged: ${manifestPath} (banner clean)`)
}

const tmp = tmpdir()

/** Download `url` to `outPath`, retrying up to MAX_ATTEMPTS times. Validates the
 *  result is > MIN_ARCHIVE_BYTES and, when `expectedSha256` is given, that its
 *  SHA-256 matches — a tampered/corrupt CDN download is rejected then retried. */
function downloadWithRetry(url, outPath, label, expectedSha256) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`Retry ${attempt}/${MAX_ATTEMPTS} for ${label}...`)
      rmSync(outPath, { force: true })
    }
    try {
      execSync(`curl -L --progress-bar -o "${outPath}" "${url}"`, { stdio: 'inherit' })
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`curl failed after ${MAX_ATTEMPTS} attempts for ${label}: ${err.message}`)
      continue
    }
    let size = 0
    try { size = statSync(outPath).size } catch (_) { /* file may not exist */ }
    if (size < MIN_ARCHIVE_BYTES) {
      const msg = `download invalid (got ${size} bytes) from ${url}`
      if (attempt === MAX_ATTEMPTS) throw new Error(msg)
      console.warn(`Warning: ${msg} — will retry`)
      continue
    }
    // Verify checksum when a hash is pinned (Windows + macOS pin a hash;
    // Linux's rolling n7.1 asset does not)
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

function main() {
  mkdirSync(dest, { recursive: true })
  if (existsSync(bin) && existsSync(probeBin)) {
    console.log(`ffmpeg + ffprobe already present: ${bin}, ${probeBin}`)
    stageCompliance() // heal a tree fetched before compliance staging existed
    return
  }

  if (plat === 'win32') {
    // gyan.dev essentials build — zip contains bin/ffmpeg.exe + bin/ffprobe.exe (+ ffplay)
    // Check the releases page for the latest: https://github.com/GyanD/codexffmpeg/releases
    const zipName = `ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`
    const url = SOURCES.win.archiveUrl
    const zipPath = join(tmp, zipName)
    const extractDir = join(tmp, `ffmpeg-${FFMPEG_VERSION}-essentials_build`)

    console.log(`Downloading ffmpeg ${FFMPEG_VERSION} (Windows essentials) from gyan.dev/GitHub...`)
    downloadWithRetry(url, zipPath, 'Windows gyan.dev', FFMPEG_WIN_SHA256)

    mkdirSync(extractDir, { recursive: true })

    if (!existsSync(bin)) {
      console.log('Extracting ffmpeg.exe...')
      const innerPath = `ffmpeg-${FFMPEG_VERSION}-essentials_build/bin/ffmpeg.exe`
      execSync(`tar -xf "${zipPath}" -C "${tmp}" "${innerPath}"`, { stdio: 'inherit' })
      const extracted = join(extractDir, 'bin', 'ffmpeg.exe')
      execSync(`move "${extracted}" "${bin}"`, { stdio: 'inherit', shell: true })
      verifyBinary(bin)
      console.log(`ffmpeg installed: ${bin}`)
    }

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
    const url = SOURCES.linux.archiveUrl
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
    // martin-riedl.de static build — native **arm64** (Apple Silicon only; the
    // evermeet.cx x86_64 build it replaces ran under Rosetta 2, where
    // hevc_videotoolbox cannot create a VT compression session: -12908,
    // issue #7 boundary #9). Version-pinned URL + SHA-256 (unlike evermeet's
    // rolling `getrelease`, so mac gets the same tamper check as Windows).
    // Skew vs the pinned 7.1.x win/linux builds: 8.1.2 — `-vsync` is deprecated
    // but still accepted (verified; the preview conformance e2e relies on it) —
    // and unlike evermeet it SHIPS libsvtav1, so AV1 export probes select it
    // (encoder_registry.rs AV1_SOFTWARE) instead of falling back to libaom-av1.
    // ffmpeg and ffprobe are separate single-binary zips.
    const macBase = `https://ffmpeg.martin-riedl.de/download/macos/arm64/${FFMPEG_MAC_BUILD}`

    if (!existsSync(bin)) {
      const ffmpegZip = join(tmp, 'ffmpeg-mac.zip')
      console.log(`Downloading ffmpeg ${FFMPEG_MAC_BUILD} (macOS arm64) from martin-riedl.de...`)
      downloadWithRetry(`${macBase}/ffmpeg.zip`, ffmpegZip, 'macOS martin-riedl ffmpeg', FFMPEG_MAC_FFMPEG_SHA256)
      console.log('Extracting ffmpeg...')
      execSync(`unzip -o "${ffmpegZip}" ffmpeg -d "${dest}"`, { stdio: 'inherit' })
      rmSync(ffmpegZip, { force: true })
      verifyBinary(bin)
      console.log(`ffmpeg installed: ${bin}`)
    }

    if (!existsSync(probeBin)) {
      const ffprobeZip = join(tmp, 'ffprobe-mac.zip')
      console.log(`Downloading ffprobe ${FFMPEG_MAC_BUILD} (macOS arm64) from martin-riedl.de...`)
      downloadWithRetry(`${macBase}/ffprobe.zip`, ffprobeZip, 'macOS martin-riedl ffprobe', FFMPEG_MAC_FFPROBE_SHA256)
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

  stageCompliance()
}

// Allow `import { assertSidecarBanner }` without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
