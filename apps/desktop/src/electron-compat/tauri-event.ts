// Replaces @tauri-apps/api/event. Mirrors the Tauri signature:
// listen returns a Promise<UnlistenFn>. In S1 events never fire (stub on());
// S2 wires them via TSFN -> main -> webContents.send -> preload on().
export interface Event<T> { event: string; id: number; payload: T }
export type UnlistenFn = () => void

let _idCounter = 0

export async function listen<T>(
  event: string,
  handler: (e: Event<T>) => void,
): Promise<UnlistenFn> {
  const id = _idCounter++
  const unsub = window.api.on(event, (payload) =>
    handler({ event, id, payload: payload as T }),
  )
  return unsub
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  // In S1 this just calls the stub invoke and swallows the rejection —
  // emit is fire-and-forget from the renderer side.
  try {
    await window.api.invoke(`emit:${event}`, payload as Record<string, unknown>)
  } catch {
    // stub rejection — ignored
  }
}
