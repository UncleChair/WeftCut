// Event subscription bridge: listen() returns a Promise<UnlistenFn>. Events are
// delivered from the Rust core via main -> webContents.send -> preload on().
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
  // Fire-and-forget from the renderer side: forward to the backend dispatcher
  // and swallow any rejection.
  try {
    await window.api.backend.invoke(`emit:${event}`, payload)
  } catch {
    // ignored (fire-and-forget)
  }
}
