// Merge the Rust-advertised MCP catalog with the TS single-source tables into the
// catalog the MCP host advertises via ListTools / ListResources. The TS table is the
// source of truth for any tool it lists: ts mutations + all 6 motif defs come from TS
// (motifToolDefs.ts). Dedup is BY NAME — any Rust tool whose name is also in the TS
// def set is dropped and re-added from TS; everything else stays Rust-sourced. This is
// robust to route (e.g. preview_motif_draft routes 'rust' for execution yet its def is
// TS-sourced, so it survives the Phase 4 Task 3 deletion of the Rust motif arms without
// duplicating). The result is an exact, duplicate-free union by construction.

export interface CatalogTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
export interface ResourceDef { uri: string; name?: string; description?: string; mimeType?: string }

export function mergeMcpCatalog(
  rustTools: ReadonlyArray<{ name: string } & Partial<CatalogTool>>,
  tsDefs: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): CatalogTool[] {
  const tsNames = new Set(tsDefs.map((d) => d.name))
  const rustKept = rustTools.filter((t) => !tsNames.has(t.name))
  return [...rustKept, ...tsDefs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))]
}

export function mergeMcpResources(
  rustResources: ReadonlyArray<{ uri: string } & Partial<ResourceDef>>,
  tsResources: ReadonlyArray<{ uri: string } & Partial<ResourceDef>>,
): ResourceDef[] {
  const tsUris = new Set(tsResources.map((r) => r.uri))
  const rustKept = rustResources.filter((r) => !tsUris.has(r.uri))
  return [...rustKept, ...tsResources]
}
