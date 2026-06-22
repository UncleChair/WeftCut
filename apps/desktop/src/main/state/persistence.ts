// apps/desktop/src/main/state/persistence.ts
//
// The PURE on-disk persistence surface — mirrors native/src/io/mod.rs (save/load)
// + native/src/io/migrate.rs (the schema-version gate). No node:fs here: the file
// read/write/delete shell + the workspace/cache/LogBus/recents/jobs orchestration
// stay in Rust until Phase 3c wires this module's pure functions into the
// project_open/save_as/new_workspace cutover. Filesystem/platform impurities are
// injected (`join` for path reconcile) or returned (quick-proxy files to delete).
import { SCHEMA_VERSION, type Project } from './model'
import { serializeProject, parseProject } from './serialize'

/** io/mod.rs:25 — serde_json::to_string_pretty (2-space indent, NO trailing
 *  newline; fs::write writes the string verbatim). Round-trip fidelity, not
 *  byte-identical key order vs Rust, is the contract (see Task 5). */
export function serializeProjectToJson(p: Project): string {
  return JSON.stringify(serializeProject(p), null, 2)
}

/** io/migrate.rs:20 run — the schema-version gate. Equal → ok; below → re-create
 *  in a fresh workspace; above → update the app. Pre-release: no migration path. */
export function schemaGate(project: unknown): void {
  const v = (project as { schema_version?: unknown })?.schema_version
  if (v === SCHEMA_VERSION) return
  if (typeof v === 'number' && v < SCHEMA_VERSION) {
    throw new Error(
      `project schema v${v} is below the supported minimum v${SCHEMA_VERSION}. ` +
      `Pre-release builds don't migrate older \`.vproj\` folders forward — ` +
      `re-create the project in a fresh workspace.`,
    )
  }
  if (typeof v === 'number') {
    throw new Error(`project schema v${v} is newer than this build (v${SCHEMA_VERSION}). Update the app.`)
  }
  throw new Error(`project schema version is missing or non-numeric (expected ${SCHEMA_VERSION})`)
}

/** io/mod.rs:57 — deserialize project.json text → Project, gated on schema version.
 *  JSON.parse throws on malformed text; schemaGate runs BEFORE the structural cast
 *  so the rich version-specific guidance wins over parseProject's generic check. */
export function parseProjectJson(text: string): Project {
  const json: unknown = JSON.parse(text)
  schemaGate(json)
  return parseProject(json)
}
