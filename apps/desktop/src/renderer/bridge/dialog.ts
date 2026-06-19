// Native open / save file dialogs, via the Electron main process.

type OpenOpts = { title?: string; multiple?: boolean; directory?: boolean; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }
type SaveOpts = { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }

export async function open(opts?: OpenOpts): Promise<string | string[] | null> {
  return window.api.dialog.open(opts ?? {})
}

export async function save(opts?: SaveOpts): Promise<string | null> {
  return window.api.dialog.save(opts ?? {})
}
