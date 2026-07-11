// Downloads the BtbN LGPL SHARED ffmpeg build (Windows x64) into
// resources/ffmpeg-lgpl/win/. This is the DISTRIBUTION decode runtime for
// @weftcut/native-decode: bin/*.dll ship as extraResources; include/ + lib/
// serve as FFMPEG_DIR for building the addon (CI + fresh dev machines).
//
// LICENSING GATE (project_ffmpeg_licensing): the shipped DLLs must be LGPL.
// Gyan's full_build-shared (the historical dev FFMPEG_DIR) is GPL and must
// never ship. This script asserts the build banner contains neither
// --enable-gpl nor --enable-nonfree and records it in manifest.json; the
// packaging step re-asserts from that manifest.
import { existsSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

// n8.1 matches the crate pin ffmpeg-next = "8.1" (decode/Cargo.toml).
const ASSET = 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip'
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${ASSET}`
const INNER = 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1' // top dir inside the zip
const MIN_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_ATTEMPTS = 3

const HERE = dirname(fileURLToPath(import.meta.url))
const dest = join(HERE, '..', 'resources', 'ffmpeg-lgpl', 'win')
const manifestPath = join(dest, 'manifest.json')

/** Pure gate, exported for reuse by napi-build-decode.mjs and the packaging
 *  assert: throws unless the ffmpeg configuration banner is LGPL-clean. */
export function assertLgplBanner(configuration) {
  if (!configuration || typeof configuration !== 'string') {
    throw new Error('ffmpeg-lgpl: empty configuration banner')
  }
  for (const forbidden of ['--enable-gpl', '--enable-nonfree']) {
    if (configuration.includes(forbidden)) {
      throw new Error(`ffmpeg-lgpl: banner contains ${forbidden} — this build must NOT ship`)
    }
  }
  if (!configuration.includes('--enable-shared')) {
    throw new Error('ffmpeg-lgpl: not a shared build (no DLLs to bundle)')
  }
}

/** Remove the bin/ executables (ffmpeg/ffprobe/ffplay), leaving a *.dll-only
 *  dir. They're needed only transiently for the banner check above; they must
 *  NOT linger. The loader (main/native-decode.ts) prepends this dir to PATH so
 *  the addon's avcodec DLLs resolve at dlopen — which ALSO puts any bin/*.exe
 *  ahead of the sidecar ffmpeg on PATH. This LGPL build has no libx264/x265, so
 *  a lingering ffmpeg.exe makes every dev transcode (proxy/export) fail
 *  `Unknown encoder 'libx264'`. The packaged app already ships this dir as
 *  *.dll-only (extraResources filter — ADR 0030 / Task 4); strip here so the dev
 *  dir matches. Idempotent (force: ignores already-absent). */
function stripBinExes(binDir) {
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe']) {
    rmSync(join(binDir, exe), { force: true })
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.log('fetch-ffmpeg-lgpl: Windows-only (component ships on Windows in v1); skipping.')
    return
  }
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assertLgplBanner(m.configuration) // re-assert even on the cached copy
    stripBinExes(join(dest, 'bin')) // heal a dir fetched before the exe-strip fix
    console.log(`ffmpeg-lgpl already present (${m.asset}); banner clean.`)
    return
  }
  mkdirSync(dest, { recursive: true })
  const zipPath = join(tmpdir(), ASSET)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) { console.log(`Retry ${attempt}/${MAX_ATTEMPTS}...`); rmSync(zipPath, { force: true }) }
    try { execSync(`curl -L --progress-bar -o "${zipPath}" "${URL}"`, { stdio: 'inherit' }) } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err
      continue
    }
    let size = 0
    try { size = statSync(zipPath).size } catch { /* missing */ }
    if (size >= MIN_ARCHIVE_BYTES) break
    if (attempt === MAX_ATTEMPTS) throw new Error(`download invalid (${size} bytes) from ${URL}`)
  }
  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  console.log('Extracting bin/ + include/ + lib/ ...')
  execSync(`tar -xf "${zipPath}" -C "${tmpdir()}" "${INNER}/bin" "${INNER}/include" "${INNER}/lib" "${INNER}/LICENSE.txt"`, { stdio: 'inherit' })
  // Node fs.cpSync (not robocopy): reliably lands bin/+include/+lib/+LICENSE.txt
  // under dest with a single cross-platform-safe call and a real thrown error
  // on failure (robocopy's 0-7 "success" exit codes are awkward to gate on).
  for (const part of ['bin', 'include', 'lib', 'LICENSE.txt']) {
    cpSync(join(tmpdir(), INNER, part), join(dest, part), { recursive: true })
  }
  // Banner: BtbN shared builds ship ffmpeg.exe in bin/ — run it once, capture
  // the `configuration:` line, gate, and record. The exe itself never ships
  // (extraResources filters to *.dll — Task 4).
  const versionOut = execSync(`"${join(dest, 'bin', 'ffmpeg.exe')}" -version`, { encoding: 'utf8' })
  const configLine = versionOut.split(/\r?\n/).find((l) => l.startsWith('configuration:')) ?? ''
  const configuration = configLine.replace(/^configuration:\s*/, '')
  assertLgplBanner(configuration)
  // Banner captured — the exes have served their purpose; strip them so the dev
  // dir is *.dll-only like the packaged one (see stripBinExes).
  stripBinExes(join(dest, 'bin'))
  writeFileSync(manifestPath, JSON.stringify({
    asset: ASSET, url: URL, sha256, configuration,
    fetchedAt: new Date().toISOString(),
  }, null, 2))
  rmSync(zipPath, { force: true })
  console.log(`ffmpeg-lgpl installed: ${dest} (banner clean, sha256 ${sha256.slice(0, 12)}…)`)
}

// Allow `import { assertLgplBanner }` without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
