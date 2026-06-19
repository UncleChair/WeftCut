// Native open / save file dialogs, via the Electron main process.

import type { DialogOpenOpts, DialogSaveOpts } from '../../shared/ipc'

export async function open(opts?: DialogOpenOpts): Promise<string | string[] | null> {
  return window.api.dialog.open(opts ?? {})
}

export async function save(opts?: DialogSaveOpts): Promise<string | null> {
  return window.api.dialog.save(opts ?? {})
}
