import { describe, it, expect } from 'vitest'
import { collectMetrics } from './metrics'

describe('collectMetrics', () => {
  it('sums whole-machine CPU% and RSS across the Electron process tree', () => {
    // percentCPUUsage is whole-machine normalized — see the LANDMINE in
    // metrics.ts; cpu_percent is the plain sum. workingSetSize is in KB.
    const m = [
      { type: 'Browser', cpu: { percentCPUUsage: 6 }, memory: { workingSetSize: 100_000 } },
      { type: 'GPU', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 50_000 } },
      { type: 'Tab', cpu: { percentCPUUsage: 4 }, memory: { workingSetSize: 200_000 } },
    ]
    const s = collectMetrics(m, 16)
    expect(s.cpu_percent).toBe(12)
    expect(s.rss_bytes).toBe(350_000 * 1024)
    expect(s.process_count).toBe(3)
    expect(s.logical_cores).toBe(16)
  })

  it('handles an empty metrics array', () => {
    expect(collectMetrics([], 8)).toEqual({
      cpu_percent: 0,
      rss_bytes: 0,
      process_count: 0,
      logical_cores: 8,
    })
  })
})
