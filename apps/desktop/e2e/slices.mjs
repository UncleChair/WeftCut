// How electron-ci spreads one e2e run across runners, and the one home for it.
// Three consumers read this file: the workflow's E2E step (through the `--shell`
// mode at the bottom), scripts/e2e-split.test.mjs (the gate against a spec that
// ends up on no runner), and scripts/run-e2e.mjs (`--slice=<name>`, which
// reproduces a CI slice locally).
//
// It owns the file-to-slice mapping and which slices each OS runs, and nothing
// more: what the two variables do to a run is playwright.config.ts
// (§WEFTCUT_E2E_ONLY), and the orthogonal per-PR/nightly tier split is
// e2e/README.md §Tiers.
import path from "node:path";
import { fileURLToPath } from "node:url";

/// One entry per slice, in `part:` matrix order. A slice either OWNS the spec
/// files it names or, with `own: []`, is the catch-all that takes everything the
/// others named — so a new spec joins the catch-all with no entry here, and only
/// the files whose cost is structural (the export matrices) are maintained.
///
/// Five is the useful maximum, not a budget: the split is per FILE, so no leg
/// finishes sooner than the single most expensive spec file, and the pack is
/// already at that floor — a sixth slice would only shorten legs that are not
/// the long pole. A drifted split is rebalanced by naming one more heavy file
/// here, measured from the `e2e-timings-<os>-<slice>` artifacts every leg
/// publishes.
///
/// Each extra rides exactly ONE slice, so that neither the machine-exclusive
/// project (`serial`, which also captures the determinism PNGs), packaging
/// (`package`), nor the software-lane family media (`decodeBench`, read only by a
/// @serial spec) lands on whichever slice is already the worst case. The
/// flag-carrying slices lead the table because every OS has to run them (see
/// OS_SLICES), and the workflow's `if:` conditions for those three steps must
/// name the same slices these flags do.
///
/// scripts/e2e-split.test.mjs asserts the invariants per OS — one catch-all, one
/// carrier per flag, no file owned twice, every named spec on disk, and the
/// workflow's own conditions agreeing with these flags.
export const SLICES = [
  { name: "audio", own: ["audio.spec.ts"], serial: true, decodeBench: true },
  {
    name: "codecs",
    own: ["export_codecs.spec.ts", "conformance.spec.ts"],
    package: true,
  },
  { name: "overlap", own: ["export_overlap_same_source.spec.ts"] },
  { name: "range", own: ["export-range-audio.spec.ts", "export_eos_tail.spec.ts"] },
  { name: "rest", own: [] },
];

/// Which slices an OS runs, keyed by its `os:` matrix label. Sized per OS rather
/// than uniformly: macOS's whole suite is a third shorter than the other two and
/// playwright.config.ts gives its parallel project 2 workers where the GPU-less
/// legs get 1, so three slices already put its longest leg under the single-file
/// floor the Windows legs cannot beat. A fourth would spend macOS concurrency —
/// capped account-wide, and the binding constraint on this matrix — to shorten a
/// leg that is not on the critical path.
///
/// LANDMINE — this map, not SLICES alone, is what an ignore set must be computed
/// from. Union the whole table instead and macOS's catch-all ignores the files of
/// slices macOS does not run: those specs then run on NO macOS leg, while every
/// leg still reports green. The workflow's matrix `exclude:` is the other half of
/// the same fact and has to agree with this map (asserted in
/// scripts/e2e-split.test.mjs).
export const OS_SLICES = {
  "windows-latest": sliceNames(),
  "ubuntu-latest": sliceNames(),
  "macos-latest": ["audio", "codecs", "rest"],
};

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

/// The slices one OS runs, as table entries, in map order. The single resolver
/// for OS_SLICES so that both ways it can silently produce a wrong ignore set —
/// an OS label the map does not know, and a name in the map no slice answers
/// to — throw at the one place both are visible.
export function slicesFor(os) {
  const names = OS_SLICES[os];
  if (!names) {
    throw new Error(`unknown OS "${os}" — expected one of ${Object.keys(OS_SLICES).join(", ")}`);
  }
  return names.map((name) => {
    const slice = SLICES.find((s) => s.name === name);
    if (!slice) {
      throw new Error(`${os} is mapped to e2e slice "${name}", which is not in the table`);
    }
    return slice;
  });
}

/// The two variables playwright.config.ts consumes, for one slice on one OS. The
/// catch-all's ignore set is the union over the slices THAT OS runs, which is the
/// whole reason the OS is a parameter (OS_SLICES carries what goes wrong without
/// it). Omitting it means the full table — the shape a local `--slice=` replay
/// wants, where one machine stands in for every leg; CI always names it.
///
/// Every way the matrix can disagree with this table throws, because each of them
/// is a leg doing the wrong amount of work while still reporting green: an unknown
/// slice name or OS label would leave an empty restriction, under which that one
/// runner repeats the whole suite, and a slice the named OS does not run is a
/// `part` the matrix should have excluded rather than a leg to skip.
export function sliceEnv(name, os) {
  const runs = os === undefined ? SLICES : slicesFor(os);
  const slice = runs.find((s) => s.name === name);
  if (!slice) {
    throw new Error(
      SLICES.some((s) => s.name === name)
        ? `e2e slice "${name}" is not one ${os} runs (${runs.map((s) => s.name).join(", ")}) — exclude that part from the matrix instead`
        : `unknown e2e slice "${name}" — expected one of ${sliceNames().join(", ")}`,
    );
  }
  return slice.own.length
    ? { WEFTCUT_E2E_ONLY: slice.own.join(","), WEFTCUT_E2E_IGNORE: "" }
    : { WEFTCUT_E2E_ONLY: "", WEFTCUT_E2E_IGNORE: runs.flatMap((s) => s.own).join(",") };
}

/// The `part:` matrix values, in order.
export function sliceNames() {
  return SLICES.map((slice) => slice.name);
}

/// `node e2e/slices.mjs --shell <part> <os>` → two assignments for `eval`, which
/// is how the table reaches electron-ci's E2E step. Both matrix dimensions, since
/// the ignore set is per OS.
///
/// Shell variables and NOT $GITHUB_ENV: the step exports the two variables in a
/// subshell around the parallel Playwright invocation only. Written to
/// $GITHUB_ENV they would reach the serial run too, narrowing the serial project
/// to the sliced files — no @serial test lives in any of them, and Playwright
/// kills the whole leg with "No tests found" before a spec runs.
function shellAssignments(name, os) {
  const { WEFTCUT_E2E_ONLY, WEFTCUT_E2E_IGNORE } = sliceEnv(name, os);
  return `OWN='${WEFTCUT_E2E_ONLY}'\nIGN='${WEFTCUT_E2E_IGNORE}'\n`;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--shell");
  const [part, os] = flag === -1 ? [] : process.argv.slice(flag + 1, flag + 3);
  if (!part || !os) {
    console.error(
      `usage: node e2e/slices.mjs --shell <${sliceNames().join("|")}> <${Object.keys(OS_SLICES).join("|")}>`,
    );
    process.exitCode = 1;
  } else {
    // A disagreement throws out of here: nothing reaches stdout, so the caller's
    // `$(…)` assignment fails instead of eval'ing an empty restriction.
    process.stdout.write(shellAssignments(part, os));
  }
}
