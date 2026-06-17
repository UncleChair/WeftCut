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

  const b1 = await runBoundary1()
  console.log('[boundary1]', JSON.stringify(b1, null, 2))

  const host = await createHost()
  const b2 = await runBoundary2(host)
  console.log('[boundary2]', JSON.stringify(b2, null, 2))

  app.quit()
})
