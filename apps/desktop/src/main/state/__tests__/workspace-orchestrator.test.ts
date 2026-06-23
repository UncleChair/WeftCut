import { describe, it, expect, vi } from 'vitest'
import { openProject, type OrchestratorDeps, type OrchestratorFs, type WorkspaceNapi } from '../workspace-orchestrator'
import { serializeProjectToJson, PROJECT_FILE } from '../persistence'
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
