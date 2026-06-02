import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE is apps/desktop/e2e/lib — four levels below the repo root. (wdio.conf is
// one level up at apps/desktop/e2e, hence its three `..`; this file needs four.)
const REPO = path.resolve(HERE, "..", "..", "..", "..");

// Runs the media_conformance bin and returns the parsed JSON report. The bin
// prints the report on stdout for exit 0 (pass) AND 1 (regression); exit 2/3
// (bad args / hard error) print only to stderr. So we parse stdout first and
// only throw when there's no parseable report.
export function analyze({ output, source, samples, ssimMin, audio }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml",
    "--bin", "media_conformance", "--quiet", "--",
    "--output", output, "--source", source, "--samples", samples.join(","),
  ];
  if (ssimMin != null) args.push("--ssim-min", String(ssimMin));
  if (audio) args.push("--audio");
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `media_conformance exit ${r.status}: ${r.stdout}\n${r.stderr}`,
    );
  }
}
