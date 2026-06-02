import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

// Runs the media_conformance bin and returns the parsed JSON report. The bin
// prints the report on stdout for exit 0 (pass) AND 1 (regression); exit 2/3
// (bad args / hard error) print only to stderr. So we parse stdout first and
// only throw when there's no parseable report.
export function analyze({ output, source, samples }) {
  const r = spawnSync(
    "cargo",
    [
      "run", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml",
      "--bin", "media_conformance", "--quiet", "--",
      "--output", output, "--source", source, "--samples", samples.join(","),
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `media_conformance exit ${r.status}: ${r.stdout}\n${r.stderr}`,
    );
  }
}
