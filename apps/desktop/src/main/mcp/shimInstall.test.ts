import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installShim, stdioConnectConfig } from './shimInstall.js'

const tmps: string[] = []
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-shim-install-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('installShim', () => {
  it('copies the packaged shim into <userData>/cli and returns the copy path', () => {
    const res = tmpDir()
    const userData = tmpDir()
    const source = path.join(res, 'weftcut-mcp.cjs')
    fs.writeFileSync(source, '// shim v1')
    const dest = installShim({ resourcesShim: source, devShim: 'X:\\nope', isPackaged: true, userDataDir: userData })
    expect(dest).toBe(path.join(userData, 'cli', 'weftcut-mcp.cjs'))
    expect(fs.readFileSync(dest!, 'utf8')).toBe('// shim v1')
  })

  it('refreshes an existing copy on every start (never stale relative to the app)', () => {
    const res = tmpDir()
    const userData = tmpDir()
    const source = path.join(res, 'weftcut-mcp.cjs')
    const opts = { resourcesShim: source, devShim: 'X:\\nope', isPackaged: true, userDataDir: userData }
    fs.writeFileSync(source, '// shim v1')
    installShim(opts)
    fs.writeFileSync(source, '// shim v2')
    installShim(opts)
    expect(fs.readFileSync(path.join(userData, 'cli', 'weftcut-mcp.cjs'), 'utf8')).toBe('// shim v2')
  })

  it('dev without a built bundle: keeps a pre-existing copy, else reports none', () => {
    const userData = tmpDir()
    const opts = { resourcesShim: 'X:\\nope', devShim: 'X:\\also-nope', isPackaged: false, userDataDir: userData }
    expect(installShim(opts)).toBeNull()
    const dest = path.join(userData, 'cli', 'weftcut-mcp.cjs')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, '// stale copy')
    expect(installShim(opts)).toBe(dest)
  })
})

describe('stdioConnectConfig', () => {
  it('emits exe + shim + discovery env, preferring $APPIMAGE as the command', () => {
    expect(
      stdioConnectConfig({ execPath: 'C:\\App\\WeftCut.exe', appImage: undefined, shimPath: 'C:\\ud\\cli\\s.cjs', userDataDir: 'C:\\ud' }),
    ).toEqual({
      command: 'C:\\App\\WeftCut.exe',
      args: ['C:\\ud\\cli\\s.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', WEFTCUT_USERDATA: 'C:\\ud' },
    })
    expect(
      stdioConnectConfig({ execPath: '/tmp/.mount/weftcut', appImage: '/apps/WeftCut.AppImage', shimPath: '/ud/cli/s.cjs', userDataDir: '/ud' })
        .command,
    ).toBe('/apps/WeftCut.AppImage')
  })
})
