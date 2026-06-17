import { app } from 'electron'
import { runBoundary1 } from './boundary1'

const useSoftware = process.argv.includes('--software')
if (useSoftware) app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const b1 = await runBoundary1()
  console.log('[boundary1]', JSON.stringify(b1, null, 2))
  app.quit()
})
