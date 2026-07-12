# Decode session-interface split (preview vs export) — design

**Status:** approved, ready for implementation planning
**Scope:** pure structural refactor of the decoder contract. Zero behavior change.

## Motivation

`DecoderHandle` (in `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts`)
is a single interface implemented by three classes — the two preview engines
(`FfmpegSource`, the WebCodecs `SourceHandle`) and the export handle
(`ExportSourceHandle`). It has accreted two masters' worth of surface, and the
interface's own doc comments admit it: `requestFrameAt` *"export ignores it"*,
`onFirstFrame` *"export no-ops"*, a run of `?()` diagnostics marked
*"preview-only"*, and `ensureReady(): Promise<unknown>` with a *"export still
returns `Promise<VideoTrackMeta>`"* note.

The roadmap (`docs/roadmap.md` §"Decode engine — export-side decode, session
split") names this the next structural bite: split a `PreviewDecodeSession`
from an `ExportDecodeSession` so the two paths stop sharing one handle
contract. This design covers **only** that split. Export-side decode via the
engine overlay (the sibling roadmap bullet) is explicitly out of scope.

### Two smells, treated differently

Auditing the current contract, the "shared" surface is really two distinct
problems, and this refactor deliberately treats them differently:

1. **Contract dishonesty — removed.**
   - `ensureReady(): Promise<unknown>` with a stale `VideoTrackMeta` comment.
     All three implementers already return `Promise<void>` (`FfmpegSource:85`,
     WebCodecs `SourceHandle:381`, `ExportSourceHandle:445`). The
     `Promise<VideoDecoderConfig>` at `SourceDecoderPool.ts:247` is
     `SourceMedia.ensureReady` — a *different* internal per-source method, not
     a `DecodeSession`, and it stays as-is.
   - The export **Worker** (`worker/exportWorker.ts`) reaches into the
     *concrete* `ExportSourceHandle` class and the `ExportDecoderPool.handles`
     map for `decodeRange` (line 376), `evictBefore` (488, 514), and
     `ring.waitForPts` (413) — none of which are on any shared interface. There
     is no named contract for the export driving surface.
   - The shared contract lives buried inside the *preview* pool file, with no
     named preview/export roles.

2. **Honest polymorphism — kept on purpose.**
   - Export's no-op `requestFrameAt` / `onFirstFrame` are a legitimate Null
     Object: a synchronous, pre-staged source truthfully satisfies "hint the
     decoder toward this time" / "notify on first frame" by doing nothing.
   - The best-effort dev-HUD diagnostics (`decodeQueueSize?`,
     `decodedFrameCount?`, `isDowngraded?`, `isLookaheadFull?`, `onFatalError?`)
     genuinely vary by engine — WebCodecs `SourceHandle` exposes
     `decodeQueueSize`/`decodedFrameCount`; `FfmpegSource` does not;
     `onFatalError` is `FfmpegSource`-only (WebCodecs self-heals internally).
     The Compositor's `?.()` there is truthful, not debt.

Forcing #2 to disappear (stub implementations, or Compositor mode-branching)
was the rejected "A-pure" alternative — more churn for no behavior gain. This
design fixes #1 and leaves #2 alone.

## Current state (verified)

- **One `Compositor` serves both modes.** It carries an explicit
  `this.mode: "preview" | "export"` field, and the export Worker injects an
  `ExportDecoderPool` via `init.pool` (`Compositor.ts:554`,
  `this.pool = init.pool ?? new SourceDecoderPool()`). The Compositor drives
  both through the `DecoderHandle` surface, papering over differences with
  optional chaining (`c.source.decodeQueueSize?.()`, `isLookaheadFull?.()`,
  `if (source.onFatalError)`).
- **The Compositor never calls the export driving surface.** `decodeRange` /
  `evictBefore` are called by the Worker, not the Compositor. The Compositor
  reads only `ring.frameAt` + `ensureReady` + `dispose` from an export session.
- **Method inventory across implementers:**

  | method | `FfmpegSource` | WebCodecs `SourceHandle` | `ExportSourceHandle` |
  | --- | --- | --- | --- |
  | `ensureReady` → `Promise<void>` | ✓ | ✓ | ✓ |
  | `requestFrameAt` / `onFirstFrame` | ✓ | ✓ | no-op |
  | `isDowngraded` / `isLookaheadFull` | ✓ | ✓ | ✗ |
  | `decodeQueueSize` / `decodedFrameCount` | ✗ | ✓ | ✗ |
  | `onFatalError` | ✓ | ✗ | ✗ |
  | `decodeRange` / `evictBefore` | ✗ | ✗ | ✓ |

## Design

### The three contracts

Extract a neutral `decoder/session.ts` holding the shared contracts (today they
live inside `SourceDecoderPool.ts`, which also holds `SourceMedia`, the
WebCodecs `SourceHandle`, and the preview pool — it is doing too much).

```ts
// decoder/session.ts

export type DecodedFrame = VideoFrame | ImageBitmap | TenBitFrame;

export interface FrameStore {
  frameAt(tUs: number): DecodedFrame | null;
  containsPts(tUs: number): boolean;
  firstPtsUs(): number | null;
  lastPtsUs(): number | null;
  size(): number;
}

/// The surface the Compositor composites through. Renamed from DecoderHandle.
/// requestFrameAt/onFirstFrame stay here: export satisfies them as documented
/// no-ops (Null Object). The trailing diagnostics are honestly optional — an
/// engine that cannot provide a value simply omits the method.
export interface DecodeSession {
  readonly mediaId: string;
  readonly ring: FrameStore;
  readonly disposed: boolean;
  ensureReady(): Promise<void>;        // was Promise<unknown>; stale VideoTrackMeta note dropped
  dispose(): void;
  requestFrameAt(tUs: number): Promise<void>;
  onFirstFrame(cb: () => void): void;
  decodeQueueSize?(): number;
  decodedFrameCount?(): number;
  isDowngraded?(): boolean;
  isLookaheadFull?(): boolean;
  onFatalError?(cb: (reason: string) => void): void;
}

/// Names preview's role. Structurally equal to DecodeSession under this bite
/// (A-lite); its job is intent + being the type the preview pool returns, so a
/// future preview-only divergence has a home. FfmpegSource and the WebCodecs
/// SourceHandle declare `implements PreviewDecodeSession`.
export type PreviewDecodeSession = DecodeSession;

/// Export's extension. Gives the Worker a NAMED contract for the driving
/// surface it currently pulls off the concrete ExportSourceHandle class.
export interface ExportDecodeSession extends DecodeSession {
  readonly ring: ExportFrameStore;     // narrows FrameStore: adds waitForPts / isReadyFor / fail
  decodeRange(aUs: number, bUs: number): Promise<void>;
  evictBefore(cutoffUs: number): void;
}

export interface DecoderPool {
  acquire(init: SourceHandleInit): DecodeSession;
  release(key: string): void;
  dispose(): void;
}

export interface SourceHandleInit { /* moved verbatim; not split this bite */ }
```

Naming: `DecoderHandle` → `DecodeSession`. `DecoderPool` and `SourceHandleInit`
keep their names and are **not** split (they are shared pool/data contracts;
splitting them is separate scope).

### Consumer impact

- **Compositor** (`Compositor.ts`): import `DecodeSession` (and the family)
  from `session.ts` instead of `DecoderHandle` from `SourceDecoderPool.ts`;
  rename the type references. The `?.()` diagnostic calls and the no-op
  `requestFrameAt`/`onFirstFrame` calls stay exactly as they are — they are
  honest. No behavior change, no mode-branching added.
- **Export Worker** (`worker/exportWorker.ts`): **unchanged.** It keeps
  consuming the concrete `ExportSourceHandle` (via `ExportDecoderPool.handles`)
  because it also reads concrete-only E2E perf-diag fields — `h.dispatchedTotal`
  and `h.firstFrameDiag` (`exportWorker.ts:575–576`) — that deliberately do not
  belong in the contract. The Worker owns the export pool; consuming the
  concrete type is legitimate. The `#1` win is realized by the handle *class*
  declaring `implements ExportDecodeSession`, which enforces the driving surface
  (`decodeRange` / `evictBefore` / `ring: ExportFrameStore`) as a named, checked
  contract instead of a shape described only in a file-header comment.

### Implementer impact

- `FfmpegSource.ts`: `implements PreviewDecodeSession` (was `DecoderHandle`).
- WebCodecs `SourceHandle` (in `SourceDecoderPool.ts`): `implements
  PreviewDecodeSession`.
- `ExportSourceHandle` (in `ExportDecoderPool.ts`): `implements
  ExportDecodeSession` (was `DecoderHandle`).
- No method bodies change. `implements` clauses and imports only.

## Files touched

The `DecoderHandle` identifier appears in exactly these five source files
(verified by grep): `SourceDecoderPool.ts`, `FfmpegSource.ts`,
`ExportDecoderPool.ts`, `Compositor.ts`, `decodeBench.ts`. Notably
`exportWorker.ts` and `protocol.ts` do **not** reference it, and no `*.test.ts`
names the type.

- **new** `decoder/session.ts` — the contracts above.
- `decoder/SourceDecoderPool.ts` — remove moved contracts, import from
  `session.ts`; `SourceHandle implements PreviewDecodeSession`.
- `decoder/FfmpegSource.ts` — `implements PreviewDecodeSession`.
- `decoder/ExportDecoderPool.ts` — `ExportSourceHandle implements
  ExportDecodeSession`.
- `render/Compositor.ts` — import path + type-name updates only.
- `decoder/decodeBench.ts` — follows the `DecoderHandle → DecodeSession` rename
  (permanent bench harness).
- Tests: **no rename needed** (none name the type); they are expected to pass
  unchanged — a green run is the proof, not an edit.
- Docs: `docs/roadmap.md` (mark the session-split bullet done) and
  `docs/decode-bench.md` — update `DecoderHandle` references to `DecodeSession`.
  Historical process specs under `docs/superpowers/` that mention
  `DecoderHandle` (the 2026-07-03 decode-bench and 2026-07-05 blindspot docs)
  are frozen artifacts and are left as-is.

## Verification (bar: zero behavior drift)

This is a pure refactor; the compiler enforces most of the correctness.

1. `tsc -b` clean — the primary net; the rename + narrowed `ensureReady` must
   type-check across all consumers.
2. Decoder unit tests green (the `decoder/*.test.ts` set above).
3. e2e conformance SSIM unchanged (the cross-OS render parity gate).
4. A manual `verify` pass: drive preview playback and one short export, confirm
   output is frame-identical to pre-refactor.

No new tests are required (no new behavior); no test references the renamed
type, so a green run of the existing suite is the correctness proof.

## Out of scope (YAGNI — deferred to separate bites)

- Splitting `SourceHandleInit` (its export-only/preview-only/bench-only fields
  have the same two-masters smell, but it is a data bag, lower harm).
- Splitting `DecoderPool`.
- Splitting the `Compositor` into preview/export instances (the rejected
  "A-pure"/"C" directions).
- Export-side decode via the engine overlay (sibling roadmap bullet; needs the
  main→renderer→worker raw-frame transport built first — currently a de-risked
  POC in `poc/export-frame-transport`, not production code).
- Unified `DecodedFrame` metadata/ownership.
