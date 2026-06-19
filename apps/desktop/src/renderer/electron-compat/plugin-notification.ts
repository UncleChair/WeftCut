// Replaces @tauri-apps/plugin-notification.
// Imports seen in src/: isPermissionGranted, requestPermission, sendNotification
// In S1 permission is trivially granted; sendNotification is a no-op.

export async function isPermissionGranted(): Promise<boolean> {
  return true
}

export async function requestPermission(): Promise<'granted'> {
  return 'granted'
}

export function sendNotification(opts: unknown): void {
  // S1 stub: no desktop notification in the stub shell.
  void window.api.invoke('notification:send', opts as Record<string, unknown>).catch(() => {
    // stub rejection — ignored
  })
}
