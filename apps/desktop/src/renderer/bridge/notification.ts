// Desktop notifications. Permission is trivially granted; sendNotification is
// currently a no-op.

export async function isPermissionGranted(): Promise<boolean> {
  return true
}

export async function requestPermission(): Promise<'granted'> {
  return 'granted'
}

export function sendNotification(opts: unknown): void {
  // S1 stub: no desktop notification in the stub shell.
  void window.api.backend.invoke('notification:send', opts).catch(() => {
    // stub rejection — ignored
  })
}
