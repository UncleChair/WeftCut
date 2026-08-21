import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { SLICES, sliceEnv, sliceNames } from '../e2e/slices.mjs'

/// electron-ci splits one e2e run across runners by NAMING spec files and giving
/// one leg everything that was not named. The split is therefore only correct if
/// the named set and the ignored set are the same set — and the way it breaks is
/// silent: a name in the ignore list with no leg owning it runs NOWHERE, on no
/// runner, reported as green by all of them. Nothing else can catch that. A
/// rename, by contrast, is loud (the owning leg collects zero tests and
/// Playwright fails it), but is cheaper to catch here.
///
/// e2e/slices.mjs is the source of truth and derives the ignore set from the
/// owned ones, so the two-lists-disagree shape is gone by construction; what is
/// asserted below is that derivation plus the table's own invariants. The
/// workflow still owns two facts no module can hold — the `part:` matrix values
/// it declares, and which invocation the restriction reaches — and those two
/// tests still read its text.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..')
const WORKFLOW = path.resolve(DESKTOP, '..', '..', '.github', 'workflows', 'electron-ci.yml')

const yml = readFileSync(WORKFLOW, 'utf8')

const names = (list) =>
  list
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)

/** The catch-all slice's ignore list — everything the named slices claim. */
const ignored = () => names(sliceEnv(SLICES.find((s) => s.own.length === 0).name).WEFTCUT_E2E_IGNORE)

/** Every spec file a slice claims, flattened. */
const owned = () => SLICES.flatMap((slice) => slice.own)

test('every ignored spec file is owned by exactly one e2e leg', () => {
  const own = owned()
  assert.ok(own.length > 0, 'no leg owns any spec file — the split would run nothing')
  const counts = new Map()
  for (const n of own) counts.set(n, (counts.get(n) ?? 0) + 1)
  const twice = [...counts].filter(([, c]) => c > 1).map(([n]) => n)
  assert.deepEqual(twice, [], 'these spec files are owned by more than one leg, so they run twice')
  assert.deepEqual(
    [...own].sort(),
    [...ignored()].sort(),
    'the named legs and the catch-all’s ignore list disagree: a file in one but not the other either runs twice or never runs at all',
  )
})

test('every spec file the split names still exists', () => {
  for (const name of ignored()) {
    const spec = path.join(DESKTOP, 'e2e', 'electron', name)
    assert.ok(existsSync(spec), `${name} is named by the e2e split but no such spec exists`)
  }
})

test('the table has exactly one catch-all, one serial slice, and one packaging slice', () => {
  // Two catch-alls would each run the whole unclaimed set; none would leave every
  // unnamed spec on no runner at all. `serial` and `package` are single-occupancy
  // for a different reason: the determinism artifact name is unsliced, so a
  // second uploader is a hard conflict, and packaging twice per OS is waste on
  // whichever slice is already the worst case.
  assert.equal(SLICES.filter((s) => s.own.length === 0).length, 1)
  assert.equal(SLICES.filter((s) => s.serial).length, 1)
  assert.equal(SLICES.filter((s) => s.package).length, 1)
})

test('a named slice restricts to its own files and ignores nothing', () => {
  // The two variables are exclusive by design (playwright.config.ts turns ONLY
  // into `testMatch`): a slice that set both would ignore files it also owns,
  // and an empty ONLY makes `testMatch` undefined — the whole suite, on that leg
  // and on the catch-all both.
  for (const slice of SLICES.filter((s) => s.own.length)) {
    const env = sliceEnv(slice.name)
    assert.deepEqual(names(env.WEFTCUT_E2E_ONLY), slice.own)
    assert.equal(env.WEFTCUT_E2E_IGNORE, '')
  }
})

test('an unknown slice name is loud rather than an empty restriction', () => {
  // The failure mode this guards: a typo in the `part:` matrix resolving to no
  // restriction, under which that runner silently repeats the entire suite.
  assert.throws(() => sliceEnv('overlaps'), /unknown e2e slice/)
})

test('the slice restriction reaches the parallel project and nothing else', () => {
  // The serial project is NOT sliced — it greps @serial across the whole suite
  // and captures the determinism PNGs. Set anywhere the serial run inherits it,
  // the restriction narrows that project to the sliced files too; no @serial
  // test lives in any of them, so Playwright kills the whole leg with "No tests
  // found" before a single spec runs.
  const applied = yml.split('\n').filter((l) => /WEFTCUT_E2E_(ONLY|IGNORE)=/.test(l))
  assert.ok(applied.length > 0, 'nothing applies a slice restriction — the split is not in effect')
  for (const line of applied)
    assert.match(
      line,
      /--project=parallel/,
      `a slice restriction must be set on the parallel invocation itself, never where the serial run inherits it: ${line.trim()}`,
    )
})

test('every e2e slice the matrix declares is a slice the step knows how to run', () => {
  const m = yml.match(/part:\s*\$\{\{[^}]*?'(\["[^\]]+\])'\s*\)\s*\}\}/)
  assert.ok(m, 'no part: matrix dimension found')
  const declared = JSON.parse(m[1])
  // `all` is the scoped-dispatch slice: handled by its own branch, not the table.
  const handled = new Set([...sliceNames(), 'all'])
  for (const part of declared)
    assert.ok(handled.has(part), `matrix declares part "${part}" but no branch runs it`)
})
