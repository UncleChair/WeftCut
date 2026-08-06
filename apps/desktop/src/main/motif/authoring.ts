// apps/desktop/src/main/motif/authoring.ts
//
// The Motif authoring lifecycle + catalog payload (TS-owned outright — no
// Rust counterpart exists). Pure: no actor, no IPC, no event emit — the host
// dispatcher (motifTools.ts) wraps these with the store/actor/emit.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_IDS, BUILTIN_MANIFESTS, type Manifest,
  parseManifestIsland, composeMotifHtml, validateManifest, assignUniqueId, canonicalizePropsLenient,
} from '../../shared/motifs/catalog'
import type { MotifRebindEntry } from '../state/model'
import { motifContentHash } from './contentHash'
import type { UserMotifStore } from './store'

export interface BuiltinMotif { id: string; manifest: Manifest; html: string }
export interface MotifSourceTs { manifest: Manifest; html: string }

/** Load each built-in's {id, manifest, html}. Manifest comes from the bundled
 *  BUILTIN_MANIFESTS (authoritative); html is read from `<builtinDir>/<id>/index.html`
 *  (the served assets). `builtinDir` is passed explicitly
 *  (host computes via builtinAssetDir(); tests pass a fixture dir) so this is
 *  hermetic. A built-in whose html can't be read is skipped (defensive). */
export function builtinMotifs(builtinDir: string): BuiltinMotif[] {
  const out: BuiltinMotif[] = []
  for (const id of BUILTIN_IDS) {
    const manifest = BUILTIN_MANIFESTS.get(id)
    if (!manifest) continue
    let html: string
    try { html = readFileSync(path.join(builtinDir, id, 'index.html'), 'utf8') } catch { continue }
    out.push({ id, manifest, html })
  }
  return out
}

/** Read any built-in or user Motif's source. Built-ins win. */
export function getMotifSource(store: UserMotifStore, builtins: BuiltinMotif[], id: string): MotifSourceTs {
  const b = builtins.find((x) => x.id === id)
  if (b) return { manifest: b.manifest, html: b.html }
  const m = store.getMotif(id)
  if (m) return { manifest: m.manifest, html: m.html }
  throw new Error(`unknown motif id '${id}'`)
}

/** Serialize manifest + raw html into the picker payload (superset of MCP
 *  list_motifs: every manifest field + html + status + content_hash). One helper
 *  so built-in/installed/draft emit the same shape. `html` MUST be the
 *  composed/stored FULL html (island included) — content_hash is computed over it. */
export function motifToPayload(manifest: Manifest, html: string, status: string): Record<string, unknown> {
  const content_hash = motifContentHash(manifest, html)
  return { ...manifest, html, status, content_hash }
}

/** UI catalog: builtins, then installed, then drafts (id-unique; a draft whose id
 *  is already published/built-in is skipped — published wins).
 *  A draft with a recorded Update target carries `target_id`. */
export function listMotifsInner(store: UserMotifStore, builtins: BuiltinMotif[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const b of builtins) out.push(motifToPayload(b.manifest, b.html, 'builtin'))
  for (const manifest of store.listManifests()) {
    // list_manifests already confirmed the island parsed; re-read html for the
    // payload. readHtml may return null on a TOCTOU (file vanished) — blank card
    // rather than failing the whole list.
    const html = store.readHtml(manifest.id) ?? ''
    out.push(motifToPayload(manifest, html, 'installed'))
  }
  const seen = new Set(out.map((e) => e.id as string))
  for (const draft of store.listDrafts()) {
    const draftId = draft.manifest.id
    if (seen.has(draftId)) continue
    const entry = motifToPayload(draft.manifest, draft.html, 'draft')
    const target = store.readDraftTarget(draftId)
    if (target) entry.target_id = target
    out.push(entry)
  }
  return out
}

// ---------------------------------------------------------------------------
// Authoring cores — write / amend / create-edit / import / delete
// ---------------------------------------------------------------------------

/** Final-ready unique id minted vs published ∪ drafts. The id a draft is born
 *  with is the one it keeps when published (install-New needs no rebind). */
function takenIds(store: UserMotifStore): string[] {
  return [...store.publishedIds(), ...store.listDraftIds()]
}

/** Validate + mint id + compose + write the draft. Identity is app-owned: id is
 *  minted from the name and version forced to 1 (any id/version in `manifest` is
 *  ignored). `from` (when set) is recorded as the draft's Update target. */
export function writeMotifDraftCore(store: UserMotifStore, manifest: Manifest, html: string, from: string | null): string {
  validateManifest(manifest)
  const draftId = assignUniqueId(manifest.name, takenIds(store))
  const finalManifest: Manifest = { ...manifest, id: draftId, version: 1 }
  store.writeDraft(draftId, composeMotifHtml(finalManifest, html))
  if (from) store.writeDraftTarget(draftId, from)
  return draftId
}

/** Parse the island out of an edited full-source doc, force the draft's stable
 *  identity (id + version 1), re-validate, overwrite the SAME draft. Amend never
 *  CREATES. */
export function amendDraftHtml(store: UserMotifStore, draftId: string, source: string): void {
  if (store.getDraft(draftId) === null) throw new Error(`unknown draft '${draftId}'`)
  const parsed = parseManifestIsland(source)
  const manifest: Manifest = { ...parsed, id: draftId, version: 1 }
  validateManifest(manifest)
  // compose strips the edited island + re-injects a canonical one; body round-trips.
  store.writeDraft(draftId, composeMotifHtml(manifest, source))
}

/** Non-throwing source lookup (built-in first, then installed). */
function getMotifSourceOrNull(store: UserMotifStore, builtins: BuiltinMotif[], id: string): MotifSourceTs | null {
  const b = builtins.find((x) => x.id === id)
  if (b) return { manifest: b.manifest, html: b.html }
  return store.getMotif(id)
}

/** Seed a NEW working draft from a built-in or installed source; for an INSTALLED
 *  source, record it as the draft's Update target (built-ins can't update in place,
 *  so a built-in fork records no target). */
export function createEditDraftCore(store: UserMotifStore, builtins: BuiltinMotif[], sourceId: string): string {
  const isBuiltin = BUILTIN_IDS.includes(sourceId)
  const source = getMotifSourceOrNull(store, builtins, sourceId)
  if (!source) throw new Error(`unknown source motif '${sourceId}'`)
  const draftId = assignUniqueId(source.manifest.name, takenIds(store))
  const manifest: Manifest = { ...source.manifest, id: draftId, version: 1 }
  store.writeDraft(draftId, composeMotifHtml(manifest, source.html))
  if (!isBuiltin) store.writeDraftTarget(draftId, sourceId)
  return draftId
}

/** Parse + validate the island from an external .html, mint a FRESH unique id
 *  (ignoring any claimed id/version), write as a from-scratch draft (no target →
 *  installs as new). */
export function importMotifFromSource(store: UserMotifStore, source: string): string {
  const parsed = parseManifestIsland(source)
  const draftId = assignUniqueId(parsed.name, takenIds(store))
  const manifest: Manifest = { ...parsed, id: draftId, version: 1 }
  validateManifest(manifest)
  store.writeDraft(draftId, composeMotifHtml(manifest, source))
  return draftId
}

/** Delete a published user Motif (built-ins rejected). */
export function deleteMotifCore(store: UserMotifStore, id: string): void {
  if (BUILTIN_IDS.includes(id)) throw new Error(`cannot delete the built-in Motif '${id}'`)
  store.deleteUserMotif(id)
}

// ---------------------------------------------------------------------------
// Install compute — buildRebindUpdates + installMotifCompute
// ---------------------------------------------------------------------------

export interface MotifLayerRef { layerId: string; motifId: string; version: number; props: Record<string, unknown> }
export type InstallArgs = { draft_id: string; mode: { kind: 'new' } | { kind: 'update'; target_id: string } }

/** Per-layer rebind updates for an Update: every layer whose motif_id is the
 *  working draft id OR the target id ends up on the target id, at the new version,
 *  with props lenient-migrated to the new schema (drop unknown, fill new defaults,
 *  fall back invalid values). Pure. */
export function buildRebindUpdates(layers: MotifLayerRef[], workingId: string, target: Manifest): MotifRebindEntry[] {
  const updates: MotifRebindEntry[] = []
  for (const l of layers) {
    if (l.motifId !== workingId && l.motifId !== target.id) continue
    updates.push({
      layer_id: l.layerId,
      motif_id: target.id,
      motif_version: target.version,
      props: canonicalizePropsLenient(target, l.props),
    })
  }
  return updates
}

/** Publish the draft (store side) + (Update) build rebind updates from the
 *  caller-supplied motif layers; returns `{ publishedId, updates }`. New mode →
 *  empty updates. Does NOT write the actor (the host dispatches rebind_motif). */
export function installMotifCompute(
  store: UserMotifStore,
  motifLayers: MotifLayerRef[],
  args: InstallArgs,
): { publishedId: string; updates: MotifRebindEntry[] } {
  const draft = store.getDraft(args.draft_id)
  if (!draft) throw new Error(`unknown draft '${args.draft_id}'`)
  // Re-validate at the install gate (the on-disk draft could have been hand-edited).
  validateManifest(draft.manifest)

  let isUpdate = false
  let finalId: string
  let version: number
  if (args.mode.kind === 'new') {
    // Draft id was made final-ready at write time; keep it (placed layers need no
    // rebind). Guard the rare race where a published Motif took the id since.
    const id = draft.manifest.id
    if (store.publishedIds().includes(id))
      throw new Error(`a Motif '${id}' is already installed; rename the draft before installing`)
    finalId = id; version = 1
  } else {
    const targetId = args.mode.target_id
    if (BUILTIN_IDS.includes(targetId)) throw new Error(`cannot overwrite the built-in Motif '${targetId}'`)
    const prev = store.getMotif(targetId)
    if (!prev) throw new Error(`update target '${targetId}' is not an installed Motif`)
    isUpdate = true
    finalId = targetId; version = prev.manifest.version + 1 // bump → frame cache invalidates
  }

  const manifest: Manifest = { ...draft.manifest, id: finalId, version }
  const html = composeMotifHtml(manifest, draft.html)
  // Rewrite the draft's island to the final id + bumped version, THEN move it into
  // the published slot. Order matters: if installDraft fails, only the DRAFT is
  // dirty; a retry re-derives the same final_id and re-runs both steps safely.
  store.writeDraft(args.draft_id, html)
  store.installDraft(args.draft_id, finalId)

  let updates: MotifRebindEntry[] = []
  if (isUpdate) {
    const target = store.getMotif(finalId)
    if (!target) throw new Error(`installed target '${finalId}' not readable`)
    updates = buildRebindUpdates(motifLayers, args.draft_id, target.manifest)
  }
  return { publishedId: finalId, updates }
}
