// Merge the Rust-advertised MCP catalog with the TS single-source tables into the
// catalog the MCP host advertises via ListTools / ListResources. Motif tool + resource
// defs now come from the TS side (motifToolDefs.ts); only rust/hybrid routes are kept
// from Rust to avoid duplicates. TS-executed tools (route 'ts') are dropped from the
// Rust side; so are motif tools (route 'motif') — both are re-added from their TS tables.
// The result is an exact union by construction. This same function is the post-split
// merge in Phase 4b — only its `rustTools` input narrows; the union property is constant.
import { routeMcpTool } from './mutationTools.js'

export interface CatalogTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
export interface ResourceDef { uri: string; name?: string; description?: string; mimeType?: string }

export function mergeMcpCatalog(
  rustTools: ReadonlyArray<{ name: string } & Partial<CatalogTool>>,
  tsDefs: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): CatalogTool[] {
  const rustKept = rustTools.filter((t) => { const r = routeMcpTool(t.name); return r === 'rust' || r === 'hybrid' })
  const tsTools = tsDefs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  return [...rustKept, ...tsTools]
}

export function mergeMcpResources(
  rustResources: ReadonlyArray<{ uri: string } & Partial<ResourceDef>>,
  tsResources: ReadonlyArray<{ uri: string } & Partial<ResourceDef>>,
): ResourceDef[] {
  const tsUris = new Set(tsResources.map((r) => r.uri))
  const rustKept = rustResources.filter((r) => !tsUris.has(r.uri))
  return [...rustKept, ...tsResources]
}
