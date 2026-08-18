// `electron` can't load under Vitest, so `BrowserWindow` is stubbed down to what
// `buildHost` + `hardenWindow` touch, and the CDP `debugger` to canned replies.
// The one thing under test is the shutdown latch, so the fake counts how many
// windows the module opens.
import { describe, it, expect, vi } from 'vitest'

let opened = 0

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents = {
      setZoomFactor: () => {},
      on: () => {},
      setWindowOpenHandler: () => {},
      debugger: {
        attach: () => {},
        detach: () => {},
        sendCommand: async (method: string) =>
          method === 'Page.captureScreenshot'
            ? { data: 'UE5H' }
            : method === 'Runtime.evaluate'
              ? { result: { value: true } }
              : {},
      },
    }
    constructor() {
      opened++
    }
    loadURL = async (): Promise<void> => {}
    destroy = (): void => {}
  }
  return { BrowserWindow: FakeBrowserWindow, shell: { openExternal: async () => {} } }
})

const { captureMotifFrameB64, setRuntimeSource, shutdownCaptureHost } = await import('./capture')

// An unknown motif id keeps the catalog out of it: no manifest means the default
// duration, which is all doCapture needs to reach the screenshot.
const args = {
  motifId: 'not-a-builtin',
  tSec: 0,
  propsJson: '{}',
  width: 32,
  height: 16,
  settleRafs: null,
  contentHash: 'v1',
}

describe('capture host shutdown', () => {
  // Ordered on purpose: the latch is permanent, so the live case has to run
  // first — it is what gives the "no window opened" assertion below its teeth.
  it('opens an offscreen host for a live capture', async () => {
    setRuntimeSource('/* clock-takeover runtime */')
    await expect(captureMotifFrameB64(args)).resolves.toBe('UE5H')
    expect(opened).toBe(1)
  })

  it('refuses a capture queued past shutdown instead of reopening the host', async () => {
    shutdownCaptureHost()
    await expect(captureMotifFrameB64(args)).rejects.toThrow(/shut down/)
    expect(opened).toBe(1)
  })
})
