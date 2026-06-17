import { app } from 'electron'
import * as fs from 'node:fs'
import { runBoundary1 } from './boundary1'
import { registerMotifSchemePrivileged, registerMotifProtocol } from './protocol'
import { createHost, captureFrame } from './capture'

const useSoftware = process.argv.includes('--software')
if (useSoftware) app.disableHardwareAcceleration()
registerMotifSchemePrivileged()

app.whenReady().then(async () => {
  registerMotifProtocol()

  const b1 = await runBoundary1()
  console.log('[boundary1]', JSON.stringify(b1, null, 2))

  const host = await createHost()
  const png = await captureFrame(host, 0.35)
  fs.writeFileSync('frame-0.35.png', png)
  console.log('[capture] wrote frame-0.35.png', png.length, 'bytes')

  app.quit()
})
