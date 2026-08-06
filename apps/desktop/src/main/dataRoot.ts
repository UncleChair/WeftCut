// Resolves the user-configurable DATA ROOT once, early at boot, and exposes the
// fixed internal subdirectory layout every large-content consumer takes its
// path from (the Backend media cache, UserMotifStore, the fs guard, future
// downloads).
//
// Layout:
//   <dataRoot>/            default: <userData>/data
//     ├── motifs/          user Motifs
//     ├── cache/           backend media cache + motif L2 prebake
//     └── downloads/       reserved for future downloaded assets
//
// The path lives in the `data_root` field of app_settings.json (it cannot live
// under the data root itself — bootstrap chicken-and-egg — so it stays in
// userData).
//
// Both the filesystem surface and the native dialog/picker are INJECTED so the
// resolver is unit-testable without real Electron or real fs (mirrors the
// AppSettingsFs injection style in app-settings.ts).

import type { AppSettingsStore } from './app-settings'

/** The resolved data root plus its three fixed subdirectories (all absolute). */
export interface ResolvedDataRoot {
  dataRoot: string
  motifsDir: string
  cacheDir: string
  downloadsDir: string
}

/**
 * Minimal fs surface — injected so tests run in-memory; node:fs in production.
 * `writeFile` doubles as the writability probe (it throws when the target is
 * unavailable). `rm` removes that probe file (best-effort).
 */
export interface DataRootFs {
  mkdirp(dir: string): void
  writeFile(path: string, text: string): void
  rm(path: string): void
}

export interface DataRootDeps {
  /** Electron `app.getPath('userData')` — parent of the default data root. */
  userDataDir: string
  /** The single app-settings store owner (reads `data_root`, persists Re-set). */
  settings: AppSettingsStore
  fs: DataRootFs
  /** Path join — inject `path.join` in production; a POSIX join in tests. */
  join: (...parts: string[]) => string
  /**
   * Blocking native dialog shown when a configured root is unavailable. Receives
   * the unreachable path (so the message can name it) and returns the chosen
   * action. In production: `dialog.showMessageBoxSync` with Re-set / Quit.
   */
  showUnavailableDialog: (unavailableRoot: string) => 'reset' | 'quit'
  /**
   * Native folder picker for the Re-set flow. Returns the chosen absolute path,
   * or null if the picker was cancelled. In production:
   * `dialog.showOpenDialogSync({ properties: ['openDirectory', ...] })`.
   */
  pickDirectory: () => string | null
  /** Terminate the app (Quit branch). In production: `app.exit(0)`. */
  exit: () => void
}

const PROBE_NAME = '.weftcut-write-probe'

export function resolveDataRoot(deps: DataRootDeps): ResolvedDataRoot {
  const { fs, join } = deps

  // "Available" = the root can be created AND written. Create the dir, drop a
  // probe file, remove it. Any throw (ENOENT on an unmounted parent, EACCES on a
  // revoked permission, EROFS, …) means unavailable — the caller decides what to
  // do, this never falls back silently.
  const isAvailable = (root: string): boolean => {
    try {
      fs.mkdirp(root)
      const probe = join(root, PROBE_NAME)
      fs.writeFile(probe, '')
      fs.rm(probe)
      return true
    } catch {
      return false
    }
  }

  // Materialize the fixed subdir layout under `root` and return the paths. The
  // three mkdirp calls also (re)create the root itself.
  const finalize = (root: string): ResolvedDataRoot => {
    const motifsDir = join(root, 'motifs')
    const cacheDir = join(root, 'cache')
    const downloadsDir = join(root, 'downloads')
    fs.mkdirp(motifsDir)
    fs.mkdirp(cacheDir)
    fs.mkdirp(downloadsDir)
    return { dataRoot: root, motifsDir, cacheDir, downloadsDir }
  }

  const configured = deps.settings.get().data_root?.trim()

  // Never configured → default, created silently. No probe/dialog: if userData
  // itself is unwritable the app is already doomed, so a throw here is correct.
  if (!configured) {
    return finalize(join(deps.userDataDir, 'data'))
  }

  if (isAvailable(configured)) {
    return finalize(configured)
  }

  // Configured + unavailable → blocking dialog loop. Recovery context: the old
  // root is unreachable, so there is nothing to copy — a Re-set just switches.
  let badRoot = configured
  for (;;) {
    const choice = deps.showUnavailableDialog(badRoot)
    if (choice === 'quit') {
      deps.exit()
      // exit() terminates the process in production; if it returns (tests), stop
      // resolution deterministically rather than looping or returning a root.
      throw new Error('[dataRoot] data folder unavailable; user chose to quit')
    }
    const picked = deps.pickDirectory()
    if (picked == null) {
      // Picker cancelled with no valid choice — re-show the blocking dialog.
      continue
    }
    if (isAvailable(picked)) {
      // Persist the new path permanently and use it for this boot.
      deps.settings.apply({ data_root: picked })
      return finalize(picked)
    }
    // The newly-picked root is ALSO unavailable → re-prompt, naming the new bad
    // path. Nothing is written until a pick succeeds.
    badRoot = picked
  }
}
