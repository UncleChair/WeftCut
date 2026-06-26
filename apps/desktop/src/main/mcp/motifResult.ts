// apps/desktop/src/main/mcp/motifResult.ts
// Shape a runMotifTool raw value into the Rust-faithful MCP ToolResult for the
// motif tools. Mirrors the Rust handlers in native/src/mcp/tools.rs:
//   list_motifs            → json(payload with `html` removed)
//   get_motif_source       → json({manifest, html})
//   write_motif_draft      → text(id)
//   install_motif          → text(published_id)
//   delete_motif           → empty
//   motif_staleness_report → json(array)
//   acknowledge_motif_staleness → text(count)
import { toolJson, toolText, toolEmpty, type ToolResultJson } from '../state/mcp-commands.js'

export function shapeMotifMcpResult(name: string, raw: unknown): ToolResultJson {
  switch (name) {
    case 'list_motifs': {
      const stripped = (raw as Array<Record<string, unknown>>).map((e) => {
        const { html: _html, ...rest } = e
        return rest
      })
      return toolJson(stripped)
    }
    case 'get_motif_source':
      return toolJson(raw)
    case 'write_motif_draft':
    case 'install_motif':
      return toolText(raw as string)
    case 'delete_motif':
      return toolEmpty()
    case 'motif_staleness_report':
      return toolJson(raw)
    case 'acknowledge_motif_staleness':
      return toolText(String(raw as number))
    default:
      throw new Error(`shapeMotifMcpResult: unhandled tool ${name}`)
  }
}
