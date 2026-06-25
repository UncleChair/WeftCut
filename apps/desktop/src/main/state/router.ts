// apps/desktop/src/main/state/router.ts
// Pure splitter classification for the WEFTCUT_TS_ACTOR flip. Consulted by
// src/main/index.ts ONLY when the flag is on; flag-off = everything → rust.
// SAFETY INVARIANT (router.test.ts): no category-A state mutation routes to 'rust'.
import { PRODUCTION_OPS } from './commands'

export type Route =
  | { kind: 'command' }       // actor.command(channel, args)
  | { kind: 'summary' }       // buildProjectSummary
  | { kind: 'projectSettings' } // actor.snapshot().settings
  | { kind: 'open' } | { kind: 'saveAs' } | { kind: 'newWorkspace' } | { kind: 'save' }
  | { kind: 'agentSessionEnd' } // agentSessionEnd seam: endSlot + unlockHistory
  | { kind: 'reject'; reason: string }
  | { kind: 'rust' }

/** Renderer-reachable category-A mutations with NO TS path — rejected under the
 *  flag (single-writer), deferred to 3d. add_motif needs the motif catalog;
 *  project_restore_checkpoint has no TS command-surface create path (and no
 *  checkpoint can exist during a single-writer soak). */
export const BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set(['add_motif', 'project_restore_checkpoint'])

export function routeChannel(channel: string): Route {
  if (PRODUCTION_OPS.has(channel)) return { kind: 'command' }
  if (BLOCKED_UNDER_FLAG.has(channel)) return { kind: 'reject', reason: `${channel} is unavailable while the TS state actor is active (WEFTCUT_TS_ACTOR); ported in Phase 3d` }
  switch (channel) {
    case 'project_summary': return { kind: 'summary' }
    case 'get_project_settings': return { kind: 'projectSettings' }
    case 'project_open': return { kind: 'open' }
    case 'project_save_as': return { kind: 'saveAs' }
    case 'project_new_workspace': return { kind: 'newWorkspace' }
    case 'project_save': return { kind: 'save' }
    case 'agent_session_end': return { kind: 'agentSessionEnd' }
    default: return { kind: 'rust' }
  }
}
