import { SCHEMA_VERSION, defaultSettings, type Group, type Project } from './model'

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

/** Validate + type a wire object as a Project. The load guard is the schema
 *  version (project.rs:17-22 rejects others); beyond that, a shallow structural
 *  check rejects a truncated/corrupt project.json (right version, missing/wrong
 *  required fields) with a clear error rather than letting `undefined` reach the
 *  actor. Shallow by design — field-level fidelity is proven by the differential
 *  + round-trip gates, and an undeclared NEW Rust field is carried through by the
 *  spread (acceptable; it can only be lost on the next save, never corrupts). */
export function parseProject(json: unknown): Project {
  if (json === null || typeof json !== 'object') throw new Error('parseProject: not an object')
  const o = json as Record<string, unknown>
  if (o.schema_version !== SCHEMA_VERSION) {
    throw new Error(`parseProject: unsupported schema_version ${String(o.schema_version)} (expected ${SCHEMA_VERSION})`)
  }
  const requireObject = (k: string) => {
    if (o[k] === null || typeof o[k] !== 'object' || Array.isArray(o[k])) throw new Error(`parseProject: ${k} must be an object`)
  }
  const requireArray = (k: string) => {
    if (!Array.isArray(o[k])) throw new Error(`parseProject: ${k} must be an array`)
  }
  const requireString = (k: string) => {
    if (typeof o[k] !== 'string') throw new Error(`parseProject: ${k} must be a string`)
  }
  // Top-level shape of Project (model.ts:98-102). Shallow presence/kind only.
  requireString('project_id')
  requireObject('metadata')
  requireObject('composition')
  requireObject('media_pool')
  requireArray('tracks')
  requireArray('markers')
  requireArray('transitions')
  requireArray('groups')
  requireObject('audio_roles')
  requireObject('settings')
  // Additive settings fields (prefer_proxies/proxy_overrides, added later WITHOUT
  // a schema bump) deserialize as absent on projects saved before they existed.
  // Rust's #[serde(default)] used to backfill them on load; the TS parse path must
  // do the same, or a consumer that reads a field as non-optional (e.g.
  // get_project_settings → the renderer proxy store) hands `undefined` downstream
  // and a `settings.proxy_overrides[id]` read throws mid-render. Existing keys win.
  o.settings = { ...defaultSettings(), ...(o.settings as Record<string, unknown>) }
  return json as Project
}
