import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Debouncer, spawnMotifWatcher } from './watcher'

describe('Debouncer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a burst into one fire, then fires again on a later burst', () => {
    const fired = vi.fn()
    const d = new Debouncer(50, fired)
    for (let i = 0; i < 5; i++) d.signal()
    expect(fired).not.toHaveBeenCalled()       // still inside the quiet window
    vi.advanceTimersByTime(60)
    expect(fired).toHaveBeenCalledTimes(1)      // burst coalesced to one
    d.signal()
    vi.advanceTimersByTime(60)
    expect(fired).toHaveBeenCalledTimes(2)      // a later burst fires again
  })

  it('cancel() suppresses a pending fire', () => {
    const fired = vi.fn()
    const d = new Debouncer(50, fired)
    d.signal()
    d.cancel()
    vi.advanceTimersByTime(60)
    expect(fired).not.toHaveBeenCalled()
  })
})

describe('spawnMotifWatcher', () => {
  it('fires onChange on a real file write under the root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'motifwatch-'))
    const fired = vi.fn()
    const w = spawnMotifWatcher(root, fired)
    try {
      await new Promise((r) => setTimeout(r, 200)) // let the OS watch attach
      mkdirSync(path.join(root, 'm1'), { recursive: true })
      writeFileSync(path.join(root, 'm1', 'index.html'), '<html>')
      const deadline = Date.now() + 5000
      while (fired.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(fired.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      w.close()
    }
  })
})
