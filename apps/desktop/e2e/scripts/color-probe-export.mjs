// Axis-A Stage-0 probe (one-shot diagnostic, NOT a gate). Given a REAL WeftCut
// export of the 709ltd color chart, it (1) ffprobes the output's color tags and
// (2) decodes the output under all four (matrix,range) combos and reports total
// error vs authored RGB — the combo with the lowest error reveals the matrix the
// app's encoder ACTUALLY used. If the output carries no/!=expected tags, that is
// itself the finding that decides whether the axis-A gate needs an export
// color-tagging product fix first.
//
//   node scripts/color-probe-export.mjs <path-to-real-exported-709ltd.mp4>
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { analyzeColor } from "../lib/analyze.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");
const MANIFEST = path.resolve(MEDIA, "color_manifest.json");
const SOURCE = path.resolve(MEDIA, "test_1080p_color_709ltd.mp4");
const OUTPUT = process.argv[2];

if (!OUTPUT || !existsSync(OUTPUT)) {
  console.error("usage: node color-probe-export.mjs <exported-709ltd.mp4>");
  console.error("  (provide a REAL WeftCut export of the 709ltd chart)");
  process.exit(2);
}

const tags = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=pix_fmt,color_space,color_transfer,color_primaries,color_range",
  "-of", "default", OUTPUT,
], { encoding: "utf8" });
console.log("=== OUTPUT TAGS ===\n" + tags.stdout);

console.log("=== TOTAL ERROR vs authored RGB, per decode matrix (LOWEST = encoder's real matrix) ===");
for (const [im, ir] of [["bt709", "tv"], ["smpte170m", "tv"], ["bt709", "pc"], ["smpte170m", "pc"]]) {
  const r = analyzeColor({ output: OUTPUT, source: SOURCE, manifest: MANIFEST, inMatrix: im, inRange: ir, sample: 10 });
  const worstTotal = Math.max(...r.patches.flatMap((p) => p.total_error.max));
  console.log(`${im}/${ir}: worst_total_max=${worstTotal}  worst_app_max=${r.worst_app_max}`);
}
console.log("\nInterpretation: the (matrix,range) row with the lowest worst_total_max is what the");
console.log("app's H.264 encoder actually produced. Compare against the OUTPUT TAGS: if the tag is");
console.log("absent or disagrees with the best-matching matrix, the export is mis/un-tagged (a finding).");
