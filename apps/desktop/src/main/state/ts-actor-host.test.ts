import { describe, it, expect } from 'vitest'
import { mapChangeEvent, createTsActorHost } from './ts-actor-host'

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
      workspaceDir: () => wsDir,
    }

    return { deps, vfs, napiCalls, sent }
  }

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

  it('project_save with no workspace is a no-op (workspaceDir returns null)', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    // No workspace set — forceFlush should not throw.
    await expect(host.handleInvoke('project_save', {})).resolves.toBeUndefined()
    host.stop()
  })
})
