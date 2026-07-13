// Builds @weftcut/native-decode with the env ffmpeg-next needs. Precedence:
// explicit FFMPEG_DIR env > fetched resources/ffmpeg-lgpl/<os> (canonical).
//
// Runtime shared-library resolution is per-OS (see docs/adr/0030):
//   - Windows: main/native-decode.ts prepends the bundled bin/ (*.dll) to PATH
//     at dlopen; nothing to bake into the addon.
//   - Linux: ld.so resolves the addon's NEEDED libav*.so at dlopen time from
//     the ELF RUNPATH — an in-process LD_LIBRARY_PATH prepend is unreliable. So
//     we bake RUNPATH=$ORIGIN into the .node and co-locate the *.so beside it.
import { existsSync, readFileSync, readdirSync, copyFileSync, lstatSync, symlinkSync, readlinkSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { assertLgplBanner, lgplLibDir } from './fetch-ffmpeg-lgpl.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = join(HERE, '..') // apps/desktop
const outDir = join(root, 'native', 'decode') // where napi drops the .node
const osKey = { win32: 'win', linux: 'linux' }[process.platform] ?? null

const env = { ...process.env }
if (!env.FFMPEG_DIR) {
  if (!osKey) {
    console.error(`napi:build:decode — no bundled ffmpeg-lgpl for "${process.platform}"; set FFMPEG_DIR.`)
    process.exit(1)
  }
  const lgplDir = join(root, 'resources', 'ffmpeg-lgpl', osKey)
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
// Linux: bake $ORIGIN into the .node so it finds its co-located libav*.so
// (below) with no runtime env mutation. It must be DT_RPATH, not the modern
// DT_RUNPATH default: the BtbN ffmpeg .so carry no rpath of their own, and
// RUNPATH is consulted ONLY for an object's direct NEEDED — not for transitive
// deps (libavcodec→libswresample, libavdevice→libavfilter). DT_RPATH of an
// ancestor IS searched across the whole dependency subtree, so
// --disable-new-dtags (which emits RPATH) is what makes the transitive libs
// resolve. (The Chromium-libffmpeg symbol collision is defeated at LOAD time via
// RTLD_DEEPBIND in main/native-decode.ts, not here — GNU ld ignores `-z
// deepbind` and there is no DF_1 flag for it.)
if (process.platform === 'linux') {
  const rpath = '-C link-arg=-Wl,--disable-new-dtags -C link-arg=-Wl,-rpath,$ORIGIN'
  env.RUSTFLAGS = env.RUSTFLAGS ? `${env.RUSTFLAGS} ${rpath}` : rpath
}

execSync(
  'napi build --platform --release --manifest-path native/decode/Cargo.toml --output-dir native/decode',
  { stdio: 'inherit', env, cwd: root },
)

// Co-locate the runtime shared libraries next to the freshly built .node so
// $ORIGIN resolution works in dev exactly as it will when packaged (where the
// same *.so ship beside the unpacked .node — see electron-builder.yml). Windows
// resolves *.dll via the PATH prepend instead, so this is Linux-only.
if (process.platform === 'linux') {
  const libDir = lgplLibDir('linux')
  if (!libDir || !existsSync(libDir)) {
    console.error('napi:build:decode — runtime lib dir missing; run `npm run fetch-ffmpeg-lgpl`.')
    process.exit(1)
  }
  let copied = 0
  for (const name of readdirSync(libDir)) {
    if (!name.includes('.so')) continue // libav*.so / .so.NN / .so.NN.MM.PP
    const src = join(libDir, name)
    const dst = join(outDir, name)
    rmSync(dst, { force: true })
    // Preserve the SONAME symlink chain (libfoo.so -> .so.62 -> .so.62.x.y):
    // the .node's DT_NEEDED names the middle link, so the chain must survive.
    // Re-anchor each link to its target's BASENAME — everything is co-located in
    // one dir, so a bare filename is the only correct (and relocatable) target.
    if (lstatSync(src).isSymbolicLink()) symlinkSync(basename(readlinkSync(src)), dst)
    else copyFileSync(src, dst)
    copied++
  }
  console.log(`napi:build:decode — co-located ${copied} shared-library entries in ${outDir}`)
}
