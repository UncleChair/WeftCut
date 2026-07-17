// Per-user keyboard-shortcut overrides persisted at <userData>/keybindings.json,
// owned by the Electron main process. One value across every project (config-dir).
//
// The on-disk file path + JSON shape are a COMPATIBILITY SURFACE: existing
// users' keybindings.json files must keep loading, so neither may change
// without a migration.
//
// On-disk shape:
//   { "overrides": { "<action-id>": ["Mod+Z", "F3"], ... } }
//
// The frontend `shortcuts/` module owns the static ACTION_DEFS catalogue (action
// ids + default chord strings). This file is a dumb JSON-backed key/value store
// that holds ONLY the user's overrides — actions not in the file fall back to
// the frontend defaults at dispatch time.
//
// An empty keys array means "explicitly unbound" — distinct from "no entry."
// Bad-config recovery: missing / empty / corrupt file returns {} (no throw).
// Import validates the source before touching the live file so a bad import
// can't brick the user's setup.
//
// No :changed event — the renderer re-fetches via keybindings_get after
// each mutation.

import type { KeybindingsMap } from '../shared/keybindings'

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface KeybindingsFs {
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  mkdirp(dir: string): void
}

export interface KeybindingsStore {
  get(): KeybindingsMap
  set(action: string, keys: string[]): void
  resetAll(): void
  exportTo(dest: string): void
  importFrom(src: string): KeybindingsMap
}

/** On-disk envelope wrapping the overrides map. */
interface KeybindingsFile {
  overrides: KeybindingsMap
}

export function createKeybindingsStore(deps: { fs: KeybindingsFs; path: string; dir: string }): KeybindingsStore {
  function read(): KeybindingsFile {
    if (!deps.fs.exists(deps.path)) return { overrides: {} }
    let body: string
    try { body = deps.fs.readFile(deps.path) }
    catch (e) { console.warn(`[keybindings] read ${deps.path}:`, e); return { overrides: {} } }
    if (body.trim() === '') return { overrides: {} }
    try {
      const parsed = JSON.parse(body) as { overrides?: KeybindingsMap }
      return { overrides: parsed.overrides ?? {} }
    } catch (e) {
      console.warn(`[keybindings] parse ${deps.path}:`, e); return { overrides: {} }
    }
  }

  function write(file: KeybindingsFile): void {
    deps.fs.mkdirp(deps.dir)
    const tmp = deps.path + '.tmp'
    deps.fs.writeFile(tmp, JSON.stringify(file, null, 2))
    deps.fs.rename(tmp, deps.path) // atomic promote
  }

  return {
    /** Current overrides map. Missing actions inherit the frontend defaults. */
    get(): KeybindingsMap {
      return read().overrides
    },

    /** Set the bindings for a single action. An empty keys array explicitly
     *  unbinds the action — distinct from "no entry for this action." */
    set(action: string, keys: string[]): void {
      const file = read()
      file.overrides[action] = keys
      write(file)
    },

    /** Wipe every override. Effective bindings revert to the frontend defaults.
     *  Atomic — the file is replaced in one rename so there's no half-reset. */
    resetAll(): void {
      write({ overrides: {} })
    },

    /** Copy the current overrides to dest. If no file exists yet (user hasn't
     *  customized anything), emits an empty {"overrides":{}} so the user gets
     *  a valid template. */
    exportTo(dest: string): void {
      const file = read()
      const tmp = dest + '.tmp'
      deps.fs.writeFile(tmp, JSON.stringify(file, null, 2))
      deps.fs.rename(tmp, dest) // atomic promote
    },

    /** Replace the current overrides with the contents of src. Validates the
     *  source parses as a keybindings file BEFORE touching the live file — a bad
     *  import can't brick the user's setup. Returns the new map on success. */
    importFrom(src: string): KeybindingsMap {
      let body: string
      try { body = deps.fs.readFile(src) }
      catch (e) { throw new Error(`[keybindings] importFrom: could not read ${src}: ${e}`) }
      let parsed: { overrides?: KeybindingsMap }
      try { parsed = JSON.parse(body) as { overrides?: KeybindingsMap } }
      catch (e) { throw new Error(`[keybindings] importFrom: invalid JSON in ${src}: ${e}`) }
      const file: KeybindingsFile = { overrides: parsed.overrides ?? {} }
      write(file)
      return file.overrides
    },
  }
}
