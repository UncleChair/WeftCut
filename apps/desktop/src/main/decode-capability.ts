// Machine capability cache (ADR 0030; docs/preview.md §Decode engine):
// probe verdicts keyed (lane, format class[, device]), persisted at
// <userData>/decode_capability.json. envKey pins the environment the verdict
// was measured in — SW: the component's ffmpeg version; HW: the GPU +
// driver identity — a mismatch wipes that lane (machine truth went stale).
// `device` is the extra dimension VAAPI needs: one machine can carry several
// DRM render nodes with different driver capability, so a verdict is keyed to
// the node it was measured on (NVDEC/d3d11va decode on the sole GPU handle and
// pass device=null). NOT the session bridge and NOT per-file (ADR 0010 stays:
// per-file incapability is session-scoped; this caches per-format-CLASS
// capability).
import type { AppSettingsFs } from './app-settings'

/// The decode lanes the machine cache can hold a verdict for — the software
/// lane plus each platform's hardware lanes, named exactly as the component
/// advertises them (`capabilities()`). `d3d11va` is Windows; `nvdec`/`vaapi`
/// are Linux. Never coexist across platforms, but the cache vocabulary is
/// platform-independent.
export type DecodeLane = 'sw' | 'd3d11va' | 'nvdec' | 'vaapi'

/// HW-lane resolution order (User Story 8; mirrors the encode side's
/// NVENC > VAAPI). NVDEC first so an NVIDIA machine uses its native decoder
/// rather than the flaky NVIDIA VAAPI shim; VAAPI next (Intel/AMD, and NVIDIA's
/// shim as a last resort); `d3d11va` trails as the Windows lane (it never shares
/// an advertisement with the Linux lanes, so its position is inert there).
export const HW_LANE_PRIORITY: readonly DecodeLane[] = ['nvdec', 'vaapi', 'd3d11va']

interface CacheFile {
  env: Partial<Record<DecodeLane, string>>
  entries: Partial<Record<DecodeLane, Record<string, { ok: boolean; at: string }>>>
}

const EMPTY: CacheFile = { env: {}, entries: {} }

/// Compose the per-lane entry key. A verdict without a device (NVDEC, d3d11va,
/// SW) keys on the bare classKey — byte-identical to the pre-device format so
/// those lanes' entries are unchanged. VAAPI folds the DRM node in so per-node
/// verdicts stay independent.
function entryKeyOf(classKey: string, device?: string | null): string {
  return device != null ? `${classKey}@${device}` : classKey
}

export interface DecodeCapabilityStore {
  get(lane: DecodeLane, classKey: string, envKey: string, device?: string | null): boolean | null
  put(lane: DecodeLane, classKey: string, envKey: string, ok: boolean, device?: string | null): void
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
    get(lane, classKey, envKey, device) {
      const c = read()
      if (c.env[lane] !== envKey) return null
      return c.entries[lane]?.[entryKeyOf(classKey, device)]?.ok ?? null
    },
    put(lane, classKey, envKey, ok, device) {
      const c = read()
      if (c.env[lane] !== envKey) {
        c.env[lane] = envKey
        c.entries[lane] = {}
      }
      ;(c.entries[lane] ??= {})[entryKeyOf(classKey, device)] = { ok, at: new Date().toISOString() }
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

export interface HwProbeVerdict {
  ok: boolean
  reason: string | null
}

/// The chosen HW lane. `lane` is null on software fallback (no advertised HW
/// lane, or every advertised lane/device probed unusable); `device` names the
/// DRM render node for a VAAPI verdict (null for NVDEC/d3d11va, which decode on
/// the sole GPU handle).
export interface HwLaneResolution {
  lane: DecodeLane | null
  device: string | null
  ok: boolean
  reason: string | null
}

/// Advertisement-gated HW-lane resolution (ADR 0030 §Lane advertisement; issue
/// #5 Block C). PURE apart from its injected collaborators (cache store, per-lane
/// envKey resolver, DRM-device enumerator, and the one-frame probe), so lane
/// selection is unit-testable with fake capabilities and fake verdicts — no GPU,
/// no platform special-casing. It replaces the single-lane `d3d11va` gate with a
/// priority walk so NVDEC/VAAPI (and Windows d3d11va) all resolve through one
/// path. Steps:
///   1. Keep only the advertised HW lanes, in `HW_LANE_PRIORITY` order. If the
///      component advertised none (Linux SW-only build, or an unloaded
///      component whose lanes are empty), return "unavailable" WITHOUT probing —
///      the gate that stops a resolver from ever calling into a lane the addon
///      never compiled.
///   2. For each candidate lane (highest priority first), enumerate its devices
///      (VAAPI: the DRM render nodes; other lanes: a single null device). A lane
///      that enumerates zero devices (VAAPI with no render nodes) is skipped.
///   3. For each (lane, device): a cached verdict short-circuits — a positive
///      wins immediately; a negative skips to the next candidate WITHOUT
///      re-probing. On a cache miss, probe once, cache the verdict, and take the
///      lane if it passed.
///   4. If every advertised lane/device is unusable, return software fallback.
export async function resolveHwLane(deps: {
  lanes: readonly string[]
  store: DecodeCapabilityStore
  classKey: string
  envKey: (lane: DecodeLane) => Promise<string>
  devices: (lane: DecodeLane) => readonly (string | null)[]
  probe: (lane: DecodeLane, device: string | null) => HwProbeVerdict
}): Promise<HwLaneResolution> {
  const candidates = HW_LANE_PRIORITY.filter((l) => deps.lanes.includes(l))
  if (candidates.length === 0) {
    return { lane: null, device: null, ok: false, reason: 'hw lane unavailable' }
  }
  for (const lane of candidates) {
    const env = await deps.envKey(lane)
    const devices = deps.devices(lane)
    for (const device of devices) {
      const cached = deps.store.get(lane, deps.classKey, env, device)
      if (cached === true) return { lane, device, ok: true, reason: 'cached' }
      if (cached === false) continue
      const v = deps.probe(lane, device)
      deps.store.put(lane, deps.classKey, env, v.ok, device)
      if (v.ok) return { lane, device, ok: true, reason: v.reason }
    }
  }
  return { lane: null, device: null, ok: false, reason: 'no hw lane passed' }
}
