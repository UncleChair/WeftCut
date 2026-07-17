import type { Project } from './model'
import { serializeProject } from './serialize'

/** Audio-export channels whose Rust fn takes the full project as a call argument;
 *  the TS actor (the sole state owner) serializes and forwards it. */
export const EXPORT_PROJECT_CHANNELS: ReadonlySet<string> = new Set([
  'export_project_audio_only', 'ensure_export_audio_conform',
])

/** Inject the wire-shape project into the export-channel args. `serializeProject`
 *  (the canonical wire shape — identity except for group member sorting) is what
 *  the Rust core deserializes into an identical `Project`. */
export function injectProjectArgs(
  args: Record<string, unknown>,
  snapshot: Project,
): Record<string, unknown> {
  return { ...args, project: serializeProject(snapshot) }
}
