// apps/desktop/scripts/gen-state-oracle.mjs
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SEQ = 'fixtures/state-corpus/sequences'
const OUT = 'fixtures/state-corpus/oracle'
mkdirSync(OUT, { recursive: true })

const run = (file) => execFileSync('cargo', [
  'run', '--quiet', '--manifest-path', 'native/Cargo.toml',
  // NOTE: bare `--features replay` does not compile (pre-existing napi_backend.rs
  // error at default features); the bin compiles the whole crate, so use the
  // feature set that builds (confirmed in Task 6).
  '--bin', 'replay_driver', '--features', 'replay,jobs,export,mcp,cloud,motifs', '--', join(SEQ, file),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

let fail = 0
for (const file of readdirSync(SEQ).filter((f) => f.endsWith('.json'))) {
  const a = run(file)
  const b = run(file) // determinism gate
  if (a !== b) { console.error(`NONDETERMINISTIC: ${file}`); fail++; continue }
  writeFileSync(join(OUT, file), a)
  console.log(`ok  ${file}`)
}
process.exit(fail ? 1 : 0)
