# Decode session-interface split (preview vs export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the single `DecoderHandle` contract into a minimal `DecodeSession` core plus named `PreviewDecodeSession` / `ExportDecodeSession` roles, extracted to a neutral `decoder/session.ts`, with zero behavior change.

**Architecture:** Pure structural refactor ("A-lite" per the spec). Extract the shared decode contracts out of `SourceDecoderPool.ts` into a new `decoder/session.ts`. Rename `DecoderHandle` → `DecodeSession` (honest `ensureReady(): Promise<void>`), add `PreviewDecodeSession` (a semantic alias) and `ExportDecodeSession` (adds `decodeRange`/`evictBefore` and narrows `ring` to `ExportFrameStore`). The three implementers declare which role they satisfy. No method bodies change. The compiler + the existing test suite are the regression harness.

**Tech Stack:** TypeScript (strict), Electron + Vite (`electron-vite`), Vitest for unit tests, Playwright (`_electron`) for the e2e conformance/SSIM gate. Node v22.20.0 via fnm.

## Global Constraints

- **Zero behavior change.** This is a rename + type-relocation. No method body, no control flow, no runtime value changes. The proof is: `tsc -b` clean + the existing test suite green + no pixel drift.
- **Rename surface is exactly 5 source files** (verified by grep for the `DecoderHandle` identifier): `SourceDecoderPool.ts`, `FfmpegSource.ts`, `ExportDecoderPool.ts`, `Compositor.ts`, `decodeBench.ts`. `exportWorker.ts` and `protocol.ts` do **not** reference it. **No `*.test.ts` names the type** — tests need no edits and must pass unchanged.
- **The export Worker stays on the concrete `ExportSourceHandle` type.** It reads concrete-only perf-diag fields `h.dispatchedTotal` / `h.firstFrameDiag` (`exportWorker.ts:575-576`) that are deliberately NOT in the contract. Do not retype it.
- **Cross-file type references use `import type`** (erased at runtime) so the `session.ts` ↔ `ExportDecoderPool.ts` reference (`ExportDecodeSession.ring: ExportFrameStore`) is not a runtime import cycle.
- **`ensureReady` is typed `Promise<void>`** on the core. All three implementers already return `Promise<void>`; the old `Promise<unknown>` + `VideoTrackMeta` comment was stale. (`SourceMedia.ensureReady(): Promise<VideoDecoderConfig>` is a different internal method — leave it alone.)
- **`SourceHandleInit` and `DecoderPool` are NOT split** — moved verbatim, names unchanged.
- **`requestFrameAt` / `onFirstFrame` stay on the core** and the export no-op implementations stay (legitimate Null Object). The optional dev-HUD diagnostics stay optional. Do not "fix" these.
- **Node:** v22.20.0 via fnm (never Node 24 — breaks Windows packaging). `pretypecheck`/`pretest` auto-run `build:wasm`; do not run wasm build manually.
- **Git discipline:** stage by explicit path (the user edits this checkout concurrently); re-check `git status` before each commit. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Extract contracts + rename `DecoderHandle` → `DecodeSession` (atomic)

This is one atomic, compiles-green change: a partial rename does not type-check, so all consumer edits land in one commit. `tsc` is the net that guarantees nothing was missed.

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/session.ts`
- Modify: `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts` (remove contracts block `28-182`; add one import + fix 2 comments)
- Modify: `apps/desktop/src/renderer/render/decoder/FfmpegSource.ts:7,42` (+ header comment `4-6`)
- Modify: `apps/desktop/src/renderer/render/decoder/ExportDecoderPool.ts:25,366`
- Modify: `apps/desktop/src/renderer/render/Compositor.ts:26-31,274,298` (+ comment `119`)
- Modify: `apps/desktop/src/renderer/render/sprite/VideoClipSprite.ts:62`
- Modify: `apps/desktop/src/renderer/render/decoder/decodeBench.ts:1,20` (comments only)
- Test: no test file changes; the existing suite is the regression check.

**Interfaces:**
- Produces (the new public contract in `decoder/session.ts`):
  - `type DecodedFrame = VideoFrame | ImageBitmap | TenBitFrame`
  - `interface FrameStore { frameAt(tUs:number):DecodedFrame|null; containsPts(tUs:number):boolean; firstPtsUs():number|null; lastPtsUs():number|null; size():number }`
  - `interface DecodeSession { readonly mediaId:string; readonly ring:FrameStore; readonly disposed:boolean; ensureReady():Promise<void>; dispose():void; requestFrameAt(tUs:number):Promise<void>; onFirstFrame(cb:()=>void):void; decodeQueueSize?():number; decodedFrameCount?():number; isDowngraded?():boolean; isLookaheadFull?():boolean; onFatalError?(cb:(reason:string)=>void):void }`
  - `type PreviewDecodeSession = DecodeSession`
  - `interface ExportDecodeSession extends DecodeSession { readonly ring:ExportFrameStore; decodeRange(aUs:number,bUs:number):Promise<void>; evictBefore(cutoffUs:number):void }`
  - `interface DecoderPool { acquire(init:SourceHandleInit):DecodeSession; release(key:string):void; dispose():void }`
  - `interface SourceHandleInit { … }` (moved verbatim, unchanged)

- [ ] **Step 1: Create `decoder/session.ts`**

Move the `SourceHandleInit` interface **verbatim** from `SourceDecoderPool.ts:28-91` (do not retype it — cut/paste to avoid drift). Then author the rest of the file exactly as below. Note the two `import type` lines (erased — no runtime cycle) and that `DecodeSession` is the old `DecoderHandle` interface with `ensureReady(): Promise<void>` and the export-carve-out comments removed.

```ts
// Neutral decode-contract module. Extracted from SourceDecoderPool.ts so the
// preview pool file no longer owns the shared vocabulary alongside SourceMedia,
// the WebCodecs SourceHandle, and the pool. Defines the surface the Compositor
// composites through (DecodeSession) plus the two role interfaces. Both imports
// below are `import type` (erased), so the session <-> ExportDecoderPool
// reference (ExportDecodeSession.ring) is not a runtime cycle.
import type { TenBitFrame } from "./tenBitFrame";
import type { ExportFrameStore } from "./ExportDecoderPool";

export interface SourceHandleInit {
  // ---- MOVED VERBATIM from SourceDecoderPool.ts:28-91 (layerId … forceLane) ----
}

/// Decoded-frame surface as exposed to the Compositor / VideoClipSprite.
/// Preview returns `ImageBitmap` (decoupled from the WebCodecs decoder's buffer
/// pool); export returns `VideoFrame` (evicted after each composited output);
/// 10-bit export returns `TenBitFrame` (CPU-plane copy). PixiJS v8 `ImageSource`
/// accepts VideoFrame and ImageBitmap; TenBitFrame is routed to
/// `bindExternalTexture` instead.
export type DecodedFrame = VideoFrame | ImageBitmap | TenBitFrame;

/// Minimal frame-by-PTS surface the Compositor reads through. Implemented by
/// `FrameRing` (preview) and `ExportFrameStore` (export).
export interface FrameStore {
  frameAt(tUs: number): DecodedFrame | null;
  containsPts(tUs: number): boolean;
  /// PTS (µs) of the earliest cached frame, or null if empty.
  firstPtsUs(): number | null;
  /// PTS (µs) of the latest cached frame, or null if empty.
  lastPtsUs(): number | null;
  /// Number of cached entries, for the dev `PerfHUD`.
  size(): number;
}

/// The surface the Compositor composites through (renamed from DecoderHandle).
/// requestFrameAt/onFirstFrame stay here: a synchronous, pre-staged source
/// (export) satisfies them as documented no-ops (Null Object). The trailing
/// members are honestly optional — an engine that cannot provide a value simply
/// omits the method (WebCodecs has decodeQueueSize/decodedFrameCount, FfmpegSource
/// does not; onFatalError is FfmpegSource-only, WebCodecs self-heals internally).
export interface DecodeSession {
  readonly mediaId: string;
  readonly ring: FrameStore;
  readonly disposed: boolean;
  ensureReady(): Promise<void>;
  dispose(): void;
  /// Preview nudges the decoder's lookahead each tick; export no-ops (frames
  /// are pre-staged by its own driver).
  requestFrameAt(tUs: number): Promise<void>;
  /// Preview repaints on the first decoded frame; export no-ops (its composite
  /// runs synchronously).
  onFirstFrame(cb: () => void): void;
  /// Dev `PerfHUD` diagnostics — best-effort, engine-varying.
  decodeQueueSize?(): number;
  decodedFrameCount?(): number;
  isDowngraded?(): boolean;
  isLookaheadFull?(): boolean;
  /// Terminal ffmpeg-engine failure (after in-place HW→SW fallback also fails).
  /// FfmpegSource-only; the Compositor wires it to `markFfmpegUnusable`.
  onFatalError?(cb: (reason: string) => void): void;
}

/// Names preview's role. Structurally equal to `DecodeSession` under this bite;
/// its job is intent + being the type the preview implementers declare, so a
/// future preview-only divergence has a home.
export type PreviewDecodeSession = DecodeSession;

/// Export's extension: a named, compiler-checked contract for the driving
/// surface the export Worker uses. `ring` narrows to `ExportFrameStore` (adds
/// `waitForPts` / `isReadyFor` / `fail`).
export interface ExportDecodeSession extends DecodeSession {
  readonly ring: ExportFrameStore;
  decodeRange(aUs: number, bUs: number): Promise<void>;
  evictBefore(cutoffUs: number): void;
}

/// Pool surface used by the Compositor. Concrete pools may expose extra surface
/// (preview's idle sweeper, export's `handles` map) but the Compositor needs
/// only these.
export interface DecoderPool {
  acquire(init: SourceHandleInit): DecodeSession;
  release(key: string): void;
  dispose(): void;
}
```

- [ ] **Step 2: Edit `SourceDecoderPool.ts` — remove the moved contracts, import what remains**

Delete the entire contracts block (the `SourceHandleInit` interface through the `DecoderPool` interface, currently lines `28-182` — everything between the `const IDLE_DISPOSE_MS = 5_000;` line and the `SourceMedia` doc comment/class). Then add the single import the file still needs (`SourceHandleInit` is used by `acquire` at what is currently line 713):

Add immediately below the existing import block (after the `import { FfmpegSource } from "./FfmpegSource";` line):

```ts
import type { SourceHandleInit } from "./session";
```

Then fix the two stale comments in this file that name `DecoderHandle`:
- The comment reading ``/// `DecoderHandle` interface (and for log lines that want to identify`` → change `DecoderHandle` to `DecodeSession`.
- The comment reading ``/// `VideoDecoder` construction. Returns void (see the `DecoderHandle``` → change `DecoderHandle` to `DecodeSession`.

(The `SourceHandle` class has no `implements` clause and the pool does not name the moved types internally, so no other edits here. `acquire`'s return stays `SourceHandle | FfmpegSource`.)

- [ ] **Step 3: Edit `FfmpegSource.ts` — implement `PreviewDecodeSession`**

Replace the import at line 7:

```ts
import type { DecoderHandle } from "./SourceDecoderPool";
```
with:
```ts
import type { PreviewDecodeSession } from "./session";
```

Replace the class declaration at line 42:
```ts
export class FfmpegSource implements DecoderHandle {
```
with:
```ts
export class FfmpegSource implements PreviewDecodeSession {
```

In the header comment (lines 4-6), change `implements\n// DecoderHandle` to `implements\n// PreviewDecodeSession` (the phrase ``\`implements DecoderHandle\``` split across lines 4-5).

- [ ] **Step 4: Edit `ExportDecoderPool.ts` — implement `ExportDecodeSession`**

Replace the import at line 25:
```ts
import type { DecoderHandle, DecoderPool, FrameStore, SourceHandleInit } from "./SourceDecoderPool";
```
with:
```ts
import type { DecoderPool, ExportDecodeSession, FrameStore, SourceHandleInit } from "./session";
```

Replace the class declaration at line 366:
```ts
export class ExportSourceHandle implements DecoderHandle {
```
with:
```ts
export class ExportSourceHandle implements ExportDecodeSession {
```

(`ExportFrameStore implements FrameStore` at line 78 and `ExportDecoderPool implements DecoderPool` at line 882 are unchanged — those names still exist.)

- [ ] **Step 5: Edit `Compositor.ts` — split the import, rename the type**

Replace the import block (lines 26-31):
```ts
import {
  SourceDecoderPool,
  SourceHandle,
  type DecoderHandle,
  type DecoderPool,
} from "./decoder/SourceDecoderPool";
```
with:
```ts
import { SourceDecoderPool, SourceHandle } from "./decoder/SourceDecoderPool";
import type { DecodeSession, DecoderPool } from "./decoder/session";
```

Rename the two type references:
- Line 274: `source: DecoderHandle;` → `source: DecodeSession;`
- Line 298: `handle: DecoderHandle;` → `handle: DecodeSession;`

Fix the comment at line 119: `/// True if a DecoderHandle existed or was created and` → `/// True if a DecodeSession existed or was created and`.

- [ ] **Step 6: Edit `VideoClipSprite.ts` and `decodeBench.ts`**

`VideoClipSprite.ts` line 62 — repoint the type import:
```ts
import type { DecodedFrame } from "../decoder/SourceDecoderPool";
```
to:
```ts
import type { DecodedFrame } from "../decoder/session";
```

`decodeBench.ts` — comment-only, for accuracy (no type edits; it imports the `SourceDecoderPool`/`SourceHandle` classes, which are unchanged):
- Line 1: `// E2E-only decode-strategy benchmark driver. Measures at the DecoderHandle` → `… Measures at the DecodeSession`
- Line 20: ``/// \`DecoderHandle\` seam as the WebCodecs strategy.`` → ``/// \`DecodeSession\` seam as the WebCodecs strategy.``

- [ ] **Step 7: Typecheck — the primary correctness net**

Run: `npm run typecheck`
Expected: exits 0, no errors. (`tsc -b`; `pretypecheck` builds wasm first.) If it flags a missing member on any implementer, that would be a latent conformance gap — add the trivial member with no behavior change; but none is expected, because the pool's return type already enforced `DecoderHandle` conformance today.

- [ ] **Step 8: Unit tests — confirm zero behavior drift**

Run: `npm --workspace apps/desktop run test`
Expected: all pass, same count as before the change. No test references the renamed type, so any failure here means a real behavior regression — investigate before proceeding.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/session.ts \
        apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts \
        apps/desktop/src/renderer/render/decoder/FfmpegSource.ts \
        apps/desktop/src/renderer/render/decoder/ExportDecoderPool.ts \
        apps/desktop/src/renderer/render/decoder/decodeBench.ts \
        apps/desktop/src/renderer/render/Compositor.ts \
        apps/desktop/src/renderer/render/sprite/VideoClipSprite.ts
git commit -m "refactor(decode): split DecoderHandle into DecodeSession + Preview/Export roles

Extract the shared decode contracts to decoder/session.ts, rename DecoderHandle
to a minimal DecodeSession core, add PreviewDecodeSession (alias) and
ExportDecodeSession (decodeRange/evictBefore + ExportFrameStore ring). Honest
ensureReady(): Promise<void>. Pure structural refactor, zero behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Update the evergreen docs

**Files:**
- Modify: `docs/roadmap.md` (the "Decode engine — export-side decode, session split" section)
- Modify: `docs/decode-bench.md` (any `DecoderHandle` references)

- [ ] **Step 1: Mark the session-split bullet done in `docs/roadmap.md`**

In the "Preview/export session-interface split" bullet, replace the deferred phrasing:
```
- **Preview/export session-interface split.** `FfmpegSource` implements the
  shared `DecoderHandle` today; the next structural bite splits a
  `PreviewDecodeSession` from an `ExportDecodeSession` so the two paths stop
  sharing one handle contract.
```
with the shipped phrasing:
```
- **Preview/export session-interface split — done.** The shared `DecoderHandle`
  was split into a minimal `DecodeSession` core plus named `PreviewDecodeSession`
  and `ExportDecodeSession` roles, extracted to `decoder/session.ts`. Preview and
  export no longer share one bloated contract; `ExportDecodeSession` gives the
  export Worker a compiler-checked driving surface.
```

Also update the sentence earlier in that section that reads `with hardware-vs-software private to the Standard engine's \`FfmpegSource\` (see …)` — no change needed there. Search the section for any remaining bare `DecoderHandle` mention and change it to `DecodeSession`.

- [ ] **Step 2: Update `docs/decode-bench.md`**

Grep the file for `DecoderHandle` and replace each occurrence with `DecodeSession` (the bench measures at that seam; the name changed, the seam did not).

Run: `npx --no-install rg -n "DecoderHandle" docs/decode-bench.md` (or the Grep tool) → confirm 0 matches after editing.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md docs/decode-bench.md
git commit -m "docs(decode): mark session-split shipped; DecoderHandle -> DecodeSession

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(Historical process specs under `docs/superpowers/` that mention `DecoderHandle` — the 2026-07-03 decode-bench and 2026-07-05 blindspot docs — are frozen artifacts and are left as-is.)

---

### Task 3: End-to-end verification gate (zero pixel drift)

No code changes. This task proves the refactor preserved behavior end-to-end. `tsc` + unit tests (Task 1) are the primary proof; this is the confirmatory belt-and-suspenders pass.

**Files:** none modified.

- [ ] **Step 1: Full typecheck + unit suite once more from a clean state**

Run: `npm run typecheck && npm --workspace apps/desktop run test`
Expected: both exit 0.

- [ ] **Step 2: Run the e2e conformance / SSIM gate**

Run: `npm --workspace apps/desktop run e2e:electron`
Expected: pass, including the render-parity SSIM assertions (unchanged from before — the refactor cannot alter pixels). The harness requires a `VITE_WEFTCUT_E2E=1` build; if the runner reports a missing E2E build, produce it per `docs`/the conformance-harness setup, then re-run.

- [ ] **Step 3: Manual confirmation — preview + a short export**

Drive the running app (via the `run`/`verify` skill or `REMOTE_DEBUGGING_PORT=9222 npm run dev` + CDP): load a clip, scrub/play the preview (frames paint; no regression in the ffmpeg/webcodecs engines), then run one short export and confirm it completes and the output is frame-identical to a pre-refactor export of the same timeline. Report the observed result (frames painted, export completed, output matches) as the evidence.

- [ ] **Step 4: Mark the spec implemented (optional bookkeeping)**

In `docs/superpowers/specs/2026-07-12-decode-session-split-design.md`, change the header `**Status:** approved, ready for implementation planning` to `**Status:** implemented`. Commit:

```bash
git add docs/superpowers/specs/2026-07-12-decode-session-split-design.md
git commit -m "docs(decode): mark session-split spec implemented

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** (checked against `2026-07-12-decode-session-split-design.md`):
- Three contracts (`DecodeSession`/`PreviewDecodeSession`/`ExportDecodeSession`) → Task 1 Step 1. ✓
- Honest `ensureReady(): Promise<void>` → Task 1 Step 1 (`DecodeSession`). ✓
- Extract to neutral `session.ts` → Task 1 Steps 1-2. ✓
- Implementer `implements` swaps (FfmpegSource, SourceHandle-via-structural, ExportSourceHandle) → Task 1 Steps 3-4. Note: the WebCodecs `SourceHandle` has no `implements` clause today and keeps none (it structurally satisfies `PreviewDecodeSession` via the pool's typed return); the spec's "`SourceHandle implements PreviewDecodeSession`" is satisfied structurally — adding an explicit clause is optional and omitted to keep the diff minimal and avoid touching that class. ✓ (documented deviation)
- Worker unchanged, keeps concrete type → Global Constraints + no Task touches `exportWorker.ts`. ✓
- 5-file rename surface, no test edits → Global Constraints + Task 1 file list. ✓
- Docs (roadmap, decode-bench) → Task 2. ✓
- Verification (tsc, unit, e2e SSIM, manual) → Task 1 Steps 7-8 + Task 3. ✓
- Out-of-scope items (split `SourceHandleInit`/`DecoderPool`/Compositor, export-side decode, `DecodedFrame` ownership) → not present in any task. ✓

**Placeholder scan:** `SourceHandleInit`'s body in Step 1 is an explicit verbatim-move instruction with an exact source line range (`SourceDecoderPool.ts:28-91`), not a "TODO/fill-in" — the content exists and is copied, not invented. No other placeholders.

**Type consistency:** `DecodeSession`, `PreviewDecodeSession`, `ExportDecodeSession`, `FrameStore`, `DecodedFrame`, `DecoderPool`, `SourceHandleInit`, `ExportFrameStore` are used identically across Steps 1-6 and match the spec's signatures. `ensureReady(): Promise<void>` consistent throughout.

**Deviation noted:** the explicit `implements PreviewDecodeSession` on the WebCodecs `SourceHandle` is omitted (structural conformance is already enforced by `SourceDecoderPool.acquire`'s return type and the `DecoderPool` field assignment in the Compositor). This keeps the diff to the 5 files named and avoids editing a class that already conforms. If the reviewer prefers the explicit clause, add `implements PreviewDecodeSession` to `class SourceHandle` (line 298) — `tsc` will confirm conformance.
