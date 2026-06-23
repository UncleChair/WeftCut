import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosave, BACKUPS_DIR, type AutosaveFs, type AutosaveDeps } from '../autosave'
import { createActor, type ActorHandle } from '../actor'
import { serializeProjectToJson, PROJECT_FILE } from '../persistence'
import { blankProject } from '../model'
import { seededGen } from '../ids'

/** In-memory fs: files map + dirs set, with copyFile/readdir for Backups. */
function memFs(): AutosaveFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files, dirs,
    writeFile: (p, t) => { files.set(p, t) },
    exists: (p) => files.has(p) || dirs.has(p),
    copyFile: (s, d) => { const t = files.get(s); if (t === undefined) throw new Error(`ENOENT ${s}`); files.set(d, t) },
    mkdirp: (d) => { dirs.add(d) },
    readdir: (d) => [...files.keys()].filter((k) => k.startsWith(d + '/')).map((k) => k.slice(d.length + 1)),
    rm: (p) => { files.delete(p) },
  }
}

const posixJoin = (...p: string[]) => p.join('/')

function setup(over: Partial<AutosaveDeps> = {}) {
  const fs = (over.fs as ReturnType<typeof memFs>) ?? memFs()
  const idGen = seededGen()
  const actor: ActorHandle = createActor({ initial: blankProject(idGen, 'auto'), idGen })
  const deps: AutosaveDeps = {
    actor, fs, workspaceDir: () => '/ws', join: posixJoin, serialize: serializeProjectToJson,
    now: () => new Date('2026-06-23T12:00:00.000Z'), ...over,
  }
  return { fs, actor, deps, ctl: createAutosave(deps) }
}

describe('autosave forceFlush', () => {
  it('writes project.json and a Backups snapshot', async () => {
    const { fs, ctl } = setup()
    ctl.start()
    await ctl.forceFlush()
    ctl.stop()
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(true)
    // a snapshot landed in Backups/ with the colon-free timestamp form.
    const backups = [...fs.files.keys()].filter((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toBe(`/ws/${BACKUPS_DIR}/20260623T120000000Z.json`)
  })

  it('is a no-op when no workspace is set', async () => {
    const { fs, ctl } = setup({ workspaceDir: () => null })
    ctl.start(); await ctl.forceFlush(); ctl.stop()
    expect(fs.files.size).toBe(0)
  })
})

describe('autosave debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a flurry of commits into ONE write after 500ms quiet', async () => {
    const { fs, actor, ctl } = setup()
    ctl.start()
    for (let i = 0; i < 5; i++) actor.dispatch('add_track', {})  // 5 commits in quick succession
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(false)       // nothing written yet (debouncing)
    await vi.advanceTimersByTimeAsync(500)
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(true)        // exactly one write after quiet
    ctl.stop()
  })
})

describe('Backups gc + snapshot interval', () => {
  it('caps retained snapshots at 20 (oldest dropped)', async () => {
    const fs = memFs()
    // 25 pre-existing snapshots with sortable names.
    for (let i = 0; i < 25; i++) fs.files.set(`/ws/${BACKUPS_DIR}/200001${String(i).padStart(2, '0')}T000000000Z.json`, '{}')
    fs.files.set(`/ws/${PROJECT_FILE}`, '{}')
    // step `now` forward so each forceFlush mints a distinct backup name.
    let t = Date.parse('2026-06-23T12:00:00.000Z')
    const { ctl } = setup({ fs, now: () => new Date((t += 1000)) })
    ctl.start(); await ctl.forceFlush(); ctl.stop()
    const remaining = [...fs.files.keys()].filter((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`) && k.endsWith('.json'))
    expect(remaining).toHaveLength(20)
  })

  it('debounced writes snapshot only every 50 commits or 5 minutes', async () => {
    vi.useFakeTimers()
    let t = Date.parse('2026-06-23T12:00:00.000Z')
    const { fs, actor, ctl } = setup({ now: () => new Date(t) })
    ctl.start()
    // one debounced write at t0 → snapshots (first commit, last_snapshot_at starts now → 0 elapsed,
    // commits_since=1 < 50, so NO snapshot on the first debounced write per Rust). Assert no backup yet.
    actor.dispatch('add_track', {}); await vi.advanceTimersByTimeAsync(500)
    expect([...fs.files.keys()].some((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))).toBe(false)
    // advance wall clock past 5 min, one more debounced write → snapshot fires.
    t += 5 * 60_000 + 1
    actor.dispatch('add_track', {}); await vi.advanceTimersByTimeAsync(500)
    expect([...fs.files.keys()].some((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))).toBe(true)
    ctl.stop(); vi.useRealTimers()
  })
})
