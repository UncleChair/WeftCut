// apps/desktop/src/main/motif/motifTools.ts
//
// Host-level Motif tool dispatcher. Both surfaces call this: the renderer IPC
// path (ts-actor-host.handleInvoke `case 'motif'`) and the MCP path (server.ts
// `route === 'motif'`). Returns a RAW value (array | object | id string | null);
// the MCP caller wraps it via shapeMotifMcpResult, the renderer returns it as-is.
// Replaces the Rust authoring commands + compute_motif_rebind hybrid for these
// channels. Mirrors native/src/commands/motif_authoring.rs (the emit + actor wrap).
import type { Manifest } from '../../shared/motifs/catalog'
import type { MotifRebindEntry } from '../state/model'
import type { UserMotifStore } from './store'
import {
  type BuiltinMotif, type MotifLayerRef, type InstallArgs,
  getMotifSource, listMotifsInner, writeMotifDraftCore, amendDraftHtml,
  createEditDraftCore, importMotifFromSource, deleteMotifCore, installMotifCompute,
} from './authoring'
import { type MotifStaleEntry, currentVersions, buildStalenessReport, buildAckEntries } from './staleness'

export interface MotifToolDeps {
  store: UserMotifStore
  builtins: BuiltinMotif[]
  /** Motif layers from the live actor snapshot (install Update rebind input). */
  motifLayers: () => MotifLayerRef[]
  /** Apply rebind_motif through the actor; throws on a rejected write. */
  dispatchRebind: (updates: MotifRebindEntry[]) => void
  /** Emit `motifs:changed` to the renderer (picker re-pull + host buster). */
  emitChanged: () => void
  /** Re-pull list_motifs → actor.setUserMotifManifests (content-window clamp). */
  refreshCatalog: () => void
  /** node:fs readFileSync(utf8) — import_motif reads an external .html. */
  readFile: (p: string) => string
  /** Emit a record-panel LogBus warn row (the on-open staleness summary).
   *  Best-effort; the host wraps the underlying emit in try/catch. */
  emitLog: (entry: { level: 'warn'; category: { kind: 'Project' }; source: { kind: 'System' }; message: string }) => void
}

/** Coerce the install `mode` arg. Renderer sends the object form
 *  `{ kind, target_id? }`; the MCP schema advertises a bare string "new"/"update"
 *  (the historical hybrid contract). "new" coerces; "update" as a bare string has
 *  no target_id and is rejected by installMotifCompute downstream — preserving the
 *  pre-existing inability to MCP-update without a target. */
function parseMode(mode: unknown): InstallArgs['mode'] {
  if (mode === 'new') return { kind: 'new' }
  if (mode === 'update') return { kind: 'update', target_id: '' } // no target → compute rejects
  return mode as InstallArgs['mode']
}

export function runMotifTool(name: string, rawArgs: Record<string, unknown>, deps: MotifToolDeps): unknown {
  // Renderer write/install nest under `args`; everything else is flat. MCP is flat.
  const a = (rawArgs.args ?? rawArgs) as Record<string, unknown>
  switch (name) {
    case 'list_motifs':
      return listMotifsInner(deps.store, deps.builtins)
    case 'get_motif_source':
      return getMotifSource(deps.store, deps.builtins, a.id as string)
    case 'write_motif_draft': {
      const id = writeMotifDraftCore(deps.store, a.manifest as Manifest, a.html as string, (a.from as string | undefined) ?? null)
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'amend_motif_draft': {
      // Renderer arg shape: { draftId, source } (camelCase, flat).
      amendDraftHtml(deps.store, a.draftId as string, a.source as string)
      deps.emitChanged(); deps.refreshCatalog()
      return null
    }
    case 'create_edit_draft': {
      const id = createEditDraftCore(deps.store, deps.builtins, a.sourceId as string)
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'import_motif': {
      const id = importMotifFromSource(deps.store, deps.readFile(a.path as string))
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'delete_motif': {
      deleteMotifCore(deps.store, a.id as string)
      deps.emitChanged(); deps.refreshCatalog()
      return null
    }
    case 'install_motif': {
      const args: InstallArgs = { draft_id: a.draft_id as string, mode: parseMode(a.mode) }
      const { publishedId, updates } = installMotifCompute(deps.store, deps.motifLayers(), args)
      if (updates.length) deps.dispatchRebind(updates)
      deps.emitChanged(); deps.refreshCatalog()
      return publishedId
    }
    case 'motif_staleness_report': {
      const current = currentVersions(deps.builtins, deps.store.listManifests())
      const layers = deps.motifLayers().map((l) => ({ motifId: l.motifId, placedVersion: l.version }))
      const report: MotifStaleEntry[] = buildStalenessReport(layers, current)
      if (report.length) {
        const summary = report
          .map((e) => `${e.motif_id} v${e.placed_version}→v${e.current_version} (${e.layer_count} layer(s))`)
          .join(', ')
        deps.emitLog({ level: 'warn', category: { kind: 'Project' }, source: { kind: 'System' }, message: `Motifs changed since placement: ${summary}` })
      }
      return report
    }
    case 'acknowledge_motif_staleness': {
      const current = currentVersions(deps.builtins, deps.store.listManifests())
      const layers = deps.motifLayers().map((l) => ({ layerId: l.layerId, motifId: l.motifId, placedVersion: l.version, props: l.props }))
      const updates = buildAckEntries(layers, current)
      if (updates.length) deps.dispatchRebind(updates)
      // Refresh so applyUpdateLayerParams' content-window clamp sees the current
      // manifests (parity with the old hybrid's post-ack refresh). Cheap + idempotent.
      deps.refreshCatalog()
      return updates.length
    }
    default:
      throw new Error(`runMotifTool: unhandled tool ${name}`)
  }
}
