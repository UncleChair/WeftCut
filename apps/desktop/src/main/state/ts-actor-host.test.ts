import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { mapChangeEvent, createTsActorHost } from './ts-actor-host'
import { UserMotifStore } from '../motif/store'
import { createAppSettingsStore } from '../app-settings'
import { createViewStateStore } from '../view-state'
import { createExportSettingsStore } from '../export-settings'
import { createKeybindingsStore } from '../keybindings'
import { createRecentsStore } from '../recents'
import { createWorkspaceStore } from '../workspace'
import { EDITING_WORKSPACE_ID, activeWorkspaceProfile, type WorkspaceDocument } from '../../shared/workspace'

describe('mapChangeEvent', () => {
  it('maps a User ChangeEvent to the Rust project:changed payload shape', () => {
    const out = mapChangeEvent({ op_id: 'op-1', actor: { kind: 'User' }, timestamp: '2026-06-23T00:00:00.000Z', summary: 'Added layer', affected: [{ kind: 'Layer', id: 'L1' }], new_snapshot: {} as never, diff_hint: { kind: 'Coarse' } })
    expect(out).toEqual({ op_id: 'op-1', actor_kind: 'user', client: null, summary: 'Added layer', timestamp: '2026-06-23T00:00:00.000Z', affected_count: 1 })
  })
  it('maps an Agent ChangeEvent client through', () => {
    const out = mapChangeEvent({ op_id: 'op-2', actor: { kind: 'Agent', client: 'mcp' }, timestamp: 't', summary: 's', affected: [], new_snapshot: {} as never, diff_hint: { kind: 'Coarse' } })
    expect(out.actor_kind).toBe('agent'); expect(out.client).toBe('mcp')
  })
})

describe('createTsActorHost — persistence-route integration', () => {
  function makeInMemoryDeps() {
    // In-memory filesystem: path → content string.
    const vfs: Record<string, string> = {}
    const dirsMade = new Set<string>()

    const memFs = {
      exists: (p: string) => Object.prototype.hasOwnProperty.call(vfs, p) || dirsMade.has(p),
      readFile: (p: string) => {
        if (!Object.prototype.hasOwnProperty.call(vfs, p)) throw new Error(`vfs: file not found: ${p}`)
        return vfs[p]!
      },
      writeFile: (p: string, t: string) => { vfs[p] = t },
      rename: (a: string, b: string) => { vfs[b] = vfs[a]!; delete vfs[a] },
      mkdirp: (d: string) => { dirsMade.add(d) },
      copyFile: (s: string, d: string) => { vfs[d] = vfs[s]! },
      readdir: (d: string) => Object.keys(vfs).filter((k) => k.startsWith(d + '/') && k.slice(d.length + 1).indexOf('/') === -1).map((k) => k.slice(d.length + 1)),
      rm: (p: string) => { delete vfs[p] },
    }

    // Workspace dir tracking — commitWorkspace updates this.
    let wsDir: string | null = null
    const napiCalls: { method: string; args: unknown[] }[] = []

    const memNapi = {
      commitWorkspace: async (p: string) => { wsDir = p; napiCalls.push({ method: 'commitWorkspace', args: [p] }) },
      pushRecent: (_p: string, _n: string) => { napiCalls.push({ method: 'pushRecent', args: [_p, _n] }) },
      setLastNewProjectParent: (_p: string) => { napiCalls.push({ method: 'setLastNewProjectParent', args: [_p] }) },
      enqueueJobsForMedia: async (_j: string) => { napiCalls.push({ method: 'enqueueJobsForMedia', args: [_j] }) },
    }

    const sent: { event: string; payload: unknown }[] = []

    const deps = {
      send: (event: string, payload: unknown) => { sent.push({ event, payload }) },
      mcpNotify: () => {},
      fileExists: (p: string) => memFs.exists(p),
      fs: memFs,
      join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      napi: memNapi,
      compute: { probeMedia: async () => '{}', hashMediaSource: async () => 'h', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
      enqueueWorkspaceCopy: async () => {},
      readFile: (p: string) => memFs.readFile(p),
      workspaceDir: () => wsDir,
      appSettings: createAppSettingsStore({ fs: memFs, path: '/cfg/app_settings.json', dir: '/cfg' }),
      viewState: createViewStateStore({ fs: memFs, join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/') }),
      exportSettings: createExportSettingsStore({ fs: memFs, join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/') }),
      keybindings: createKeybindingsStore({ fs: memFs, path: '/cfg/keybindings.json', dir: '/cfg' }),
      recents: createRecentsStore({ fs: memFs, path: '/cfg/recents.json', dir: '/cfg' }),
      // debounceMs 0 + immediate timer → writes land synchronously in tests.
      workspace: createWorkspaceStore({ fs: memFs, path: '/cfg/workspaces.json', dir: '/cfg', debounceMs: 0, timer: { set: (cb: () => void) => { cb(); return null }, clear: () => {} } }),
    }

    return { deps, vfs, napiCalls, sent }
  }

  it('project_open flushes pending edits to the current workspace before switching', async () => {
    vi.useFakeTimers()
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()

    try {
      const targetDir = await host.handleInvoke('project_new_workspace', {
        parentFolder: '/projects',
        name: 'target',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
      }) as string
      const currentDir = await host.handleInvoke('project_new_workspace', {
        parentFolder: '/projects',
        name: 'current',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
      }) as string

      await host.handleInvoke('add_track', { kind: 'Video', name: 'Unsaved' })
      await host.handleInvoke('project_open', { path: targetDir })

      const persisted = JSON.parse(vfs[`${currentDir}/project.json`]!) as {
        tracks: Array<{ label: string }>
      }
      expect(persisted.tracks).toHaveLength(3)
      expect(persisted.tracks.at(-1)?.label).toBe('Track')
      expect(await host.handleInvoke('project_summary', {})).toMatchObject({ name: 'target' })
    } finally {
      host.stop()
      vi.useRealTimers()
    }
  })

  it('project_new_workspace flushes pending edits to the current workspace before replacing it', async () => {
    vi.useFakeTimers()
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()

    try {
      const currentDir = await host.handleInvoke('project_new_workspace', {
        parentFolder: '/projects',
        name: 'current',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
      }) as string
      await host.handleInvoke('add_track', {})

      await host.handleInvoke('project_new_workspace', {
        parentFolder: '/projects',
        name: 'replacement',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
      })

      const persisted = JSON.parse(vfs[`${currentDir}/project.json`]!) as {
        tracks: Array<{ label: string }>
      }
      expect(persisted.tracks).toHaveLength(3)
      expect(await host.handleInvoke('project_summary', {})).toMatchObject({ name: 'replacement' })
    } finally {
      host.stop()
      vi.useRealTimers()
    }
  })

  it('newWorkspace → project_summary → add_track → project_save round-trip', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()

    // 1. Create a new workspace — should write project.json and return the path.
    const wsPath = await host.handleInvoke('project_new_workspace', {
      parentFolder: '/projects',
      name: 'test-proj',
      width: 1920,
      height: 1080,
      fpsNum: 30,
      fpsDen: 1,
    }) as string
    expect(wsPath).toBe('/projects/test-proj')

    // 2. project.json must exist in the vfs at that path.
    const projectFile = '/projects/test-proj/project.json'
    expect(deps.fs.exists(projectFile)).toBe(true)

    // 3. project_summary should reflect the new blank project.
    const summary = await host.handleInvoke('project_summary', {}) as { name: string }
    expect(summary.name).toBe('test-proj')

    // 4. Mutate via add_track — should succeed.
    const addResult = await host.handleInvoke('add_track', { kind: 'Video', name: 'V1' })
    expect(addResult).toBeTruthy()

    // 5. project_save (forceFlush) — should write updated project.json.
    await host.handleInvoke('project_save', {})

    // 6. The written project.json must be valid JSON containing our project name.
    const written = vfs[projectFile]!
    expect(written).toBeDefined()
    const parsed = JSON.parse(written) as { metadata?: { name?: string }; name?: string }
    // The serialized form nests name under metadata (serializeProject shape).
    const projectName = parsed?.metadata?.name ?? (parsed as unknown as { name?: string }).name
    expect(projectName).toBe('test-proj')

    host.stop()
  })

  // The panel's read. Serves the WHOLE stack (limit = the History cap, asked of
  // the actor) — MCP's project://history keeps its own view(100).
  it('project_history_view serves the full stack + checkpoints without dirtying the project', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'hv', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    await host.handleInvoke('add_track', {})
    const cpId = await host.handleInvoke('project_create_checkpoint', { label: 'cp' }) as string

    const before = host.actor.historyStatus()
    const sentBefore = sent.length
    const view = await host.handleInvoke('project_history_view', {}) as {
      ops: Array<{ op_id: string; label_key: string; entity_labels: unknown[] }>
      cursor: number; len: number; evicted: number
      checkpoints: Array<{ id: string; label: string }>
    }

    // Rows the summary channel does not carry at all, plus the eviction counter.
    expect(view.ops).toHaveLength(view.len)
    expect(view.ops[0].label_key).toBe('history.initial')
    expect(view.cursor).toBe(view.len - 1)
    expect(view.evicted).toBe(0)
    expect(view.checkpoints).toEqual([{ id: cpId, label: 'cp', actor: { kind: 'User' }, created_at: expect.any(String) }])

    // A read: no history movement, no change broadcast.
    expect(host.actor.historyStatus()).toEqual(before)
    expect(sent.length).toBe(sentBefore)
    host.stop()
  })

  it('project_jump_to moves the cursor through the host and broadcasts project:changed', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'jt', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    await host.handleInvoke('add_track', {})
    await host.handleInvoke('add_track', {})
    const tracksAtHead = host.actor.snapshot().tracks.length

    await host.handleInvoke('project_jump_to', { index: 0 })
    expect(host.actor.historyStatus().cursor).toBe(0)
    expect(host.actor.snapshot().tracks.length).toBe(tracksAtHead - 2)
    expect(sent.filter((s) => s.event === 'project:changed').length).toBeGreaterThan(0)

    // Out of range surfaces as a structured refusal on the IPC rejection.
    await expect(host.handleInvoke('project_jump_to', { index: 99 })).rejects.toThrow(/InvalidArgument/)
    host.stop()
  })

  it('project_save with no workspace is a no-op (workspaceDir returns null)', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    // No workspace set — forceFlush should not throw.
    await expect(host.handleInvoke('project_save', {})).resolves.toBeUndefined()
    host.stop()
  })

  it('handleInvoke routes a motif channel through runMotifTool (write_motif_draft)', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const motifStore = new UserMotifStore(mkdtempSync(nodePath.join(tmpdir(), 'host-motif-')))
    const host = createTsActorHost({ ...deps, motifStore, motifBuiltins: [] })
    host.start()
    const manifest = { id: 'x', name: 'Foo', version: 1, size: [10, 10], default_duration_s: 1, fonts: [], props_schema: {} }
    const id = await host.handleInvoke('write_motif_draft', { args: { manifest, html: '<head></head><body>b</body>' } }) as string
    expect(typeof id).toBe('string')
    expect(motifStore.getDraft(id)).not.toBeNull()
    expect(sent.some((s) => s.event === 'motifs:changed')).toBe(true)
    host.stop()
  })

  it('app_settings_set persists, returns the after-state, and emits app_settings:changed', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const after = await host.handleInvoke('app_settings_set', { patch: { display_mode: 'ShowAll' } }) as { display_mode: string }
    expect(after.display_mode).toBe('ShowAll')
    expect(sent.some((s) => s.event === 'app_settings:changed' && (s.payload as { display_mode?: string }).display_mode === 'ShowAll')).toBe(true)
    host.stop()
  })

  it('app_settings_get returns the persisted value', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('app_settings_set', { patch: { tail_snap_strength_px: 20 } })
    const got = await host.handleInvoke('app_settings_get', {}) as { tail_snap_strength_px: number }
    expect(got.tail_snap_strength_px).toBe(20)
    host.stop()
  })

  it('workspace_set_current persists the active profile layout and workspace_get reads it back across a restart', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const layout = { version: 1, empty: false, dockview: { grid: { root: { type: 'leaf', data: { views: ['preview'] } } } } }
    await host.handleInvoke('workspace_set_current', { current: layout })
    expect(vfs['/cfg/workspaces.json']).toBeDefined()
    const got = await host.handleInvoke('workspace_get', {}) as WorkspaceDocument
    expect(got.activeId).toBe(EDITING_WORKSPACE_ID)
    expect(activeWorkspaceProfile(got).current).toEqual(layout)
    expect(activeWorkspaceProfile(got).saved).toBeNull()
    host.stop()

    // A fresh host over the same on-disk document restores the same current.
    const restart = createTsActorHost(deps)
    restart.start()
    const afterRestart = await restart.handleInvoke('workspace_get', {}) as WorkspaceDocument
    expect(activeWorkspaceProfile(afterRestart).current).toEqual(layout)
    restart.stop()
  })

  it('workspace profile CRUD (save-as / switch / save / delete) persists across a restart', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()

    // Save As from the live Editing arrangement → a custom profile becomes active.
    const cutLayout = { version: 1, empty: false, dockview: { grid: { root: { type: 'leaf', data: { views: ['timeline'] } } } } }
    const created = await host.handleInvoke('workspace_create_profile', { name: 'Cutting', current: cutLayout }) as WorkspaceDocument
    expect(created.profiles.map((p) => p.name)).toEqual(['Editing', 'Cutting'])
    const cutId = created.activeId
    expect(cutId).not.toBe(EDITING_WORKSPACE_ID)

    // Edit the custom current, then Save promotes it to the reset baseline.
    await host.handleInvoke('workspace_set_current', { current: { version: 1, empty: true, dockview: null } })
    const saved = await host.handleInvoke('workspace_save_baseline', {}) as WorkspaceDocument
    expect(activeWorkspaceProfile(saved).saved).toEqual({ version: 1, empty: true, dockview: null })

    // Switch back to Editing.
    const switched = await host.handleInvoke('workspace_set_active', { id: EDITING_WORKSPACE_ID }) as WorkspaceDocument
    expect(switched.activeId).toBe(EDITING_WORKSPACE_ID)
    host.stop()

    // Restart: the custom profile + its baseline + the active selection survive.
    const restart = createTsActorHost(deps)
    restart.start()
    const afterRestart = await restart.handleInvoke('workspace_get', {}) as WorkspaceDocument
    expect(afterRestart.activeId).toBe(EDITING_WORKSPACE_ID)
    const cutting = afterRestart.profiles.find((p) => p.id === cutId)!
    expect(cutting.name).toBe('Cutting')
    expect(cutting.saved).toEqual({ version: 1, empty: true, dockview: null })

    // Deleting the custom profile leaves just Editing.
    const deleted = await restart.handleInvoke('workspace_delete_profile', { id: cutId }) as WorkspaceDocument
    expect(deleted.profiles.map((p) => p.id)).toEqual([EDITING_WORKSPACE_ID])
    restart.stop()
  })

  it('workspace_set_current does not dirty the Project or its undo history', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'ws', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    const before = await host.handleInvoke('project_summary', {}) as unknown
    const historyBefore = host.actor.historyStatus()

    await host.handleInvoke('workspace_set_current', { current: { version: 1, empty: true, dockview: null } })

    const after = await host.handleInvoke('project_summary', {}) as unknown
    expect(after).toEqual(before)
    expect(host.actor.historyStatus()).toEqual(historyBefore)
    host.stop()
  })

  it('view_state_set persists to <workspace>/view.json and view_state_get reads it back', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'vs', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    await host.handleInvoke('view_state_set', { state: { timeline_px_per_sec: 200, track_heights: { t1: 64 }, expanded_tracks: ['t1'] } })
    expect(vfs['/projects/vs/view.json']).toBeDefined()
    const got = await host.handleInvoke('view_state_get', {}) as { timeline_px_per_sec: number; track_heights: Record<string, number>; expanded_tracks: string[] }
    expect(got.timeline_px_per_sec).toBe(200)
    expect(got.track_heights.t1).toBe(64)
    expect(got.expanded_tracks).toEqual(['t1'])
    host.stop()
  })

  it('pre-workspace: view_state_get returns defaults and view_state_set is a no-op', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('view_state_get', {}) as { timeline_px_per_sec: number }
    expect(got.timeline_px_per_sec).toBe(80)
    await host.handleInvoke('view_state_set', { state: { timeline_px_per_sec: 999, track_heights: {}, expanded_tracks: [] } })
    expect(Object.keys(vfs).some((k) => k.endsWith('view.json'))).toBe(false)
    host.stop()
  })

  it('export_settings_set persists to <workspace>/export.json and export_settings_get reads it back', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'es', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    const value = { codec: 'av1', quality: 'high', resolution: '1080p' }
    await host.handleInvoke('export_settings_set', { settings: value })
    expect(vfs['/projects/es/export.json']).toBeDefined()
    const got = await host.handleInvoke('export_settings_get', {})
    expect(got).toEqual(value)
    host.stop()
  })

  it('pre-workspace: export_settings_get returns null and export_settings_set is a no-op', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('export_settings_get', {})
    expect(got).toBeNull()
    await host.handleInvoke('export_settings_set', { settings: { codec: 'h264' } })
    expect(Object.keys(vfs).some((k) => k.endsWith('export.json'))).toBe(false)
    host.stop()
  })

  it('keybindings_set persists and keybindings_get reads it back', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('keybindings_set', { action: 'undo', keys: ['Mod+Z', 'F3'] })
    const got = await host.handleInvoke('keybindings_get', {}) as Record<string, string[]>
    expect(got['undo']).toEqual(['Mod+Z', 'F3'])
    host.stop()
  })

  it('keybindings_reset_all clears all overrides', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('keybindings_set', { action: 'undo', keys: ['F3'] })
    await host.handleInvoke('keybindings_reset_all', {})
    const got = await host.handleInvoke('keybindings_get', {}) as Record<string, string[]>
    expect(got).toEqual({})
    host.stop()
  })

  it('keybindings_get returns empty map when no file', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('keybindings_get', {}) as Record<string, string[]>
    expect(got).toEqual({})
    host.stop()
  })

  it('keybindings empty keys (explicitly unbound) round-trips through the host', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('keybindings_set', { action: 'undo', keys: [] })
    const got = await host.handleInvoke('keybindings_get', {}) as Record<string, string[]>
    expect('undo' in got).toBe(true)
    expect(got['undo']).toEqual([])
    host.stop()
  })

  it('recents_list returns empty list on cold start', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('recents_list', {}) as unknown[]
    expect(got).toEqual([])
    host.stop()
  })

  it('recents_set_reopen_on_launch persists and recents_get_reopen_on_launch reads it back', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('recents_set_reopen_on_launch', { value: true })
    const got = await host.handleInvoke('recents_get_reopen_on_launch', {})
    expect(got).toBe(true)
    host.stop()
  })

  it('recents_most_recent returns null when no entries', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('recents_most_recent', {})
    expect(got).toBeNull()
    host.stop()
  })

  it('recents_last_new_project_parent returns null then persists after setLastNewProjectParent', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    expect(await host.handleInvoke('recents_last_new_project_parent', {})).toBeNull()
    deps.recents!.setLastNewProjectParent('/my/projects')
    expect(await host.handleInvoke('recents_last_new_project_parent', {})).toBe('/my/projects')
    host.stop()
  })

  it('recents_remove drops an entry pushed via the store push method', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    deps.recents!.push('/proj/a', 'a')
    deps.recents!.push('/proj/b', 'b')
    await host.handleInvoke('recents_remove', { path: '/proj/a' })
    const got = await host.handleInvoke('recents_list', {}) as Array<{ name: string }>
    expect(got.length).toBe(1)
    expect(got[0]!.name).toBe('b')
    host.stop()
  })
})
