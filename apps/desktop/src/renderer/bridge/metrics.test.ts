import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSystemStats } from './metrics'

afterEach(() => vi.unstubAllGlobals())

describe('metrics bridge', () => {
  it('reads process metrics via the native capability, not the Rust dispatcher', async () => {
    const stats = { cpu_percent: 12, rss_bytes: 1024, process_count: 3, logical_cores: 16 }
    const get = vi.fn().mockResolvedValue(stats)
    const invoke = vi.fn()
    vi.stubGlobal('window', { api: { metrics: { get }, backend: { invoke } } })

    expect(await getSystemStats()).toEqual(stats)
    expect(get).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
  })
})
