// Machine capability cache (ADR 0030; docs/preview.md §Decode engine):
// probe verdicts keyed (lane, format class), persisted at
// <userData>/decode_capability.json. envKey pins the environment the verdict
// was measured in — SW: the component's ffmpeg version; HW (D4): the GPU +
// driver identity — a mismatch wipes that lane (machine truth went stale).
// NOT the session bridge and NOT per-file (ADR 0010 stays: per-file
// incapability is session-scoped; this caches per-format-CLASS capability).
import type { AppSettingsFs } from './app-settings'

type Lane = 'sw' | 'hw'

interface CacheFile {
  env: Partial<Record<Lane, string>>
  entries: Partial<Record<Lane, Record<string, { ok: boolean; at: string }>>>
}

const EMPTY: CacheFile = { env: {}, entries: {} }

export interface DecodeCapabilityStore {
  get(lane: Lane, classKey: string, envKey: string): boolean | null
  put(lane: Lane, classKey: string, envKey: string, ok: boolean): void
}

export function createDecodeCapabilityStore(deps: { fs: AppSettingsFs; path: string; dir: string }): DecodeCapabilityStore {
  function read(): CacheFile {
    if (!deps.fs.exists(deps.path)) return structuredClone(EMPTY)
    try {
      const parsed = JSON.parse(deps.fs.readFile(deps.path)) as CacheFile
      return { env: parsed.env ?? {}, entries: parsed.entries ?? {} }
    } catch {
      return structuredClone(EMPTY)
    }
  }
  function write(c: CacheFile): void {
    deps.fs.mkdirp(deps.dir)
    const tmp = deps.path + '.tmp'
    deps.fs.writeFile(tmp, JSON.stringify(c, null, 2))
    deps.fs.rename(tmp, deps.path)
  }
  return {
    get(lane, classKey, envKey) {
      const c = read()
      if (c.env[lane] !== envKey) return null
      return c.entries[lane]?.[classKey]?.ok ?? null
    },
    put(lane, classKey, envKey, ok) {
      const c = read()
      if (c.env[lane] !== envKey) {
        c.env[lane] = envKey
        c.entries[lane] = {}
      }
      ;(c.entries[lane] ??= {})[classKey] = { ok, at: new Date().toISOString() }
      write(c)
    },
  }
}

/// Format-class key: codec::pix_fmt:resolution-class. Probe-informed
// (Task 12 returns codec/pixFmt); resolution classes keep 4K verdicts from
// vouching for 8K.
export function classKeyOf(codec: string, pixFmt: string | null, width: number, height: number): string {
  const px = Math.max(width, height)
  const res = px <= 1024 ? 'sd' : px <= 2048 ? 'hd' : px <= 4096 ? 'uhd' : 'huge'
  return `${codec}::${pixFmt ?? 'unknown'}:${res}`
}
