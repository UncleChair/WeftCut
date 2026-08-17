/// Stage the agent skill folder that ships with the app: the repo's skills/
/// tree plus the docs/ pages a skill tells the agent to read. Both live at the
/// repo root as the single source of truth — docs/motif-authoring.md is read by
/// humans there — so the skill bundle is assembled at build time instead of
/// keeping a second copy in the tree that could drift.
///
/// out/skills/ rides along as an extraResource and the app refreshes
/// <userData>/skills/ from it at startup (src/main/mcp/skillsInstall.ts).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'out', 'skills')

/// Docs copied verbatim into a skill folder, keyed by their destination. A
/// skill references these by bare filename ("read motif-authoring.md next to
/// this file"), so the name must survive the copy.
const DOCS = [{ from: path.join(REPO, 'docs', 'motif-authoring.md'), to: path.join(OUT, 'weftcut', 'motif-authoring.md') }]

// Clean first: a renamed or deleted skill file must not survive in the bundle.
fs.rmSync(OUT, { recursive: true, force: true })
fs.cpSync(path.join(REPO, 'skills'), OUT, { recursive: true })
for (const doc of DOCS) fs.copyFileSync(doc.from, doc.to)

console.log(`[build:skills] staged ${path.relative(path.join(HERE, '..'), OUT)}`)
