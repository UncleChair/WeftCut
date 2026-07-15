import { describe, it, expect } from 'vitest'
import { secondaryWindowConfig } from './windowConfig'

describe('secondaryWindowConfig', () => {
  it('gives a decorated (framed) window when decorations is true', () => {
    // The PerfHUD popup passes decorations:true and draws NO custom titlebar.
    // Regression guard: a frameless window here is un-movable and un-closable.
    expect(secondaryWindowConfig({ decorations: true }, 'win32').frame).toBe(true)
  })

  it('defaults to a framed window when decorations is omitted', () => {
    // Secondary windows render content directly with no in-page chrome, so the
    // safe default is the native OS frame (Render & Play passes no decorations).
    expect(secondaryWindowConfig({}, 'win32').frame).toBe(true)
    expect(secondaryWindowConfig(undefined, 'win32').frame).toBe(true)
  })

  it('honors an explicit frameless request on Windows/Linux', () => {
    // Only a window that draws its own caption should opt out of the OS frame.
    expect(secondaryWindowConfig({ decorations: false }, 'win32').frame).toBe(false)
    expect(secondaryWindowConfig({ decorations: false }, 'linux').frame).toBe(false)
  })

  it('keeps the frame + native traffic lights for a frameless popup on macOS', () => {
    // On macOS the renderer suppresses its own caption buttons (native traffic
    // lights take over), so a truly frameless popup would be un-closable. Keep
    // the frame and hide only the titlebar so the traffic lights remain.
    const c = secondaryWindowConfig({ decorations: false }, 'darwin')
    expect(c.frame).toBe(true)
    expect(c.titleBarStyle).toBe('hidden')
    expect(c.trafficLightPosition).toEqual({ x: 10, y: 10 })
  })

  it('threads sizing + title + resizable through', () => {
    const c = secondaryWindowConfig({
      width: 640,
      height: 560,
      minWidth: 380,
      minHeight: 320,
      title: 'WeftCut — Performance',
      resizable: true,
    })
    expect(c).toMatchObject({
      width: 640,
      height: 560,
      minWidth: 380,
      minHeight: 320,
      title: 'WeftCut — Performance',
      resizable: true,
    })
  })

  it('applies sensible defaults', () => {
    const c = secondaryWindowConfig()
    expect(c.width).toBe(480)
    expect(c.height).toBe(320)
    expect(c.resizable).toBe(true)
    expect(c.show).toBe(true)
    expect(c.backgroundColor).toBe('#0a0a0a')
  })
})
