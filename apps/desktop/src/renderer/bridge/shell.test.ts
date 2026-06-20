import { afterEach, describe, expect, it, vi } from 'vitest'
import { open } from './shell'

afterEach(() => vi.unstubAllGlobals())

describe('shell bridge', () => {
  it('opens a target via the native shell capability, not the Rust dispatcher', async () => {
    const shellOpen = vi.fn().mockResolvedValue(undefined)
    const invoke = vi.fn()
    vi.stubGlobal('window', { api: { shell: { open: shellOpen }, backend: { invoke } } })

    await open('C:/logs')

    expect(shellOpen).toHaveBeenCalledWith('C:/logs')
    expect(invoke).not.toHaveBeenCalled()
  })
})
