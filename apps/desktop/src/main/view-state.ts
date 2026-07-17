// Per-workspace timeline view state persisted at <workspace>/view.json, owned by
// the Electron main process. The renderer (useTimelineView) is the only writer;
// it reads on mount and writes debounced. Best-effort UX, not a correctness
// anchor — a missing / empty / corrupt file degrades to defaults.
//
// The on-disk file path + JSON field names are a COMPATIBILITY SURFACE:
// existing workspaces' view.json files must keep loading.
//
// Workspace-scoping is handled by the caller (ts-actor-host): pre-workspace it
// returns defaults on read and drops on write. This store always has a
// concrete workspace dir. The renderer prunes dead track ids before calling
// view_state_set.

import { viewStateDefaults, type ViewState } from '../shared/view-state'

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface ViewStateFs {
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  mkdirp(dir: string): void
}

export interface ViewStateStore {
  load(workspaceDir: string): ViewState
  save(workspaceDir: string, state: ViewState): void
}

export function createViewStateStore(deps: { fs: ViewStateFs; join: (...parts: string[]) => string }): ViewStateStore {
  const fileOf = (ws: string) => deps.join(ws, 'view.json')
  return {
    load(ws) {
      const path = fileOf(ws)
      if (!deps.fs.exists(path)) return viewStateDefaults()
      let body: string
      try { body = deps.fs.readFile(path) }
      catch (e) { console.warn(`[view-state] read ${path}:`, e); return viewStateDefaults() }
      if (body.trim() === '') return viewStateDefaults()
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(body) as Record<string, unknown> }
      catch (e) { console.warn(`[view-state] parse ${path}:`, e); return viewStateDefaults() }
      // Per-field defaulting (parity with serde #[serde(default)]): a missing or
      // wrong-typed field falls back to its default.
      const d = viewStateDefaults()
      const th = parsed.track_heights
      return {
        timeline_px_per_sec: typeof parsed.timeline_px_per_sec === 'number' ? parsed.timeline_px_per_sec : d.timeline_px_per_sec,
        track_heights: th != null && typeof th === 'object' && !Array.isArray(th) ? (th as Record<string, number>) : d.track_heights,
        expanded_tracks: Array.isArray(parsed.expanded_tracks) ? parsed.expanded_tracks.filter((x): x is string => typeof x === 'string') : d.expanded_tracks,
      }
    },
    save(ws, state) {
      deps.fs.mkdirp(ws)
      const path = fileOf(ws)
      const tmp = path + '.tmp'
      deps.fs.writeFile(tmp, JSON.stringify(state, null, 2))
      deps.fs.rename(tmp, path) // atomic promote
    },
  }
}
