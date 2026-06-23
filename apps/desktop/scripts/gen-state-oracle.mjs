// apps/desktop/scripts/gen-state-oracle.mjs
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SEQ = 'fixtures/state-corpus/sequences'
const OUT = 'fixtures/state-corpus/oracle'
const OUT_SUMMARY = 'fixtures/state-corpus/oracle-summary'
mkdirSync(OUT, { recursive: true })
mkdirSync(OUT_SUMMARY, { recursive: true })

const run = (file, emit) => execFileSync('cargo', [
  'run', '--quiet', '--manifest-path', 'native/Cargo.toml',
  '--bin', 'replay_driver', '--features', 'replay,jobs,export,mcp,cloud,motifs', '--', join(SEQ, file),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, REPLAY_EMIT: emit } })

let fail = 0
for (const file of readdirSync(SEQ).filter((f) => f.endsWith('.json'))) {
  for (const [emit, dir] of [['state', OUT], ['summary', OUT_SUMMARY]]) {
    const a = run(file, emit)
    const b = run(file, emit) // determinism gate
    if (a !== b) { console.error(`NONDETERMINISTIC (${emit}): ${file}`); fail++; continue }
    writeFileSync(join(dir, file), a)
  }
  console.log(`ok  ${file}`)
}
// Production-channel oracles: real Backend.dispatch under det ids.
const SEQ_PROD = 'fixtures/state-corpus/sequences-prod'
const OUT_PROD = 'fixtures/state-corpus/oracle-prod'
mkdirSync(OUT_PROD, { recursive: true })
const runProd = (file) => execFileSync('cargo', [
  'run', '--quiet', '--manifest-path', 'native/Cargo.toml',
  '--bin', 'prod_driver', '--features', 'replay,jobs,export,mcp,cloud,motifs', '--', join(SEQ_PROD, file),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
for (const file of readdirSync(SEQ_PROD).filter((f) => f.endsWith('.json'))) {
  const a = runProd(file), b = runProd(file)
  if (a !== b) { console.error(`NONDETERMINISTIC (prod): ${file}`); fail++; continue }
  writeFileSync(join(OUT_PROD, file), a)
  console.log(`ok  prod/${file}`)
}

process.exit(fail ? 1 : 0)
