// Merge the Rust-advertised MCP catalog with the TS single-source table into the
// catalog the MCP host advertises via ListTools. The TS-executed tools advertise
// from the TS table (schema + parser are two fields of one record — they cannot
// drift); they are dropped from the Rust side to avoid duplicates. Rust keeps
// native reads/compute + hybrids (their schema is Rust's). The result is an exact
// union by construction. This same function is the post-split merge in Phase 4b —
// only its `rustTools` input narrows (mutation catalog removed from Rust); the
// union property is constant.
import { routeMcpTool } from './mutationTools.js'

export interface CatalogTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

export function mergeMcpCatalog(
  rustTools: ReadonlyArray<{ name: string } & Partial<CatalogTool>>,
  tsDefs: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): CatalogTool[] {
  const rustKept = rustTools.filter((t) => routeMcpTool(t.name) !== 'ts')
  const tsTools = tsDefs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  return [...rustKept, ...tsTools]
}
