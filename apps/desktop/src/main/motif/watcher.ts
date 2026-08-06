// Motif file watch: a recursive fs.watch on the user-Motif root. Any disk
// change — external-editor saves included — coalesces through a quiet-window
// debounce into ONE onChange call. The caller (index.ts) refreshes the actor
// catalog + emits motifs:changed; the renderer resync pipeline does the rest.
// Deliberately NO per-file dispatch (the resync is a full idempotent refresh)
// and NO filtering of the app's own writes (install/delete/amend emit
// motifs:changed themselves; the debounced duplicate is harmless).
// The debounce is unit-tested independently of the OS watch.
import { mkdirSync, watch, type FSWatcher } from 'node:fs'

/** Quiet window (ms): after a change, wait until this long passes with no
 *  further event, then fire once. Absorbs editor write bursts + multi-file writes. */
export const DEBOUNCE_QUIET_MS = 400

/** Coalesce raw watch events into one onChange after a quiet window. Split from
 *  spawnMotifWatcher so the debounce is testable with fake timers (no OS watch). */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly quietMs: number, private readonly onChange: () => void) {}
  /** Signal a raw change; resets the quiet window. */
  signal(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.onChange() }, this.quietMs)
  }
  /** Cancel any pending fire (used on close). */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}

export interface MotifWatcher { close(): void }

/** Attach a recursive watcher at `root` (created if missing — a first boot has
 *  no user Motifs yet, but the watcher must still attach) and fire `onChange`
 *  once per debounced burst. Errors are forwarded as change signals too: a
 *  watch error means "something may have changed that we missed" — a spurious
 *  resync is harmless, a missed one isn't.
 *
 *  Recursive watch is supported on the ship targets (Windows/macOS); on Linux
 *  dev it throws, so fall back to a shallow watch on the root (top-level
 *  <id>/ dirs still fire). The e2e gate is local-only on a ship target. */
export function spawnMotifWatcher(root: string, onChange: () => void): MotifWatcher {
  mkdirSync(root, { recursive: true })
  const deb = new Debouncer(DEBOUNCE_QUIET_MS, onChange)
  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true })
  } catch {
    watcher = watch(root)
  }
  watcher.on('change', () => deb.signal())
  watcher.on('error', () => deb.signal())
  return { close() { deb.cancel(); watcher.close() } }
}
