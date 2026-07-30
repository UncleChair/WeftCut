import type { PreviewGpuBudgetSnapshot } from '../shared/ipc'

export const PREVIEW_GPU_MAX_SESSIONS = 5
// Admission currency is coded pixel AREA (30fps-calibrated), not bytes — but
// area implies pool VRAM, and the A′ RGBA8 slots made that conversion worth
// writing down: slot bytes = area × 4 (RGBA8) × poolSize (3 by default), i.e.
// this cap fully subscribed ≈ 3×(3840×2160) × 4B × 3 slots ≈ 299MB of shared
// pool — ×2.67 the NV12 pools it replaced (area × 1.5B). The live number (not
// this arithmetic) is `hwBudget().slotVram` / takeTimings' `poolSlotBytes`.
export const PREVIEW_GPU_MAX_CODED_PIXEL_AREA = 3 * 3840 * 2160
export const PREVIEW_GPU_BUDGET_CALIBRATED_FPS = 30

export interface PreviewGpuCodedSize {
  width: number
  height: number
}

export interface PreviewGpuBudgetLease {
  readonly sessionId: string
  readonly codedPixelArea: number
}

export interface PreviewGpuBudgetController {
  reserve(sessionId: string, codedSize: PreviewGpuCodedSize): PreviewGpuBudgetLease | null
  release(lease: PreviewGpuBudgetLease | null | undefined): void
  /// Everything admission knows. `slotVram` is deliberately absent: leases
  /// carry coded area, not pool sizes — previewGpu.ts merges the live VRAM sum
  /// from its session records (the only place slot counts exist).
  snapshot(): Omit<PreviewGpuBudgetSnapshot, 'slotVram'>
}

export function createPreviewGpuBudget(): PreviewGpuBudgetController {
  const leases = new Map<string, PreviewGpuBudgetLease>()
  let usedCodedPixelArea = 0

  return {
    reserve(sessionId, codedSize) {
      if (leases.has(sessionId)) return null
      if (leases.size >= PREVIEW_GPU_MAX_SESSIONS) return null
      if (
        !Number.isSafeInteger(codedSize.width)
        || !Number.isSafeInteger(codedSize.height)
        || codedSize.width <= 0
        || codedSize.height <= 0
      ) {
        return null
      }
      const codedPixelArea = codedSize.width * codedSize.height
      if (!Number.isSafeInteger(codedPixelArea)) return null
      if (usedCodedPixelArea + codedPixelArea > PREVIEW_GPU_MAX_CODED_PIXEL_AREA) return null
      const lease = Object.freeze({
        sessionId,
        codedPixelArea,
      })
      leases.set(sessionId, lease)
      usedCodedPixelArea += codedPixelArea
      return lease
    },

    release(lease) {
      if (!lease || leases.get(lease.sessionId) !== lease) return
      leases.delete(lease.sessionId)
      usedCodedPixelArea -= lease.codedPixelArea
    },

    snapshot() {
      return {
        currency: 'coded-pixel-area',
        sessions: { used: leases.size, max: PREVIEW_GPU_MAX_SESSIONS },
        codedPixelArea: {
          used: usedCodedPixelArea,
          max: PREVIEW_GPU_MAX_CODED_PIXEL_AREA,
          calibratedFps: PREVIEW_GPU_BUDGET_CALIBRATED_FPS,
        },
      }
    },
  }
}
