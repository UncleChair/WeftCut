// Machine capability cache (ADR 0030; docs/preview.md §Decode engine):
// probe verdicts keyed (lane, format class), persisted at
// <userData>/decode_capability.json. envKey pins the environment the verdict
// was measured in — SW: the component's ffmpeg version; HW: the GPU +
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

/// Format-class key: codec::pix_fmt:resolution-class. Probe-informed (the SW
// probe returns codec/pixFmt); resolution classes keep 4K verdicts from
// vouching for 8K.
export function classKeyOf(codec: string, pixFmt: string | null, width: number, height: number): string {
  const px = Math.max(width, height)
  const res = px <= 1024 ? 'sd' : px <= 2048 ? 'hd' : px <= 4096 ? 'uhd' : 'huge'
  return `${codec}::${pixFmt ?? 'unknown'}:${res}`
}

/// The HW-preview lane the component advertises when it compiled the d3d11va GPU
/// path in (Windows). Resolvers gate their HW probe on this lane appearing in
/// the component's advertised `capabilities()` — so a build WITHOUT it (Linux,
/// where the native `preview_gpu_probe` is a by-design stub returning a
/// "not built" verdict) is never probed for HW. This explicit advertisement
/// gate replaces the fragile `process.platform` / throw-catch bypass.
export const HW_PREVIEW_LANE = 'd3d11va'

export interface HwProbeVerdict {
  ok: boolean
  reason: string | null
}

/// Advertisement-gated HW-lane probe resolution (ADR 0030 §Lane advertisement).
/// PURE apart from its injected collaborators (cache store, envKey resolver, and
/// the one-frame probe), so lane selection is unit-testable with fake
/// capabilities and fake verdicts — no GPU, no platform special-casing. Steps:
///   1. If the component never ADVERTISED the HW lane, return "unavailable"
///      WITHOUT probing. This is the gate that stops the Linux resolver from
///      ever calling into the GPU-preview stub (and covers an unloaded
///      component, whose advertised lanes are empty).
///   2. A cached verdict for this (classKey, envKey) short-circuits the probe.
///   3. Otherwise probe once, cache the verdict, and return it.
export async function resolveHwProbe(deps: {
  lanes: readonly string[]
  store: DecodeCapabilityStore
  classKey: string
  envKey: () => Promise<string>
  probe: () => HwProbeVerdict
}): Promise<HwProbeVerdict> {
  if (!deps.lanes.includes(HW_PREVIEW_LANE)) {
    return { ok: false, reason: 'hw lane unavailable' }
  }
  const envKey = await deps.envKey()
  const cached = deps.store.get('hw', deps.classKey, envKey)
  if (cached !== null) return { ok: cached, reason: 'cached' }
  const v = deps.probe()
  deps.store.put('hw', deps.classKey, envKey, v.ok)
  return { ok: v.ok, reason: v.reason }
}
