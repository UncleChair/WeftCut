// Process-tree resource snapshot, backed by the Electron main process
// (app.getAppMetrics()); available in dev and release.

import type { SystemStats } from '../../shared/ipc'

export type { SystemStats }

export async function getSystemStats(): Promise<SystemStats> {
  return window.api.metrics.get()
}
