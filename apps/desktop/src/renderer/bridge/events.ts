// Event subscription bridge: listen() returns a Promise<UnlistenFn>. Events are
// delivered from main -> webContents.send -> preload on() — both Rust core
// events and renderer-originated cross-window broadcasts (see emit() below).
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
  // Fire-and-forget from the renderer side: forward to main's cross-window
  // broadcast and swallow any rejection.
  try {
    await window.api.emit(event, payload)
  } catch {
    // ignored (fire-and-forget)
  }
}
