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

  return { p50Ms, p99Ms, payloadBytes, tickRatio: NaN, eventsReceived: -1 }
}
