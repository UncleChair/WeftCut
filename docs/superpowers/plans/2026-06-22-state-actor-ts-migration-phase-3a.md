# State-Actor TS Migration — Phase 3a Plan (renderer read-view: `buildProjectSummary`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the FIRST slice of **Phase 3** of the master plan `2026-06-22-state-actor-ts-migration.md` (§Phase 3). Read the **Phase-2b-vi plan** (`…-phase-2b-vi.md`) first — it established the per-slice oracle-regen workflow (extend the Rust `replay_driver` → regen oracles additively → differential-gate) and the env/toolchain this slice reuses. Phases 0–2b-vi are DONE on local `main` (corpus = **157 sequences / 157 state oracles**; `differential.phase2.test.ts` runs all 157 with `skipped === []`).

> **SCOPE (decided 2026-06-22):** Port the **renderer read-view** — the `ProjectSummary` IPC view the renderer's `projectStore` pulls on `project:changed` (`commands/query.rs:project_summary` → `commands/mod.rs:build_project_summary`). This is a SEPARATE serializer from the `.vproj` `serializeProject` the TS actor already has: it is the **kebab-`TrackRole`** UI view, derives per-track `kind`/per-layer `color_hint`, surfaces `HistoryView` (cursor/len/can_undo/can_redo/lock_reason), and emits all four audio roles in canonical order with defaults filled. It is differential-gated against the Rust oracle over the existing 157-seq corpus via a NEW summary-emission mode on `replay_driver` writing to a NEW `oracle-summary/` dir (the existing state oracles stay byte-identical). **This slice does NO live wiring** — `summary.ts` is a pure builder; the actual cutover (creating the TS actor in main, routing `backend:invoke`, emitting `project:changed`) is Phase 3c. **OUT OF SCOPE:** persistence/`replace_state` (3b), autosave + jobs-callback re-point (3c), MCP handler port (3d+).

**Goal:** Add `src/main/state/summary.ts` — a pure `buildProjectSummary(project, historyStatus, fileExists)` that reproduces `commands::build_project_summary` byte-for-byte (canonically), plus all its helpers (`deriveTrackKindLabel`, `layerKind`, `layerColorHint`/`hslToHex`, `mediaLabel`, `markerColorHint`, `layerParamsView` for all 6 param kinds, the canonical audio-role fill) — and gate it differentially over the full corpus.

**Architecture:** Same proven methodology as every 2b slice — a pure TS function mirrors the authoritative Rust, gated by replaying the corpus through both. The Rust `replay_driver` gains a `REPLAY_EMIT=summary` mode that, per step, emits `build_project_summary(snapshot, history_status)` (instead of the canonical `.vproj` state) into a separate oracle set; the TS gate replays the same corpus through the (existing) TS actor, builds the TS summary per step via `actor.snapshot()` + `actor.historyStatus()`, and asserts canonical-JSON equality. Because the read-view's field NAMES come from Rust serde (not the wire round-trip), this gate is also a strong field-name-drift check for the read-view (closes the Phase-1 carry-forward (a) gap for the summary surface).

**Tech Stack:** TypeScript, Vitest, the existing TS actor (`createActor`, `ActorHandle.snapshot()`/`historyStatus()`), the Rust `replay_driver` bin + `gen-state-oracle.mjs` (needs the cargo/ffmpeg toolchain). No Immer/mutation changes — `summary.ts` is read-only over a frozen snapshot. The wasm eval leaf is untouched (the summary ships `Animated<T>` tracks verbatim; per-frame resolution stays in the renderer).

## Global Constraints

- **The oracle-regeneration toolchain (verified working through 2b-vi).** Regenerating oracles builds `replay_driver` (compiles the native crate incl. ffmpeg-next). Set these env vars before any `cargo`/regen, then run from `apps/desktop/`:
  ```bash
  export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
  export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
  export PATH="$FFMPEG_DIR/bin:$PATH"
  node scripts/gen-state-oracle.mjs   # builds replay_driver, runs each sequence; now ALSO writes oracle-summary/
  ```
  The build feature set is baked into `gen-state-oracle.mjs` (`--features replay,jobs,export,mcp,cloud,motifs`; bare `replay` fails on a pre-existing `napi_backend.rs` error).
- **★ ADDITIVITY (the load-bearing safety constraint).** This slice changes `replay_driver` ONLY by adding a NEW emission mode keyed on the `REPLAY_EMIT` env var; the **default (state) mode must be byte-unchanged**. After Task 3's regen, the **157 pre-existing `fixtures/state-corpus/oracle/*.json` must be byte-identical** and a NEW `fixtures/state-corpus/oracle-summary/` dir appears with 157 files. Verify with `git status --short fixtures/state-corpus/oracle/` (must show NOTHING — no `M`, no `??`) and `git status --short fixtures/state-corpus/oracle-summary/` (157 new `??`). If any `oracle/*.json` shows `M`, STOP — the default mode wasn't preserved; investigate before continuing.
- **★ COLOR-HINT f32 LANDMINE — neutralized by det-mode UUIDs; gated only at hue 0.** `layer_color_hint` (commands/mod.rs:629) computes a stable hue from the layer UUID's first two bytes: `((bytes[0]<<8 | bytes[1]) % 360)`, then `hsl_to_hex(hue as f32, 0.55, 0.55)` (f32 math). In det mode every layer id is `Uuid::from_u128(N)` → bytes `[0,0,…,N]`, so `bytes[0]=bytes[1]=0` → **hue is ALWAYS 0** → the hint is the single constant `#cb4d4d` (hand-derived; confirmed by the gate). So the f32-vs-f64 divergence the captions slice warned about can only manifest at hues the corpus never reaches. **Mitigation:** unit-test `hslToHex(0,0.55,0.55) === '#cb4d4d'`; the differential gate confirms it across all non-Color layers. Production (real uuidv7) DOES exercise other hues where f32/f64 may differ by ±1 in a channel — this is **cosmetic-only** (a timeline-block tint, never persisted, never a correctness property), so it is deliberately NOT differential-gated and TS implements the math in plain f64. Do NOT emulate f32 (Math.fround) — it would serialize the f64-expansion of the f32 and be no closer. Color LAYERS use their exact `ColorParams` rgba (integers) → always safe.
- **★ FILESYSTEM FIELDS — inject a `fileExists` predicate.** `MediaSummary.available` = `path_abs.is_file()`, and `proxy_path`/`quick_proxy_path`/`conform_path` are `Some(p).filter(is_file)` (commands/mod.rs:341-362). These are filesystem-dependent, hence non-deterministic for a pure unit/differential test. `buildProjectSummary` takes a **required** `fileExists: (absPath: string) => boolean` parameter; the gate + unit tests pass `() => false`. The oracle's fixture media all use `path_abs:"media/clip.bin"` (non-existent relative to the cargo cwd `apps/desktop`) so the Rust side computes `available:false` and the proxy/quick/conform paths are `null` in `mediaItemTemplate` anyway → both sides agree on `false`/`null`. Phase 3c's caller wires the real `fs.existsSync(p) && fs.statSync(p).isFile()` predicate.
- **★ AUDIO-ROLE CANONICAL FILL.** The view ALWAYS emits all four roles in `AudioRole::ALL` order — `['dialogue','music','sfx','voiceover']` (kebab, `audio_role.rs`) — with `RoleMixSettings` defaults `{gain_db:0,muted:false,solo:false}` filled when absent (commands/mod.rs:446). The TS `audio_roles` record is sparse + kebab-keyed; iterate the fixed order, default-fill per role.
- **★ MEDIA SORT — descending by id string.** `media.sort_by(|a,b| b.id.cmp(&a.id))` (commands/mod.rs:378) = lexicographic DESCENDING on the id STRING. TS: `media.sort((a,b)=> a.id < b.id ? 1 : a.id > b.id ? -1 : 0)`.
- **`HistoryView` is the ONLY differential coverage of `History.status()`.** cursor/len/can_undo/can_redo/lock_reason are actor-internal (not in `serializeProject`), so the summary gate is the first/only mechanical check that TS `History.status()` matches Rust `history_status()` across undo/redo. Per-step emission (not final-only) preserves this.
- **The Motif arm of `layerParamsView` is unit-tested only** (no Motif layers in the corpus — Motif `update_layer_params` is deferred), exactly as the Rust Motif arm is. Every other arm (VideoClip/ImageOverlay/Text/Color/Audio) IS corpus-exercised.
- **Field-name fidelity = mirror the Rust serde names EXACTLY** (these view structs carry NO `#[serde(rename_all)]`, so fields serialize verbatim snake_case: `project_id`, `track_count`, `layer_count`, `duration_us`, `color_hint`, `t_start_us`, `t_end_us`, `font_family`, `font_size_px`, `anchor_x`/`anchor_y`, `media_id`, `media_label`, `src_in_us`, `fade_in_us`, …). `LayerParamsView` is `#[serde(tag="kind")]` → `{"kind":"VideoClip", …fields}`. The renderer's existing TS interfaces in `src/renderer/ipc/index.ts` (`ProjectSummary`/`TrackSummary`/`LayerSummary`/`LayerParamsView`/the 6 `*View`s/`MediaSummary`/`CompositionSummary`/`HistoryView`/`RoleMixView`/`GroupSummary`/`MarkerSummary`) are the type contract to match name-for-name. Re-declare them in `summary.ts` (a shared single definition is a Phase-4 unification, NOT this slice — main importing renderer types crosses the project boundary).
- **TimeUs is `number`.** `i64` µs fits in `number`. Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `git add` by **explicit path only** (parallel sessions — feedback_parallel_sessions_git). Work on local `main`; do NOT push. TDD, frequent commits, DRY, YAGNI.

### Reference Rust sources (cite; re-read only if a differential step diverges)

- **The view builder:** `build_project_summary` (commands/mod.rs:322-485) + helpers `layer_params_view` (487-584), `layer_kind` (586-596), `derive_track_kind_label` (607-627), `layer_color_hint` (629-645), `hsl_to_hex` (647-665). View structs: `ProjectSummary` (41), `GroupSummary` (65), `MarkerSummary` (72), `TrackSummary` (84), `LayerSummary` (115), `LayerParamsView` (139, `tag="kind"`), `MotifView`/`VideoClipView`/`ImageOverlayView`/`TextView`/`ColorView`/`AudioView`/`RoleMixView` (150-246), `MediaSummary` (248), `CompositionSummary` (296), `HistoryView` (307, `lock_reason` `skip_serializing_if=Option::is_none`).
- **The command path (for the driver):** `project_summary` (query.rs:8-13) = `handle.snapshot().await` + `handle.history_status().await` → `build_project_summary(&snap, &history)`. `history_status` is `pub async fn` (actor.rs:869) returning `state::HistoryStatus`.
- **Role canonical order:** `AudioRole::ALL` + `as_str()` (audio_role.rs) — `[Dialogue, Music, Sfx, Voiceover]` → `dialogue/music/sfx/voiceover`. `Project::role_mix(role)` (project.rs:99) default-fills.
- **The harness:** `replay_driver.rs` `main()` loop (16-46) + `canonical_state` (50-57); `gen-state-oracle.mjs` (run-twice determinism gate, writes `oracle/`); `differential.phase2.test.ts` (the comparison pattern). `lib.rs:17` `mod commands;` (private) + `lib.rs:54` `pub mod state; // …consumed by the replay_driver…` (the precedent for the visibility comment).
- **TS pieces already in place:** `createActor`/`ActorHandle.snapshot()`/`historyStatus()` (actor.ts:44-53,329); `History.status()` → `HistoryStatus {cursor,len,can_undo,can_redo,lock_reason?}` (history.ts:23,162); `canonicalize` (canonical.ts); `serializeProject` (serialize.ts); `replaySequence`/`buildArgs`/`resolve`/`sequenceIsSupported` (replay.ts); `seededGen`/`blankProject`/`mediaItemTemplate` (ids.ts/model.ts/mutations/media.ts); model types `Project`/`Track`/`Layer`/`LayerParams`/`Animated`/`Rgba`/`MediaItem`/`Marker`/`Group`/`Effect`/`TextAlign`/`Shadow`/`Outline`/`RoleMixSettings` (model.ts).

---

## File Structure

All paths under `apps/desktop/`. Vitest from `apps/desktop/` (`npx vitest run <path>`).

| Path | Responsibility | New/Mod |
|---|---|---|
| `src/main/state/summary.ts` | The 6 `*View` structs + `LayerParamsView`; pure helpers `layerKind`/`deriveTrackKindLabel`/`layerColorHint`/`hslToHex`/`mediaLabel`/`markerColorHint`/`layerParamsView` (Task 1); the top-level view types + `buildProjectSummary` assembler (Task 2). | **New** |
| `src/main/state/summary.test.ts` | Unit tests: helpers (Task 1); blank + built-project full summary (Task 2). | **New** |
| `native/src/commands/mod.rs` | `pub(crate) fn build_project_summary` → `pub fn`. | Mod |
| `native/src/lib.rs` | `pub use commands::build_project_summary;` re-export (bin reach). | Mod |
| `native/src/bin/replay_driver.rs` | `REPLAY_EMIT=summary` mode + `canonical_summary()`. | Mod |
| `scripts/gen-state-oracle.mjs` | also generate `oracle-summary/` (REPLAY_EMIT=summary), determinism-gated. | Mod |
| `fixtures/state-corpus/oracle-summary/*.json` | 157 regenerated summary oracle traces (generated). | **New (generated)** |
| `src/main/state/replay.ts` | `replaySummaries(seq)` (shared `runSequence` refactor). | Mod |
| `src/main/state/__tests__/summary.differential.test.ts` | THE GATE: TS summary === Rust summary oracle, full corpus. | **New** |
| `fixtures/state-corpus/README.md` | note the `oracle-summary/` dir + Phase-3a coverage. | Mod |

> Task 3 is the only Rust/oracle task; Tasks 1–2 are pure-TS (unit-gated); Task 4 is the differential gate (needs both the oracle from Task 3 and the builder from Tasks 1–2).

---

## Task 1: `summary.ts` pure helpers + the 6 `*View` types

**Files:**
- Create: `src/main/state/summary.ts`
- Test: `src/main/state/summary.test.ts`

**Interfaces:**
- Produces:
  - View types `VideoClipView`/`ImageOverlayView`/`TextView`/`ColorView`/`AudioView`/`MotifView` and the tagged union `LayerParamsView` (discriminant `kind`).
  - `layerKind(params: LayerParams): string` — the `LayerParams` discriminant ("VideoClip"/"ImageOverlay"/"Text"/"Motif"/"Audio"/"Color").
  - `deriveTrackKindLabel(track: Track): string` — "Video" if any visual-class layer, else "Audio" if audio-only, else "Video" (empty).
  - `layerColorHint(layer: Layer): string` — Color layer → its rgba hex; else `hslToHex` of the uuid-derived hue.
  - `markerColorHint(c: Rgba): string` — `#rrggbb`.
  - `mediaLabel(item: MediaItem): string` — `label ?? basename(path_abs) ?? path_abs`.
  - `layerParamsView(params: LayerParams, pool: Record<Uuid, MediaItem>): LayerParamsView`.
- Consumes: `Layer`/`LayerParams`/`Track`/`MediaItem`/`Rgba`/`Animated`/`TextAlign`/`Shadow`/`Outline`/`Uuid` from `./model`.

- [ ] **Step 1: Write the failing tests** (`src/main/state/summary.test.ts`). These mirror the Rust `text_view_tests` + cover every helper:

```ts
import { describe, it, expect } from 'vitest'
import type { Layer, LayerParams, MediaItem, Rgba, Track } from './model'
import {
  layerKind, deriveTrackKindLabel, layerColorHint, hslToHex, markerColorHint, mediaLabel, layerParamsView,
} from './summary'

const stat = <T>(value: T) => ({ mode: 'Static' as const, value })
const xf = () => ({ x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), rotation_deg: stat(0), anchor: [0.5, 0.5] as [number, number] })
function layer(id: string, params: LayerParams): Layer {
  return { id, label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function track(layers: Layer[]): Track {
  return { id: 't', label: null, enabled: true, locked: false, muted: false, solo: false, removable: true, role: null, transient: false, height_px: 64, layers }
}
const color = (rgba: Rgba): LayerParams => ({ kind: 'Color', color: stat(rgba), width: 1920, height: 1080 })

describe('hslToHex (mirror commands/mod.rs:647 hsl_to_hex)', () => {
  it('det-mode hue 0 is the constant #cb4d4d', () => {
    // c=(1-|2*.55-1|)*.55=.495, x=0, m=.3025 → R=round(.7975*255)=203, G=B=round(.3025*255)=77
    expect(hslToHex(0, 0.55, 0.55)).toBe('#cb4d4d')
  })
})

describe('layerColorHint (commands/mod.rs:629)', () => {
  it('Color layer uses its exact rgba hex', () => {
    expect(layerColorHint(layer('x', color({ r: 0x12, g: 0x34, b: 0x56, a: 255 })))).toBe('#123456')
  })
  it('Color layer with a keyframed color uses the first keyframe value', () => {
    const kf: LayerParams = { kind: 'Color', color: { mode: 'Keyframed', value: [{ id: 'k', t_us: 0, value: { r: 1, g: 2, b: 3, a: 255 }, interp: { kind: 'Linear' } }] }, width: 16, height: 16 }
    expect(layerColorHint(layer('x', kf))).toBe('#010203')
  })
  it('det-mode id (leading bytes 00 00) → hue 0 → #cb4d4d for a non-Color layer', () => {
    expect(layerColorHint(layer('00000000-0000-0000-0000-000000000005', { kind: 'Text', ...textParamsLite() }))).toBe('#cb4d4d')
  })
})

describe('layerKind / deriveTrackKindLabel', () => {
  it('layerKind returns the discriminant', () => {
    expect(layerKind(color({ r: 0, g: 0, b: 0, a: 255 }))).toBe('Color')
  })
  it('a track with a visual layer is "Video"', () => {
    expect(deriveTrackKindLabel(track([layer('a', color({ r: 0, g: 0, b: 0, a: 255 }))]))).toBe('Video')
  })
  it('an audio-only track is "Audio"', () => {
    const audio: LayerParams = { kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: 1, gain_db: stat(0), pan: stat(0), fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' }
    expect(deriveTrackKindLabel(track([layer('a', audio)]))).toBe('Audio')
  })
  it('an empty track is "Video"', () => {
    expect(deriveTrackKindLabel(track([]))).toBe('Video')
  })
})

describe('markerColorHint / mediaLabel', () => {
  it('markerColorHint formats #rrggbb', () => {
    expect(markerColorHint({ r: 0, g: 128, b: 255, a: 255 })).toBe('#0080ff')
  })
  it('mediaLabel falls back to the path basename when label is null', () => {
    expect(mediaLabel({ path_abs: 'media/clip.bin', label: null } as MediaItem)).toBe('clip.bin')
  })
  it('mediaLabel prefers an explicit label', () => {
    expect(mediaLabel({ path_abs: 'media/clip.bin', label: 'My Clip' } as MediaItem)).toBe('My Clip')
  })
})

describe('layerParamsView Text arm (mirror text_view_tests)', () => {
  it('carries font/weight/italic/align/anchor/outline/shadow', () => {
    const tp: LayerParams = {
      kind: 'Text', content: 'hi',
      font: { family: 'Liberation Sans', size_px: 54, weight: 700, italic: true },
      color: stat({ r: 255, g: 255, b: 255, a: 255 }), align: 'Center',
      transform: { ...xf(), anchor: [0.5, 1.0] }, opacity: stat(1),
      shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
      outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
      intro: null, outro: null, backend_hint: 'DrawText',
    }
    const v = layerParamsView(tp, {})
    expect(v.kind).toBe('Text')
    if (v.kind !== 'Text') throw new Error('unreachable')
    expect([v.font_family, v.font_size_px, v.weight, v.italic]).toEqual(['Liberation Sans', 54, 700, true])
    expect([v.anchor_x, v.anchor_y]).toEqual([0.5, 1.0])
    expect(v.align).toBe('Center')
    expect(v.outline).not.toBeNull()
    expect(v.shadow).not.toBeNull()
  })
})

// minimal Text params for the color-hint test above
function textParamsLite(): Omit<Extract<LayerParams, { kind: 'Text' }>, 'kind'> {
  return {
    content: '', font: { family: 'f', size_px: 10, weight: 400, italic: false },
    color: stat({ r: 0, g: 0, b: 0, a: 255 }), align: 'Center', transform: xf(), opacity: stat(1),
    shadow: null, outline: null, intro: null, outro: null, backend_hint: 'Auto',
  }
}
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/summary.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/main/state/summary.ts` (helpers + view types only — Task 2 appends the assembler + top-level types):

```ts
// apps/desktop/src/main/state/summary.ts
import type { Animated, Layer, LayerParams, MediaItem, Outline, Rgba, Shadow, TextAlign, Track, Uuid } from './model'

// ── per-kind view structs (mirror commands/mod.rs:150-238; field names verbatim) ──
export interface VideoClipView {
  kind: 'VideoClip'; media_id: string; media_label: string; src_in_us: number; src_out_us: number
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; opacity: Animated<number>
  speed: number; flip_h: boolean; flip_v: boolean; fade_in_us: number; fade_out_us: number
}
export interface ImageOverlayView {
  kind: 'ImageOverlay'; media_id: string; media_label: string
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; opacity: Animated<number>
  fade_in_us: number; fade_out_us: number
}
export interface TextView {
  kind: 'Text'; content: string; font_family: string; font_size_px: number; weight: number; italic: boolean
  color: Animated<Rgba>; align: TextAlign; x: Animated<number>; y: Animated<number>; anchor_x: number; anchor_y: number
  opacity: Animated<number>; shadow: Shadow | null; outline: Outline | null
}
export interface ColorView { kind: 'Color'; color: Animated<Rgba>; width: number; height: number }
export interface AudioView {
  kind: 'Audio'; media_id: string; media_label: string; src_in_us: number; src_out_us: number
  gain_db: Animated<number>; pan: Animated<number>; fade_in_us: number; fade_out_us: number; mute: boolean; role: string
}
export interface MotifView {
  kind: 'Motif'; motif_id: string
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; opacity: Animated<number>
  src_in_us: number; props: Record<string, unknown>
}
export type LayerParamsView = VideoClipView | ImageOverlayView | TextView | ColorView | AudioView | MotifView

/** commands/mod.rs:586 layer_kind — the LayerParams discriminant. */
export function layerKind(params: LayerParams): string { return params.kind }

/** commands/mod.rs:607 derive_track_kind_label — visual-class wins; audio-only →
 *  "Audio"; empty → "Video" (so blank A/B-roll rows still style as video lanes). */
export function deriveTrackKindLabel(track: Track): string {
  let hasVisual = false, hasAudio = false
  for (const l of track.layers) {
    if (l.params.kind === 'Audio') hasAudio = true
    else hasVisual = true // VideoClip | ImageOverlay | Color | Motif | Text
  }
  if (hasVisual) return 'Video'
  if (hasAudio) return 'Audio'
  return 'Video'
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** commands/mod.rs:647 hsl_to_hex. Plain f64 (cosmetic; only hue 0 is gated — see
 *  the color-hint landmine in the plan). h is a non-negative integer hue. */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r: number, g: number, b: number
  const hi = Math.trunc(h)
  if (hi <= 59) { r = c; g = x; b = 0 }
  else if (hi <= 119) { r = x; g = c; b = 0 }
  else if (hi <= 179) { r = 0; g = c; b = x }
  else if (hi <= 239) { r = 0; g = x; b = c }
  else if (hi <= 299) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const ch = (v: number) => clamp(Math.round((v + m) * 255), 0, 255)
  return `#${hex2(ch(r))}${hex2(ch(g))}${hex2(ch(b))}`
}

function rgbaHex(c: Rgba): string { return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` }

/** commands/mod.rs:629 layer_color_hint — Color clip → its exact rgba (Static, or
 *  the first keyframe value, BLACK if none); else a stable hue from the uuid's
 *  first two bytes. */
export function layerColorHint(layer: Layer): string {
  if (layer.params.kind === 'Color') {
    const a = layer.params.color
    const rgba = a.mode === 'Static' ? a.value : (a.value[0]?.value ?? { r: 0, g: 0, b: 0, a: 255 })
    return rgbaHex(rgba)
  }
  const hex = layer.id.replace(/-/g, '')
  const b0 = parseInt(hex.slice(0, 2), 16), b1 = parseInt(hex.slice(2, 4), 16)
  const hue = ((b0 << 8) | b1) % 360
  return hslToHex(hue, 0.55, 0.55)
}

/** commands/mod.rs:430 marker color_hint — `#rrggbb`. */
export function markerColorHint(c: Rgba): string { return rgbaHex(c) }

/** commands/mod.rs:333 media label — explicit label, else path basename, else the
 *  whole path. Mirrors the `or_else`/`unwrap_or_else` chain. */
export function mediaLabel(item: MediaItem): string {
  if (item.label) return item.label
  const p = item.path_abs
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = slash >= 0 ? p.slice(slash + 1) : p
  return base.length > 0 ? base : p
}

function mediaLabelFor(id: Uuid, pool: Record<Uuid, MediaItem>): string {
  const m = pool[id]
  return m ? mediaLabel(m) : id
}

/** commands/mod.rs:487 layer_params_view — kind-matched UI projection. NOTE: the
 *  Motif arm is unit-tested only (no Motif layers in the corpus), matching Rust. */
export function layerParamsView(params: LayerParams, pool: Record<Uuid, MediaItem>): LayerParamsView {
  switch (params.kind) {
    case 'VideoClip': {
      const t = params.transform
      return { kind: 'VideoClip', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        src_in_us: params.src_in_us, src_out_us: params.src_out_us, x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y,
        opacity: params.opacity, speed: params.speed, flip_h: params.flip_h, flip_v: params.flip_v,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us }
    }
    case 'ImageOverlay': {
      const t = params.transform
      return { kind: 'ImageOverlay', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y, opacity: params.opacity,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us }
    }
    case 'Text': {
      const t = params.transform
      return { kind: 'Text', content: params.content, font_family: params.font.family, font_size_px: params.font.size_px,
        weight: params.font.weight, italic: params.font.italic, color: params.color, align: params.align,
        x: t.x, y: t.y, anchor_x: t.anchor[0], anchor_y: t.anchor[1], opacity: params.opacity,
        shadow: params.shadow, outline: params.outline }
    }
    case 'Color':
      return { kind: 'Color', color: params.color, width: params.width, height: params.height }
    case 'Audio':
      return { kind: 'Audio', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        src_in_us: params.src_in_us, src_out_us: params.src_out_us, gain_db: params.gain_db, pan: params.pan,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us, mute: params.mute, role: params.role }
    case 'Motif': {
      const t = params.transform
      return { kind: 'Motif', motif_id: params.motif_id, x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y,
        opacity: params.opacity, src_in_us: params.src_in_us, props: params.props }
    }
  }
}
```
> If a field name above does not exist on the TS model type, FIX it to match `model.ts` (the differential gate in Task 4 will otherwise catch the wire-name mismatch — but compile-time is cheaper). In particular re-read the `Transform`, `TextParams`/`FontSpec`, `VideoClipParams`, `AudioParams`, `MotifParams` definitions in `model.ts` to confirm `transform.anchor` is `[number,number]`, `font.size_px`/`weight`/`italic`, `speed`/`flip_h`/`flip_v`, `props` is `Record<string,unknown>`.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/summary.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean — noUnusedLocals: import only what these helpers use)
git add apps/desktop/src/main/state/summary.ts apps/desktop/src/main/state/summary.test.ts
git commit -m "feat(state-migration): summary.ts pure helpers + per-kind view types (Phase 3a)"
```

---

## Task 2: `buildProjectSummary` assembler + top-level view types

**Files:**
- Modify: `src/main/state/summary.ts`
- Test: `src/main/state/summary.test.ts`

**Interfaces:**
- Consumes: the Task-1 helpers; `HistoryStatus` from `./history`; `Project`/`Track`/`MediaItem`/`Uuid` from `./model`.
- Produces:
  - Top-level view types `CompositionSummary`/`HistoryView`/`RoleMixView`/`GroupSummary`/`MarkerSummary`/`MediaSummary`/`TrackSummary`/`LayerSummary`/`ProjectSummary` (mirror commands/mod.rs, names verbatim).
  - `buildProjectSummary(p: Project, history: HistoryStatus, fileExists: (absPath: string) => boolean): ProjectSummary`.

- [ ] **Step 1: Add failing tests** to `src/main/state/summary.test.ts`:

```ts
import { seededGen } from './ids'
import { blankProject } from './model'
import { createActor } from './actor'
import { buildProjectSummary } from './summary'

const NEVER = () => false // gate/test fileExists predicate

describe('buildProjectSummary (mirror commands/mod.rs:322 build_project_summary)', () => {
  it('blank project: counts, composition, canonical roles, history', () => {
    const gen = seededGen()
    const initial = blankProject(gen, 'demo')
    const actor = createActor({ initial, idGen: gen, clock: () => '<TS>' })
    const s = buildProjectSummary(actor.snapshot(), actor.historyStatus(), NEVER)
    expect(s.name).toBe('demo')
    expect([s.track_count, s.layer_count]).toEqual([2, 0]) // A-roll + B-roll, no layers
    expect(s.composition).toEqual({ width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false })
    expect(s.audio_roles.map((r) => r.role)).toEqual(['dialogue', 'music', 'sfx', 'voiceover']) // ALL order
    expect(s.audio_roles[0]).toEqual({ role: 'dialogue', gain_db: 0, muted: false, solo: false }) // defaults filled
    expect([s.history.cursor, s.history.len, s.history.can_undo, s.history.can_redo]).toEqual([0, 1, false, false])
    expect(s.history.lock_reason).toBeUndefined() // skip_serializing_if=Option::is_none → absent
    expect([s.media, s.markers, s.groups]).toEqual([[], [], []])
  })
  it('a built project: track kind, layer kind/color_hint, media sorted desc + label', () => {
    const gen = seededGen()
    const initial = blankProject(gen, 'demo')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen: gen, clock: () => '<TS>' })
    actor.dispatch('add_media', { id: '00000000-0000-0000-0000-0000000000aa', kind: 'Video', duration_us: 5_000_000 })
    actor.dispatch('add_media', { id: '00000000-0000-0000-0000-0000000000bb', kind: 'Audio', duration_us: 3_000_000 })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    const s = buildProjectSummary(actor.snapshot(), actor.historyStatus(), NEVER)
    expect(s.media.map((m) => m.id)).toEqual([ // descending by id string
      '00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000aa',
    ])
    expect(s.media[0]).toMatchObject({ label: 'clip.bin', kind: 'Audio', available: false, proxy_path: null })
    const t0 = s.tracks[0]
    expect(t0.kind).toBe('Video')
    expect(t0.layers[0].kind).toBe('Color')
    expect(t0.layers[0].color_hint).toBe('#ff0000') // default add_layer color is red (255,0,0)
    expect(s.layer_count).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/summary.test.ts` → FAIL (`buildProjectSummary` not exported).

- [ ] **Step 3: Implement** — append to `src/main/state/summary.ts`. First widen the model import and add the history import:
```ts
import type { Animated, Effect, Group, Layer, LayerParams, Marker, MediaItem, Outline, Project, Rgba, RoleMixSettings, Shadow, TextAlign, Track, Uuid } from './model'
import type { HistoryStatus } from './history'
```
Then append the types + assembler:
```ts
export interface CompositionSummary { width: number; height: number; fps_num: number; fps_den: number; duration_pinned: boolean }
export interface HistoryView { cursor: number; len: number; can_undo: boolean; can_redo: boolean; lock_reason?: string }
export interface RoleMixView { role: string; gain_db: number; muted: boolean; solo: boolean }
export interface GroupSummary { id: string; label: string | null; layer_ids: string[] }
export interface MarkerSummary { id: string; t_us: number; end_t_us: number | null; label: string; color_hint: string }
export interface MediaSummary {
  id: string; label: string; path: string; kind: string; duration_us: number | null
  width: number | null; height: number | null; size_bytes: number; available: boolean
  proxy_path: string | null; quick_proxy_path: string | null; proxy_bypassed: boolean; export_uses_original: boolean
  codec: string | null; pix_fmt: string | null; color_matrix: string | null; color_range: string | null
  color_primaries: string | null; color_transfer: string | null; conform_path: string | null
}
export interface LayerSummary {
  id: string; label: string | null; t_start_us: number; t_end_us: number; kind: string; color_hint: string
  enabled: boolean; locked: boolean; params: LayerParamsView; effects: Effect[]
}
export interface TrackSummary {
  id: string; kind: string; label: string | null; enabled: boolean; locked: boolean; muted: boolean; solo: boolean
  role: string | null; transient: boolean; layers: LayerSummary[]
}
export interface ProjectSummary {
  project_id: string; name: string; composition: CompositionSummary
  track_count: number; layer_count: number; duration_us: number; history: HistoryView
  media: MediaSummary[]; tracks: TrackSummary[]; markers: MarkerSummary[]; groups: GroupSummary[]; audio_roles: RoleMixView[]
}

// commands/mod.rs:446 — AudioRole::ALL order; default-filled per role.
const ROLE_ORDER = ['dialogue', 'music', 'sfx', 'voiceover'] as const
const DEFAULT_ROLE: RoleMixSettings = { gain_db: 0, muted: false, solo: false }

/** commands/mod.rs:322 build_project_summary — the read-only IPC view the renderer
 *  pulls on project:changed. Pure; `fileExists` is injected (filesystem fields). */
export function buildProjectSummary(p: Project, history: HistoryStatus, fileExists: (absPath: string) => boolean): ProjectSummary {
  const layer_count = p.tracks.reduce((n, t) => n + t.layers.length, 0)

  const fileOrNull = (path: string | null | undefined): string | null => (path && fileExists(path) ? path : null)
  const media: MediaSummary[] = Object.values(p.media_pool).map((m: MediaItem) => ({
    id: m.id, label: mediaLabel(m), path: m.path_abs, kind: m.kind, duration_us: m.metadata.duration_us,
    width: m.metadata.video?.width ?? null, height: m.metadata.video?.height ?? null, size_bytes: m.file_size,
    available: fileExists(m.path_abs),
    proxy_path: fileOrNull(m.proxy_path), quick_proxy_path: fileOrNull(m.quick_proxy_path),
    proxy_bypassed: m.proxy_bypassed, export_uses_original: m.export_uses_original,
    codec: m.metadata.video?.codec ?? null, pix_fmt: m.metadata.video?.pix_fmt ?? null,
    color_matrix: m.metadata.video?.color_matrix ?? null, color_range: m.metadata.video?.color_range ?? null,
    color_primaries: m.metadata.video?.color_primaries ?? null, color_transfer: m.metadata.video?.color_transfer ?? null,
    conform_path: fileOrNull(m.conform_path),
  }))
  media.sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0)) // b.id.cmp(&a.id) — descending

  const tracks: TrackSummary[] = p.tracks.map((t: Track) => ({
    id: t.id, kind: deriveTrackKindLabel(t), label: t.label, enabled: t.enabled, locked: t.locked,
    muted: t.muted, solo: t.solo, role: t.role, transient: t.transient,
    layers: t.layers.map((l: Layer): LayerSummary => ({
      id: l.id, label: l.label, t_start_us: l.t_start_us, t_end_us: l.t_end_us, kind: layerKind(l.params),
      color_hint: layerColorHint(l), enabled: l.enabled, locked: l.locked,
      params: layerParamsView(l.params, p.media_pool), effects: l.effects,
    })),
  }))

  const markers: MarkerSummary[] = p.markers.map((m: Marker) => ({
    id: m.id, t_us: m.t_us, end_t_us: m.end_t_us, label: m.label, color_hint: markerColorHint(m.color),
  }))
  const groups: GroupSummary[] = p.groups.map((g: Group) => ({ id: g.id, label: g.label, layer_ids: g.members }))
  const audio_roles: RoleMixView[] = ROLE_ORDER.map((role) => {
    const s = p.audio_roles[role] ?? DEFAULT_ROLE
    return { role, gain_db: s.gain_db, muted: s.muted, solo: s.solo }
  })

  const view: ProjectSummary = {
    project_id: p.project_id, name: p.metadata.name,
    composition: { width: p.composition.width, height: p.composition.height, fps_num: p.composition.fps.num,
      fps_den: p.composition.fps.den, duration_pinned: p.composition.duration_pinned },
    track_count: p.tracks.length, layer_count, duration_us: p.composition.duration_us,
    history: { cursor: history.cursor, len: history.len, can_undo: history.can_undo, can_redo: history.can_redo },
    media, tracks, markers, groups, audio_roles,
  }
  if (history.lock_reason !== undefined) view.history.lock_reason = history.lock_reason
  return view
}
```
> Confirm against `model.ts`: `Marker` has `t_us`/`end_t_us`/`label`/`color`; `Group.members` is `Uuid[]`; `MediaItem.metadata` has `duration_us` + optional `video` with `width`/`height`/`codec`/`pix_fmt`/`color_matrix`/`color_range`/`color_primaries`/`color_transfer`; `MediaItem` has `proxy_path`/`quick_proxy_path`/`conform_path` (string|null), `proxy_bypassed`/`export_uses_original` (bool), `file_size`. Fix any name drift now.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/summary.test.ts` → PASS (Task-1 tests still green too).

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/summary.ts apps/desktop/src/main/state/summary.test.ts
git commit -m "feat(state-migration): buildProjectSummary assembler + view types (Phase 3a)"
```

---

## Task 3: Rust driver summary mode + oracle regen (ADDITIVE)

**Files:**
- Modify: `native/src/commands/mod.rs` (visibility)
- Modify: `native/src/lib.rs` (re-export)
- Modify: `native/src/bin/replay_driver.rs` (summary mode)
- Modify: `scripts/gen-state-oracle.mjs` (also write `oracle-summary/`)
- Generate: 157 `fixtures/state-corpus/oracle-summary/*.json`
- Modify: `fixtures/state-corpus/README.md`

- [ ] **Step 1: Make `build_project_summary` reachable from the bin.** In `native/src/commands/mod.rs:322` change `pub(crate) fn build_project_summary` → `pub fn build_project_summary`. In `native/src/lib.rs`, add after the `mod commands;` line (17):
```rust
// pub: build_project_summary consumed by the replay_driver differential-harness bin
pub use commands::build_project_summary;
```

- [ ] **Step 2: Add the summary mode to `replay_driver.rs`.** At the top of `main()` (after reading `name`), read the env switch once:
```rust
    let emit_summary = std::env::var("REPLAY_EMIT").as_deref() == Ok("summary");
```
Change the per-step push (line 41-42) to branch on the mode (fetch history status only in summary mode):
```rust
        let snap = h.snapshot().await;
        let step = if emit_summary {
            let status = h.history_status().await;
            json!({ "op": op, "ok": ok, "error": error, "summary": canonical_summary(&snap, &status) })
        } else {
            json!({ "op": op, "ok": ok, "error": error, "state": canonical_state(&snap) })
        };
        steps.push(step);
```
Add the builder next to `canonical_state`:
```rust
/// The renderer IPC read-view (commands::build_project_summary). No wall-clock
/// fields in the view, so no <TS> normalization is needed (unlike canonical_state).
fn canonical_summary(p: &state::Project, status: &state::HistoryStatus) -> Value {
    serde_json::to_value(weftcut_lib::build_project_summary(p, status)).unwrap()
}
```

- [ ] **Step 3: Sanity-check the new mode compiles + emits a summary** (one sequence, both modes):
```bash
# (env vars per Global Constraints; from apps/desktop/)
cargo run --quiet --manifest-path native/Cargo.toml --bin replay_driver --features replay,jobs,export,mcp,cloud,motifs -- fixtures/state-corpus/sequences/<any>.json | head -c 400          # default → "state"
REPLAY_EMIT=summary cargo run --quiet --manifest-path native/Cargo.toml --bin replay_driver --features replay,jobs,export,mcp,cloud,motifs -- fixtures/state-corpus/sequences/<any>.json | head -c 400   # → "summary"
```
Expected: the first prints `…"state":…`; the second prints `…"summary":{"audio_roles":…,"composition":…}`.

- [ ] **Step 4: Extend `gen-state-oracle.mjs`** to ALSO produce summary oracles, keeping the state path unchanged. Replace the body so `run` takes an `emit` arg and there are two output dirs:
```js
// apps/desktop/scripts/gen-state-oracle.mjs
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SEQ = 'fixtures/state-corpus/sequences'
const OUT = 'fixtures/state-corpus/oracle'
const OUT_SUMMARY = 'fixtures/state-corpus/oracle-summary'
mkdirSync(OUT, { recursive: true })
mkdirSync(OUT_SUMMARY, { recursive: true })

const run = (file, emit) => execFileSync('cargo', [
  'run', '--quiet', '--manifest-path', 'native/Cargo.toml',
  '--bin', 'replay_driver', '--features', 'replay,jobs,export,mcp,cloud,motifs', '--', join(SEQ, file),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, REPLAY_EMIT: emit } })

let fail = 0
for (const file of readdirSync(SEQ).filter((f) => f.endsWith('.json'))) {
  for (const [emit, dir] of [['state', OUT], ['summary', OUT_SUMMARY]]) {
    const a = run(file, emit)
    const b = run(file, emit) // determinism gate
    if (a !== b) { console.error(`NONDETERMINISTIC (${emit}): ${file}`); fail++; continue }
    writeFileSync(join(dir, file), a)
  }
  console.log(`ok  ${file}`)
}
process.exit(fail ? 1 : 0)
```
> `REPLAY_EMIT=state` (or any non-"summary" value) preserves the existing behavior exactly, so the `oracle/` files regenerate byte-identical.

- [ ] **Step 5: Regenerate** (env vars per Global Constraints, from `apps/desktop/`):
```bash
node scripts/gen-state-oracle.mjs
git status --short fixtures/state-corpus/oracle/          # MUST be EMPTY (no M, no ??) — additivity check
git status --short fixtures/state-corpus/oracle-summary/  # MUST show 157 new (??) files
```
If `oracle/` shows ANY `M`, STOP — the default mode regressed; investigate before continuing.

- [ ] **Step 6: Update the corpus README.** Add a short section under the oracle description:
```markdown
### oracle-summary/

Parallel oracle set for the renderer IPC read-view (`commands::build_project_summary`
→ TS `summary.ts buildProjectSummary`), produced by `replay_driver` with
`REPLAY_EMIT=summary`. One file per sequence, same step structure as `oracle/` but
each step carries `summary` (the `ProjectSummary` view) instead of `state` (the
`.vproj` snapshot). Gated by `__tests__/summary.differential.test.ts`. Filesystem
fields (`available`/proxy paths) are `false`/`null` on both sides (fixture media
paths don't exist). Phase 3a.
```

- [ ] **Step 7: Commit** (state oracles are unchanged so they are NOT staged):
```bash
git add apps/desktop/native/src/commands/mod.rs apps/desktop/native/src/lib.rs apps/desktop/native/src/bin/replay_driver.rs apps/desktop/scripts/gen-state-oracle.mjs apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/README.md
git commit -m "test(state-migration): replay_driver REPLAY_EMIT=summary mode + summary oracle corpus (Phase 3a)"
```

---

## Task 4: `replaySummaries` + the differential gate

**Files:**
- Modify: `src/main/state/replay.ts`
- Create: `src/main/state/__tests__/summary.differential.test.ts`

**Interfaces:**
- Consumes: `buildProjectSummary` from `./summary`; the existing `buildArgs`/`resolve` internals.
- Produces: `replaySummaries(seq: Sequence): SummaryTrace` where `SummaryTrace = { name: string; steps: { op; ok; error; summary }[] }`.

- [ ] **Step 1: Write the failing gate** (`src/main/state/__tests__/summary.differential.test.ts`), mirroring `differential.phase2.test.ts`:

```ts
// apps/desktop/src/main/state/__tests__/summary.differential.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { parseOracleErrorVariant } from '../errors'
import { replaySummaries, sequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences')
const ORACLE = join(ROOT, 'oracle-summary')

describe('Phase 3a differential: TS read-view === Rust summary oracle (FULL corpus)', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    it(`summary matches the oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      expect(sequenceIsSupported(seq), `seq ${f} out of vocabulary`).toBe(true)
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing summary oracle ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replaySummaries(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts = trace.steps[i], or = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.summary), `summary ${where}`).toBe(JSON.stringify(canonicalize(or.summary)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (!ts.ok) {
          expect(parseOracleErrorVariant(String(ts.error)), `error ${where}`).toEqual(parseOracleErrorVariant(String(or.error)))
        }
      }
    })
  }
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/__tests__/summary.differential.test.ts` → FAIL (`replaySummaries` not exported).

- [ ] **Step 3: Implement `replaySummaries`** in `replay.ts`. Refactor the dispatch loop in `replaySequence` into a shared `runSequence` so both traces share it (DRY), then add the summary variant. Add imports:
```ts
import { buildProjectSummary } from './summary'
```
Add the type + shared runner + the new export (place `replaySummaries` after `replaySequence`):
```ts
export interface SummaryStep { op: string; ok: boolean; error: string | null; summary: unknown }
export interface SummaryTrace { name: string; steps: SummaryStep[] }

/** Shared replay engine: applies each command and calls `capture(actor)` per step.
 *  Used by replaySequence (canonical .vproj state) and replaySummaries (read-view). */
function runSequence<T>(seq: Sequence, capture: (actor: ReturnType<typeof createActor>) => T): { name: string; steps: { op: string; ok: boolean; error: string | null; out: T }[] } {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  const aRoll = initial.tracks[0].id
  const bRoll = initial.tracks[1].id
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const refs = new Map<string, string>([['A', aRoll], ['B', bRoll]])
  const steps: { op: string; ok: boolean; error: string | null; out: T }[] = []
  for (const cmd of seq.commands) {
    const r = actor.dispatch(cmd.op, buildArgs(cmd, refs))
    let error: string | null = null
    if (r.ok) {
      if (cmd.ref && typeof r.value === 'string') refs.set(cmd.ref, r.value)
    } else {
      const v = tsErrorVariant(r.error)
      error = v.inner ? `${v.top}(${v.inner})` : v.top
    }
    steps.push({ op: cmd.op, ok: r.ok, error, out: capture(actor) })
  }
  return { name: seq.name, steps }
}
```
Re-point `replaySequence` to the shared runner:
```ts
export function replaySequence(seq: Sequence): Trace {
  const t = runSequence(seq, (actor) => canonicalize(serializeProject(actor.snapshot())))
  return { name: t.name, steps: t.steps.map((s) => ({ op: s.op, ok: s.ok, error: s.error, state: s.out })) }
}

/** Phase 3a read-view twin: per step, the canonical ProjectSummary built from the
 *  TS actor snapshot + history status. `fileExists` is () => false to match the
 *  corpus's non-existent fixture media paths (the Rust oracle computes available:
 *  false / proxy paths null). */
export function replaySummaries(seq: Sequence): SummaryTrace {
  const t = runSequence(seq, (actor) => canonicalize(buildProjectSummary(actor.snapshot(), actor.historyStatus(), () => false)))
  return { name: t.name, steps: t.steps.map((s) => ({ op: s.op, ok: s.ok, error: s.error, summary: s.out })) }
}
```
> The original `replaySequence` body (lines 54-78) is replaced by the two functions above. Keep `buildArgs`/`resolve`/`resolveParamKey`/`SUPPORTED_OPS`/`sequenceIsSupported` unchanged.

- [ ] **Step 4: Run the gate** — `npx vitest run src/main/state/__tests__/summary.differential.test.ts` → PASS (157/157). Then the existing state gate to prove the refactor didn't regress it: `npx vitest run src/main/state/__tests__/differential.phase2.test.ts` → PASS (157/157). Then the full state suite: `npx vitest run src/main/state` → all green. Then `npm run typecheck` → clean.

  If a summary step diverges, the failure message names `<file> @ step <i> (op=…)`. Diff the TS vs oracle JSON for that step; the usual culprits are (a) a wire field-name drift (fix the `*View`/summary type), (b) a missing/extra field vs `build_project_summary`, (c) audio-role order/default, (d) media sort direction. Re-read the cited Rust lines; do NOT touch the oracle.

- [ ] **Step 5: Commit.**
```bash
git add apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/__tests__/summary.differential.test.ts
git commit -m "test(state-migration): replaySummaries + read-view differential gate, 157/157 (Phase 3a)"
```

---

## Self-Review

- **Spec coverage:** every field of `ProjectSummary` and every helper of `build_project_summary` (`layer_params_view` ×6 arms, `layer_kind`, `derive_track_kind_label`, `layer_color_hint`+`hsl_to_hex`, marker/media/role/group projections, canonical role fill, media sort) maps to Task 1/2 code + a unit test, and is differential-gated over the full corpus in Task 4. ✓
- **No placeholders:** every code step shows the full code; the regen commands and expected `git status` outputs are exact. The one hand-derived constant (`#cb4d4d`) is computed in the landmine note and re-confirmed by the gate. ✓
- **Type consistency:** `buildProjectSummary`, `layerParamsView`, `ProjectSummary`, `LayerParamsView`, `replaySummaries`, `SummaryTrace`, `canonical_summary`, `REPLAY_EMIT` are named identically across tasks; the `*View` field names mirror the cited Rust serde names verbatim. ✓
- **Additivity:** Task 3 touches `replay_driver` only behind a new env switch; the 157 existing state oracles must be byte-identical (explicit `git status` gate). ✓
- **Out of scope guarded:** no live wiring, no `replace_state`/persistence/autosave/MCP — those are 3b/3c/3d. `summary.ts` is pure and read-only. ✓
