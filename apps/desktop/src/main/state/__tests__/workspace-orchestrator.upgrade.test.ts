// apps/desktop/src/main/state/__tests__/workspace-orchestrator.upgrade.test.ts
//
// The open path's schema-upgrade wiring: preserve the pre-upgrade bytes, then
// report.
//
// WHY THIS FILE MOCKS THE LOADER: at v1 the migration chain is empty, so no real
// project.json can arrive needing an upgrade — an older file is refused at the
// floor and a current one needs nothing. The wiring would therefore ship
// completely unexercised and first run for real on a user's v1 project years from
// now, at the exact moment its only job (keeping the original) matters. So the
// loader's `upgradedFrom` is forced here; everything else — the real parse, the
// real fs fake, the real handler order — is untouched. The mock lives in its own
// file so the main orchestrator suite keeps using the real module.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ upgradedFrom: null as number | null }))

vi.mock('../persistence', async (importOriginal) => {
  const real = await importOriginal<typeof import('../persistence')>()
  return {
    ...real,
    loadProjectFromJson: (text: string, opts: Parameters<typeof real.loadProjectFromJson>[1]) => ({
      ...real.loadProjectFromJson(text, opts),
      upgradedFrom: state.upgradedFrom,
    }),
  }
})

const { openProject } = await import('../workspace-orchestrator')
const { serializeProjectToJson, PROJECT_FILE, preUpgradeBackupFile } = await import('../persistence')
const { blankProject } = await import('../model')
const { seededGen } = await import('../ids')
type OrchestratorDeps = import('../workspace-orchestrator').OrchestratorDeps
type OrchestratorFs = import('../workspace-orchestrator').OrchestratorFs
type SchemaUpgradeReport = import('../workspace-orchestrator').SchemaUpgradeReport

const posixJoin = (...p: string[]) => p.join('/')
const PROJECT_JSON = serializeProjectToJson(blankProject(seededGen(), 'Demo'))

function memFs(seed: Record<string, string> = {}): OrchestratorFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>(['/ws'])
  return {
    files, dirs,
    exists: (p) => files.has(p) || dirs.has(p),
    readFile: (p) => { const t = files.get(p); if (t === undefined) throw new Error(`ENOENT ${p}`); return t },
    writeFile: (p, t) => { files.set(p, t) },
    mkdirp: (d) => { dirs.add(d) },
    rm: (p) => { files.delete(p) },
  }
}

function harness(fs: OrchestratorFs) {
  const calls: string[] = []
  const reports: SchemaUpgradeReport[] = []
  const deps = {
    actor: {
      replaceState: vi.fn(() => { calls.push('replaceState') }),
      snapshot: vi.fn(() => blankProject(seededGen(), 'snap')),
    },
    napi: {
      commitWorkspace: vi.fn(async () => { calls.push('commitWorkspace') }),
      pushRecent: vi.fn(() => { calls.push('pushRecent') }),
      setLastNewProjectParent: vi.fn(() => {}),
      enqueueJobsForMedia: vi.fn(() => {}),
    },
    fs, join: posixJoin, idGen: seededGen(),
    onSchemaUpgrade: (r: SchemaUpgradeReport) => { calls.push('onSchemaUpgrade'); reports.push(r) },
  } as unknown as OrchestratorDeps
  return { deps, calls, reports }
}

beforeEach(() => { state.upgradedFrom = null })

describe('openProject — schema upgrade', () => {
  it('preserves the pre-upgrade bytes verbatim, beside project.json', async () => {
    state.upgradedFrom = 1
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: PROJECT_JSON })
    const { deps } = harness(fs)
    await openProject(deps, '/ws')

    // The ORIGINAL text, not a re-serialization — a re-serialization would already
    // be the upgraded shape, which is precisely what the backup must not be.
    expect(fs.files.get(`/ws/${preUpgradeBackupFile(1)}`)).toBe(PROJECT_JSON)
    // Not in Backups/: that directory's 20-file gc must never be able to reclaim it.
    expect([...fs.files.keys()].some((k) => k.includes('Backups'))).toBe(false)
  })

  it('reports the upgrade after commitWorkspace and before replaceState', async () => {
    state.upgradedFrom = 1
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: PROJECT_JSON })
    const { deps, calls, reports } = harness(fs)
    await openProject(deps, '/ws')

    // After commitWorkspace because that rotates the per-workspace LogBus (a row
    // emitted earlier lands in the doomed bus); before replaceState because if the
    // swap fails validation, "this was upgraded from v1" is the first clue.
    expect(calls).toEqual(['commitWorkspace', 'onSchemaUpgrade', 'replaceState', 'pushRecent'])
    expect(reports).toEqual([{ from: 1, to: 1, backupFile: 'project.pre-v1.json' }])
  })

  it('never clobbers an existing backup — the oldest copy is the valuable one', async () => {
    state.upgradedFrom = 1
    const fs = memFs({
      [`/ws/${PROJECT_FILE}`]: PROJECT_JSON,
      [`/ws/${preUpgradeBackupFile(1)}`]: '{"the":"first open kept this"}',
    })
    const { deps, reports } = harness(fs)
    await openProject(deps, '/ws')

    expect(fs.files.get(`/ws/${preUpgradeBackupFile(1)}`)).toBe('{"the":"first open kept this"}')
    expect(reports[0]!.backupFile).toBe('project.pre-v1.json')
  })

  it('still opens when the backup cannot be written, and says so', async () => {
    state.upgradedFrom = 1
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: PROJECT_JSON })
    const readOnly: OrchestratorFs = {
      ...fs,
      writeFile: () => { throw new Error('EROFS') },
    }
    const { deps, calls, reports } = harness(readOnly)
    await openProject(deps, '/ws')

    expect(calls).toContain('replaceState')                  // the open is not blocked
    expect(reports[0]).toEqual({ from: 1, to: 1, backupFile: null })  // …but the row must not imply a safety net
  })

  it('writes nothing and reports nothing when the file was already current', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: PROJECT_JSON })
    const { deps, calls, reports } = harness(fs)
    await openProject(deps, '/ws')

    expect([...fs.files.keys()]).toEqual([`/ws/${PROJECT_FILE}`])
    expect(reports).toEqual([])
    expect(calls).not.toContain('onSchemaUpgrade')
  })
})
