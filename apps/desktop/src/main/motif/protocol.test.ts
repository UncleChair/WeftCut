// `electron` can't load under Vitest, so the module is stubbed down to the one
// call `registerMotifProtocol` makes (`protocol.handle`) plus the `app` shape
// `builtinAssets` reads at import time. The captured handler is then driven
// with plain `Request`s — this is the served-response contract, not a mock of it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let handler: ((request: Request) => Promise<Response>) | null = null

vi.mock('electron', () => ({
  app: { isPackaged: false },
  protocol: {
    handle: (_scheme: string, fn: (request: Request) => Promise<Response>) => {
      handler = fn
    },
  },
}))

import { MOTIF_CSP, MOTIF_PARAMS_CSP, cspForMotifFile, registerMotifProtocol } from './protocol'
import { UserMotifStore } from './store'

const BUILTIN_DIR = path.resolve(__dirname, '../../shared/motifs/builtin')

let root: string
beforeEach(() => {
  handler = null
  root = mkdtempSync(path.join(tmpdir(), 'motif-protocol-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/// Install a user motif directory with the given files under `<root>/<id>/`.
function installUserMotif(id: string, files: Record<string, string>): void {
  const dir = path.join(root, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body)
}

function serve(id: string, rest: string): Promise<Response> {
  const store = new UserMotifStore(root)
  registerMotifProtocol(BUILTIN_DIR, store)
  return handler!(new Request(`motif://${id}/${rest}`))
}

describe('cspForMotifFile', () => {
  it('gives params.html the params CSP and everything else the render CSP', () => {
    expect(cspForMotifFile('params.html')).toBe(MOTIF_PARAMS_CSP)
    expect(cspForMotifFile('index.html')).toBe(MOTIF_CSP)
    // A nested path that merely ends in the name is NOT the params page.
    expect(cspForMotifFile('assets/params.html')).toBe(MOTIF_CSP)
  })

  it('the params CSP loosens only script-src/style-src and still denies network', () => {
    // Delta: the `motif:` scheme joins script/style sources so a params page can
    // ship companion files. Nothing else moves.
    expect(MOTIF_PARAMS_CSP).toContain("script-src 'unsafe-inline' motif:")
    expect(MOTIF_PARAMS_CSP).toContain("style-src 'unsafe-inline' motif:")
    expect(MOTIF_CSP).toContain("script-src 'unsafe-inline';")
    for (const directive of ["default-src 'none'", 'img-src data: motif:', 'font-src data: motif:']) {
      expect(MOTIF_PARAMS_CSP).toContain(directive)
      expect(MOTIF_CSP).toContain(directive)
    }
    // No connect-src anywhere → `default-src 'none'` denies fetch/XHR/WebSocket.
    expect(MOTIF_PARAMS_CSP).not.toContain('connect-src')
    // `'self'` would match nothing under the frame's opaque origin.
    expect(MOTIF_PARAMS_CSP).not.toContain("'self'")
  })
})

describe('registerMotifProtocol responses', () => {
  it('serves a user motif params.html with the params CSP', async () => {
    installUserMotif('user-p', { 'index.html': '<html>i</html>', 'params.html': '<html>p</html>' })
    const res = await serve('user-p', 'params.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toBe(MOTIF_PARAMS_CSP)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe('<html>p</html>')
  })

  it('keeps the render CSP on index.html of the same motif', async () => {
    installUserMotif('user-p', { 'index.html': '<html>i</html>', 'params.html': '<html>p</html>' })
    const res = await serve('user-p', 'index.html')
    expect(res.headers.get('Content-Security-Policy')).toBe(MOTIF_CSP)
  })

  it('keeps the render CSP on a built-in document', async () => {
    const res = await serve('countdown', 'index.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toBe(MOTIF_CSP)
  })

  it('404s a params.html the motif does not ship (no CSP promise for a miss)', async () => {
    installUserMotif('bare', { 'index.html': '<html>i</html>' })
    const res = await serve('bare', 'params.html')
    expect(res.status).toBe(404)
  })

  it('the ?v= cache buster does not change resolution or CSP', async () => {
    installUserMotif('user-p', { 'index.html': '<html>i</html>', 'params.html': '<html>p</html>' })
    const store = new UserMotifStore(root)
    registerMotifProtocol(BUILTIN_DIR, store)
    const res = await handler!(new Request('motif://user-p/params.html?v=7'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toBe(MOTIF_PARAMS_CSP)
  })
})
