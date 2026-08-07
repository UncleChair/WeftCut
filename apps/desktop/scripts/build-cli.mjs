/// Bundle the weftcut-mcp shim into ONE self-contained file. It ships as an
/// extraResource and is copied to <userData>/cli/ at app startup, then runs
/// under ELECTRON_RUN_AS_NODE (the app binary as plain Node) on user machines
/// that have no Node install — so everything, SDK included, must be inlined.
///
/// CJS + .cjs on purpose: the file executes far from any package.json on user
/// machines, and inside this repo (`"type": "module"`) a bare .js would parse
/// as ESM. The .cjs extension is unambiguous in both worlds.
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [path.join(HERE, '..', 'src', 'cli', 'main.ts')],
  outfile: path.join(HERE, '..', 'out', 'cli', 'weftcut-mcp.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
})
