import { describe, it, expect, vi } from 'vitest'
import { openProject, saveProjectAs, newWorkspace, makeEnqueueDerivatives, type OrchestratorDeps, type OrchestratorFs, type WorkspaceNapi } from '../workspace-orchestrator'
import { serializeProjectToJson, PROJECT_FILE } from '../persistence'
import { canonicalize } from '../canonical'
import { serializeProject } from '../serialize'
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

  it('deletes stale quick proxies returned by the loader', async () => {
    const quickProxyPath = '/ws/Cache/quick/m1.mp4'
    const item: MediaItem = {
      id: 'm1', label: null,
      path_abs: '/ws/Media/clip.mp4', path_rel: null, kind: 'Video',
      metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'deadbeef', file_size: 0, file_mtime: 0,
      imported_at: '2026-01-01T00:00:00Z', proxy_path: null, quick_proxy_path: quickProxyPath,
      proxy_bypassed: false, export_uses_original: false, proxy_format_version: 0,
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
