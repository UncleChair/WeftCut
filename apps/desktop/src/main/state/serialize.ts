import { SCHEMA_VERSION, type Group, type Project } from './model'

function serializeGroup(g: Group): unknown {
  const out: Record<string, unknown> = { id: g.id, members: [...g.members].sort() }
  if (g.label !== undefined && g.label !== null) out.label = g.label // skip_serializing_if = None
  return out
}

/** Produce the on-disk/wire JSON shape. The model is already JSON-native, so
 *  this is mostly identity; the only non-identity rules are group member
 *  sorting and the `Group.label` omission (mirrors serde skip_serializing_if). */
export function serializeProject(p: Project): unknown {
  return { ...p, groups: p.groups.map(serializeGroup) }
}

/** Validate + type a wire object as a Project. Near-identity for the JSON-native
 *  model; the load guard is the schema version (project.rs:17-22 rejects others). */
export function parseProject(json: unknown): Project {
  if (json === null || typeof json !== 'object') throw new Error('parseProject: not an object')
  const v = (json as { schema_version?: unknown }).schema_version
  if (v !== SCHEMA_VERSION) throw new Error(`parseProject: unsupported schema_version ${String(v)} (expected ${SCHEMA_VERSION})`)
  return json as Project
}
