// Per-workspace export settings persisted at <workspace>/export.json, owned by
// the Electron main process. The renderer (exportSettings.ts) is the only writer;
// it reads on mount and writes on change. The value schema is OPAQUE — main treats
// it as unknown; the renderer assembles/consumes the typed shape.
//
// History: persistence used to live in the Rust addon (native/src/export_settings_store.rs);
// it moved here so the addon is compute-only. The on-disk file path is unchanged
// (<workspace>/export.json), so existing workspaces' export.json keeps working.
//
// None/null semantics (from the Rust original): missing file, empty file, or
// unparseable JSON all return null — the renderer falls back to its own defaults.
// There is no TS-side default object; absence means null.
//
// No :changed event (parity with Rust behavior — renderer re-fetches on next open).
//
// Workspace-scoping is handled by the caller (ts-actor-host): pre-workspace it
// returns null on read and drops on write. This store always has a concrete
// workspace dir.

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface ExportSettingsFs {
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  mkdirp(dir: string): void
}

export interface ExportSettingsStore {
  load(workspaceDir: string): unknown
  save(workspaceDir: string, value: unknown): void
}

export function createExportSettingsStore(deps: { fs: ExportSettingsFs; join: (...parts: string[]) => string }): ExportSettingsStore {
  const fileOf = (ws: string) => deps.join(ws, 'export.json')
  return {
    load(ws) {
      const path = fileOf(ws)
      if (!deps.fs.exists(path)) return null
      let body: string
      try { body = deps.fs.readFile(path) }
      catch (e) { console.warn(`[export-settings] read ${path}:`, e); return null }
      if (body.trim() === '') return null
      try { return JSON.parse(body) }
      catch (e) { console.warn(`[export-settings] parse ${path}:`, e); return null }
    },
    save(ws, value) {
      deps.fs.mkdirp(ws)
      const path = fileOf(ws)
      const tmp = path + '.tmp'
      deps.fs.writeFile(tmp, JSON.stringify(value, null, 2))
      deps.fs.rename(tmp, path) // atomic promote
    },
  }
}
