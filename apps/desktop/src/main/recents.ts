// Recent-projects list + startup prefs persisted at <userData>/recents.json,
// owned by the Electron main process (config-dir, one value across every
// project).
//
// History: persistence used to live in the Rust addon (native/src/recents.rs);
// it moved here so the addon is compute-only and the Rust↔TS struct twin is
// gone. The on-disk file path + JSON field names are unchanged, so existing
// users' recents.json keeps working after the move to TS.
//
// On-disk shape:
//   {
//     "reopen_on_launch": bool,
//     "entries": [ { "path": "…", "name": "…", "last_opened": "<ISO-8601>" }, … ],
//     "last_new_project_parent": "…" | null
//   }
//
// Bad-config recovery: a missing / empty / corrupt file degrades to all-defaults
// (entries=[], reopen_on_launch=false, last_new_project_parent=null) so a hand-
// edit mishap can't brick the editor (parity with the old Rust store).
//
// push() and setLastNewProjectParent() are BEST-EFFORT: they log and swallow on
// any fs/parse error (parity with the Rust store's warn+return pattern).
//
// No :changed event (parity with Rust behavior — renderer re-fetches via channel
// calls as needed).

import type { RecentEntry } from '../shared/recents'

const MAX_RECENTS = 10

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface RecentsFs {
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  mkdirp(dir: string): void
}

export interface RecentsStore {
  /** Read the current list, newest first. */
  list(): RecentEntry[]
  /** Remove an entry by path. No-op if the path isn't in the list. */
  remove(path: string): void
  /** Top entry, if any. Used by the "Reopen last project on launch" path. */
  mostRecent(): RecentEntry | null
  getReopenOnLaunch(): boolean
  setReopenOnLaunch(value: boolean): void
  lastNewProjectParent(): string | null
  /** Push (path, displayName) to top, dedupe by path (case-insensitive on Windows),
   *  cap at 10, stamp last_opened = new Date().toISOString().
   *  BEST-EFFORT: never throws (log + swallow on any fs/parse error). */
  push(path: string, displayName: string): void
  /** Record the parent folder of the just-created workspace.
   *  BEST-EFFORT: never throws (log + swallow on any fs/parse error). */
  setLastNewProjectParent(parent: string): void
}

/** On-disk envelope. */
interface RecentsFile {
  reopen_on_launch: boolean
  entries: RecentEntry[]
  last_new_project_parent: string | null
}

const DEFAULTS: RecentsFile = { reopen_on_launch: false, entries: [], last_new_project_parent: null }

/** Normalize path for dedup comparison, mirroring the old Rust `same_path`
 *  (#[cfg]-split): case-INSENSITIVE on Windows (lower-cased), case-SENSITIVE
 *  everywhere else (returned verbatim). This preserves exact parity with the
 *  Rust store across the 3-OS matrix — on macOS/Linux `/Proj/A` and `/proj/a`
 *  are DISTINCT recents, on Windows they collapse to one. */
function normPath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

export function createRecentsStore(deps: { fs: RecentsFs; path: string; dir: string }): RecentsStore {
  function read(): RecentsFile {
    if (!deps.fs.exists(deps.path)) return { ...DEFAULTS, entries: [] }
    let body: string
    try { body = deps.fs.readFile(deps.path) }
    catch (e) { console.warn(`[recents] read ${deps.path}:`, e); return { ...DEFAULTS, entries: [] } }
    if (body.trim() === '') return { ...DEFAULTS, entries: [] }
    try {
      const parsed = JSON.parse(body) as Partial<RecentsFile>
      return {
        reopen_on_launch: typeof parsed.reopen_on_launch === 'boolean' ? parsed.reopen_on_launch : false,
        entries: Array.isArray(parsed.entries) ? (parsed.entries as RecentEntry[]) : [],
        last_new_project_parent: typeof parsed.last_new_project_parent === 'string' ? parsed.last_new_project_parent : null,
      }
    } catch (e) {
      console.warn(`[recents] parse ${deps.path}:`, e); return { ...DEFAULTS, entries: [] }
    }
  }

  function write(file: RecentsFile): void {
    deps.fs.mkdirp(deps.dir)
    const tmp = deps.path + '.tmp'
    deps.fs.writeFile(tmp, JSON.stringify(file, null, 2))
    deps.fs.rename(tmp, deps.path) // atomic promote
  }

  return {
    list(): RecentEntry[] {
      return read().entries
    },

    remove(path: string): void {
      const file = read()
      const norm = normPath(path)
      file.entries = file.entries.filter((e) => normPath(e.path) !== norm)
      write(file)
    },

    mostRecent(): RecentEntry | null {
      return read().entries[0] ?? null
    },

    getReopenOnLaunch(): boolean {
      return read().reopen_on_launch
    },

    setReopenOnLaunch(value: boolean): void {
      const file = read()
      if (file.reopen_on_launch === value) return
      file.reopen_on_launch = value
      write(file)
    },

    lastNewProjectParent(): string | null {
      return read().last_new_project_parent
    },

    push(path: string, displayName: string): void {
      const now = new Date().toISOString()
      let file: RecentsFile
      try { file = read() }
      catch (e) { console.warn('[recents] read failed on push, starting fresh:', e); file = { ...DEFAULTS, entries: [] } }
      const norm = normPath(path)
      file.entries = file.entries.filter((e) => normPath(e.path) !== norm)
      file.entries.unshift({ path, name: displayName, last_opened: now })
      if (file.entries.length > MAX_RECENTS) file.entries.length = MAX_RECENTS
      try { write(file) }
      catch (e) { console.warn('[recents] write failed on push:', e) }
    },

    setLastNewProjectParent(parent: string): void {
      let file: RecentsFile
      try { file = read() }
      catch (e) { console.warn('[recents] read failed on setLastNewProjectParent, starting fresh:', e); file = { ...DEFAULTS, entries: [] } }
      file.last_new_project_parent = parent
      try { write(file) }
      catch (e) { console.warn('[recents] write failed on setLastNewProjectParent:', e) }
    },
  }
}
