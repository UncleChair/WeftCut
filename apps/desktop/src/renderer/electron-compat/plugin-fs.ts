// Replaces @tauri-apps/plugin-fs.
// Imports seen in src/:
//   App.tsx:        remove, writeFile
//   e2eHook.ts:     exists, readDir
//   frameCache.ts:  mkdir, writeFile, readFile, readDir, remove, exists (motif L2 cache)
// All are invoke wrappers; callers guard with try/catch.

export async function readFile(path: string, _opts?: unknown): Promise<Uint8Array<ArrayBuffer>> {
  // The IPC payload is a Node Buffer → a plain ArrayBuffer-backed Uint8Array in
  // the renderer (never SharedArrayBuffer). Type it concretely so callers can
  // pass the result straight to Blob/BufferSource sinks (TS 5.7+ generic).
  return (await window.api.invoke('fs:readFile', { path })) as Uint8Array<ArrayBuffer>
}

export async function mkdir(
  path: string,
  opts?: { recursive?: boolean },
): Promise<void> {
  await window.api.invoke('fs:mkdir', { path, recursive: opts?.recursive ?? false })
}

export async function writeFile(
  path: string,
  data: Uint8Array,
  opts?: { append?: boolean },
): Promise<void> {
  await window.api.invoke('fs:writeFile', { path, data, append: opts?.append ?? false })
}

export async function writeTextFile(
  path: string,
  data: string,
  _opts?: unknown,
): Promise<void> {
  await window.api.invoke('fs:writeTextFile', { path, data })
}

export async function remove(path: string, _opts?: unknown): Promise<void> {
  await window.api.invoke('fs:remove', { path })
}

export async function exists(path: string, _opts?: unknown): Promise<boolean> {
  return (await window.api.invoke('fs:exists', { path })) as boolean
}

export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
}

export async function readDir(path: string, _opts?: unknown): Promise<DirEntry[]> {
  return (await window.api.invoke('fs:readDir', { path })) as DirEntry[]
}
