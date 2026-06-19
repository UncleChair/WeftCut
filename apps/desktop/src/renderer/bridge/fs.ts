// Filesystem helpers (read/write/mkdir/remove/exists/readDir) via the Electron
// main process. All are invoke wrappers; callers guard with try/catch.

export async function readFile(path: string, _opts?: unknown): Promise<Uint8Array<ArrayBuffer>> {
  // The IPC payload is a Node Buffer → a plain ArrayBuffer-backed Uint8Array in
  // the renderer (never SharedArrayBuffer). Type it concretely so callers can
  // pass the result straight to Blob/BufferSource sinks (TS 5.7+ generic).
  return window.api.fs.readFile(path)
}

export async function mkdir(
  path: string,
  opts?: { recursive?: boolean },
): Promise<void> {
  await window.api.fs.mkdir(path, opts?.recursive ?? false)
}

export async function writeFile(
  path: string,
  data: Uint8Array,
  opts?: { append?: boolean },
): Promise<void> {
  await window.api.fs.writeFile(path, data, opts?.append ?? false)
}

export async function writeTextFile(
  path: string,
  data: string,
  _opts?: unknown,
): Promise<void> {
  await window.api.fs.writeTextFile(path, data)
}

export async function remove(path: string, _opts?: unknown): Promise<void> {
  await window.api.fs.remove(path)
}

export async function exists(path: string, _opts?: unknown): Promise<boolean> {
  return window.api.fs.exists(path)
}

export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
}

export async function readDir(path: string, _opts?: unknown): Promise<DirEntry[]> {
  return window.api.fs.readDir(path)
}
