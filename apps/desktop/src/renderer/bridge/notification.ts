// Desktop notifications. Permission is trivially granted; sendNotification is
// currently a no-op.

export async function isPermissionGranted(): Promise<boolean> {
  return true
}

export async function requestPermission(): Promise<'granted'> {
  return 'granted'
}

export function sendNotification(opts: unknown): void {
  // Best-effort: forward to the backend dispatcher; swallow rejections (no
  // desktop-notification handler is wired yet).
  void window.api.backend.invoke('notification:send', opts).catch(() => {
    // ignored (best-effort)
  })
}
