import type { Project } from './model'
import { serializeProject } from './serialize'

/** Audio-export channels that used to read the Rust mirror for the full project
 *  and now receive it from the TS actor (the sole state owner). Phase 2. */
export const EXPORT_PROJECT_CHANNELS: ReadonlySet<string> = new Set([
  'export_project_audio_only', 'ensure_export_audio_conform',
])

/** Inject the wire-shape project into the export-channel args. Uses the SAME
 *  serialization as the read-mirror (`serializeProject` — identity except for
 *  group member sorting), so the Rust core deserializes an identical `Project`. */
export function injectProjectArgs(
  args: Record<string, unknown>,
  snapshot: Project,
): Record<string, unknown> {
  return { ...args, project: serializeProject(snapshot) }
}
