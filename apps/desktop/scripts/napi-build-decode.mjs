// Builds @weftcut/native-decode with the env ffmpeg-next needs. Precedence:
// explicit FFMPEG_DIR env > fetched resources/ffmpeg-lgpl/win (canonical).
// LIBCLANG_PATH defaults to the standard LLVM install (dev + windows-latest CI).
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { assertLgplBanner } from './fetch-ffmpeg-lgpl.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const lgplDir = join(HERE, '..', 'resources', 'ffmpeg-lgpl', 'win')

const env = { ...process.env }
if (!env.FFMPEG_DIR) {
  const manifest = join(lgplDir, 'manifest.json')
  if (!existsSync(manifest)) {
    console.error('napi:build:decode — set FFMPEG_DIR or run `npm run fetch-ffmpeg-lgpl` first.')
    process.exit(1)
  }
  assertLgplBanner(JSON.parse(readFileSync(manifest, 'utf8')).configuration)
  env.FFMPEG_DIR = lgplDir
}
if (process.platform === 'win32' && !env.LIBCLANG_PATH) {
  env.LIBCLANG_PATH = 'C:\\Program Files\\LLVM\\bin'
}
execSync(
  'napi build --platform --release --manifest-path native/decode/Cargo.toml --output-dir native/decode',
  { stdio: 'inherit', env, cwd: join(HERE, '..') },
)
