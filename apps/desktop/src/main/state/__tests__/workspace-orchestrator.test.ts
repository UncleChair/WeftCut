import { describe, it, expect, vi } from 'vitest'
import { openProject, saveProjectAs, newWorkspace, makeEnqueueDerivatives, type OrchestratorDeps, type OrchestratorFs, type WorkspaceNapi } from '../workspace-orchestrator'
import { serializeProjectToJson, PROJECT_FILE } from '../persistence'
import { canonicalize } from '../canonical'
import { serializeProject, type GridRepair } from '../serialize'
import { applyAddLayer, colorParams } from '../mutations/add'
import { blankProject } from '../model'
import type { MediaItem } from '../model'
import { seededGen } from '../ids'

const posixJoin = (...p: string[]) => p.join('/')

/** In-memory fs fake: a flat path→contents map. */
function memFs(seed: Record<string, string> = {}): OrchestratorFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  return {
    files, dirs,
    exists: (p) => files.has(p) || dirs.has(p),
    readFile: (p) => { const t = files.get(p); if (t === undefined) throw new Error(`ENOENT ${p}`); return t },
    writeFile: (p, t) => { files.set(p, t) },
    mkdirp: (d) => { dirs.add(d) },
    rm: vi.fn((p) => { files.delete(p) }),
  }
}

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps & { calls: string[] } {
  const calls: string[] = []
  const napi: WorkspaceNapi = {
    commitWorkspace: vi.fn(async (p) => { calls.push(`commit:${p}`) }),
    pushRecent: vi.fn((p, n) => { calls.push(`recent:${p}:${n}`) }),
    setLastNewProjectParent: vi.fn((p) => { calls.push(`parent:${p}`) }),
    enqueueJobsForMedia: vi.fn((_json) => {}),
  }
  const actor = {
    replaceState: vi.fn((_p: unknown) => { calls.push('replaceState') }),
    snapshot: vi.fn(() => blankProject(seededGen(), 'snap')),
  }
  return { actor, napi, fs: memFs(), join: posixJoin, idGen: seededGen(), calls, ...over } as OrchestratorDeps & { calls: string[] }
}

describe('openProject', () => {
  const project = blankProject(seededGen(), 'Demo')
  const projectJson = serializeProjectToJson(project)

  it('throws PROJECT_FOLDER_MISSING when the folder is absent', async () => {
    const d = deps()
    await expect(openProject(d, '/ws')).rejects.toThrow('PROJECT_FOLDER_MISSING')
  })

  it('throws NOT_PROJECT_FOLDER when project.json is absent', async () => {
    const d = deps({ fs: memFs() }); (d.fs as any).dirs.add('/ws')
    await expect(openProject(d, '/ws')).rejects.toThrow('NOT_PROJECT_FOLDER')
  })

  it('commits the workspace BEFORE replaceState, pushes recent AFTER', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: projectJson }); fs.dirs.add('/ws')
    const d = deps({ fs })
    await openProject(d, '/ws')
    expect(d.calls).toEqual(['commit:/ws', 'replaceState', 'recent:/ws:Demo'])
    expect(d.actor.replaceState).toHaveBeenCalledOnce()
  })

  it('does not push recent and propagates the error when replaceState throws', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: projectJson }); fs.dirs.add('/ws')
    const d = deps({ fs })
    d.actor.replaceState = vi.fn(() => { throw new Error('ValidationFailed') })
    await expect(openProject(d, '/ws')).rejects.toThrow('ValidationFailed')
    expect(d.napi.pushRecent).not.toHaveBeenCalled()
  })

  // ── Load-time grid repair report ───────────────────────────────────────────
  /** A saved project whose only clip ends 1 µs below frame 90 at 30/1 — the shape
   *  `parseProject`'s load pass repairs on the way in. */
  function offGridJson(): string {
    const g = seededGen()
    const p = blankProject(g, 'Demo')
    applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 255, g: 0, b: 0, a: 255 }, 16, 9), 0, 2_000_000)
    const wire = serializeProject(p) as any
    wire.tracks[0].layers[0].t_end_us = 2_999_999
    return JSON.stringify(wire)
  }

  it('reports a load-time grid repair AFTER the workspace commit and BEFORE the state swap', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: offGridJson() }); fs.dirs.add('/ws')
    const reports: GridRepair[][] = []
    const d = deps({ fs })
    d.onGridRepair = (r) => { reports.push([...r]); d.calls.push('gridLog') }
    await openProject(d, '/ws')
    // The parse happens before commitWorkspace, but commitWorkspace ROTATES the
    // per-workspace LogBus — so emitting where the repair happened would drop the row
    // into the doomed pre-open bus. It is captured and replayed here instead. Before
    // replaceState, so a swap that still fails validation leaves the diagnostic behind.
    expect(d.calls).toEqual(['commit:/ws', 'gridLog', 'replaceState', 'recent:/ws:Demo'])
    expect(reports[0]).toContainEqual({ entity: 'Layer', id: expect.any(String), field: 't_end_us', from: 2_999_999, to: 3_000_000 })
  })

  it('does not report when the loaded project needs no repair', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: projectJson }); fs.dirs.add('/ws')
    const d = deps({ fs })
    const onGridRepair = vi.fn()
    d.onGridRepair = onGridRepair
    await openProject(d, '/ws')
    expect(onGridRepair).not.toHaveBeenCalled()
  })

  it('never lets a throwing onGridRepair abort the open', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: offGridJson() }); fs.dirs.add('/ws')
    const d = deps({ fs, onGridRepair: () => { throw new Error('emit failed') } })
    await expect(openProject(d, '/ws')).resolves.toBeUndefined()
    expect(d.actor.replaceState).toHaveBeenCalledOnce()
  })

  const managedItem: MediaItem = {
    id: 'm1', label: null,
    path_abs: '/elsewhere/电子榨菜.mp3', path_rel: 'Media/电子榨菜.mp3', kind: 'Audio',
    metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'b3:AAAA', file_size: 4, file_mtime: 1,
    imported_at: '2026-01-01T00:00:00Z',
    decode_route: { route: 'bypass' },
    conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
  const managedJson = serializeProjectToJson({ ...project, media_pool: { m1: managedItem } })

  it('relinks a mangled media filename when the relink dep is present, and logs via onRelink', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: managedJson }); fs.dirs.add('/ws')
    // The workspace copy survived the transfer under a garbled name —
    // "电子榨菜"'s UTF-8 bytes decoded as GBK, the real flag-less-zip artifact.
    const disk = new Map([['/ws/Media/鐢靛瓙姒ㄨ彍.mp3', 'AAAA']])
    const relink = {
      fs: {
        exists: (p: string) => disk.has(p),
        listDir: (d: string) => [...disk.keys()].filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1)),
        statFile: (p: string) => (disk.has(p) ? { size: disk.get(p)!.length, mtimeSecs: 9 } : null),
        rename: (from: string, to: string) => { disk.set(to, disk.get(from)!); disk.delete(from) },
      },
      join: posixJoin,
      hashFile: async (p: string) => `b3:${disk.get(p) ?? ''}`,
    }
    const reports: unknown[] = []
    let swapped: any
    const d = deps({ fs, relink })
    // Pushes into d.calls so the emit's position in the open sequence is assertable.
    d.onRelink = (r) => { reports.push(r); d.calls.push('relinkLog') }
    d.actor.replaceState = vi.fn((p) => { swapped = p; d.calls.push('replaceState') })
    await openProject(d, '/ws')
    expect(swapped.media_pool.m1.path_abs).toBe('/ws/Media/电子榨菜.mp3')  // healed + renamed back
    expect(disk.has('/ws/Media/电子榨菜.mp3')).toBe(true)
    expect(reports).toHaveLength(1)
    // The report emits after the commit and the state swap, never during the heal.
    expect(d.calls).toEqual(['commit:/ws', 'replaceState', 'relinkLog', 'recent:/ws:Demo'])
  })

  it('never lets a throwing onRelink abort the open', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: managedJson }); fs.dirs.add('/ws')
    const disk = new Map([['/ws/Media/鐢靛瓙姒ㄨ彍.mp3', 'AAAA']])
    const relink = {
      fs: {
        exists: (p: string) => disk.has(p),
        listDir: (d: string) => [...disk.keys()].filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1)),
        statFile: (p: string) => (disk.has(p) ? { size: disk.get(p)!.length, mtimeSecs: 9 } : null),
        rename: (from: string, to: string) => { disk.set(to, disk.get(from)!); disk.delete(from) },
      },
      join: posixJoin,
      hashFile: async (p: string) => `b3:${disk.get(p) ?? ''}`,
    }
    const d = deps({ fs, relink, onRelink: () => { throw new Error('emit failed') } })
    await openProject(d, '/ws')
    expect(d.actor.replaceState).toHaveBeenCalledOnce()
    expect(d.napi.pushRecent).toHaveBeenCalledOnce()
  })

  it('opens the un-healed project when the relink pass itself throws', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: managedJson }); fs.dirs.add('/ws')
    const relink = {
      fs: { exists: (): boolean => { throw new Error('boom') }, listDir: () => [], statFile: () => null, rename: () => {} },
      join: posixJoin,
      hashFile: async () => '',
    }
    const reports: unknown[] = []
    const d = deps({ fs, relink, onRelink: (r) => reports.push(r) })
    await openProject(d, '/ws')
    expect(d.actor.replaceState).toHaveBeenCalledOnce()
    expect(reports).toHaveLength(0)
  })

  it('deletes stale quick proxies returned by the loader', async () => {
    const quickProxyPath = '/ws/Cache/quick/m1.mp4'
    const item: MediaItem = {
      id: 'm1', label: null,
      path_abs: '/ws/Media/clip.mp4', path_rel: null, kind: 'Video',
      metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'deadbeef', file_size: 0, file_mtime: 0,
      imported_at: '2026-01-01T00:00:00Z',
      decode_route: { route: 'direct-export', quick_proxy: quickProxyPath },
      conform_path: null, waveform_path: null, thumbnails_dir: null,
    }
    const withProxy = { ...project, media_pool: { m1: item } }
    const json = serializeProjectToJson(withProxy)
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: json }); fs.dirs.add('/ws')
    const d = deps({ fs })
    await openProject(d, '/ws')
    expect(fs.rm).toHaveBeenCalledWith(quickProxyPath)
  })
})

describe('saveProjectAs', () => {
  it('snapshots, writes project.json under the dir, commits workspace, pushes recent', async () => {
    const d = deps()
    await saveProjectAs(d, '/out')
    expect((d.fs as any).dirs.has('/out')).toBe(true)
    expect((d.fs as any).files.get(`/out/${PROJECT_FILE}`)).toContain('"schema_version"')
    expect(d.calls).toEqual(['commit:/out', 'recent:/out:snap']) // snapshot() name is 'snap'
    expect(d.actor.replaceState).not.toHaveBeenCalled()           // save-as never swaps state
  })
})

describe('newWorkspace', () => {
  const args = { parentFolder: '/parent', name: 'Fresh', width: 1280, height: 720, fpsNum: 24, fpsDen: 1 }

  it('rejects an empty name', async () => {
    await expect(newWorkspace(deps(), { ...args, name: '  ' })).rejects.toThrow(/name is required/)
  })
  it('rejects a zero canvas/fps', async () => {
    await expect(newWorkspace(deps(), { ...args, width: 0 })).rejects.toThrow(/canvas preset/)
    await expect(newWorkspace(deps(), { ...args, fpsDen: 0 })).rejects.toThrow(/canvas preset/)
  })
  it('rejects an existing target folder', async () => {
    const fs = memFs(); fs.dirs.add('/parent/Fresh')
    await expect(newWorkspace(deps({ fs }), args)).rejects.toThrow(/already exists/)
  })
  it('writes a blank project with the canvas preset, commits, swaps, pushes recent + parent', async () => {
    const d = deps()
    const out = await newWorkspace(d, args)
    expect(out).toBe('/parent/Fresh')
    const written = JSON.parse((d.fs as any).files.get(`/parent/Fresh/${PROJECT_FILE}`))
    expect(written.composition).toMatchObject({ width: 1280, height: 720, fps: { num: 24, den: 1 } })
    expect(d.calls).toEqual(['commit:/parent/Fresh', 'replaceState', 'recent:/parent/Fresh:Fresh', 'parent:/parent'])
  })
})

describe('makeEnqueueDerivatives', () => {
  it('serializes the media pool values and calls the napi once', () => {
    const calls: string[] = []
    const enqueue = makeEnqueueDerivatives({ enqueueJobsForMedia: (json) => { calls.push(json) } })
    const project = blankProject(seededGen(), 'D') // empty pool → "[]"
    enqueue(project)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0])).toEqual([])
  })

  it('openProject runs the injected enqueueDerivatives after replaceState', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: serializeProjectToJson(blankProject(seededGen(), 'Demo')) }); fs.dirs.add('/ws')
    const seen: unknown[] = []
    const d = deps({ fs, enqueueDerivatives: (p) => seen.push(p) })
    await openProject(d, '/ws')
    expect(seen).toHaveLength(1)
  })
})

describe('round-trip: new → save → open is state-identical', () => {
  it('reopens to the same serialized project', async () => {
    // shared in-memory fs so save writes and open reads the same map
    const fs = memFs()
    // capture what newWorkspace replaceState'd, and what openProject replaceState's
    let created: any, reopened: any
    const dNew = deps({ fs }); dNew.actor.replaceState = vi.fn((p) => { created = p })
    const out = await newWorkspace(dNew, { parentFolder: '/p', name: 'RT', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    // save the created project to its own folder (snapshot returns it)
    const dSave = deps({ fs }); dSave.actor.snapshot = vi.fn(() => created)
    await saveProjectAs(dSave, out)
    // reopen
    const dOpen = deps({ fs }); dOpen.actor.replaceState = vi.fn((p) => { reopened = p })
    await openProject(dOpen, out)
    expect(JSON.stringify(canonicalize(serializeProject(reopened))))
      .toBe(JSON.stringify(canonicalize(serializeProject(created))))
  })
})
