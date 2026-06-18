// Downloads a static ffmpeg for the host OS into resources/ffmpeg/<os>/.
// Sources: Windows = gyan.dev essentials; Linux = johnvansickle; macOS = evermeet.
// Used locally and in CI to populate extraResources before packaging.
// CI may inline equivalent commands; this script mirrors them for local use.
import { existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const FFMPEG_VERSION = '7.1.1'

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

if (plat === 'win32') {
  // gyan.dev essentials build — small (~75 MB zip, ffmpeg.exe only + deps)
  // Check the releases page for the latest: https://github.com/GyanD/codexffmpeg/releases
  const zipName = `ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`
  const url = `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/${zipName}`
  const zipPath = join(tmp, zipName)

  console.log(`Downloading ffmpeg ${FFMPEG_VERSION} (Windows essentials) from gyan.dev/GitHub...`)
  execSync(`curl -L --progress-bar -o "${zipPath}" "${url}"`, { stdio: 'inherit' })

  console.log('Extracting ffmpeg.exe...')
  // Windows 10+ tar supports .zip; extract just the ffmpeg.exe from the nested bin/ dir
  const extractDir = join(tmp, `ffmpeg-${FFMPEG_VERSION}-essentials_build`)
  mkdirSync(extractDir, { recursive: true })
  const innerPath = `ffmpeg-${FFMPEG_VERSION}-essentials_build/bin/ffmpeg.exe`
  execSync(`tar -xf "${zipPath}" -C "${tmp}" "${innerPath}"`, { stdio: 'inherit' })

  const extracted = join(extractDir, 'bin', 'ffmpeg.exe')
  execSync(`move "${extracted}" "${bin}"`, { stdio: 'inherit', shell: true })
  rmSync(zipPath, { force: true })
  console.log(`ffmpeg installed: ${bin}`)

} else if (plat === 'linux') {
  // johnvansickle static build (amd64)
  const url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'
  const tarPath = join(tmp, 'ffmpeg-release-amd64-static.tar.xz')

  console.log('Downloading ffmpeg (Linux static amd64) from johnvansickle...')
  execSync(`curl -L --progress-bar -o "${tarPath}" "${url}"`, { stdio: 'inherit' })

  console.log('Extracting ffmpeg...')
  const extractDir = join(tmp, 'ffmpeg-linux-extract')
  mkdirSync(extractDir, { recursive: true })
  execSync(`tar -xJ -f "${tarPath}" -C "${extractDir}" --strip-components=1 --wildcards '*/ffmpeg'`, { stdio: 'inherit' })

  const extracted = join(extractDir, 'ffmpeg')
  execSync(`cp "${extracted}" "${bin}"`, { stdio: 'inherit' })
  chmodSync(bin, 0o755)
  rmSync(tarPath, { force: true })
  console.log(`ffmpeg installed: ${bin}`)

} else if (plat === 'darwin') {
  // evermeet.cx static build (universal / arm64+x86_64)
  // Check https://evermeet.cx/ffmpeg/ for latest version
  const url = 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip'
  const zipPath = join(tmp, 'ffmpeg-mac.zip')

  console.log('Downloading ffmpeg (macOS) from evermeet.cx...')
  execSync(`curl -L --progress-bar -o "${zipPath}" "${url}"`, { stdio: 'inherit' })

  console.log('Extracting ffmpeg...')
  execSync(`unzip -o "${zipPath}" ffmpeg -d "${dest}"`, { stdio: 'inherit' })
  chmodSync(bin, 0o755)
  rmSync(zipPath, { force: true })
  console.log(`ffmpeg installed: ${bin}`)

} else {
  console.error(`fetch-ffmpeg: unsupported platform: ${plat}`)
  process.exit(1)
}
