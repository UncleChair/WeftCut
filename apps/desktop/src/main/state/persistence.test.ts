import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, SCHEMA_VERSION } from './model'
import { canonicalString } from './canonical'
import { serializeProject } from './serialize'
import { serializeProjectToJson, schemaGate, parseProjectJson } from './persistence'

describe('serializeProjectToJson (mirror io/mod.rs:25 to_string_pretty)', () => {
  it('pretty-prints with 2-space indent and no trailing newline', () => {
    const p = blankProject(seededGen(), 'doc')
    const json = serializeProjectToJson(p)
    expect(json.startsWith('{\n  "schema_version": 9')).toBe(true)
    expect(json.endsWith('\n')).toBe(false)
    expect(json.includes('\n    ')).toBe(true) // nested 4-space level exists
  })
  it('round-trips through parseProjectJson canonically', () => {
    const p = blankProject(seededGen(), 'doc')
    const back = parseProjectJson(serializeProjectToJson(p))
    expect(canonicalString(serializeProject(back))).toBe(canonicalString(serializeProject(p)))
  })
})

describe('schemaGate (mirror io/migrate.rs:20 run)', () => {
  it('accepts the current schema version', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION })).not.toThrow()
  })
  it('rejects an older version with fresh-workspace guidance', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION - 1 }))
      .toThrow(/below the supported minimum.*fresh workspace/s)
  })
  it('rejects a newer version with update-the-app guidance', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION + 5 }))
      .toThrow(/newer than this build.*Update the app/s)
  })
  it('rejects a non-numeric / absent version', () => {
    expect(() => schemaGate({})).toThrow(/schema/i)
  })
})

describe('parseProjectJson', () => {
  it('throws on malformed JSON', () => {
    expect(() => parseProjectJson('{not json')).toThrow()
  })
  it('throws on a wrong schema version (gate before cast)', () => {
    const p = blankProject(seededGen(), 'doc')
    const bad = JSON.stringify({ ...(serializeProject(p) as object), schema_version: 8 })
    expect(() => parseProjectJson(bad)).toThrow(/below the supported minimum/)
  })
})
