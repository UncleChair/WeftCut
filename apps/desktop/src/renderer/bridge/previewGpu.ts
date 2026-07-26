// Read-only view of main's concurrent-HW-session budget for native GPU decode.
//
// Diagnostics only. Nothing may branch on this: the authority is main's gate
// inside `previewGpu:open`, and a sample is already stale by the time it
// arrives — sessions close asynchronously (the renderer's teardown fires
// `previewGpu:close` without awaiting it), so `used < max` here is not a
// promise that the next open succeeds.
//
// Deliberately NOT routed through `GpuTransport`, which owns a single session:
// the budget is process-wide and stays readable with no session open at all.

import type { PreviewGpuBudget } from '../../shared/ipc'

export type { PreviewGpuBudget }

export async function getPreviewGpuBudget(): Promise<PreviewGpuBudget> {
  return window.api.previewGpu.budget()
}
