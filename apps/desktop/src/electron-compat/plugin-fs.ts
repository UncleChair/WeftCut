// Replaces @tauri-apps/plugin-fs.
// Imports seen in src/:
//   App.tsx:        remove, writeFile
//   e2eHook.ts:     exists, readDir
// All are stub-invoke in S1; callers guard with try/catch.

export async function readFile(path: string, _opts?: unknown): Promise<Uint8Array> {
  return (await window.api.invoke('fs:readFile', { path })) as Uint8Array
}

export async function writeFile(
  path: string,
  data: Uint8Array,
  _opts?: unknown,
): Promise<void> {
  await window.api.invoke('fs:writeFile', { path, data })
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
