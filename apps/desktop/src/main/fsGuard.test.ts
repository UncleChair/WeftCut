import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { isInside, isAllowed } from './fsGuard'

// A host-valid absolute root (C:\app\data on Windows, /app/data on POSIX).
const ROOT = path.resolve('/app/data')

describe('isInside', () => {
  it('accepts the root itself', () => {
    expect(isInside(ROOT, ROOT)).toBe(true)
  })

  it('accepts a direct child file', () => {
    expect(isInside(ROOT, path.join(ROOT, 'file.txt'))).toBe(true)
  })

  it('accepts a deeply nested child', () => {
    expect(isInside(ROOT, path.join(ROOT, 'a', 'b', 'c.png'))).toBe(true)
  })

  it('accepts a literal name that merely starts with ".."', () => {
    // `..foo` is a real dir name, not a traversal segment.
    expect(isInside(ROOT, path.join(ROOT, '..foo'))).toBe(true)
  })

  it('rejects a sibling that shares a name prefix', () => {
    expect(isInside(ROOT, path.resolve('/app/dataother', 'x'))).toBe(false)
  })

  it('rejects an unrelated path', () => {
    expect(isInside(ROOT, path.resolve('/etc/passwd'))).toBe(false)
  })

  it('rejects a traversal that climbs out of the root', () => {
    expect(isInside(ROOT, path.join(ROOT, '..', 'escape'))).toBe(false)
    expect(isInside(ROOT, path.join(ROOT, 'sub', '..', '..', 'escape'))).toBe(false)
  })

  it('rejects the parent of the root', () => {
    expect(isInside(ROOT, path.dirname(ROOT))).toBe(false)
  })
})

describe('isInside — Windows case-insensitivity', () => {
  const win = process.platform === 'win32'
  it.runIf(win)('treats a differently-cased root as the same', () => {
    expect(isInside(ROOT, path.join(ROOT.toUpperCase(), 'f.txt'))).toBe(true)
  })
  it.runIf(win)('rejects a path on a different drive', () => {
    expect(isInside('C:\\app\\data', 'D:\\app\\data\\f.txt')).toBe(false)
  })
})

describe('isAllowed', () => {
  const TEMP = path.resolve('/tmp/weft')
  const USER = path.resolve('/home/u/userData')
  const roots = [TEMP, USER]

  it('accepts a path under any root', () => {
    expect(isAllowed(path.join(TEMP, 'export.mp4'), roots)).toBe(true)
    expect(isAllowed(path.join(USER, 'Cache', 'x'), roots)).toBe(true)
  })

  it('rejects a path under no root', () => {
    expect(isAllowed(path.resolve('/etc/shadow'), roots)).toBe(false)
  })

  it('rejects against an empty root list', () => {
    expect(isAllowed(path.join(TEMP, 'x'), [])).toBe(false)
  })
})
