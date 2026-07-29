// Installs the Electron binary. The repo sets `ignore-scripts=true` in .npmrc,
// so `npm install` never runs electron's own postinstall (install.js), which is
// what downloads dist/. This script runs it explicitly, skipping the download
// when a matching binary is already present.
//
// Honors electron's standard env vars (ELECTRON_MIRROR, ELECTRON_CACHE, ...)
// for machines that need a mirror to reach the GitHub release artifacts.
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = join(HERE, '..') // apps/desktop

const require = createRequire(join(root, 'package.json'))
const electronPkgDir = dirname(require.resolve('electron/package.json'))
const version = require('electron/package.json').version

// Mirror electron/index.js's own check: path.txt names the executable inside dist/.
const pathFile = join(electronPkgDir, 'path.txt')
const executable =
  existsSync(pathFile) && join(electronPkgDir, 'dist', readFileSync(pathFile, 'utf8').trim())

if (executable && existsSync(executable)) {
  console.log(`electron:install — electron@${version} binary already present, skipping.`)
  process.exit(0)
}

console.log(`electron:install — downloading electron@${version} binary...`)
const result = spawnSync(process.execPath, [join(electronPkgDir, 'install.js')], {
  stdio: 'inherit',
  cwd: electronPkgDir,
  env: process.env,
})
if (result.error) throw result.error
if (result.status !== 0) {
  console.error(
    'electron:install — download failed. If github.com is unreachable, set ELECTRON_MIRROR ' +
      '(e.g. https://npmmirror.com/mirrors/electron/) and retry.',
  )
  process.exit(result.status ?? 1)
}
