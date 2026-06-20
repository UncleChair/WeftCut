import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPermissionGranted, requestPermission, sendNotification } from './notification'

afterEach(() => vi.unstubAllGlobals())

describe('notification bridge', () => {
  it('grants permission trivially (single-user desktop app)', async () => {
    expect(await isPermissionGranted()).toBe(true)
    expect(await requestPermission()).toBe('granted')
  })

  it('forwards a notification via the native capability, not the Rust dispatcher', () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const invoke = vi.fn()
    vi.stubGlobal('window', { api: { notification: { send }, backend: { invoke } } })

    sendNotification({ title: 'Export done', body: 'clip.mp4' })

    expect(send).toHaveBeenCalledWith({ title: 'Export done', body: 'clip.mp4' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('swallows a rejected send (best-effort)', () => {
    const send = vi.fn().mockRejectedValue(new Error('no Notification support'))
    vi.stubGlobal('window', { api: { notification: { send }, backend: { invoke: vi.fn() } } })
    expect(() => sendNotification({ title: 'x' })).not.toThrow()
  })
})
