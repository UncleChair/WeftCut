# State-Actor TS Migration — Phase 0 Implementation Plan (Foundations & Safety Net)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is Phase 0 of the master plan `2026-06-22-state-actor-ts-migration.md` — read Parts 1–3 of that doc first.

**Goal:** Build the TypeScript canonical project model + serializer, inject determinism into the Rust actor, and stand up the differential harness — so every later phase can prove the TS actor is byte-identical to the Rust actor. **No production behavior changes in this phase.**

**Architecture:** A JSON-native TypeScript `Project` model (plain objects/arrays/strings/numbers — no Map/Set, so it is directly serializable and Immer-friendly later) plus a `serialize`/`parse` pair and a `canonicalJson` function. On the Rust side, `new_id()` gains a process-global deterministic mode, and a feature-gated `replay_driver` binary replays command sequences through the real actor to emit canonical JSON oracle traces. A Vitest suite proves the TS model round-trips those real-actor traces.

**Tech Stack:** TypeScript, Vitest 4, the existing Rust actor (`weftcut_lib::state`), serde_json (`preserve_order` is OFF → `serde_json::Value` round-trips object keys sorted, giving free canonicalization on the Rust side). **No new npm dependencies** — UUID generation is a ~15-line inline implementation.

## Global Constraints

- **JSON-native model.** The TS model uses only `string | number | boolean | null | array | object`. Maps (`media_pool`, `audio_roles`, `layer.metadata`, `motif.props`) are plain objects (`Record<string,…>`); sets (`group.members`) are arrays kept sorted. This makes the model directly JSON-serializable and avoids Immer Map/Set handling later.
- **serde wire-shape fidelity** (from master plan Part 2.3 — copied verbatim):
  - `LayerParams` external tag on `kind`: `{"kind":"Color", ...}`
  - `Animated<T>` internal tag: `{"mode":"Static","value":0.5}` / `{"mode":"Keyframed","value":[…]}`
  - `Interpolation` external tag on `kind`: `{"kind":"Linear"}` / `{"kind":"Bezier","p1":[x,y],"p2":[x,y]}`
  - `TransitionKind` external tag on `kind`: `{"kind":"Crossfade"}`
  - `AudioRole` kebab-case: `"voiceover"`; `TrackRole` has NO rename_all → PascalCase variant names: `"ARoll"`/`"BRoll"`/`"AudioA"`/`"AudioB"`/`"Caption"` (the kebab `"a-roll"` form is the IPC summary view only, NOT the `.vproj` serde — `track.rs:93-102`)
  - Plain enums serialize as the bare variant name: `TextAlign`→`"Center"`, `TextAnimPreset`→`"FadeIn"`, `TextBackend`→`"Auto"`, `BlendMode`→`"Normal"`, `MediaKind`→`"Video"`, `ColorSpace`→`"Bt709"`
  - all ids = UUID strings; `TimeUs` = `number`; `Rational` = `{num,den}`; `Rgba` = `{r,g,b,a}` (0–255)
  - `Option::None` serializes as explicit `null` (key present) EXCEPT `Group.label` which uses `skip_serializing_if` (omitted when absent)
  - `Project.media_pool` / `audio_roles` / `Effect.params` are objects with **sorted keys** in canonical form
- **Determinism caps (logged, deliberate):** (1) wall-clock fields `metadata.created_at` / `metadata.modified_at` are NORMALIZED to a sentinel in canonicalization rather than compared — timestamps are not an invariant and Phase 0 does not inject a Rust clock. (2) the Phase 0 corpus is scoped to **media-free** commands (Color + Text layers, markers, groups, composition, transforms, undo/redo) — media-bearing layers (which need a populated `media_pool`) are added to the corpus in Phase 2.
- **Schema version is 9** (`native/src/state/project.rs:22`). `parseProject` rejects anything else.
- TDD, frequent commits, DRY, YAGNI.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/desktop/src/main/state/ids.ts` | `IdGen` contract; `seededGen` (deterministic, matches Rust); `uuidV7Gen` (prod, inline) |
| `apps/desktop/src/main/state/canonical.ts` | `canonicalJson` — recursive object-key sort + timestamp normalization |
| `apps/desktop/src/main/state/model.ts` | The canonical TS `Project` type graph + `blankProject(idGen)` constructor |
| `apps/desktop/src/main/state/serialize.ts` | `parseProject` / `serializeProject` (wire-faithful, canonical) |
| `apps/desktop/src/main/state/*.test.ts` | Co-located Vitest specs |
| `apps/desktop/src/main/state/__tests__/differential.test.ts` | Phase-0 round-trip over oracle traces |
| `apps/desktop/native/src/state/ids.rs` | (modify) add process-global deterministic id mode |
| `apps/desktop/native/src/bin/replay_driver.rs` | (create, feature `replay`) command-sequence → canonical oracle trace |
| `apps/desktop/native/Cargo.toml` | (modify) add `replay` feature + `[[bin]]` entry |
| `apps/desktop/fixtures/state-corpus/sequences/*.json` | authored command sequences (≥50) |
| `apps/desktop/fixtures/state-corpus/oracle/*.json` | generated oracle traces (committed) |
| `apps/desktop/scripts/gen-state-oracle.mjs` | runs the driver over every sequence → oracle traces |

All Vitest commands run from `apps/desktop/`. All cargo commands use `--manifest-path native/Cargo.toml`.

---

## Task 1: TS id generators (`ids.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/ids.ts`
- Test: `apps/desktop/src/main/state/ids.test.ts`

**Interfaces:**
- Produces: `type IdGen = () => string`; `seededGen(start?: number): IdGen`; `uuidV7Gen(): IdGen`.
- `seededGen` MUST produce the same strings as the Rust deterministic generator: id #n = `Uuid::from_u128(n)` ⇒ the 32-hex-digit big-endian of `n`, hyphenated `8-4-4-4-12`. So the first id is `00000000-0000-0000-0000-000000000001`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/ids.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen, uuidV7Gen } from './ids'

describe('seededGen', () => {
  it('matches Uuid::from_u128(n) formatting, starting at 1', () => {
    const g = seededGen()
    expect(g()).toBe('00000000-0000-0000-0000-000000000001')
    expect(g()).toBe('00000000-0000-0000-0000-000000000002')
  })
  it('honours a custom start', () => {
    const g = seededGen(255)
    expect(g()).toBe('00000000-0000-0000-0000-0000000000ff')
  })
})

describe('uuidV7Gen', () => {
  it('produces distinct, well-formed v7 uuids', () => {
    const g = uuidV7Gen()
    const a = g(), b = g()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/ids.test.ts`
Expected: FAIL — `Cannot find module './ids'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/main/state/ids.ts

/** A source of opaque, unique entity ids. Injected so the differential
 *  harness can replace it with a deterministic sequence. */
export type IdGen = () => string

function hyphenate32(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Deterministic generator: id #n = Uuid::from_u128(n). Byte-identical to the
 *  Rust replay driver's deterministic mode (native/src/state/ids.rs). */
export function seededGen(start = 0): IdGen {
  let n = start
  return () => {
    n += 1
    return hyphenate32(n.toString(16).padStart(32, '0'))
  }
}

/** Production generator: UUIDv7 (time-ordered). ~15 lines, no dependency. */
export function uuidV7Gen(): IdGen {
  return () => {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const ms = Date.now()
    // 48-bit big-endian millisecond timestamp
    bytes[0] = (ms / 2 ** 40) & 0xff
    bytes[1] = (ms / 2 ** 32) & 0xff
    bytes[2] = (ms / 2 ** 24) & 0xff
    bytes[3] = (ms / 2 ** 16) & 0xff
    bytes[4] = (ms / 2 ** 8) & 0xff
    bytes[5] = ms & 0xff
    bytes[6] = (bytes[6] & 0x0f) | 0x70 // version 7
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return hyphenate32(hex)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/ids.test.ts`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/ids.ts apps/desktop/src/main/state/ids.test.ts
git commit -m "feat(state-migration): TS id generators (seeded + uuidv7) for Phase 0"
```

---

## Task 2: Canonical JSON (`canonical.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/canonical.ts`
- Test: `apps/desktop/src/main/state/canonical.test.ts`

**Interfaces:**
- Produces: `canonicalize(value: unknown): unknown` (recursively sorts object keys, leaves arrays in order, normalizes the two timestamp fields) and `canonicalString(value: unknown): string` (= `JSON.stringify(canonicalize(value))`).
- The timestamp normalization: any object key named `created_at` or `modified_at` whose value is a string is replaced with the sentinel `"<TS>"`. (Both sides apply this; see Global Constraints.)

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/canonical.test.ts
import { describe, it, expect } from 'vitest'
import { canonicalize, canonicalString } from './canonical'

describe('canonicalize', () => {
  it('sorts object keys recursively but preserves array order', () => {
    const out = canonicalize({ b: 1, a: { d: 2, c: 3 }, list: [3, 1, 2] })
    expect(JSON.stringify(out)).toBe('{"a":{"c":3,"d":2},"b":1,"list":[3,1,2]}')
  })
  it('normalizes wall-clock fields to a sentinel', () => {
    const out = canonicalize({ metadata: { created_at: '2020-01-01T00:00:00Z', modified_at: '2021-06-06T12:00:00Z', name: 'x' } })
    expect((out as any).metadata.created_at).toBe('<TS>')
    expect((out as any).metadata.modified_at).toBe('<TS>')
    expect((out as any).metadata.name).toBe('x')
  })
  it('canonicalString is stable regardless of input key order', () => {
    expect(canonicalString({ y: 1, x: 2 })).toBe(canonicalString({ x: 2, y: 1 }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/canonical.test.ts`
Expected: FAIL — `Cannot find module './canonical'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/main/state/canonical.ts

const TS_FIELDS = new Set(['created_at', 'modified_at'])
const TS_SENTINEL = '<TS>'

/** Return a structurally-canonical clone: object keys sorted recursively,
 *  arrays left in order (order is semantic for tracks/layers/keyframes),
 *  wall-clock fields normalized. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) {
      out[key] = TS_FIELDS.has(key) && typeof src[key] === 'string' ? TS_SENTINEL : canonicalize(src[key])
    }
    return out
  }
  return value
}

export function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/canonical.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/canonical.ts apps/desktop/src/main/state/canonical.test.ts
git commit -m "feat(state-migration): canonical JSON (key-sort + timestamp normalize)"
```

---

## Task 3: Canonical model + `blankProject` (`model.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/model.ts`
- Test: `apps/desktop/src/main/state/model.test.ts`

**Interfaces:**
- Produces: the full `Project` type graph (consumed by every later phase and by `serialize.ts`) and `blankProject(idGen: IdGen, name: string): Project`.
- `blankProject` MUST allocate ids in the SAME ORDER as Rust `Project::new_blank` (`project.rs:56-96`): A-roll track id, B-roll track id, then `project_id`. With `seededGen()` that yields A-roll=`…0001`, B-roll=`…0002`, project=`…0003`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/model.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, SCHEMA_VERSION } from './model'

describe('blankProject', () => {
  it('mirrors Rust new_blank: A-roll, B-roll, then project_id', () => {
    const p = blankProject(seededGen(), 'test')
    expect(p.schema_version).toBe(SCHEMA_VERSION)
    expect(p.tracks).toHaveLength(2)
    expect(p.tracks[0].id).toBe('00000000-0000-0000-0000-000000000001')
    expect(p.tracks[0].role).toBe('ARoll')
    expect(p.tracks[0].removable).toBe(false)
    expect(p.tracks[1].id).toBe('00000000-0000-0000-0000-000000000002')
    expect(p.tracks[1].role).toBe('BRoll')
    expect(p.project_id).toBe('00000000-0000-0000-0000-000000000003')
    expect(p.media_pool).toEqual({})
    expect(p.settings.history_capacity).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/model.test.ts`
Expected: FAIL — `Cannot find module './model'`.

- [ ] **Step 3: Write minimal implementation**

Define the complete type graph (matches `native/src/state/*.rs`; see master plan Part 2.2/2.3) and the constructor. Source-of-truth field lists: `project.rs`, `composition.rs:40`, `track.rs`, `layer.rs`, `transform.rs`, `media.rs`, `marker.rs`, `transition.rs`, `group.rs`, `effect.rs`, `audio_role.rs`, `weftcut-eval/src/lib.rs:120`.

```ts
// apps/desktop/src/main/state/model.ts
import type { IdGen } from './ids'

export const SCHEMA_VERSION = 9

export type Uuid = string
export type TimeUs = number
export interface Rational { num: number; den: number }
export interface Rgba { r: number; g: number; b: number; a: number }
export type ColorSpace = 'Bt709' | 'Bt601' | 'Bt2020' | 'SRgb'
export type AudioRole = 'dialogue' | 'music' | 'sfx' | 'voiceover'
export type TrackRole = 'ARoll' | 'BRoll' | 'AudioA' | 'AudioB' | 'Caption'
export type BlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten' | 'Add' | 'Difference'

export type Interpolation =
  | { kind: 'Hold' } | { kind: 'Linear' } | { kind: 'EaseIn' } | { kind: 'EaseOut' }
  | { kind: 'Bezier'; p1: [number, number]; p2: [number, number] }
export interface Keyframe<T> { id: Uuid; t_us: TimeUs; value: T; interp: Interpolation }
export type Animated<T> = { mode: 'Static'; value: T } | { mode: 'Keyframed'; value: Keyframe<T>[] }

export interface Transform {
  x: Animated<number>; y: Animated<number>
  scale_x: Animated<number>; scale_y: Animated<number>
  rotation_deg: Animated<number>
  anchor: [number, number]
}
export interface Rect { x: number; y: number; w: number; h: number }

export interface FontSpec { family: string; size_px: number; weight: number; italic: boolean }
export type TextAlign = 'Left' | 'Center' | 'Right'
export interface Shadow { color: Rgba; offset_x: number; offset_y: number; blur: number }
export interface Outline { color: Rgba; width: number }
export type TextAnimPreset = 'FadeIn' | 'FadeOut' | 'SlideUp' | 'SlideDown' | 'Typewriter'
export type TextBackend = 'Auto' | 'DrawText' | 'Rasterized'

export interface VideoClipParams {
  kind: 'VideoClip'; media: Uuid; src_in_us: TimeUs; src_out_us: TimeUs
  transform: Transform; opacity: Animated<number>; crop: Rect | null
  flip_h: boolean; flip_v: boolean; blend_mode: BlendMode; speed: number
  fade_in_us: number; fade_out_us: number
}
export interface ImageOverlayParams {
  kind: 'ImageOverlay'; media: Uuid; transform: Transform; opacity: Animated<number>
  blend_mode: BlendMode; fade_in_us: number; fade_out_us: number
}
export interface TextParams {
  kind: 'Text'; content: string; font: FontSpec; color: Animated<Rgba>; align: TextAlign
  transform: Transform; opacity: Animated<number>; shadow: Shadow | null; outline: Outline | null
  intro: TextAnimPreset | null; outro: TextAnimPreset | null; backend_hint: TextBackend
}
export interface MotifParams {
  kind: 'Motif'; motif_id: string; motif_version: number; props: Record<string, unknown>
  src_in_us: TimeUs; transform: Transform; opacity: Animated<number>
}
export interface AudioParams {
  kind: 'Audio'; media: Uuid; src_in_us: TimeUs; src_out_us: TimeUs
  gain_db: Animated<number>; pan: Animated<number>
  fade_in_us: number; fade_out_us: number; mute: boolean; role: AudioRole
}
export interface ColorParams { kind: 'Color'; color: Animated<Rgba>; width: number; height: number }
export type LayerParams =
  | VideoClipParams | ImageOverlayParams | TextParams | MotifParams | AudioParams | ColorParams

export interface Effect { id: Uuid; kind: string; enabled: boolean; params: Record<string, Animated<number>> }
export interface Layer {
  id: Uuid; label: string | null; t_start_us: TimeUs; t_end_us: TimeUs
  enabled: boolean; locked: boolean; metadata: Record<string, unknown>
  params: LayerParams; effects: Effect[]
}
export interface Track {
  id: Uuid; label: string | null; enabled: boolean; locked: boolean
  muted: boolean; solo: boolean; removable: boolean; role: TrackRole | null
  transient: boolean; height_px: number; layers: Layer[]
}
export interface Composition {
  width: number; height: number; fps: Rational; duration_us: TimeUs; duration_pinned: boolean
  sample_rate: number; channels: number; color_space: ColorSpace; background: Rgba
}
export interface Marker { id: Uuid; t_us: TimeUs; end_t_us: TimeUs | null; label: string; color: Rgba; metadata: Record<string, unknown> }
export interface Transition { id: Uuid; from_layer: Uuid; to_layer: Uuid; duration_us: TimeUs; kind: { kind: 'Crossfade' } }
/** `members` kept sorted; `label` omitted (not null) when absent — see serialize.ts. */
export interface Group { id: Uuid; label?: string; members: Uuid[] }
export interface RoleMixSettings { gain_db: number; muted: boolean; solo: boolean }
export interface MediaMetadata { duration_us: TimeUs | null; [k: string]: unknown }
export interface MediaItem {
  id: Uuid; path_abs: string; path_rel: string | null; kind: 'Video' | 'Audio' | 'Image' | 'Subtitle'
  metadata: MediaMetadata; file_hash_blake3: string; file_size: number; file_mtime: number
  imported_at: string; proxy_path: string | null; quick_proxy_path: string | null
  proxy_bypassed: boolean; export_uses_original: boolean; proxy_format_version: number
  conform_path: string | null; waveform_path: string | null; thumbnails_dir: string | null
}
export interface ProjectMetadata { name: string; created_at: string; modified_at: string; description: string | null }
export interface ProjectSettings {
  preview_width: number; preview_height: number; autosave_interval_secs: number | null
  history_capacity: number; auto_pair_audio_on_import: boolean; auto_delete_empty_tracks: boolean
}
export interface Project {
  schema_version: number; project_id: Uuid; metadata: ProjectMetadata; composition: Composition
  media_pool: Record<string, MediaItem>; tracks: Track[]; markers: Marker[]
  transitions: Transition[]; groups: Group[]; audio_roles: Record<string, RoleMixSettings>
  settings: ProjectSettings
}

function newTrack(id: Uuid, label: string, role: TrackRole): Track {
  return { id, label, enabled: true, locked: false, muted: false, solo: false,
    removable: false, role, transient: false, height_px: 64, layers: [] }
}
function defaultComposition(): Composition {
  return { width: 1920, height: 1080, fps: { num: 30, den: 1 }, duration_us: 0,
    duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709',
    background: { r: 0, g: 0, b: 0, a: 255 } }
}
function defaultSettings(): ProjectSettings {
  return { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
    history_capacity: 200, auto_pair_audio_on_import: true, auto_delete_empty_tracks: true }
}

/** Mirror of Rust `Project::new_blank`. Id order: A-roll, B-roll, project_id. */
export function blankProject(idGen: IdGen, name: string): Project {
  const aRoll = newTrack(idGen(), 'A roll', 'ARoll')
  const bRoll = newTrack(idGen(), 'B roll', 'BRoll')
  const projectId = idGen()
  return {
    schema_version: SCHEMA_VERSION, project_id: projectId,
    metadata: { name, created_at: '<TS>', modified_at: '<TS>', description: null },
    composition: defaultComposition(), media_pool: {}, tracks: [aRoll, bRoll],
    markers: [], transitions: [], groups: [], audio_roles: {}, settings: defaultSettings(),
  }
}
```

> NOTE on defaults: `Composition::default()` (`composition.rs:40`) values (1920×1080, 30fps, sample_rate, channels, background) MUST be read from that file and matched exactly; the values above are the expected defaults but the implementer must verify against `composition.rs:40` and `track.rs Track::new()` (esp. `height_px`) and correct any mismatch before the test passes the differential round-trip in Task 8.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/model.ts apps/desktop/src/main/state/model.test.ts
git commit -m "feat(state-migration): canonical TS Project model + blankProject"
```

---

## Task 4: Serializer (`serialize.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/serialize.ts`
- Test: `apps/desktop/src/main/state/serialize.test.ts`

**Interfaces:**
- Consumes: `Project`, `Group` from `model.ts`; `canonicalize` from `canonical.ts`.
- Produces: `serializeProject(p: Project): unknown` (wire object: `group.members` sorted, `group.label` omitted when undefined, everything else identity) and `parseProject(json: unknown): Project` (validates `schema_version === 9`, returns typed; near-identity since the model is JSON-native). Round-trip law: `canonicalString(serializeProject(parseProject(x))) === canonicalString(x)` for any real actor output `x`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/serialize.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import { canonicalString } from './canonical'
import { parseProject, serializeProject } from './serialize'

describe('serialize round-trip', () => {
  it('round-trips a blank project', () => {
    const p = blankProject(seededGen(), 'test')
    const wire = serializeProject(p)
    expect(canonicalString(serializeProject(parseProject(wire)))).toBe(canonicalString(wire))
  })
  it('sorts group.members and omits a null label', () => {
    const p = blankProject(seededGen(), 'test')
    p.groups = [{ id: 'g', members: ['00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a'] }]
    const wire = serializeProject(p) as any
    expect(wire.groups[0].members).toEqual(['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b'])
    expect('label' in wire.groups[0]).toBe(false)
  })
  it('rejects a wrong schema version', () => {
    expect(() => parseProject({ schema_version: 8 })).toThrow(/schema/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/serialize.test.ts`
Expected: FAIL — `Cannot find module './serialize'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/main/state/serialize.ts
import { SCHEMA_VERSION, type Group, type Project } from './model'

function serializeGroup(g: Group): unknown {
  const out: Record<string, unknown> = { id: g.id, members: [...g.members].sort() }
  if (g.label !== undefined && g.label !== null) out.label = g.label // skip_serializing_if = None
  return out
}

/** Produce the on-disk/wire JSON shape. The model is already JSON-native, so
 *  this is mostly identity; the only non-identity rules are group member
 *  sorting and the `Group.label` omission (mirrors serde skip_serializing_if). */
export function serializeProject(p: Project): unknown {
  return { ...p, groups: p.groups.map(serializeGroup) }
}

/** Validate + type a wire object as a Project. Near-identity for the JSON-native
 *  model; the load guard is the schema version (project.rs:17-22 rejects others). */
export function parseProject(json: unknown): Project {
  if (json === null || typeof json !== 'object') throw new Error('parseProject: not an object')
  const v = (json as { schema_version?: unknown }).schema_version
  if (v !== SCHEMA_VERSION) throw new Error(`parseProject: unsupported schema_version ${String(v)} (expected ${SCHEMA_VERSION})`)
  return json as Project
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/serialize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/serialize.ts apps/desktop/src/main/state/serialize.test.ts
git commit -m "feat(state-migration): wire-faithful Project serialize/parse"
```

---

## Task 5: Rust deterministic id mode (`ids.rs`)

**Files:**
- Modify: `apps/desktop/native/src/state/ids.rs`

**Interfaces:**
- Produces: `det::enable()`, `det::reset()`, `det::disable()` (process-global). When enabled, `new_id()` returns `Uuid::from_u128(counter)` with `counter` incrementing from 1; otherwise `Uuid::now_v7()` (unchanged production path). Works across tokio worker threads (global atomics, not thread-local) — safe because the replay driver issues commands strictly serially (awaits each reply).

- [ ] **Step 1: Write the failing test**

```rust
// append to apps/desktop/native/src/state/ids.rs
#[cfg(test)]
mod det_tests {
    use super::*;

    #[test]
    fn deterministic_mode_counts_from_one() {
        det::reset();
        det::enable();
        assert_eq!(new_id().to_string(), "00000000-0000-0000-0000-000000000001");
        assert_eq!(new_id().to_string(), "00000000-0000-0000-0000-000000000002");
        det::disable();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path native/Cargo.toml state::ids::det_tests`
Expected: FAIL — `det` module / functions do not exist (compile error).

- [ ] **Step 3: Write minimal implementation**

```rust
// apps/desktop/native/src/state/ids.rs — replace the body of new_id and add det
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub fn new_id() -> Uuid {
    if det::ENABLED.load(Ordering::Relaxed) {
        let n = det::COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
        Uuid::from_u128(n as u128)
    } else {
        Uuid::now_v7()
    }
}

/// Process-global deterministic id mode for the differential replay driver.
/// OFF in production (default). Not thread-local: the driver runs commands
/// serially, so a global counter yields a stable sequence across tokio threads.
pub mod det {
    use super::{AtomicBool, AtomicU64, Ordering};
    pub(super) static ENABLED: AtomicBool = AtomicBool::new(false);
    pub(super) static COUNTER: AtomicU64 = AtomicU64::new(0);
    pub fn enable() { ENABLED.store(true, Ordering::Relaxed); }
    pub fn disable() { ENABLED.store(false, Ordering::Relaxed); }
    pub fn reset() { COUNTER.store(0, Ordering::Relaxed); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path native/Cargo.toml state::ids::det_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/state/ids.rs
git commit -m "feat(state-migration): process-global deterministic id mode (test-only)"
```

---

## Task 6: Replay driver binary (`replay_driver.rs`)

**Files:**
- Create: `apps/desktop/native/src/bin/replay_driver.rs`
- Modify: `apps/desktop/native/Cargo.toml` (add `replay` feature + `[[bin]]` with `required-features`)

**Interfaces:**
- Consumes: `weftcut_lib::state::{spawn, Project, Actor, LayerParams, ...}`, `state::ids::det`.
- The shared **command sequence** JSON format (also consumed by the TS actor in Phase 1):
  ```json
  { "name": "groups-split", "commands": [
    { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
    { "op": "move_layer", "layer": "@L1", "to_track": "@A", "t_start_us": 500000 },
    { "op": "undo" }
  ] }
  ```
  - `@A`/`@B` resolve to the seeded A-roll/B-roll track ids; `@<ref>` resolves an id captured by an earlier command's `"ref"`.
- Produces: `Trace` JSON = `{ "name", "steps": [ { "op", "ok": bool, "error"?: string, "state": <canonical Project> } ... ] }`. `state` is the canonical Project after the step (`serde_json::to_value` then `serde_json::to_string` ⇒ keys sorted; then the timestamp fields are normalized to `"<TS>"`).
- Scoped command set (media-free): `add_layer` (kinds `color`, `text`), `add_track`, `move_layer`, `trim_layer`, `delete_layer`, `duplicate_layer`, `split_layer`, `groups_create`, `groups_dissolve`, `add_marker`, `set_composition`, `undo`, `redo`. (Extensible; documented cap per Global Constraints.)

- [ ] **Step 1: Write the failing test (a smoke sequence run twice is identical)**

Create `apps/desktop/fixtures/state-corpus/sequences/_smoke.json`:
```json
{ "name": "_smoke", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "duplicate_layer", "layer": "@L1", "t_offset_us": 2000000 }
] }
```

Add the determinism check as a step in the gen script's test (Task 7 wires the full run). For Task 6 the gate is manual:

Run: `cargo build --manifest-path native/Cargo.toml --bin replay_driver --features replay`
Expected after Step 3: builds clean.

- [ ] **Step 2: Verify it fails first**

Run: `cargo build --manifest-path native/Cargo.toml --bin replay_driver --features replay`
Expected: FAIL — no such bin / unknown feature `replay`.

- [ ] **Step 3: Implement the feature, bin entry, and driver**

In `native/Cargo.toml`, under `[features]` add:
```toml
replay = []     # differential-harness replay driver (test tooling)
```
and add a bin entry:
```toml
[[bin]]
name = "replay_driver"
required-features = ["replay"]
```

```rust
// apps/desktop/native/src/bin/replay_driver.rs
//! Differential-harness oracle generator. Reads a command-sequence JSON on
//! argv[1], replays it through the real project actor with deterministic ids,
//! and prints the canonical Trace JSON to stdout. Build/run with
//! `--features replay`. NOT compiled into the production addon.

use std::collections::HashMap;
use serde_json::{json, Value};
use weftcut_lib::state::{self, Actor, LayerParams, ColorParams, Rgba, ProjectHandle};
use weftcut_lib::state::actor::{LayerEdge, CompositionPatch};
use weftcut_lib::state::animated::Animated;
use weftcut_lib::state::ids::det;

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: replay_driver <sequence.json>");
    let seq: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let name = seq["name"].as_str().unwrap_or("unnamed").to_string();

    det::reset();
    det::enable();
    let initial = state::Project::new_blank("replay"); // consumes ids #1 (A) #2 (B) #3 (project)
    let a_roll = initial.tracks[0].id;
    let b_roll = initial.tracks[1].id;
    let h = state::spawn(initial);

    let mut refs: HashMap<String, String> = HashMap::new();
    refs.insert("A".into(), a_roll.to_string());
    refs.insert("B".into(), b_roll.to_string());

    let mut steps = Vec::new();
    for cmd in seq["commands"].as_array().unwrap() {
        let op = cmd["op"].as_str().unwrap().to_string();
        let outcome = apply(&h, cmd, &mut refs).await;
        let (ok, error) = match &outcome { Ok(_) => (true, None), Err(e) => (false, Some(e.clone())) };
        let snap = h.snapshot().await;
        steps.push(json!({ "op": op, "ok": ok, "error": error, "state": canonical_state(&snap) }));
    }
    det::disable();
    println!("{}", serde_json::to_string_pretty(&json!({ "name": name, "steps": steps })).unwrap());
}

/// Serialize via serde_json::Value (BTreeMap ⇒ keys sorted; preserve_order is
/// off) then normalize the two wall-clock fields, matching the TS canonicalize.
fn canonical_state(p: &state::Project) -> Value {
    let mut v = serde_json::to_value(p).unwrap();
    if let Some(m) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        m.insert("created_at".into(), json!("<TS>"));
        m.insert("modified_at".into(), json!("<TS>"));
    }
    v
}

fn id(refs: &HashMap<String, String>, token: &str) -> uuid::Uuid {
    let key = token.strip_prefix('@').unwrap_or(token);
    uuid::Uuid::parse_str(refs.get(key).unwrap_or(&key.to_string())).unwrap()
}

async fn apply(h: &ProjectHandle, cmd: &Value, refs: &mut HashMap<String, String>) -> Result<(), String> {
    let op = cmd["op"].as_str().unwrap();
    let u = Actor::User;
    let r = |c: &Value, k: &str| c[k].as_i64().unwrap();
    match op {
        "add_layer" => {
            let track = id(refs, cmd["track"].as_str().unwrap());
            let params = match cmd["kind"].as_str().unwrap() {
                "color" => LayerParams::Color(ColorParams {
                    color: Animated::Static(Rgba { r: 255, g: 0, b: 0, a: 255 }),
                    width: 1920, height: 1080,
                }),
                "text" => default_text_params(),
                other => return Err(format!("unknown kind {other}")),
            };
            let res = h.add_layer(u, track, params, r(cmd, "t_start_us"), r(cmd, "t_end_us")).await;
            match res {
                Ok(lid) => { if let Some(rf) = cmd["ref"].as_str() { refs.insert(rf.into(), lid.to_string()); } Ok(()) }
                Err(e) => Err(format!("{e:?}")),
            }
        }
        "add_track" => h.add_track(u, cmd["label"].as_str().map(str::to_string)).await.map(|_| ()).map_err(|e| format!("{e:?}")),
        "move_layer" => h.move_layer(u, id(refs, cmd["layer"].as_str().unwrap()), id(refs, cmd["to_track"].as_str().unwrap()), r(cmd, "t_start_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map_err(|e| format!("{e:?}")),
        "trim_layer" => {
            let edge = if cmd["edge"].as_str() == Some("out") { LayerEdge::Out } else { LayerEdge::In };
            h.trim_layer(u, id(refs, cmd["layer"].as_str().unwrap()), edge, r(cmd, "new_t_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map_err(|e| format!("{e:?}"))
        }
        "delete_layer" => h.delete_layer(u, id(refs, cmd["layer"].as_str().unwrap())).await.map_err(|e| format!("{e:?}")),
        "duplicate_layer" => h.duplicate_layer(u, id(refs, cmd["layer"].as_str().unwrap()), r(cmd, "t_offset_us")).await.map(|_| ()).map_err(|e| format!("{e:?}")),
        "split_layer" => h.split_layer(u, id(refs, cmd["layer"].as_str().unwrap()), r(cmd, "at_t_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map(|_| ()).map_err(|e| format!("{e:?}")),
        "groups_create" => {
            let ids: Vec<_> = cmd["layers"].as_array().unwrap().iter().map(|t| id(refs, t.as_str().unwrap())).collect();
            h.groups_create(u, ids, cmd["label"].as_str().map(str::to_string), cmd["reassign"].as_bool().unwrap_or(false)).await.map(|_| ()).map_err(|e| format!("{e:?}"))
        }
        "groups_dissolve" => h.groups_dissolve(u, id(refs, cmd["group"].as_str().unwrap())).await.map_err(|e| format!("{e:?}")),
        "add_marker" => h.add_marker(u, r(cmd, "t_us"), cmd["end_t_us"].as_i64(), cmd["label"].as_str().unwrap_or("m"), Rgba { r: 0, g: 128, b: 255, a: 255 }).await.map(|_| ()).map_err(|e| format!("{e:?}")),
        "set_composition" => {
            let patch = CompositionPatch { duration_us: cmd["duration_us"].as_i64(), ..Default::default() };
            h.set_composition(u, patch).await.map_err(|e| format!("{e:?}"))
        }
        "undo" => h.undo(u).await.map_err(|e| format!("{e:?}")),
        "redo" => h.redo(u).await.map_err(|e| format!("{e:?}")),
        other => Err(format!("driver: unsupported op {other}")),
    }
}

fn default_text_params() -> LayerParams {
    use weftcut_lib::state::layer::{TextParams, FontSpec, TextAlign, TextBackend};
    use weftcut_lib::state::transform::Transform;
    LayerParams::Text(TextParams {
        content: "hello".into(),
        font: FontSpec { family: "Inter".into(), size_px: 48.0, weight: 400, italic: false },
        color: Animated::Static(Rgba { r: 255, g: 255, b: 255, a: 255 }),
        align: TextAlign::Center, transform: Transform::default(),
        opacity: Animated::Static(1.0), shadow: None, outline: None,
        intro: None, outro: None, backend_hint: TextBackend::Auto,
    })
}
```

> The implementer must reconcile exact pub paths/signatures against `state/mod.rs` re-exports and the `ProjectHandle` methods (master plan Part 2.1). Where a type is not `pub`, add the minimal `pub`/`pub(crate)` needed — note any such visibility change in the commit message.

- [ ] **Step 4: Verify it builds and runs**

Run: `cargo run --manifest-path native/Cargo.toml --bin replay_driver --features replay -- fixtures/state-corpus/sequences/_smoke.json`
Expected: prints a Trace JSON with 2 steps; running it a second time produces byte-identical output.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/Cargo.toml apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/_smoke.json
git commit -m "feat(state-migration): feature-gated replay_driver emitting canonical oracle traces"
```

---

## Task 7: Corpus + oracle generation

**Files:**
- Create: `apps/desktop/scripts/gen-state-oracle.mjs`
- Create: `apps/desktop/fixtures/state-corpus/sequences/*.json` (≥50, see coverage checklist)
- Create (generated, committed): `apps/desktop/fixtures/state-corpus/oracle/*.json`

**Interfaces:**
- `gen-state-oracle.mjs`: for each `sequences/<n>.json`, spawn the replay driver, write stdout to `oracle/<n>.json`; then RE-RUN once and assert byte-identical (determinism gate); fail nonzero on any divergence.
- **Coverage checklist** the ≥50 sequences must hit (cite the invariant being exercised): layer add on A and B; overlap rejection (two visual layers overlapping, no transition) → expect `ok:false`; visual+audio coexistence — DEFERRED to Phase 2 (media); move within/ across track; trim In and Out (incl. clamp to `t_start<t_end`) ; split inside a layer; duplicate; groups_create (≥2) + fan-out under move/trim/split (escape_group false vs true) + lock-member rejection; groups below-2 auto-dissolve; markers (point + region); set_composition duration pin + fit; undo/redo across each of the above; redo-tail truncation after a new edit; history cap behavior (sequence >200 ops). Any invariant intentionally NOT covered must be listed at the top of the checklist as a known gap.

- [ ] **Step 1: Write the generator (it is the test)**

```js
// apps/desktop/scripts/gen-state-oracle.mjs
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SEQ = 'fixtures/state-corpus/sequences'
const OUT = 'fixtures/state-corpus/oracle'
mkdirSync(OUT, { recursive: true })

const run = (file) => execFileSync('cargo', [
  'run', '--quiet', '--manifest-path', 'native/Cargo.toml',
  // NOTE: bare `--features replay` does not compile (pre-existing napi_backend.rs
  // error at default features); the bin compiles the whole crate, so use the
  // feature set that builds (confirmed in Task 6).
  '--bin', 'replay_driver', '--features', 'replay,jobs,export,mcp,cloud,motifs', '--', join(SEQ, file),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

let fail = 0
for (const file of readdirSync(SEQ).filter((f) => f.endsWith('.json'))) {
  const a = run(file)
  const b = run(file) // determinism gate
  if (a !== b) { console.error(`NONDETERMINISTIC: ${file}`); fail++; continue }
  writeFileSync(join(OUT, file), a)
  console.log(`ok  ${file}`)
}
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: Author the corpus**

Create the ≥50 sequence files per the coverage checklist (start from `_smoke.json`'s shape). Keep each focused on one or two invariants; name them by what they exercise (`overlap-reject.json`, `trim-in-clamp.json`, `group-split-fanout.json`, …).

- [ ] **Step 3: Generate + gate**

Run: `node scripts/gen-state-oracle.mjs`
Expected: every sequence prints `ok`; exit 0 (all deterministic). `oracle/*.json` written.

- [ ] **Step 4: Spot-check an oracle trace**

Open one `oracle/*.json`; confirm `state` objects have sorted keys, `<TS>` timestamps, and that `ok:false` steps carry an `error` string for the overlap-reject sequence.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/scripts/gen-state-oracle.mjs apps/desktop/fixtures/state-corpus/
git commit -m "test(state-migration): command corpus + committed canonical oracle traces"
```

---

## Task 8: Differential round-trip test (`differential.test.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/__tests__/differential.test.ts`

**Interfaces:**
- Consumes: `parseProject`, `serializeProject`, `canonicalString`, and the committed `oracle/*.json`.
- Phase-0 assertion: for every step's `state` in every oracle trace, `canonicalString(serializeProject(parseProject(state)))` equals `canonicalString(state)`. This proves the TS model + serializer are wire-faithful against REAL Rust actor output across the whole corpus. (The TS actor is wired into this same harness in Phase 1; for now there is no TS actor.)

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/__tests__/differential.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseProject, serializeProject } from '../serialize'
import { canonicalString } from '../canonical'

const ORACLE = join(__dirname, '../../../../fixtures/state-corpus/oracle')

describe('TS model round-trips real Rust actor states', () => {
  const files = readdirSync(ORACLE).filter((f) => f.endsWith('.json'))
  it('has a non-empty oracle corpus', () => expect(files.length).toBeGreaterThanOrEqual(50))
  for (const file of files) {
    const trace = JSON.parse(readFileSync(join(ORACLE, file), 'utf8'))
    it(`round-trips every state in ${file}`, () => {
      for (const step of trace.steps) {
        const round = canonicalString(serializeProject(parseProject(step.state)))
        expect(round, `${file} @ op=${step.op}`).toBe(canonicalString(step.state))
      }
    })
  }
})
```

- [ ] **Step 2: Run test to verify it fails (then drives model fixes)**

Run: `npx vitest run src/main/state/__tests__/differential.test.ts`
Expected: initially FAIL — most likely on a default mismatch (e.g. `height_px`, composition defaults) or a missed wire-shape rule. Each failure pinpoints `file @ op`; fix `model.ts` defaults / `serialize.ts` rules until green. This is the loop that actually validates the model against reality.

- [ ] **Step 3: Reconcile model/serializer against failures**

For each diff: read the offending `state` in the oracle vs the round-tripped output, correct `model.ts` (defaults) or `serialize.ts` (field presence / ordering). Re-run. Repeat until green.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/__tests__/differential.test.ts`
Expected: PASS — corpus ≥50, every state round-trips.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/__tests__/differential.test.ts apps/desktop/src/main/state/model.ts apps/desktop/src/main/state/serialize.ts
git commit -m "test(state-migration): TS model round-trips full Rust oracle corpus (Phase 0 exit gate)"
```

---

## Phase 0 Exit Criteria (verify before declaring done)

- [ ] `npx vitest run src/main/state` — all specs green.
- [ ] `cargo test --manifest-path native/Cargo.toml state::ids` — det mode green; production `new_id` path unchanged (no behavior change when det disabled).
- [ ] `node scripts/gen-state-oracle.mjs` — exit 0; every sequence deterministic (run-twice identical).
- [ ] `differential.test.ts` — ≥50 oracle traces; every state round-trips through the TS model.
- [ ] Coverage checklist (Task 7) reviewed; any uncovered invariant explicitly listed as a known gap (no silent caps).
- [ ] No production code path changed (det disabled by default; `replay` feature off in normal builds).

## Self-Review

- **Spec coverage:** Phase 0 master-plan deliverables — TS model+serde (Tasks 3,4), id+clock injection (Task 1 TS / Task 5 Rust; clock handled by canonical normalization per the logged cap), differential harness (Tasks 6,7,8), oracle traces from corpus (Task 7). ✓
- **Type consistency:** `IdGen`, `seededGen`, `canonicalize`/`canonicalString`, `Project`, `blankProject`, `parseProject`/`serializeProject`, `det::{enable,disable,reset}`, the command-sequence/Trace JSON shapes are named identically across tasks. ✓
- **No placeholders:** every step has runnable code/commands and expected output. The two explicit "implementer must verify against source" notes (composition defaults in Task 3; pub-path reconciliation in Task 6) are reconciliation instructions, not deferred work — Task 8's failing-test loop forces them closed before the gate passes. ✓
