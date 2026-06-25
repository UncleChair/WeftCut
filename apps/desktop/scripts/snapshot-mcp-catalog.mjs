// One-shot generator for the committed Rust MCP catalog snapshot
// (`apps/desktop/fixtures/mcp/rust-catalog-snapshot.json`). This is a DATA
// FIXTURE, not an oracle — it does NOT touch `fixtures/state-corpus/`. It is
// the input to the loose faithfulness gate (mcp.catalog-faithfulness.test.ts)
// and the structural bijection gate (mcp.catalog-bijection.test.ts), which
// assert the TS single-source MCP table stays consistent with the live Rust
// catalog. Regenerate (and re-commit) whenever the Rust `tool_table!` changes.
//
// Run:  node apps/desktop/scripts/snapshot-mcp-catalog.mjs   (from repo root, or cwd=apps/desktop)
//
// We import the built napi addon by relative path rather than the bare
// `@weftcut/core` specifier: `@weftcut/core` is a `file:native` dependency and
// does not always resolve as a bare specifier in a plain node script, whereas
// the relative path is stable. mcpCatalog() reads the static tool table, so no
// backend.init() is needed; the temp dirs are only to satisfy the constructor.
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const nativeUrl = pathToFileURL(join(here, '..', 'native', 'index.js')).href
const { Backend } = await import(nativeUrl)

const cfg = join(tmpdir(), 'weftcut-catalog-snapshot', 'cfg')
const cache = join(tmpdir(), 'weftcut-catalog-snapshot', 'cache')
mkdirSync(cfg, { recursive: true })
mkdirSync(cache, { recursive: true })

const backend = new Backend(cfg, cache, () => {})
const cat = JSON.parse(await backend.mcpCatalog())

const outDir = join(here, '..', 'fixtures', 'mcp')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'rust-catalog-snapshot.json')
writeFileSync(outPath, JSON.stringify(cat, null, 2) + '\n')
console.log(`snapshot: ${cat.tools.length} tools, ${(cat.resources ?? []).length} resources → ${outPath}`)
// The Backend keeps a tokio runtime / event callback alive, so node would
// otherwise hang after writing. The snapshot is complete here — exit cleanly.
process.exit(0)
