// Path helpers (documentDir / join / tempDir) backed by the Electron main process.

export async function documentDir(): Promise<string> {
  return (await window.api.invoke('path:documentDir')) as string
}

export async function join(...paths: string[]): Promise<string> {
  return (await window.api.invoke('path:join', { paths })) as string
}

export async function tempDir(): Promise<string> {
  return (await window.api.invoke('path:tempDir')) as string
}
