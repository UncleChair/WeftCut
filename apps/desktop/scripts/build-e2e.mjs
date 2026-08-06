// Builds the app with the e2e control surface compiled in. A plain
// `npm run build` tree-shakes window.__weftcutTest out of the bundle and every
// export spec then times out in waitForHook — this wrapper exists so the flag
// cannot be forgotten, and works on Windows where an inline env-var prefix
// would need a bash shell. Goes through npm rather than invoking electron-vite
// directly so it inherits whatever `build` does — today that includes chaining
// build:wasm, which `build` has to spell out because .npmrc sets
// ignore-scripts=true and pre/post hooks never fire under it.
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url))) // apps/desktop

execSync('npm run build', {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, VITE_WEFTCUT_E2E: '1' },
})
