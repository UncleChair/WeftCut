import { protocol } from 'electron'
import { resolveMotifFile } from './builtinAssets.js'
import type { UserMotifStore } from './store.js'

/// CSP served with every Motif document.
/// `default-src 'none'` denies network (no connect-src); inline script/style for
/// self-contained Motifs; data: + motif: images/fonts.
const MOTIF_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: motif:; font-src data: motif:"

/// Exported so index.ts can spread it into the single registerSchemesAsPrivileged call.
/// `standard:true` gives motif://<id>/… real origin semantics (same-origin assets +
/// CSP); `secure:true` lets it host fonts; `supportFetchAPI:true` enables net.fetch.
export const MOTIF_SCHEME_ENTRY = {
  scheme: 'motif',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
} as const

/// Serve motif://<id>/<rest> from TS (built-in assets + the user store). The
/// `?v=<content_hash>` query is ignored by resolution (it only busts the host
/// page cache). No caching headers — the host reloads each id on navigate.
///
/// With `standard:true`, `motif://countdown/index.html` parses with
/// `hostname === 'countdown'` and `pathname === '/index.html'`.
export function registerMotifProtocol(builtinDir: string, store: UserMotifStore): void {
  protocol.handle('motif', async (request) => {
    const url = new URL(request.url) // motif://<id>/<rest>
    const id = url.hostname
    const rest = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html'
    const file = resolveMotifFile(builtinDir, store, id, rest)
    if (!file) return new Response('not found: ' + id + '/' + rest, { status: 404 })
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: { 'Content-Type': file.contentType, 'Content-Security-Policy': MOTIF_CSP },
    })
  })
}
