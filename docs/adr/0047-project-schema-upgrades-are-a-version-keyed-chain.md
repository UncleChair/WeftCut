---
status: accepted
---

# Project-schema upgrades are a version-keyed chain, and conversions may live nowhere else

## Context

`project.json` carries a `schema_version`. Until now the load path was a
**cut-over gate**: the version had to equal the build's `SCHEMA_VERSION` or the
file was refused — older with "re-create the project in a fresh workspace", newer
with "update the app". Pre-release that was the right trade, and
`docs/data-model.md` said so plainly: maintaining migration code for formats
nobody has is pure overhead.

The trade has a one-way expiry. The moment the format ships, the first bump makes
every existing user project unopenable, and a chain added afterwards cannot
rescue files already written. So the gate had to be replaced *before* release,
not after — which is why this was a v1 blocker rather than a nice-to-have.

It also had a second cost, and that one was already being paid. Because a bump
would have refused to open the very files a change needed to fix, three shape
**conversions** shipped as unconditional rewrites inside `parseProject`'s
normalize pass instead:

- `anchor: [x, y]` → the `anchor_x` / `anchor_y` animated tracks
- the retired `EaseIn` / `EaseOut` interp kinds → their baked cubic béziers
- `scale_linked` derived from a twin check when the field was absent

Each was correct in isolation and each carried a comment explaining that the
schema gate left no alternative. Together they had drifted the on-disk shape
across three generations while the version number sat still — so the version no
longer described the shape, and a file's version told you nothing about which of
the three rewrites it needed. The rewrites could not even have been converted
into version-keyed steps retroactively: every file they targeted claims the same
version as a current one.

Nothing has been released, so there is no v10 file in the world that matters and
no user to migrate.

## Decision

**1. The load path becomes a version-keyed upgrade chain.** `state/migrate.ts`
owns `MIN_SCHEMA_VERSION`, an ordered `STEPS` table of `v_n → v_n+1` functions,
and the runner that walks them. `state/persistence.ts` keeps the two refusals —
a missing/non-numeric version, and a version *ahead* of the build — and an older
version becomes the chain's input rather than an error. The refusal for a newer
file drops its "update the app" guess: the file that trips it most often is a
`.vproj` written by a different build of this repo.

**2. `SCHEMA_VERSION` resets to 1.** v1 is the first published format. Keeping 10
would have meant a floor with nine phantom generations no step covers and no
fixture records. The cost is that pre-release `.vproj` folders stop opening —
which the reset makes explicit instead of leaving them to a rewrite that silently
half-understands them.

**3. The two dead conversions are deleted, and the boundary is now a rule:**

> The version-blind normalize pass in `parseProject` owns **defaults** (an
> additive optional field materializing) and **validity repairs** (off-grid
> geometry, a flag that contradicts the data it describes). Both are idempotent
> statements about the *current* shape. Every shape **conversion** — a field
> renamed, merged, split, retyped, or an enum variant retired — is a step in the
> chain, with a version number attached.

`convergeNamedEases` and `backfillAnchorTracks` are gone with the formats they
read. `backfillScaleLinked` becomes `normalizeScaleLinked`, keeping the two halves
that sit on the right side of the line and dropping the one that did not: an
absent flag gets the **default** `false`, a `true` the tracks contradict is
**repaired** to false (the collapsed Scale UI would otherwise hide a divergent
`scale_y`), and the flag is no longer **inferred** from a twin check — equal tracks
are not evidence that the user asked them to move as one, and linking is the
destructive direction. The settings default spread and `repairGrid` stay exactly
where they are; both were always defaults-and-repairs.

**4. A step may import nothing.** Steps take the wire object
(`Record<string, unknown>`), declare local types for only the fields they touch,
and write frozen literals. `migrate.ts` imports nothing at all — not
`SCHEMA_VERSION` (the target version is a parameter), not a model type, not
`defaultSettings()`. A step is a frozen statement about a shape that has passed
into history; anything it reads from the live model would silently re-anchor it to
whatever that model becomes, and the failure would surface only on a real user's
old file.

**5. The runner owns the version stamp and the clone.** It writes
`schema_version` after each step (a step that had to stamp its own output could
forget, and a forgotten stamp reads as a hole in the chain) and it clones the
input once up front, so a step that throws mid-walk leaves the caller holding the
original bytes rather than a half-upgraded hybrid.

**6. Upgrading is in-memory; the pre-upgrade bytes are preserved.** `project.json`
is not rewritten on open — the existing autosave overwrites it on the first edit,
as it always has. But when the chain runs, `openProject` first copies the original
text to `project.pre-v{n}.json` beside it, and reports the upgrade as a status-log
row naming that file. The copy deliberately does **not** go in `Backups/`: those
snapshots are taken *after* a write and are gc'd to the 20 newest, so the one file
that can undo a bad migration step would be both already-upgraded and
collectable. A failed copy does not block the open, and the row then says the
original could not be preserved rather than implying a safety net.

**7. Rust holds no version constant.** `native/src/state/project.rs` keeps the
`schema_version` field — it deserializes whole projects for export and audio mix —
but its `SCHEMA_VERSION` constant is deleted. Rust never reads the value, never
gates on it and never writes a project to disk, so the constant was a version
claim with no reader, kept in sync by nothing. The field's doc comment now names
TS as the owner. Test fixtures in the crate write a literal.

**8. The rule is a test, not a convention.** `migrate.completeness.test.ts`
asserts that `MIN_SCHEMA_VERSION + STEPS.length === SCHEMA_VERSION`, that the
steps sit at exactly the versions in between, and that every version from the
floor to the build's — inclusive — has a frozen fixture under
`fixtures/projects/`, each of which still upgrades and passes `parseProject` +
`validate`. A bump without its step, or a step without its fixture, is a red test.
`migrate.contract.test.ts` enforces the import ban by reading the source, because
this repo has no linter.

## Consequences

- A `SCHEMA_VERSION` bump now costs a step, a fixture, and the same-PR discipline
  the completeness test enforces. That is the intended price: the alternative was
  paying it once, at the first post-release bump, with users' files.
- The fixtures are frozen artefacts with no generator. Regenerating one from the
  current model would re-anchor it to today's shape, and the step it guards would
  then be tested against its own output.
- The chain ships **empty** at v1, and the completeness assertions hold
  vacuously. What is actually proven today is the runner, exercised against
  synthetic steps injected by its unit test, and the upgrade wiring in
  `openProject`, exercised with the loader's `upgradedFrom` forced. The first real
  step is the first time the chain carries load.
- Pre-release `.vproj` folders (schema 8, 9, 10 — dev machines only) no longer
  open. They report the version mismatch rather than being partially understood.
- The upgrade path cannot be gated by e2e until a second generation exists: with
  one generation there is no older file to hand the app.
- **Supersedes the no-migration policy** wherever earlier records lean on it —
  [ADR 0028](0028-persist-decode-route-as-folded-enum.md) ("a cut-over schema
  bump … projects below the new `SCHEMA_VERSION` are rejected and re-created") and
  [ADR 0026](0026-captions-as-text-layers.md) (the v8 → v9 bump under the same
  gate). Both were true when written and stand as the record of it; a change of
  either shape today ships a step.
