import { protocol } from 'electron'
import { PARAMS_PAGE_FILE } from '../../shared/motifs/catalog.js'
import { resolveMotifFile } from './builtinAssets.js'
import type { UserMotifStore } from './store.js'

/// CSP served with every Motif RENDER document (`index.html` and friends).
/// `default-src 'none'` denies network (no connect-src); inline script/style for
/// self-contained Motifs; data: + motif: images/fonts.
export const MOTIF_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: motif:; font-src data: motif:"

/// CSP served with a Motif's params page. Delta vs `MOTIF_CSP`: `script-src`
/// and `style-src` additionally allow the `motif:` scheme, so a params page may
/// split itself into companion `.js`/`.css` files instead of cramming
/// everything inline — a render document is one self-contained file by
/// construction, a parameter UI is not.
///
/// Everything else is deliberately identical:
/// - `default-src 'none'` leaves `connect-src` empty, so fetch / XHR /
///   WebSocket / EventSource are denied. A params page cannot reach the
///   network, exactly like a render document.
/// - `'self'` is NOT used anywhere: the page is framed with
///   `sandbox="allow-scripts"` and no `allow-same-origin`, so its origin is
///   opaque and `'self'` would match nothing. `motif:` is the only workable
///   way to name a motif's own files.
export const MOTIF_PARAMS_CSP =
  "default-src 'none'; script-src 'unsafe-inline' motif:; style-src 'unsafe-inline' motif:; img-src data: motif:; font-src data: motif:"

/// The CSP for one served motif file. Params pages get the looser script/style
/// sources; every other file — including any HTML the render host loads — keeps
/// the render CSP.
export function cspForMotifFile(rest: string): string {
  return rest === PARAMS_PAGE_FILE ? MOTIF_PARAMS_CSP : MOTIF_CSP
}

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
      headers: {
        'Content-Type': file.contentType,
        'Content-Security-Policy': cspForMotifFile(rest),
      },
    })
  })
}
