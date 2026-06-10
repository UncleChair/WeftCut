// Node-side (wdio runner) helpers that write user Motifs DIRECTLY on disk —
// deliberately bypassing every app command, because the file watcher and the
// staleness check exist precisely for out-of-band disk changes. The path
// mirrors Tauri's app_config_dir on Windows: %APPDATA%/<identifier> (the
// e2e app under test is the real debug build, identifier dev.weftcut.desktop,
// per src-tauri/tauri.conf.json).
import path from "node:path";
import fs from "node:fs";

export const MOTIFS_ROOT = path.join(
  process.env.APPDATA,
  "dev.weftcut.desktop",
  "motifs",
);

/// A minimal valid single-file Motif: manifest island + a solid `color` box
/// filling the whole 320×320 document (an unambiguous center-pixel assert).
/// `props_schema` is a required manifest field (empty = no props).
export function motifHtml({ id, version, color, name = "E2E User Motif" }) {
  const manifest = {
    id,
    name,
    version,
    size: [320, 320],
    default_duration_s: 4,
    props_schema: {},
  };
  return `<!doctype html><html><head><meta charset="utf-8">
<script type="application/json" id="motif-manifest">${JSON.stringify(manifest)}</script>
<style>html,body{margin:0;background:transparent}#box{width:320px;height:320px;background:${color}}</style>
</head><body><div id="box"></div>
<script>motif.define({ setup() {} });</script>
</body></html>`;
}

export function writeUserMotif(opts) {
  const dir = path.join(MOTIFS_ROOT, opts.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), motifHtml(opts));
}

export function removeUserMotif(id) {
  fs.rmSync(path.join(MOTIFS_ROOT, id), { recursive: true, force: true });
}
