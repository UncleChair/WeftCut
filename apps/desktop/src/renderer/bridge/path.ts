// Path helpers (documentDir / join / tempDir) backed by the Electron main process.

export async function documentDir(): Promise<string> {
  return window.api.path.documentDir()
}

export async function join(...paths: string[]): Promise<string> {
  return window.api.path.join(paths)
}

export async function tempDir(): Promise<string> {
  return window.api.path.tempDir()
}
