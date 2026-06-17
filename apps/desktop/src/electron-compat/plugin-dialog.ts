// Replaces @tauri-apps/plugin-dialog.
// Imports seen in src/: open (as openDialog), save (as saveDialog)
// In S1 these invoke the stub and reject; callers handle null/cancel.

export async function open(opts?: unknown): Promise<string | string[] | null> {
  return (await window.api.invoke('dialog:open', opts as Record<string, unknown>)) as
    | string
    | string[]
    | null
}

export async function save(opts?: unknown): Promise<string | null> {
  return (await window.api.invoke('dialog:save', opts as Record<string, unknown>)) as string | null
}
