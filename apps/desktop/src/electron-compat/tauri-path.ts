// Replaces @tauri-apps/api/path.
// Imports seen in src/: documentDir, join, tempDir
// In S1 these call the stub invoke and reject; callers fall back gracefully.

export async function documentDir(): Promise<string> {
  return (await window.api.invoke('path:documentDir')) as string
}

export async function join(...paths: string[]): Promise<string> {
  return (await window.api.invoke('path:join', { paths })) as string
}

export async function tempDir(): Promise<string> {
  return (await window.api.invoke('path:tempDir')) as string
}
