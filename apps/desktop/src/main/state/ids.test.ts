import { describe, it, expect } from 'vitest'
import { seededGen, uuidV7Gen } from './ids'

describe('seededGen', () => {
  it('matches Uuid::from_u128(n) formatting, starting at 1', () => {
    const g = seededGen()
    expect(g()).toBe('00000000-0000-0000-0000-000000000001')
    expect(g()).toBe('00000000-0000-0000-0000-000000000002')
  })
  it('honours a custom start', () => {
    const g = seededGen(255)
    expect(g()).toBe('00000000-0000-0000-0000-0000000000ff')
  })
})

describe('uuidV7Gen', () => {
  it('produces distinct, well-formed v7 uuids', () => {
    const g = uuidV7Gen()
    const a = g(), b = g()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
