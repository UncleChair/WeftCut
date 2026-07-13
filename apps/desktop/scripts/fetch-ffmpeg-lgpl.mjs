// Downloads a BtbN LGPL SHARED ffmpeg build (per-OS) into
// resources/ffmpeg-lgpl/<os>/. This is the DISTRIBUTION decode runtime for
// @weftcut/native-decode: the shared libs ship beside the addon; include/ + lib/
// serve as FFMPEG_DIR for building the addon (CI + fresh dev machines).
//
// Per-OS runtime-library resolution (see docs/adr/0030 + docs/preview.md):
//   - Windows: bin/*.dll, resolved at dlopen via a PATH prepend (main/native-decode.ts).
//   - Linux:   lib/*.so*, resolved via the addon's RUNPATH ($ORIGIN) — the .so
//     ship next to the .node, no runtime env mutation (ld.so fixes NEEDED libs
//     at dlopen time, so an in-process LD_LIBRARY_PATH prepend is unreliable).
//   - macOS: no BtbN LGPL-shared build exists; supply chain still unsettled.
//
// LICENSING GATE (project_ffmpeg_licensing): the shipped libs must be LGPL.
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

// n8.1 matches the crate pin ffmpeg-next = "8.1" (decode/Cargo.toml). Each
// OS descriptor names its BtbN asset, the archive's top dir, the transient
// banner exe, and which subdir holds the runtime shared libraries.
const BUILDS = {
  win: {
    asset: 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip',
    inner: 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1',
    exe: 'ffmpeg.exe',
    exes: ['ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe'],
    libDir: 'bin', // *.dll live in bin/ (also the PATH-prepend dir at runtime)
  },
  linux: {
    asset: 'ffmpeg-n8.1-latest-linux64-lgpl-shared-8.1.tar.xz',
    inner: 'ffmpeg-n8.1-latest-linux64-lgpl-shared-8.1',
    exe: 'ffmpeg',
    exes: ['ffmpeg', 'ffprobe', 'ffplay'],
    libDir: 'lib', // *.so* live in lib/ (resolved at runtime via the .node's RUNPATH)
  },
}
const OS_KEY = { win32: 'win', linux: 'linux' }[process.platform] ?? null

const MIN_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_ATTEMPTS = 3
const RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'

const HERE = dirname(fileURLToPath(import.meta.url))
const destOf = (osKey) => join(HERE, '..', 'resources', 'ffmpeg-lgpl', osKey)

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
    throw new Error('ffmpeg-lgpl: not a shared build (no libs to bundle)')
  }
}

/** The runtime shared-library dir the loader/packaging consumes, resolved for
 *  a given OS key. Exported so napi-build-decode.mjs co-locates the same libs
 *  next to the built .node. */
export function lgplLibDir(osKey = OS_KEY) {
  if (!osKey || !BUILDS[osKey]) return null
  return join(destOf(osKey), BUILDS[osKey].libDir)
}

/** Remove the transient banner executables, leaving a lib-only tree. On Windows
 *  they linger in bin/ ALONGSIDE the *.dll (bin/ is the PATH-prepend dir), so a
 *  stray ffmpeg.exe would shadow the sidecar (this LGPL build lacks libx264/x265,
 *  so `Unknown encoder 'libx264'` on every transcode). On Linux the exes sit in
 *  bin/ apart from the runtime lib/, so they only waste space. Strip both.
 *  Idempotent (force: ignores already-absent). */
function stripExes(cfg, dest) {
  for (const exe of cfg.exes) rmSync(join(dest, 'bin', exe), { force: true })
}

function main() {
  if (!OS_KEY) {
    console.log(
      `fetch-ffmpeg-lgpl: no LGPL-shared build for platform "${process.platform}" ` +
        '(Windows + Linux supported; macOS supply chain unsettled); skipping.',
    )
    return
  }
  const cfg = BUILDS[OS_KEY]
  const dest = destOf(OS_KEY)
  const manifestPath = join(dest, 'manifest.json')
  const url = `${RELEASE}/${cfg.asset}`

  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assertLgplBanner(m.configuration) // re-assert even on the cached copy
    stripExes(cfg, dest) // heal a dir fetched before the exe-strip fix
    console.log(`ffmpeg-lgpl already present (${m.asset}); banner clean.`)
    return
  }
  mkdirSync(dest, { recursive: true })
  const archivePath = join(tmpdir(), cfg.asset)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) { console.log(`Retry ${attempt}/${MAX_ATTEMPTS}...`); rmSync(archivePath, { force: true }) }
    try { execSync(`curl -L --progress-bar -o "${archivePath}" "${url}"`, { stdio: 'inherit' }) } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err
      continue
    }
    let size = 0
    try { size = statSync(archivePath).size } catch { /* missing */ }
    if (size >= MIN_ARCHIVE_BYTES) break
    if (attempt === MAX_ATTEMPTS) throw new Error(`download invalid (${size} bytes) from ${url}`)
  }
  const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  console.log('Extracting bin/ + include/ + lib/ ...')
  // `tar -xf` auto-detects the format: GNU tar reads .tar.xz on Linux, bsdtar
  // (Windows 10+'s `tar`) reads .zip. Each OS only ever extracts its own asset.
  const members = ['bin', 'include', 'lib', 'LICENSE.txt'].map((p) => `${cfg.inner}/${p}`)
  execSync(`tar -xf "${archivePath}" -C "${tmpdir()}" ${members.map((m) => `"${m}"`).join(' ')}`, { stdio: 'inherit' })
  // Node fs.cpSync (not robocopy): reliably lands bin/+include/+lib/+LICENSE.txt
  // under dest with a single cross-platform-safe call and a real thrown error
  // on failure (robocopy's 0-7 "success" exit codes are awkward to gate on).
  for (const part of ['bin', 'include', 'lib', 'LICENSE.txt']) {
    // verbatimSymlinks: keep the SONAME chain's RELATIVE targets as-is. Without
    // it cpSync rewrites `libavcodec.so -> libavcodec.so.62` into an absolute
    // path under tmpdir/ that vanishes once this extract is cleaned.
    cpSync(join(tmpdir(), cfg.inner, part), join(dest, part), { recursive: true, verbatimSymlinks: true })
  }
  // Banner: BtbN shared builds ship the ffmpeg exe in bin/ — run it once,
  // capture the `configuration:` line, gate, and record. The exe itself never
  // ships. On Linux the runtime libs sit in a sibling lib/ (not beside the exe
  // like Windows' bin/*.dll), and the exe's own rpath doesn't always resolve
  // them here, so point the loader at lib/ explicitly for this one invocation.
  const bannerEnv = { ...process.env }
  if (OS_KEY === 'linux') {
    const libs = join(dest, 'lib')
    bannerEnv.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH ? `${libs}:${process.env.LD_LIBRARY_PATH}` : libs
  }
  const versionOut = execSync(`"${join(dest, 'bin', cfg.exe)}" -version`, { encoding: 'utf8', env: bannerEnv })
  const configLine = versionOut.split(/\r?\n/).find((l) => l.startsWith('configuration:')) ?? ''
  const configuration = configLine.replace(/^configuration:\s*/, '')
  assertLgplBanner(configuration)
  // Banner captured — strip the transient exes (see stripExes).
  stripExes(cfg, dest)
  writeFileSync(manifestPath, JSON.stringify({
    os: OS_KEY, asset: cfg.asset, url, sha256, configuration,
    fetchedAt: new Date().toISOString(),
  }, null, 2))
  rmSync(archivePath, { force: true })
  console.log(`ffmpeg-lgpl installed: ${dest} (banner clean, sha256 ${sha256.slice(0, 12)}…)`)
}

// Allow `import { assertLgplBanner }` without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
