// Native open / save file dialogs, via the Electron main process.

export async function open(opts?: unknown): Promise<string | string[] | null> {
  return (await window.api.invoke('dialog:open', opts as Record<string, unknown>)) as
    | string
    | string[]
    | null
}

export async function save(opts?: unknown): Promise<string | null> {
  return (await window.api.invoke('dialog:save', opts as Record<string, unknown>)) as string | null
}
