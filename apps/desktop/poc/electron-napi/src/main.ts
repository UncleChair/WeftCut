import { app } from 'electron'
import * as fs from 'node:fs'
import { runBoundary1 } from './boundary1'
import { registerMotifSchemePrivileged, registerMotifProtocol } from './protocol'
import { createHost } from './capture'
import { runBoundary2 } from './boundary2'

const useSoftware = process.argv.includes('--software')
if (useSoftware) app.disableHardwareAcceleration()
registerMotifSchemePrivileged()

app.whenReady().then(async () => {
  registerMotifProtocol()
  const mode = useSoftware ? 'software' : 'gpu'

  const b1 = await runBoundary1()
  const host = await createHost()
  const b2 = await runBoundary2(host)

  const block = [
    `## Run: ${mode}`,
    '',
    '### Boundary 1 (napi-rs state)',
    `- p50: ${b1.p50Ms.toFixed(4)} ms  (GO ≤ 1.0)`,
    `- p99: ${b1.p99Ms.toFixed(4)} ms  (GO ≤ 5.0)`,
    `- payload: ${b1.payloadBytes} bytes`,
    `- tickRatio: ${b1.tickRatio.toFixed(3)}  (GO ≥ 0.8 — event loop non-blocking)`,
    `- eventsReceived: ${b1.eventsReceived}  (GO = 5 — TSFN delivery)`,
    '',
    '### Boundary 2 (capture)',
    `- identical: ${b2.identical}  (GO = true in software mode)`,
    `- maxChannelDiff: ${b2.maxChannelDiff}`,
    `- pctPixelsDiffering: ${b2.pctPixelsDiffering.toFixed(4)}%`,
    `- hasAlpha: ${b2.hasAlpha}  (GO = true)`,
    `- avgCaptureMs: ${b2.avgCaptureMs.toFixed(2)} ms  (GO < 300 in software mode)`,
    `- gpuRenderer (normal window): ${b2.gpuRenderer}`,
    '',
  ].join('\n')

  fs.appendFileSync('results.md', block + '\n')
  console.log(block)
  app.quit()
})
