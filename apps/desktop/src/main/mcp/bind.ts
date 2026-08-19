import type { Server as HttpServer } from 'node:http'

const LOOPBACK = '127.0.0.1'

/// The `listen` surface `listenLoopback` drives. Express's app satisfies it.
export interface Listenable {
  listen(port: number, host: string, onListening: () => void): HttpServer
}

export interface Bound {
  server: HttpServer
  port: number
}

type Attempt =
  | { ok: true; server: HttpServer; port: number }
  | { ok: false; error: NodeJS.ErrnoException }

function attempt(target: Listenable, port: number): Promise<Attempt> {
  return new Promise((settle) => {
    let done = false
    const server = target.listen(port, LOOPBACK, () => {
      // LANDMINE: Node runs the listen callback even when the bind failed —
      // `address()` is already null and the `error` event is still queued
      // behind it. Settling on the callback alone hands back a server that
      // never bound, and every later read of its port is a null deref.
      const addr = server.address()
      if (done || addr === null || typeof addr === 'string') return
      done = true
      settle({ ok: true, server, port: addr.port })
    })
    // Stays attached past settling: an 'error' with no listener is fatal in
    // Node, and a bind that lost the race above still emits one.
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (done) return
      done = true
      settle({ ok: false, error })
    })
  })
}

/// Bind the MCP host to loopback, preferring `hintPort` and falling back to an
/// OS-picked port on any failure.
///
/// `hintPort` is never a contract — it is whichever ephemeral port a previous
/// run happened to be handed, and it can stop being bindable with nobody else
/// holding it: Windows carves excluded ranges out of the ephemeral space and
/// those ranges move across reboots, so a port that bound yesterday answers
/// EACCES today. That is why *any* error demotes the hint, not EADDRINUSE
/// alone. Re-picking is a supported outcome downstream — the stdio shim
/// re-reads mcp_auth.json on every connect attempt to follow a moved port.
///
/// Electron-free on purpose (the app rides in as an argument) so Vitest can
/// cover the retry policy — `electron` cannot load under the unit runner.
export async function listenLoopback(target: Listenable, hintPort: number): Promise<Bound> {
  if (hintPort !== 0) {
    const hinted = await attempt(target, hintPort)
    if (hinted.ok) return { server: hinted.server, port: hinted.port }
  }
  const picked = await attempt(target, 0)
  if (!picked.ok) throw picked.error
  return { server: picked.server, port: picked.port }
}
