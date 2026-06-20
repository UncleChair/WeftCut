import { describe, it, expect } from 'vitest'
import { secondaryWindowConfig } from './windowConfig'

describe('secondaryWindowConfig', () => {
  it('gives a decorated (framed) window when decorations is true', () => {
    // The PerfHUD popup passes decorations:true and draws NO custom titlebar.
    // Regression guard: a frameless window here is un-movable and un-closable.
    expect(secondaryWindowConfig({ decorations: true }).frame).toBe(true)
  })

  it('defaults to a framed window when decorations is omitted', () => {
    // Secondary windows render content directly with no in-page chrome, so the
    // safe default is the native OS frame (Render & Play passes no decorations).
    expect(secondaryWindowConfig({}).frame).toBe(true)
    expect(secondaryWindowConfig().frame).toBe(true)
  })

  it('honors an explicit frameless request', () => {
    // Only a window that draws its own caption should opt out of the OS frame.
    expect(secondaryWindowConfig({ decorations: false }).frame).toBe(false)
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
