import { describe, expect, it } from 'vitest'
import { isPageZoomShortcut, matchDevKeyAction, shouldClearApplicationMenu, type KeyInput } from './inputPolicy'

function input(overrides: Partial<KeyInput> = {}): KeyInput {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    control: true,
    meta: false,
    alt: false,
    shift: false,
    ...overrides,
  }
}

describe('isPageZoomShortcut', () => {
  it.each([
    ['Minus', '-'],
    ['Equal', '='],
    ['Equal', '+'],
    ['Digit0', '0'],
    ['NumpadSubtract', '-'],
    ['NumpadAdd', '+'],
    ['Numpad0', '0'],
  ])('blocks Chromium page zoom for %s', (code, key) => {
    expect(isPageZoomShortcut(input({ code, key }))).toBe(true)
  })

  it('supports the macOS Command variants', () => {
    expect(isPageZoomShortcut(input({ control: false, meta: true, code: 'Minus', key: '-' }))).toBe(true)
  })

  it('does not consume unmodified keys, other shortcuts, Alt chords, or keyup', () => {
    expect(isPageZoomShortcut(input({ control: false, code: 'Minus', key: '-' }))).toBe(false)
    expect(isPageZoomShortcut(input({ code: 'KeyS', key: 's' }))).toBe(false)
    expect(isPageZoomShortcut(input({ alt: true, code: 'Minus', key: '-' }))).toBe(false)
    expect(isPageZoomShortcut(input({ type: 'keyUp', code: 'Minus', key: '-' }))).toBe(false)
  })
})

describe('matchDevKeyAction', () => {
  it.each([
    ['reload — Ctrl+R', input({ control: true, code: 'KeyR', key: 'r' }), 'reload'],
    ['reload — Cmd+R', input({ control: false, meta: true, code: 'KeyR', key: 'r' }), 'reload'],
    ['force-reload — Ctrl+Shift+R', input({ control: true, shift: true, code: 'KeyR', key: 'R' }), 'forceReload'],
    ['force-reload — Cmd+Shift+R', input({ control: false, meta: true, shift: true, code: 'KeyR', key: 'R' }), 'forceReload'],
    ['devtools — Ctrl+Shift+I', input({ control: true, shift: true, code: 'KeyI', key: 'I' }), 'toggleDevTools'],
    // macOS Option+I prints a dead key, so the physical `code` is what identifies it.
    ['devtools — Cmd+Alt+I', input({ control: false, meta: true, alt: true, code: 'KeyI', key: 'ˆ' }), 'toggleDevTools'],
    ['devtools — F12', input({ control: false, code: 'F12', key: 'F12' }), 'toggleDevTools'],
    ['fullscreen — F11', input({ control: false, code: 'F11', key: 'F11' }), 'toggleFullscreen'],
  ])('maps %s', (_label, ev, expected) => {
    expect(matchDevKeyAction(ev, true)).toBe(expected)
  })

  it('is inert in production for every dev chord', () => {
    for (const ev of [
      input({ control: true, code: 'KeyR', key: 'r' }),
      input({ control: true, shift: true, code: 'KeyR', key: 'R' }),
      input({ control: true, shift: true, code: 'KeyI', key: 'I' }),
      input({ control: false, meta: true, alt: true, code: 'KeyI', key: 'ˆ' }),
      input({ control: false, code: 'F12', key: 'F12' }),
      input({ control: false, code: 'F11', key: 'F11' }),
    ]) {
      expect(matchDevKeyAction(ev, false)).toBeNull()
    }
  })

  it.each([
    ['Ctrl+Minus (page zoom out)', input({ control: true, code: 'Minus', key: '-' })],
    ['Ctrl+Equal (page zoom in)', input({ control: true, code: 'Equal', key: '=' })],
    ['Ctrl+0 (page zoom reset)', input({ control: true, code: 'Digit0', key: '0' })],
  ])('leaves %s to isPageZoomShortcut', (_label, ev) => {
    expect(matchDevKeyAction(ev, true)).toBeNull()
  })

  it('ignores keyup, bare letters, and modifier-less R/I', () => {
    expect(matchDevKeyAction(input({ type: 'keyUp', control: true, code: 'KeyR', key: 'r' }), true)).toBeNull()
    expect(matchDevKeyAction(input({ control: false, code: 'KeyR', key: 'r' }), true)).toBeNull()
    expect(matchDevKeyAction(input({ control: false, code: 'KeyI', key: 'i' }), true)).toBeNull()
    // Ctrl+I without Shift is not the DevTools chord.
    expect(matchDevKeyAction(input({ control: true, code: 'KeyI', key: 'i' }), true)).toBeNull()
    // Ctrl+Alt+R is not a reload chord (Alt disqualifies it).
    expect(matchDevKeyAction(input({ control: true, alt: true, code: 'KeyR', key: 'r' }), true)).toBeNull()
  })
})

describe('shouldClearApplicationMenu', () => {
  it.each([
    ['win32', true],
    ['linux', true],
    ['darwin', false],
  ] as const)('returns %s → %s', (platform, expected) => {
    expect(shouldClearApplicationMenu(platform)).toBe(expected)
  })
})
