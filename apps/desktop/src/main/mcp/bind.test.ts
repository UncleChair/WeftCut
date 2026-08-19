import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { listenLoopback, type Listenable } from './bind.js'

const opened: HttpServer[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
})

/// A fresh server per listen call — the semantics express gives us, and what
/// makes a second attempt on the same target possible at all.
const realTarget: Listenable = {
  listen: (port, host, onListening) => {
    const s = http.createServer().listen(port, host, onListening)
    opened.push(s)
    return s
  },
}

/// Scripted bind outcomes, one per listen call. `phantom` is the Windows
/// sequence that motivated this module: the listen callback fires first with a
/// null address, and only then does the error arrive.
type Outcome = { kind: 'ok'; port: number } | { kind: 'error' | 'phantom'; code: string }

function fakeTarget(outcomes: Outcome[]): { target: Listenable; ports: number[]; servers: EventEmitter[] } {
  const ports: number[] = []
  const servers: EventEmitter[] = []
  let next = 0
  const target: Listenable = {
    listen(port, _host, onListening) {
      ports.push(port)
      const outcome = outcomes[next++]!
      const server = new EventEmitter()
      let addr: { port: number } | null = null
      Object.assign(server, { address: () => addr })
      servers.push(server)
      queueMicrotask(() => {
        if (outcome.kind === 'ok') {
          addr = { port: outcome.port }
          onListening()
          return
        }
        if (outcome.kind === 'phantom') onListening()
        server.emit('error', Object.assign(new Error(outcome.code), { code: outcome.code }))
      })
      return server as unknown as HttpServer
    },
  }
  return { target, ports, servers }
}

describe('listenLoopback', () => {
  it('keeps the hinted port when it binds, so client configs stay valid', async () => {
    const { target, ports } = fakeTarget([{ kind: 'ok', port: 4711 }])
    expect(await listenLoopback(target, 4711)).toMatchObject({ port: 4711 })
    expect(ports).toEqual([4711])
  })

  it('asks the OS directly when there is no hint', async () => {
    const { target, ports } = fakeTarget([{ kind: 'ok', port: 5000 }])
    expect(await listenLoopback(target, 0)).toMatchObject({ port: 5000 })
    expect(ports).toEqual([0])
  })

  it('re-picks when a phantom listen callback precedes the error', async () => {
    // The regression: settling on the callback alone returned a server whose
    // address() was null, and reading .port off it killed the whole MCP host.
    const { target, ports } = fakeTarget([
      { kind: 'phantom', code: 'EACCES' },
      { kind: 'ok', port: 6001 },
    ])
    expect(await listenLoopback(target, 50793)).toMatchObject({ port: 6001 })
    expect(ports).toEqual([50793, 0])
  })

  it('re-picks on EACCES, not just on a collision', async () => {
    // A stored port can land inside an OS-excluded range after a reboot with
    // nobody holding it; EADDRINUSE-only fallback stranded the host there.
    const { target, ports } = fakeTarget([
      { kind: 'error', code: 'EACCES' },
      { kind: 'ok', port: 6002 },
    ])
    expect(await listenLoopback(target, 50793)).toMatchObject({ port: 6002 })
    expect(ports).toEqual([50793, 0])
  })

  it('survives a late error on the abandoned server', async () => {
    // An 'error' with no listener is fatal in Node, so the handler must outlive
    // the settle it lost.
    const { target, servers } = fakeTarget([
      { kind: 'error', code: 'EACCES' },
      { kind: 'ok', port: 6003 },
    ])
    await listenLoopback(target, 50793)
    expect(() => servers[0]!.emit('error', new Error('late'))).not.toThrow()
  })

  it('surfaces the error when even the OS pick fails', async () => {
    const { target } = fakeTarget([
      { kind: 'error', code: 'EACCES' },
      { kind: 'error', code: 'EPERM' },
    ])
    await expect(listenLoopback(target, 50793)).rejects.toMatchObject({ code: 'EPERM' })
  })

  it('re-picks off a genuinely occupied port', async () => {
    const taken = await listenLoopback(realTarget, 0)
    const next = await listenLoopback(realTarget, taken.port)
    expect(next.port).not.toBe(taken.port)
    expect(next.server.address()).not.toBeNull()
  })
})
