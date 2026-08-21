// How electron-ci spreads one e2e run across runners, and the one home for it.
// Three consumers read this file: the workflow's E2E step (through the `--shell`
// mode at the bottom), scripts/e2e-split.test.mjs (the gate against a spec that
// ends up on no runner), and scripts/run-e2e.mjs (`--slice=<name>`, which
// reproduces a CI slice locally).
//
// It owns the file-to-slice mapping and nothing else: what the two variables do
// to a run is playwright.config.ts (§WEFTCUT_E2E_ONLY), and the orthogonal
// per-PR/nightly tier split is e2e/README.md §Tiers.
import path from "node:path";
import { fileURLToPath } from "node:url";

/// One entry per runner, in `part:` matrix order. A slice either OWNS the spec
/// files it names or, with `own: []`, is the catch-all that takes everything the
/// others named — so a new spec joins the catch-all with no entry here, and only
/// the files whose cost is structural (the export matrices) are maintained.
///
/// `serial` marks the single slice that also runs the machine-exclusive project
/// and captures the determinism PNGs; `package` the single slice that packages.
/// Each rides one slice so neither lands on whichever is already the worst case,
/// and the workflow's `if:` conditions for the determinism upload and the
/// packaging step must name the same slices these flags do.
///
/// scripts/e2e-split.test.mjs asserts the invariants (one catch-all, one
/// `serial`, one `package`, no file owned twice, every named spec on disk).
/// Rebalance from the `e2e-timings-<os>-<slice>` artifacts when a slice drifts.
export const SLICES = [
  { name: "audio", own: ["audio.spec.ts"] },
  { name: "codecs", own: ["export_codecs.spec.ts"], serial: true },
  {
    name: "overlap",
    own: ["export_overlap_same_source.spec.ts", "export-range-audio.spec.ts"],
    package: true,
  },
  { name: "rest", own: [] },
];

/// Conservative on purpose: `--shell` emits these names inside single quotes for
/// `eval`, so a quote character in one would run arbitrary shell on every runner.
/// Validated at import, which makes every consumer the tripwire, not just CI.
const SPEC_NAME = /^[\w.-]+\.spec\.ts$/;

for (const slice of SLICES) {
  for (const name of slice.own) {
    if (!SPEC_NAME.test(name)) {
      throw new Error(
        `e2e slice "${slice.name}" names "${name}", which is not a plain <file>.spec.ts`,
      );
    }
  }
}

/// The two variables playwright.config.ts consumes, for one slice. An unknown
/// name throws: a typo in the `part:` matrix has to be a red leg, not an empty
/// restriction under which that runner quietly repeats the whole suite.
export function sliceEnv(name) {
  const slice = SLICES.find((s) => s.name === name);
  if (!slice) {
    throw new Error(`unknown e2e slice "${name}" — expected one of ${sliceNames().join(", ")}`);
  }
  return slice.own.length
    ? { WEFTCUT_E2E_ONLY: slice.own.join(","), WEFTCUT_E2E_IGNORE: "" }
    : { WEFTCUT_E2E_ONLY: "", WEFTCUT_E2E_IGNORE: SLICES.flatMap((s) => s.own).join(",") };
}

/// The `part:` matrix values, in order.
export function sliceNames() {
  return SLICES.map((slice) => slice.name);
}

/// `node e2e/slices.mjs --shell <part>` → two assignments for `eval`, which is
/// how the table reaches electron-ci's E2E step.
///
/// Shell variables and NOT $GITHUB_ENV: the step exports the two variables in a
/// subshell around the parallel Playwright invocation only. Written to
/// $GITHUB_ENV they would reach the serial run too, narrowing the serial project
/// to the sliced files — no @serial test lives in any of them, and Playwright
/// kills the whole leg with "No tests found" before a spec runs.
function shellAssignments(name) {
  const { WEFTCUT_E2E_ONLY, WEFTCUT_E2E_IGNORE } = sliceEnv(name);
  return `OWN='${WEFTCUT_E2E_ONLY}'\nIGN='${WEFTCUT_E2E_IGNORE}'\n`;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const part = process.argv.includes("--shell")
    ? process.argv[process.argv.indexOf("--shell") + 1]
    : undefined;
  if (!part) {
    console.error(`usage: node e2e/slices.mjs --shell <${sliceNames().join("|")}>`);
    process.exitCode = 1;
  } else {
    // An unknown name throws out of here: nothing reaches stdout, so the
    // caller's `$(…)` assignment fails instead of eval'ing an empty restriction.
    process.stdout.write(shellAssignments(part));
  }
}
