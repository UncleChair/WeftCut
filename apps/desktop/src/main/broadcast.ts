// Cross-window event fan-out. The renderer's `emit()` (bridge/events.ts) forwards
// an event here; main re-sends it as `evt:<event>` to every live window, where
// the preload's `on()` delivers it to any `listen()` subscriber. This is also
// how the main editor streams on-demand telemetry snapshots to the independent
// Dev Performance Monitor.
// Kept electron-free (operates on any window-like) so it's unit-testable without
// spinning up a BrowserWindow.

interface BroadcastTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload?: unknown): void }
}

export function broadcastEvent(windows: BroadcastTarget[], event: string, payload?: unknown): void {
  for (const w of windows) {
    if (w.isDestroyed()) continue
    w.webContents.send('evt:' + event, payload)
  }
}
