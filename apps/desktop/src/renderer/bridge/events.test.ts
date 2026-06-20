import { afterEach, describe, expect, it, vi } from 'vitest'
import { emit, listen } from './events'

afterEach(() => vi.unstubAllGlobals())

describe('events bridge', () => {
  it('emit() forwards to the native cross-window broadcast, not the Rust dispatcher', async () => {
    const apiEmit = vi.fn().mockResolvedValue(undefined)
    const invoke = vi.fn()
    vi.stubGlobal('window', { api: { emit: apiEmit, backend: { invoke } } })

    await emit('perf:snapshot', { fps: 60 })

    expect(apiEmit).toHaveBeenCalledWith('perf:snapshot', { fps: 60 })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('emit() swallows a rejected broadcast (fire-and-forget)', async () => {
    const apiEmit = vi.fn().mockRejectedValue(new Error('down'))
    vi.stubGlobal('window', { api: { emit: apiEmit, backend: { invoke: vi.fn() } } })
    await expect(emit('x')).resolves.toBeUndefined()
  })

  it('listen() subscribes through window.api.on and returns its unlisten', async () => {
    const off = vi.fn()
    const on = vi.fn().mockReturnValue(off)
    vi.stubGlobal('window', { api: { on } })

    const received: unknown[] = []
    const unlisten = await listen('perf:snapshot', (e) => received.push(e.payload))

    // window.api.on(event, cb) — drive the registered callback.
    expect(on).toHaveBeenCalledWith('perf:snapshot', expect.any(Function))
    const cb = on.mock.calls[0]![1] as (p: unknown) => void
    cb({ fps: 60 })
    expect(received).toEqual([{ fps: 60 }])
    expect(unlisten).toBe(off)
  })
})
