import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { OS_SLICES, SLICES, sliceEnv, sliceNames, slicesFor } from '../e2e/slices.mjs'

/// electron-ci splits one e2e run across runners by NAMING spec files and giving
/// one leg everything that was not named. The split is therefore only correct if
/// the named set and the ignored set are the same set — and the way it breaks is
/// silent: a name in the ignore list with no leg owning it runs NOWHERE, on no
/// runner, reported as green by all of them. Nothing else can catch that. A
/// rename, by contrast, is loud (the owning leg collects zero tests and
/// Playwright fails it), but is cheaper to catch here.
///
/// Everything below is asserted PER OS, because the two sets are per OS: an OS
/// that runs fewer slices has fewer owners, so one union over the whole table
/// would land exactly that failure on that OS alone — every leg of every OS
/// green, one OS quietly short of coverage.
///
/// e2e/slices.mjs is the source of truth and derives each ignore set from the
/// owned ones, so the two-lists-disagree shape is gone by construction; what is
/// asserted here is that derivation plus the table's own invariants. The workflow
/// still owns facts no module can hold — the parts and the (os, part) exclusions
/// it declares, which invocation the restriction reaches, and which slice each
/// once-per-OS extra is gated to — and those tests read its text.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..')
const WORKFLOW = path.resolve(DESKTOP, '..', '..', '.github', 'workflows', 'electron-ci.yml')

const yml = readFileSync(WORKFLOW, 'utf8')

const OSES = Object.keys(OS_SLICES)

const names = (list) =>
  list
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)

/** The catch-all slice one OS runs — the leg that takes what its siblings did not. */
const catchAllOn = (os) => {
  const found = slicesFor(os).filter((slice) => slice.own.length === 0)
  assert.equal(
    found.length,
    1,
    `${os} must run exactly one catch-all slice: two would each run the whole unclaimed set, and none would leave every unnamed spec on no runner at all — it runs ${found.length}`,
  )
  return found[0]
}

/** What that OS's catch-all leg is told to ignore. */
const ignoredOn = (os) => names(sliceEnv(catchAllOn(os).name, os).WEFTCUT_E2E_IGNORE)

/** Every spec file the slices of one OS claim, flattened. */
const ownedOn = (os) => slicesFor(os).flatMap((slice) => slice.own)

/** The one slice a single-occupancy flag rides. */
const carrier = (flag) => {
  const found = SLICES.filter((slice) => slice[flag])
  assert.equal(found.length, 1, `exactly one slice may carry \`${flag}\`, not ${found.length}`)
  return found[0].name
}

/** The `if:` condition of a named workflow step, as its raw line. */
const stepIf = (step) => {
  const lines = yml.split('\n')
  const at = lines.findIndex((line) => line.trim() === `- name: ${step}`)
  assert.notEqual(at, -1, `no workflow step is named "${step}"`)
  const next = lines.findIndex((line, i) => i > at && /^\s*- (name|uses):/.test(line))
  const condition = lines
    .slice(at + 1, next === -1 ? undefined : next)
    .find((line) => /^\s*if:/.test(line))
  assert.ok(condition, `the "${step}" step has no if: condition, so every slice runs it`)
  return condition
}

test('every ignored spec file is owned by exactly one leg of the same OS', () => {
  for (const os of OSES) {
    const own = ownedOn(os)
    assert.ok(own.length > 0, `no leg of ${os} owns any spec file — the split would run nothing`)
    const counts = new Map()
    for (const n of own) counts.set(n, (counts.get(n) ?? 0) + 1)
    const twice = [...counts].filter(([, c]) => c > 1).map(([n]) => n)
    assert.deepEqual(twice, [], `these spec files are owned by two legs of ${os}, so they run twice`)
    assert.deepEqual(
      [...own].sort(),
      [...ignoredOn(os)].sort(),
      `on ${os} the named legs and the catch-all’s ignore list disagree: a file in one but not the other either runs twice or never runs at all`,
    )
  }
})

test('every spec file the split names still exists', () => {
  for (const name of SLICES.flatMap((slice) => slice.own)) {
    const spec = path.join(DESKTOP, 'e2e', 'electron', name)
    assert.ok(existsSync(spec), `${name} is named by the e2e split but no such spec exists`)
  }
})

test('every OS runs exactly one carrier of each once-per-OS extra', () => {
  // Single-occupancy per OS, each for its own reason: the determinism artifact
  // name is unsliced, so a second uploader is a hard conflict; packaging twice
  // per OS is waste on whichever slice is already the worst case; and the
  // decode-bench media is 1.8 GB that only the serial project's reader needs.
  // ZERO carriers is the quiet half of the same failure — an OS that runs none
  // of them never packages, never captures determinism PNGs, and self-skips the
  // software-lane family gates, all while reporting green. That is why the
  // flag-carrying slices have to be slices EVERY OS runs.
  for (const os of OSES) {
    for (const flag of ['serial', 'package', 'decodeBench']) {
      const found = slicesFor(os).filter((slice) => slice[flag])
      assert.deepEqual(
        found.map((slice) => slice.name),
        [carrier(flag)],
        `${os} must run exactly the one slice carrying \`${flag}\``,
      )
    }
  }
})

test('a named slice restricts to its own files and ignores nothing', () => {
  // The two variables are exclusive by design (playwright.config.ts turns ONLY
  // into `testMatch`): a slice that set both would ignore files it also owns,
  // and an empty ONLY makes `testMatch` undefined — the whole suite, on that leg
  // and on the catch-all both.
  for (const os of OSES) {
    for (const slice of slicesFor(os).filter((s) => s.own.length)) {
      const env = sliceEnv(slice.name, os)
      assert.deepEqual(names(env.WEFTCUT_E2E_ONLY), slice.own)
      assert.equal(env.WEFTCUT_E2E_IGNORE, '')
    }
  }
})

test('naming no OS means the whole table, which is what a local replay wants', () => {
  // scripts/run-e2e.mjs's `--slice=<name>` reproduces one CI leg on one machine,
  // where there are no sibling legs to absorb a remainder: the full table is the
  // only shape under which every named file still runs somewhere. CI always
  // passes the OS, so this default never reaches a runner.
  const everything = SLICES.flatMap((slice) => slice.own)
  const catchAll = SLICES.find((slice) => slice.own.length === 0)
  assert.deepEqual(names(sliceEnv(catchAll.name).WEFTCUT_E2E_IGNORE), everything)
  for (const slice of SLICES.filter((s) => s.own.length))
    assert.deepEqual(names(sliceEnv(slice.name).WEFTCUT_E2E_ONLY), slice.own)
})

test('an unknown slice name is loud rather than an empty restriction', () => {
  // The failure mode this guards: a typo in the `part:` matrix resolving to no
  // restriction, under which that runner silently repeats the entire suite.
  assert.throws(() => sliceEnv('overlaps'), /unknown e2e slice/)
  assert.throws(() => sliceEnv('overlaps', OSES[0]), /unknown e2e slice/)
})

test('a slice its OS does not run is loud rather than a silent skip', () => {
  // Both halves of the (os, part) space that the matrix must not produce. An
  // unknown OS label would compute the ignore set from the wrong slice set; a
  // part the named OS does not run is one the matrix should have excluded, and
  // letting the leg quietly do nothing is how a whole OS loses coverage.
  assert.throws(() => sliceEnv(sliceNames()[0], 'freebsd-latest'), /unknown OS/)
  const skipped = OSES.flatMap((os) =>
    sliceNames()
      .filter((name) => !OS_SLICES[os].includes(name))
      .map((name) => [os, name]),
  )
  assert.ok(skipped.length > 0, 'no OS runs a subset of the table — this guard is untested')
  for (const [os, name] of skipped)
    assert.throws(() => sliceEnv(name, os), /is not one .* runs/, `${os} / ${name}`)
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

test('the E2E step passes both matrix dimensions to the table', () => {
  // Which slices exist is per OS, so the ignore set is too. Pass the part alone
  // and the module falls back to the whole table — under which the OSes running
  // fewer slices ignore files no leg of theirs owns. That is the silent-skip
  // failure this file exists for, one dropped argument away.
  const invocation = yml.split('\n').find((line) => line.includes('slices.mjs --shell'))
  assert.ok(invocation, 'no leg reads the slice table — the split is not in effect')
  const passed = [...invocation.matchAll(/"\$(\w+)"/g)].map(([, name]) => name)
  assert.equal(passed.length, 2, `--shell needs the part AND the OS: ${invocation.trim()}`)
  for (const variable of passed)
    assert.match(
      yml,
      new RegExp(`^\\s+${variable}: \\$\\{\\{ matrix\\.\\w+ \\}\\}$`, 'm'),
      `$${variable} reaches the table but comes from somewhere other than the matrix`,
    )
})

test('the matrix declares the table’s parts, and excludes exactly what no OS runs', () => {
  const m = yml.match(/part:\s*\$\{\{[^}]*?'(\["[^\]]+\])'\s*\)\s*\}\}/)
  assert.ok(m, 'no part: matrix dimension found')
  // `all` is the scoped-dispatch slice: handled by its own branch, not the table.
  const declared = JSON.parse(m[1]).filter((part) => part !== 'all')
  // In order, not as a set: the table calls itself `part:`-matrix order, and a
  // slice in one and not the other is a leg running the wrong share (a part the
  // table does not know reddens its leg; a slice no part declares runs nowhere).
  assert.deepEqual(declared, sliceNames(), 'the matrix and the slice table disagree')
  const excluded = [...yml.matchAll(/-\s*os:\s*(\S+)\s*\n\s*part:\s*(\S+)/g)].map(
    ([, os, part]) => `${os} ${part}`,
  )
  const unrun = OSES.flatMap((os) =>
    declared.filter((part) => !OS_SLICES[os].includes(part)).map((part) => `${os} ${part}`),
  )
  assert.deepEqual(
    [...excluded].sort(),
    [...unrun].sort(),
    'the matrix `exclude:` and OS_SLICES disagree: an unexcluded leg reddens on a slice its OS does not run, and an excluded slice still listed for that OS makes its files run nowhere on it',
  )
})

test('the steps that ride one slice name the slice its flag marks', () => {
  // The coupling no module can hold: a workflow `if:` cannot call into the
  // table, so each condition repeats a slice name that the table owns.
  const gated = [
    ['Upload determinism artifacts', 'serial'],
    ['Package (unsigned)', 'package'],
    ['Upload installer', 'package'],
    ['Generate software-lane family fixtures (e2e)', 'decodeBench'],
  ]
  for (const [step, flag] of gated) {
    const condition = stepIf(step)
    for (const name of sliceNames())
      assert.equal(
        condition.includes(`'${name}'`),
        name === carrier(flag),
        `the "${step}" step must name slice '${carrier(flag)}' — the \`${flag}\` carrier — and no other: ${condition.trim()}`,
      )
  }
  // The serial PROJECT's own branch, inside the E2E step's script: the same
  // slice as the determinism upload above, or the PNGs are captured on a leg
  // that never uploads them.
  const serial = yml.split('\n').find((line) => line.includes('--project=serial'))
  assert.ok(serial, 'no leg runs the serial project')
  assert.match(
    serial,
    new RegExp(`"\\$PART" = "${carrier('serial')}"`),
    `the serial project must run on the \`serial\` carrier: ${serial.trim()}`,
  )
})
