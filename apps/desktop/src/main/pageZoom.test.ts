import { describe, expect, it } from 'vitest'
import { isPageZoomShortcut, type PageZoomInput } from './pageZoom'

function input(overrides: Partial<PageZoomInput> = {}): PageZoomInput {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    control: true,
    meta: false,
    alt: false,
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
