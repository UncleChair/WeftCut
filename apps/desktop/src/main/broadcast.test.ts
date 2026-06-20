import { describe, it, expect, vi } from 'vitest'
import { broadcastEvent } from './broadcast'

// Minimal stand-in for the slice of BrowserWindow broadcastEvent touches.
function fakeWin(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } }
}

describe('broadcastEvent', () => {
  it('re-sends as evt:<event> with the payload to every live window', () => {
    const a = fakeWin()
    const b = fakeWin()
    broadcastEvent([a, b], 'perf:snapshot', { fps: 60 })
    expect(a.webContents.send).toHaveBeenCalledWith('evt:perf:snapshot', { fps: 60 })
    expect(b.webContents.send).toHaveBeenCalledWith('evt:perf:snapshot', { fps: 60 })
  })

  it('skips destroyed windows', () => {
    const live = fakeWin()
    const dead = fakeWin(true)
    broadcastEvent([live, dead], 'x')
    expect(live.webContents.send).toHaveBeenCalledWith('evt:x', undefined)
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })
})
