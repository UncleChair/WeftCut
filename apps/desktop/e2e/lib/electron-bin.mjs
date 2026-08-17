// Where the repo's own Electron binary lives — the one `npm install` unpacked
// into node_modules — for the local gates and benchmarks that launch it
// directly rather than through the Playwright fixture.
//
// The executable is NOT called `electron` everywhere: on macOS it is
// `Electron.app/Contents/MacOS/Electron`. The electron package records the
// right name in `dist/`'s sibling `path.txt`, so reading that file is what
// makes this correct on all three platforms. The win32 ternary survives only as
// a fallback for a checkout whose `path.txt` is missing.
//
// Deliberately NOT `import("electron")`. That module resolves the same path
// correctly, but its module-evaluation side effect is to *download* a missing
// binary — every caller here would rather be told the binary is absent than
// have a gate silently turn into a network fetch.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");

/// The path Electron *should* be at. It may not exist — deciding what a missing
/// binary means belongs to the caller, and the callers disagree: the f16 parity
/// gate exits BLOCKED, `playback-perf.mjs` and `ruler-node-count.mjs` fall back
/// to Playwright's own resolution by passing `executablePath: undefined`, and
/// `memory-ratchet.mjs` hands the path over unchecked and lets the launch fail.
export function electronBinPath() {
  const dir = path.join(REPO, "node_modules", "electron");
  const nameFile = path.join(dir, "path.txt");
  const name = existsSync(nameFile)
    ? readFileSync(nameFile, "utf8").trim()
    : process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(dir, "dist", name);
}
