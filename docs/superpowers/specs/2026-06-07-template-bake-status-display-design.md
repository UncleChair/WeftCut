# Template Bake-Status Display Design

## Problem

L2 persisted pre-bake works, but it is **invisible**: when a user enables the
global "Pre-bake" setting or clicks a layer's "Pre-bake now", nothing in the UI
indicates that a bake is running, finished, or failed. The only evidence is
smoother playback or inspecting the workspace `Cache/raster/` folder. A user
can't tell whether the feature is doing anything, which template is baked, or
whether a bake errored.

The original `docs/templates.md` agent-surface section already anticipated a
per-layer status (`idle | rastering{progress} | ready | error`), but v1 shipped
no plumbing for it.

## Goal

Surface per-template-layer bake status in the UI, cheaply and without per-frame
churn:

- A **timeline status dot** on each Template layer block — coarse **phase only**
  (baking / ready / error / hidden-when-idle).
- A **property-panel status line** in `TemplateFields` carrying the detail
  (phase + frame count, e.g. "预烘焙中 92/150").
- A small **per-layer status store** that both consume.

Out of scope for v1 (deferred, with reasons): the MCP/events agent surface (needs
a TS→Rust status bridge), export "preparing" gating (tangled with the deferred
"export reads PNGs from disk" work), and any numeric/percent on the dot itself.

## Approach

One direction, single source of truth, no per-frame React re-render:

```
TemplateBaker ──onStatus(cacheKey,{phase,done,total})──▶ Compositor ──▶ templateBakeStatusStore
  per-cacheKey {done,total}        (throttled)            fans cacheKey→status     (Zustand: layerId→status)
  phase change + coalesced progress                       out to active layerIds          │
                                                                                          ▼
                                                       LayerBlock dot  +  TemplateFields line
                                                              (atomic selectors)
```

- The **baker** is the only component that knows bake progress, so it owns the
  per-`cacheKey` counters and emits status. It never touches React or the store.
- The **Compositor** already maps active template layers → cacheKey (in
  `updateBakeTargets`); it translates the baker's per-cacheKey status into a
  per-`layerId` map and writes the store. This is also where one cacheKey's
  status fans out to every layer sharing it (N identical templates → one bake →
  one status, shown on all N).
- **Consumers** read the store through atomic selectors, so the dot re-renders
  only on phase change and the count updates only the one selected panel.

## Components

### 1. `TemplateBaker` status tracking (modify `TemplateBaker.ts`)

Add a per-`cacheKey` counter and an `onStatus` dependency:

```ts
export type BakePhase = "baking" | "ready" | "error";
export interface BakeStatus { phase: BakePhase; done: number; total: number; }

export interface TemplateBakerDeps {
  // … existing: schedule, cancel, isOnDisk, persist, warm, batchSize …
  /// Report coarse per-content status. Called immediately on a phase change
  /// (baking↔ready↔error) and coalesced on progress. Never throws.
  onStatus?: (cacheKey: string, status: BakeStatus) => void;
}
```

Tracking rules:
- On `setTargets`, for each active content set `total = contentDurationFrames`,
  `done = 0`, `phase = "baking"`, and emit `baking`. (Contents no longer active
  are dropped — see the Compositor's idle handling.)
- In `drainBatch`, each time a frame is **persisted OR skipped because it's
  already on disk**, increment that cacheKey's `done`. When `done === total`,
  set `phase = "ready"` and emit immediately.
- If the per-frame `try` catches an exception (raster/encode/write failure for a
  real reason, not disposal), set that cacheKey's `phase = "error"` and emit;
  freeze `done`/`total`. (Disposal-driven drops do not set error.)
- **Coalesce progress emits**: emit on every phase change immediately; emit
  progress at most once per batch (the loop is already batched), which bounds it
  to ~`total/batchSize` emits per bake — cheap.

The counter map is cleared/reset per `setTargets` (a fresh plan). Node-testable
with a fake `onStatus`: assert the emitted sequence for a normal bake, an
all-on-disk content (fast `baking`→`ready`), and an error.

### 2. `templateBakeStatusStore.ts` (new, Zustand)

```ts
export interface LayerBakeStatus { phase: "baking" | "ready" | "error"; done: number; total: number; }

// store state: { byLayer: Record<string, LayerBakeStatus> }
// idle layers are ABSENT from the map (no entry == idle/not-baking).

export function setLayerBakeStatuses(next: Record<string, LayerBakeStatus>): void; // replace whole map
export const useLayerBakePhase = (layerId: string): LayerBakeStatus["phase"] | null;  // dot
export const useLayerBakeStatus = (layerId: string): LayerBakeStatus | null;          // panel
```

Atomic selectors only (per `feedback_zustand_composite_selector`): the phase
selector returns just the phase string (or null), so the dot doesn't re-render
on `done` ticks. The store is a pure module — unit-testable for set + selector
semantics. `setLayerBakeStatuses` replaces the whole `byLayer` map each call
(the Compositor recomputes the full small map; simpler than per-key diffing).

### 3. Compositor wiring (modify `Compositor.ts`)

- Pass `onStatus` into the `TemplateBaker` constructor. The callback updates an
  internal `statusByCacheKey: Map<string, BakeStatus>` and triggers a recompute.
- **Recompute** `byLayer` (and write the store) on: an `onStatus` event,
  `updateBakeTargets`, and `setProject`. The recompute iterates active template
  layers (few), resolves each layer's cacheKey via the existing
  `templateFrameDescriptor`, and:
  - if the baker has live status for the key (`statusByCacheKey`) → that status
    (baking / ready / error);
  - else if `sharedBakedKeyIndex.has(key)` → synthesize `ready`
    (`done = total = contentDurationFrames`): frames already on disk from a prior
    session/bake, even with the global toggle off. This is what makes the
    cold-start case read as 已预烘焙 rather than 未烘焙.
  - else → omit (idle).
  Then `setLayerBakeStatuses(map)`.
- Clear on `dispose` and on `setProject(null)` (project close): `statusByCacheKey.clear()`
  and `setLayerBakeStatuses({})`.

Throttle note: `onStatus` is already coalesced by the baker; the Compositor's
recompute is O(active template layers) — negligible.

### 4. Timeline status dot (modify `Timeline.tsx` `LayerBlock`)

In `LayerBlock` (which has `layer`), when `layer.params.kind === "Template"`,
render a small dot inside the `.timeline-layer` block (near `.layer-label`) using
`useLayerBakePhase(layer.id)`:
- `null` (idle) → render nothing.
- `"baking"` → `.template-bake-dot.is-baking` (CSS spinner).
- `"ready"` → `.template-bake-dot.is-ready` (subtle filled dot).
- `"error"` → `.template-bake-dot.is-error` (red) + `title` tooltip.

The dot is presentational; no interaction. Non-Template layers never render it.

### 5. Property-panel status line (modify `PropertyPanel.tsx` `TemplateFields`)

At the top of the `prop-section` (after the `h3`), render a status line from
`useLayerBakeStatus(layer.id)`:
- `null` → 「未烘焙 — 在设置中开启预烘焙，或右键『立即预烘焙』」 (neutral, actionable).
- `baking` → 「预烘焙中 {done}/{total}」.
- `ready` → 「已预烘焙 {total} 帧」.
- `error` → 「预烘焙失败」.

### 6. i18n + CSS

- `en-US.ts` / `zh-CN.ts`: `property_panel.bake_idle`, `bake_baking`,
  `bake_ready`, `bake_error` (with `{done}`/`{total}` interpolation), and a short
  dot `aria-label`/`title` per phase.
- `styles.css`: `.template-bake-dot` + `.is-baking` (spinner keyframes),
  `.is-ready`, `.is-error`.

## State mapping (summary)

| State | When | Dot | Panel |
|---|---|---|---|
| idle | not baking, and no frames on disk for its key (`!bakedKeyIndex.has`) | hidden | "未烘焙 …" |
| baking | in active set, done < total | spinner | "预烘焙中 {done}/{total}" |
| ready | done === total, OR frames already on disk (`bakedKeyIndex.has`, e.g. baked last session) | check/filled | "已预烘焙 {total} 帧" |
| error | caught bake error | red + tooltip | "预烘焙失败" |

## Designed-in subtleties

- **Default-off is idle/neutral, never error** — a fresh project shows no dots
  and a neutral panel line.
- **Prop edit → new cacheKey → status resets to baking.** The old key's status
  becomes irrelevant (the layer now resolves to a new key with no status yet, or
  the baker re-plans it). The baker's coalesced emit smooths the brief flip; no
  extra debounce needed.
- **Phase-only dot** is immune to progress churn (atomic phase selector); the
  count lives only in the panel, which is visible for one selected layer.
- **Shared cacheKey** → all layers with that key show the same status (the
  Compositor fan-out handles it).
- **Ready reflects disk, not just live baking.** Idle layers consult
  `sharedBakedKeyIndex`, so a layer baked in a prior session reads as 已预烘焙
  even with the global toggle off (the cold-start case). Caveat: the index
  tracks "≥1 frame on disk", so an interrupted/partial on-disk bake can briefly
  read as `ready` until the next bake completes it — acceptable for v1
  (self-heals; the worst case is an optimistic label, never a wrong render).
- **Error is coarse**: a caught raster/persist exception flips the content to
  `error` with frozen counts; the user retries via "立即预烘焙". Disposal-driven
  drops are not errors.

## Testing

- **Node units (TDD):** `TemplateBaker` emits the correct `onStatus` sequence —
  normal bake (`baking` → progress → `ready`), an all-on-disk content
  (`baking` → `ready` fast), and an error (`error`, counts frozen). The store's
  `setLayerBakeStatuses` + `useLayerBakePhase`/`useLayerBakeStatus` semantics
  (idle absence → null, atomic phase).
- **Real-WebView2 e2e / manual:** drive a template, enable Pre-bake, observe the
  dot go spinner → check and the panel show the count climb to `{total}/{total}`;
  trigger "Pre-bake now" on a cleared dir and watch the same; confirm default-off
  shows no dot. (Same harness used to verify L2.)

## Out of scope (v1, deferred)

- **MCP / events agent surface** (`idle|rastering{progress}|ready|error` query +
  `/events`): the baker is TS (webview) and MCP is Rust, so it needs a new
  TS→Rust status-report bridge. The `templateBakeStatusStore` is the foundation a
  later bridge would publish from.
- **Export "preparing" gating**: export bakes its own frames fresh today
  (doesn't read the L2 cache), so this is tangled with the deferred "export reads
  PNGs from disk" work.
- **Numeric/percent on the dot itself** — count stays in the panel.
