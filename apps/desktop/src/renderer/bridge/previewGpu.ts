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

import type { PreviewGpuBudgetSnapshot } from '../../shared/ipc'

export type { PreviewGpuBudgetSnapshot }

export async function getPreviewGpuBudget(): Promise<PreviewGpuBudgetSnapshot> {
  return window.api.previewGpu.budget()
}
