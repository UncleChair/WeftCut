// apps/desktop/src/main/state/__tests__/mcp.skill-conformance.test.ts
// Anti-drift gate for the shipped agent-skill sources.
//
// The skill bundle (repo-root skills/weftcut/ + docs/motif-authoring.md, staged
// by scripts/build-skills.mjs) name-drops MCP tools, resources, and prompts in
// backticks. Those files ship to end users' agents, so a rename that leaves a
// stale name behind teaches every connected agent to call something that no
// longer exists — silently. This suite pins every backticked reference to the
// advertised catalog, the same fixture-plus-TS-tables union the bijection gate
// uses (REGEN-FREE: no napi addon at test time).
//
// Contract for prose authors: a bare backticked `snake_case` token in these
// files is an MCP tool name unless it is listed in KNOWN_NON_TOOLS below.
// Adding prose that backticks a new non-tool identifier means adding it there —
// that friction is the point, it is what makes renames fail loudly.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { MOTIF_TOOL_DEFS, MOTIF_RESOURCE_DEFS } from '../../mcp/motifToolDefs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const SKILL_SOURCES = [
  path.join(repoRoot, 'skills/weftcut/SKILL.md'),
  path.join(repoRoot, 'docs/motif-authoring.md'),
]

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string }>
  resources: Array<{ uri: string }>
  prompts: Array<{ name: string }>
}
const toolNames = new Set([
  ...rust.tools.map((t) => t.name),
  ...MCP_TOOL_DEFS.map((d) => d.name),
  ...MOTIF_TOOL_DEFS.map((d) => d.name),
])
const resourceUris = new Set([
  ...rust.resources.map((r) => r.uri),
  ...MOTIF_RESOURCE_DEFS.map((r) => r.uri),
])
const promptNames = new Set(rust.prompts.map((p) => p.name))

// Backticked snake_case tokens in the skill sources that are NOT tool names:
// manifest fields, props_schema variants, lifecycle identifiers, tool params.
// Every entry must occur in the sources (pruned below) and must never collide
// with a live tool name (checked below).
const KNOWN_NON_TOOLS = new Set([
  // SKILL.md — tool params
  'from',
  // motif-authoring.md — manifest fields
  'id', 'version', 'name', 'size', 'default_duration_s', 'max_duration_s',
  'max_duration_prop', 'content_duration_s', 'settle_rafs', 'fonts',
  'props_schema',
  // motif-authoring.md — props_schema variants + their constraint fields
  'string', 'color', 'number', 'enum', 'default', 'max_length', 'multiline',
  'min', 'max', 'options',
  // motif-authoring.md — lifecycle / code identifiers
  'motif', 'setup', 'ctx', 't', 'duration', 'await', 'bg_color',
])

const BARE_IDENT = /^[a-z][a-z0-9_]*$/
const URI = /^[a-z]+:\/\//

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)
}

describe('shipped skill sources ↔ MCP catalog (anti-drift gate)', () => {
  const byFile = SKILL_SOURCES.map((file) => ({
    file: path.relative(repoRoot, file),
    tokens: backticked(readFileSync(file, 'utf8')),
  }))
  const allTokens = byFile.flatMap((f) => f.tokens)

  it('every bare backticked identifier is an advertised tool or a known non-tool', () => {
    const offenders = byFile.flatMap(({ file, tokens }) =>
      tokens
        .filter((t) => BARE_IDENT.test(t))
        .filter((t) => !toolNames.has(t) && !KNOWN_NON_TOOLS.has(t))
        .map((t) => `${file}: \`${t}\``),
    )
    // A hit here is either a renamed/removed tool still referenced by the
    // shipped prose (fix the prose), or new prose backticking a non-tool
    // identifier (add it to KNOWN_NON_TOOLS).
    expect(offenders).toEqual([])
  })

  it('every backticked resource URI is advertised', () => {
    const offenders = byFile.flatMap(({ file, tokens }) =>
      tokens
        .filter((t) => URI.test(t))
        .filter((t) => !resourceUris.has(t))
        .map((t) => `${file}: \`${t}\``),
    )
    expect(offenders).toEqual([])
  })

  it('every backticked /slash reference is an advertised prompt', () => {
    const offenders = byFile.flatMap(({ file, tokens }) =>
      tokens
        .filter((t) => /^\/[a-z-]+$/.test(t))
        .filter((t) => !promptNames.has(t.slice(1)))
        .map((t) => `${file}: \`${t}\``),
    )
    expect(offenders).toEqual([])
  })

  it('the extraction is alive: the sources still reference a healthy number of tools', () => {
    // Guards the gate itself — an extraction regression (or a gutted SKILL.md)
    // would otherwise pass every membership test vacuously.
    const referenced = new Set(allTokens.filter((t) => toolNames.has(t)))
    expect(referenced.size).toBeGreaterThanOrEqual(15)
  })

  it('KNOWN_NON_TOOLS carries no dead entries and no tool-name collisions', () => {
    const present = new Set(allTokens)
    expect([...KNOWN_NON_TOOLS].filter((t) => !present.has(t))).toEqual([])
    // A collision means prose ambiguity: a token the gate can no longer tell
    // apart from a tool reference. Rename one side.
    expect([...KNOWN_NON_TOOLS].filter((t) => toolNames.has(t))).toEqual([])
  })
})
