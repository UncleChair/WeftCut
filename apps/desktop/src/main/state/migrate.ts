// apps/desktop/src/main/state/migrate.ts
//
// The version-keyed upgrade chain for `project.json`. One step per schema
// generation, applied in sequence: v_n → v_n+1 → … → the build's version.
// `persistence.ts` owns the refusals (missing/non-numeric version, a file NEWER
// than the build) and calls in here for everything older.
//
// THE ONE RULE this file exists to enforce: a shape CONVERSION is a step here,
// with a version number attached. It is NOT an unconditional rewrite in
// `parseProject`. The version-blind normalize pass over there is for DEFAULTS
// (an additive optional field materializing) and VALIDITY REPAIRS (off-grid
// geometry, a flag that contradicts the data it describes) — both of which are
// idempotent statements about the *current* shape and carry no version. A
// conversion states "the shape used to be X and is now Y", which is exactly what
// a version number is for. Before this file existed the codebase had no way to
// say that, so three conversions rode the blind pass and the version never moved
// (see ADR 0047).
//
// WHY THIS FILE IMPORTS NOTHING FROM ./model — and must keep importing nothing:
// a step is a frozen statement about a shape that has already passed into
// history. If a step read `SCHEMA_VERSION`, a type, or `defaultSettings()` from
// the live model, it would silently re-anchor to whatever the model looks like
// years later — the step's meaning would change without the step being edited,
// and the failure would only ever surface on a real user's old file. So every
// step works on the WIRE object (`Record<string, unknown>`), declares local
// types for just the fields it touches, and writes frozen literals. There is no
// linter in this repo; `migrate.contract.test.ts` asserts the import ban by
// reading this file's source.
//
// The runner — never a step — owns `schema_version`: a step that had to stamp
// its own output version could forget, and a forgotten stamp is silent (the next
// step's `from` would not match and the walk would report a hole that isn't one).

/** The oldest on-disk schema version this build can upgrade FROM.
 *
 *  v1 is the first PUBLISHED format. Nothing before it was ever released — the
 *  pre-release builds cut over rather than migrating (`docs/data-model.md`
 *  §Versioning) — so there is deliberately no step below this floor and a file
 *  claiming one is refused rather than guessed at. */
export const MIN_SCHEMA_VERSION = 1

export interface MigrationStep {
  /** The schema version this step READS. It produces `from + 1`. */
  from: number
  /** Convert the wire object in place. Receives the runner's private clone, so
   *  mutation is safe and expected; the caller's object is never touched. */
  apply(wire: Record<string, unknown>): void
}

/** The chain, in ascending `from` order.
 *
 *  EMPTY at v1, and that is the correct state — not an unfinished one. The
 *  format has shipped exactly one generation, so there is nothing to upgrade
 *  from yet. The first entry lands with the first post-v1 schema change, and
 *  `migrate.completeness.test.ts` fails the build if a `SCHEMA_VERSION` bump
 *  arrives without one (and without its committed fixture). */
export const STEPS: readonly MigrationStep[] = []

export interface UpgradeOutcome {
  /** The wire object at the target version. Identical reference to the input
   *  when nothing ran; a clone when it did. */
  wire: Record<string, unknown>
  /** The version the input was at. */
  from: number
}

/** Walk `wire` from its own version up to `to`.
 *
 *  `steps` is injectable so the machinery can be tested against synthetic steps:
 *  with a real chain of length zero, nothing else could exercise the walk, the
 *  stamping, or the hole report until the first real bump — and "the migration
 *  runner was first exercised in production" is not a sentence anyone wants to
 *  write. Production always passes the default.
 *
 *  Clones once up front rather than mutating in place: a step that throws
 *  half-way leaves the caller's object untouched, so the error path can report
 *  the ORIGINAL file rather than a half-upgraded hybrid. */
export function upgradeWire(
  wire: Record<string, unknown>,
  from: number,
  to: number,
  steps: readonly MigrationStep[] = STEPS,
): UpgradeOutcome {
  if (from === to) return { wire, from }
  if (from > to) {
    // Defensive: persistence.ts refuses newer-than-build before we are called.
    throw new Error(`project schema v${from} is ahead of v${to}; there is no downgrade path`)
  }
  if (from < MIN_SCHEMA_VERSION) {
    throw new Error(
      `project schema v${from} predates the oldest upgradable version (v${MIN_SCHEMA_VERSION}) — ` +
      `re-create the project in a fresh workspace.`,
    )
  }

  const out = structuredClone(wire)
  for (let v = from; v < to; v += 1) {
    const step = steps.find((s) => s.from === v)
    if (step === undefined) {
      // Unreachable while the completeness test is green — it asserts the chain
      // covers every version from MIN to current. Kept because "unreachable"
      // depends on a test staying green, and a wrong upgrade is worse than a
      // refused open.
      throw new Error(
        `no upgrade step from project schema v${v} to v${v + 1}: the migration chain is incomplete ` +
        `(this build reads v${to}).`,
      )
    }
    step.apply(out)
    out.schema_version = v + 1
  }
  return { wire: out, from }
}
