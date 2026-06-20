// Process-tree resource snapshot, backed by the Electron main process
// (app.getAppMetrics()). Always available in dev AND release — unlike the
// dropped Rust `get_system_stats` command this replaces.

import type { SystemStats } from '../../shared/ipc'

export type { SystemStats }

export async function getSystemStats(): Promise<SystemStats> {
  return window.api.metrics.get()
}
