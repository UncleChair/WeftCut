// Desktop notifications. Permission is trivially granted (single-user desktop
// app); sendNotification posts through the native main-process Notification API.

import type { NotificationOpts } from '../../shared/ipc'

export async function isPermissionGranted(): Promise<boolean> {
  return true
}

export async function requestPermission(): Promise<'granted'> {
  return 'granted'
}

export function sendNotification(opts: NotificationOpts): void {
  // Best-effort: post via the native capability; swallow rejections (some
  // platforms have no notification support).
  void window.api.notification.send(opts).catch(() => {
    // ignored (best-effort)
  })
}
