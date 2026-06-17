import { app } from 'electron'

app.disableHardwareAcceleration() // overridden per-run in later tasks

app.whenReady().then(async () => {
  console.log('[poc] electron ready')
  app.quit()
})
