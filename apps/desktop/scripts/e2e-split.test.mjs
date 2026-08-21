import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/// electron-ci splits one e2e run across runners by NAMING spec files (the E2E
/// step's `case` arms) and giving one leg everything that was not named. The
/// split is therefore only correct if the named set and the ignored set are the
/// same set — and the way it breaks is silent: a name in the ignore list with no
/// leg owning it runs NOWHERE, on no runner, reported as green by all of them.
/// Nothing else can catch that. A rename, by contrast, is loud (the owning leg
/// collects zero tests and Playwright fails it), but is cheaper to catch here.
///
/// The workflow is the source of truth; this deduces from its text rather than
/// restating the list, so there is still one home for it.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..')
const WORKFLOW = path.resolve(DESKTOP, '..', '..', '.github', 'workflows', 'electron-ci.yml')

const yml = readFileSync(WORKFLOW, 'utf8')

const names = (list) =>
  list
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)

/** The `HEAVY='a,b,c'` assignment the catch-all leg ignores. */
function ignored() {
  const m = yml.match(/^\s*HEAVY='([^']+)'/m)
  assert.ok(m, 'no HEAVY=... assignment in the E2E step — did the split change shape?')
  return names(m[1])
}

/** Every spec file a case arm claims via `OWN='…'`, flattened. */
function owned() {
  const found = [...yml.matchAll(/^\s*\w+\)\s+OWN='([^']+)'/gm)].flatMap((m) => names(m[1]))
  assert.ok(found.length > 0, 'no leg owns any spec file — the split would run nothing')
  return found
}

test('every ignored spec file is owned by exactly one e2e leg', () => {
  const own = owned()
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
  // `all` is the scoped-dispatch slice: handled by its own branch, not a case arm.
  const handled = new Set([
    ...[...yml.matchAll(/^\s*(\w+)\)\s+(?:OWN|IGN)=/gm)].map((x) => x[1]),
    'all',
  ])
  for (const part of declared)
    assert.ok(handled.has(part), `matrix declares part "${part}" but no branch runs it`)
})
