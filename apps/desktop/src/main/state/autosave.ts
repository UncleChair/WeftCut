// apps/desktop/src/main/state/autosave.ts
//
// Auto-save subscriber + periodic Backups/ snapshots — the TS port of
// native/src/io/autosave.rs. Per docs/data-model.md the workspace is the truth:
// every actor commit eventually lands on disk as project.json, no explicit Save.
// Subscribes the TS actor, debounces 500ms (a 10-event drag → one write), stays
// silent while no workspace is set, and after each successful write copies
// project.json to Backups/<timestamp>.json once 50 commits OR 5 minutes elapse
// (whichever first), retaining the most recent 20. forceFlush() skips the
// debounce (the Cmd-S / quit gate). Pure + injected (fs / clock / timer /
// workspace-dir) so the debounce, interval, and gc are deterministic in tests.
// Wired by ts-actor-host: subscribed at backend bring-up; project_save →
// forceFlush.
import type { ActorHandle, ChangeEvent } from './actor'
import type { Project } from './model'
import { PROJECT_FILE } from './persistence'

const DEBOUNCE_MS = 500
const SNAPSHOT_EVERY_COMMITS = 50
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000
const RETAIN_SNAPSHOTS = 20
export const BACKUPS_DIR = 'Backups'

export interface AutosaveFs {
  writeFile(path: string, text: string): void
  exists(path: string): boolean
  copyFile(src: string, dest: string): void
  mkdirp(dir: string): void
  readdir(dir: string): string[]
  rm(path: string): void
}

export interface AutosaveDeps {
  actor: Pick<ActorHandle, 'subscribe' | 'snapshot'>
  fs: AutosaveFs
  /** workspace.current() — null in the blank-boot window before Save As / Open. */
  workspaceDir: () => string | null
  join: (...parts: string[]) => string
  /** serializeProjectToJson (persistence.ts) — injected to keep this module pure. */
  serialize: (p: Project) => string
  now?: () => Date
  debounceMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}

export interface AutosaveController {
  start(): void
  forceFlush(): Promise<void>
  stop(): void
}

export function createAutosave(deps: AutosaveDeps): AutosaveController {
  const now = deps.now ?? (() => new Date())
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))

  let unsubscribe: (() => void) | null = null
  let pending: ReturnType<typeof setTimeout> | null = null
  let commitsSinceSnapshot = 0
  let lastSnapshotAtMs = now().getTime()

  /** ISO-8601, no colons/dashes/dots — sorts lexicographically == chronologically
   *  (Windows-filename-safe). Matches Rust `%Y%m%dT%H%M%S%3fZ` (io/autosave.rs:196). */
  function stamp(): string {
    return now().toISOString().replace(/[-:.]/g, '')
  }

  function persist(ws: string): void {
    deps.fs.writeFile(deps.join(ws, PROJECT_FILE), deps.serialize(deps.actor.snapshot()))
  }

  function takeSnapshot(ws: string): void {
    const src = deps.join(ws, PROJECT_FILE)
    if (!deps.fs.exists(src)) return // defensive: nothing to copy yet
    const backups = deps.join(ws, BACKUPS_DIR)
    try {
      deps.fs.mkdirp(backups)
      deps.fs.copyFile(src, deps.join(backups, `${stamp()}.json`))
      gcSnapshots(backups)
    } catch { /* best-effort, matches Rust warn-and-continue; a setTimeout-callback throw would be an unhandled rejection */ }
  }

  function gcSnapshots(backups: string): void {
    const names = deps.fs.readdir(backups).filter((n) => n.endsWith('.json'))
    names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // descending: newest (largest) first
    for (const stale of names.slice(RETAIN_SNAPSHOTS)) {
      try { deps.fs.rm(deps.join(backups, stale)) } catch { /* logged-only in prod; ignore */ }
    }
  }

  /** Debounced write: persist, then snapshot if the commit/time threshold passed. */
  function flushDebounced(): void {
    pending = null
    const ws = deps.workspaceDir()
    if (ws === null) return // no workspace yet — edits stay dirty for the next cycle
    persist(ws)
    // One per debounce CYCLE (a flurry coalesced into one quiet-window write),
    // NOT per raw actor commit — faithful to io/autosave.rs:156.
    commitsSinceSnapshot += 1
    if (commitsSinceSnapshot >= SNAPSHOT_EVERY_COMMITS || now().getTime() - lastSnapshotAtMs >= SNAPSHOT_EVERY_MS) {
      takeSnapshot(ws)
      commitsSinceSnapshot = 0
      lastSnapshotAtMs = now().getTime()
    }
  }

  function onChange(_e: ChangeEvent): void {
    if (pending !== null) clearTimer(pending)
    pending = setTimer(flushDebounced, debounceMs)
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = deps.actor.subscribe(onChange)
    },
    /** Flush + snapshot right now, skipping the debounce (Cmd-S / quit gate). The
     *  force path always snapshots and resets the counters (io/autosave.rs:106-113). */
    async forceFlush(): Promise<void> {
      if (pending !== null) { clearTimer(pending); pending = null }
      const ws = deps.workspaceDir()
      if (ws === null) return
      persist(ws)
      takeSnapshot(ws)
      commitsSinceSnapshot = 0
      lastSnapshotAtMs = now().getTime()
    },
    stop() {
      if (pending !== null) { clearTimer(pending); pending = null }
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
    },
  }
}
