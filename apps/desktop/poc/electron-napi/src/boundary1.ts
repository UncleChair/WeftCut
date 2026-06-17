import { performance } from 'node:perf_hooks'

// CJS output (esbuild --format=cjs): the global `require` is available; the
// addon is external and resolved by package name from node_modules/poc_native.
declare const require: (id: string) => any
const native = require('poc_native') as {
  applyMutation(payload: string): Promise<string>
  heavyMutation(rounds: number): Promise<number>
  subscribeAndFire(cb: (err: unknown, msg: string) => void): void
}

export interface Boundary1Result {
  p50Ms: number
  p99Ms: number
  payloadBytes: number
  tickRatio: number
  eventsReceived: number
}

export async function runBoundary1(): Promise<Boundary1Result> {
  const N = 1000
  // warm-up
  for (let i = 0; i < 50; i++) {
    await native.applyMutation(JSON.stringify({ layerIndex: i % 50, deltaUs: 1000 }))
  }
  const samples: number[] = []
  let payloadBytes = 0
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    const view = await native.applyMutation(JSON.stringify({ layerIndex: i % 50, deltaUs: 1000 }))
    samples.push(performance.now() - t0)
    if (i === 0) payloadBytes = Buffer.byteLength(view, 'utf8')
  }
  samples.sort((a, b) => a - b)
  const p50Ms = samples[Math.floor(N * 0.5)]
  const p99Ms = samples[Math.floor(N * 0.99)]

  // Non-blocking: a JS-thread timer must keep ticking while a heavy native op runs.
  let ticks = 0
  const intervalMs = 10
  const timer = setInterval(() => { ticks++ }, intervalMs)
  const tStart = performance.now()
  await native.heavyMutation(800) // tune so elapsed >= ~500ms on this machine
  const elapsedMs = performance.now() - tStart
  clearInterval(timer)
  const expectedTicks = elapsedMs / intervalMs
  const tickRatio = ticks / expectedTicks // ~1.0 == event loop never blocked

  // ThreadsafeFunction: expect 5 events delivered to the JS callback.
  const events: string[] = []
  await new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 3000)
    native.subscribeAndFire((_err, msg) => {
      events.push(msg)
      if (events.length >= 5) { clearTimeout(done); resolve() }
    })
  })

  return { p50Ms, p99Ms, payloadBytes, tickRatio, eventsReceived: events.length }
}
