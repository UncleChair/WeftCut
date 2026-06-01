# Instant Decodable Preview — Plan 3: no-flash original→proxy overlap-swap (Compositor)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. **Fidelity note:** this is an **approach-level** plan, not line-level TDD. The swap is render-integration that resists blind line-level specs and can't run in the headless test suite ([[weftcut-toolchain-baseline-red]]). Each task names the exact site + the contract + the verification; the implementing agent reads the live `Compositor`/`SourceDecoderPool` and writes the diff in-situ. Decide the **pool-keying approach (Task 1)** first — everything else hangs off it.

**Goal:** When a quick proxy lands for a source currently previewing from its original (the Plan 2 bridge), switch the preview to the proxy **without a flash** — keep showing the original until the proxy decoder has the current-playhead frame, then atomically swap and release the original.

**Architecture:** `ActiveClip` records the URL its source was built from. The Compositor detects when `proxyAssetUrl(mediaId)` resolves to a new URL for an active clip and, instead of returning the stale clip, spins up a **second** `DecoderHandle` on the new URL, requests the current frame, and on `onFirstFrame` repoints `ActiveClip.source` to it and releases the old one. Reuses the existing `createImageBitmap` snapshot + `onFirstFrame` + `scheduleRepaint` machinery.

**Tech Stack:** TypeScript (`apps/desktop/src/render`). Gate: `npm test` for any pure helper extracted; `tauri:dev` smoke for the swap itself.

**Spec:** `docs/superpowers/specs/2026-06-01-instant-decodable-preview-design.md` (§D). Depends on Plan 2 (the bridge). Only fires for the **long-GOP decodable** subset — short-GOP decodable scrubs fine from the original (no proxy benefit), undecodable never bridged.

---

## File Structure

- **Modify** `apps/desktop/src/render/Compositor.ts` — `ActiveClip` gains `builtFromUrl`; `ensureClip` (≈775-800) detects URL change → starts a swap; a new `beginSwap`/`completeSwap` pair holds the transient second handle; `compositeFrame` + `setAnchorTime` keep reading `clip.source` (unchanged once repointed).
- **Modify** `apps/desktop/src/render/decoder/SourceDecoderPool.ts` — supply the second handle on a NEW URL for the same `mediaId` (the keying decision, Task 1).
- **Test:** `apps/desktop/src/render/Compositor.swap.test.ts` (only for any extracted pure helper, e.g. "should-swap?" predicate); the swap itself is smoke-verified.

---

## Task 1: Decide + implement how the pool yields a second handle on a new URL

**The problem:** `SourceDecoderPool.acquireMedia(mediaId, url)` returns the **existing** `SourceMedia` for a `mediaId`, ignoring the new `url`; and `SourceMedia.proxyAssetUrl` is set once at construction. So acquiring the proxy URL under the real `mediaId` reuses the original's `SourceMedia` (wrong URL). Two clean options:

- **(A) Synthetic swap identity (recommended).** Acquire the second handle under a synthetic key derived from the target URL — `layerId = "${layerId}#swap"`, `mediaId = "${mediaId}@${hash(url)}"` — so the pool builds a fresh `SourceMedia` on the proxy URL. After the swap completes, `ActiveClip.source` holds that handle by reference; release the ORIGINAL `(layerId, mediaId)` handle. The synthetic handle then lives under its own pool key (idle-swept independently). Downside: a follow-up swap (rare — proxy→? doesn't happen) would need another synthetic key; acceptable since proxy is terminal.
- **(B) Teach `SourceMedia` to re-point its URL.** Add `SourceMedia.repointUrl(url)` that disposes the opened input + clears `config`/`readyP` so the next `ensureReady` re-opens at the new URL. Cleaner key-space, but mutates shared per-`mediaId` state — risky if two layers share the `mediaId` mid-swap (one wants original, one wants proxy).

**Recommendation: (A)** — it never mutates shared `SourceMedia`, so two clips of the same source can swap independently. The cost (an extra short-lived pool entry) is bounded to the swap window.

- [ ] **Step 1:** Implement the chosen pool access. For (A): add a small helper on the pool or in the Compositor that calls `pool.acquire({ layerId: swapLayerId, mediaId: swapMediaId, proxyAssetUrl: newUrl })` where `swapLayerId`/`swapMediaId` are derived as above. No `SourceDecoderPool` API change is required for (A) — it already keys by the passed ids. (For (B), add `repointUrl` + a `SourceMedia` unit test.)
- [ ] **Step 2:** If (A), add a pure helper `swapKeys(layerId, mediaId, url) → { layerId, mediaId }` with a unit test (deterministic, collision-free for distinct urls). Run `npm test -- Compositor.swap`.
- [ ] **Step 3:** Commit (`feat(preview): pool yields a fresh handle on a new URL for source-swap`).

---

## Task 2: `ActiveClip` records its source URL + the Compositor detects a change

**Files:** `Compositor.ts` (`ActiveClip` interface ≈103-113; `ensureClip` ≈775-800).

- [ ] **Step 1:** Add `builtFromUrl: string;` to `ActiveClip`. Set it in `ensureClip` where the clip is created (`clips.set(layer.id, { ..., builtFromUrl: proxyUrl })`).
- [ ] **Step 2:** In `ensureClip`, before the `existing && !existing.source.disposed → return existing` short-circuit, compute `const url = this.proxyAssetUrl(mediaId)`. If `existing` and `url && url !== existing.builtFromUrl` and no swap is already in flight for this layer → call `this.beginSwap(existing, url)` (Task 3) and return `existing` (keep showing the original meanwhile). Otherwise keep the current behavior.
- [ ] **Step 3:** Smoke later (Task 4). Commit (`feat(preview): detect preview-source URL change per clip`).

---

## Task 3: `beginSwap` / `completeSwap` — overlap then atomic repoint

**Files:** `Compositor.ts` (new private methods + a `swaps: Map<string, DecoderHandle>` field keyed by layerId for in-flight swap handles).

Contract:

- [ ] **Step 1: `beginSwap(clip: ActiveClip, newUrl: string)`**
  - Guard: if `this.swaps.has(clip.layerId)` return (one swap at a time).
  - Acquire the second handle via Task 1's path; store it in `this.swaps.set(clip.layerId, handle)`.
  - `void handle.ensureReady()`; compute the current source time for this clip (mirror `setAnchorTime`: `srcTUs = layer.params.src_in_us + (currentPlayheadUs - layer.t_start_us)`) and `void handle.requestFrameAt(srcTUs)`.
  - `handle.onFirstFrame(() => this.completeSwap(clip.layerId))`.
- [ ] **Step 2: `completeSwap(layerId)`**
  - Look up the swap handle + the `ActiveClip`. If either is gone (clip disposed mid-swap), dispose the swap handle + clear the map entry and bail.
  - Verify the swap handle's ring actually has the current frame (`ring.frameAt(currentSrcTUs) != null`); if not, return (wait for the next `onFirstFrame`/repaint — do NOT swap to an empty ring, that's the flash we're avoiding).
  - Atomically: `const old = clip.source; clip.source = swapHandle; clip.builtFromUrl = newUrl; this.swaps.delete(layerId);` then `this.pool.release(old's layerId)` (the ORIGINAL handle's key) and `this.scheduleRepaint()`.
- [ ] **Step 3:** Ensure the per-tick paths are swap-safe: `setAnchorTime`'s `requestFrameAt` loop and `compositeFrame`'s `frameAt` read `clip.source` (already a live ref), so once repointed they transparently use the proxy handle. While the swap is in flight, both keep driving the OLD `clip.source` (original) so the preview never goes blank.
- [ ] **Step 4:** Dispose hygiene — in the Compositor's clip teardown (`setProject` prune + `dispose`), also dispose/clear any `this.swaps` entry for a removed layer so a mid-swap handle can't leak.
- [ ] **Step 5:** Commit (`feat(preview): no-flash overlap-swap from original to proxy`).

---

## Task 4: Smoke verification (`tauri:dev`)

- [ ] **Step 1:** Import a **long-GOP** decodable source (e.g. a long-GOP 1080p HEVC, or a Hi10P MKV). Drop it on the timeline. Confirm: preview shows the original immediately (Plan 2 bridge), scrub is rough during the window.
- [ ] **Step 2:** Wait for the quick proxy to finish (watch the `media:job_*` log / the import dialog row flip). Confirm: the preview **does not flash/blank** at the swap moment, and scrub becomes smooth afterward.
- [ ] **Step 3:** Scrub continuously across the moment the proxy lands → no black frame, no jump to a wrong frame.
- [ ] **Step 4:** Two clips of the same long-GOP source on the timeline → both swap independently, neither flashes (validates the (A) synthetic-key choice — no shared-`SourceMedia` contention).
- [ ] **Step 5:** Delete a clip mid-swap (proxy still encoding) → no console error, no leaked decoder (the Task 3 Step 4 teardown).

---

## Self-Review

**Spec coverage (§D):**
- Keep original visible until proxy frame ready, then atomic repoint → Task 3 (`beginSwap` holds old `clip.source`; `completeSwap` only swaps when `ring.frameAt != null`). ✅
- Reuse `onFirstFrame` + snapshot + `scheduleRepaint` → Task 3 Steps 1-2. ✅
- Only the long-GOP-decodable subset swaps → preconditions inherited (short-GOP decodable bypasses/no-proxy via Plan 1 later, or scrubs fine; undecodable never bridged) + Task 4 Step 1 uses a long-GOP source. ✅
- Pool's immutable-URL `SourceMedia` resolved → Task 1 (synthetic key, no shared-state mutation). ✅
- No leak on mid-swap teardown → Task 3 Step 4 + Task 4 Step 5. ✅

**Placeholder scan:** Approach-level by design (declared at top). Every task names the exact site (`ActiveClip` ≈103, `ensureClip` ≈775), the contract, and a concrete smoke check. The only pure-unit test (`swapKeys`) is line-level. ✅

**Type consistency:** `builtFromUrl` on `ActiveClip` used in Task 2 (set) + Task 3 (read/update). `this.swaps: Map<string, DecoderHandle>` used consistently in `beginSwap`/`completeSwap`/teardown. `clip.source: DecoderHandle` (existing type) is what gets repointed. ✅

---

## Status of the whole feature after Plans 2+3

- **Plan 2 (bridge) + Plan 3 (swap) = the shipped feature**: instant preview for every decodable source (incl. Hi10P), with a no-flash upgrade to the proxy for long-GOP sources. Pure frontend; no Rust, no schema change, no portability hole (every source keeps its proxy).
- **Deferred (the narrow-proxy track)**: Plan 1 (`decodable_here` widening, already written) + a future command/gop/job-guard plan + Plan 4 (open re-probe). Only needed if we later choose to skip building proxies for 8-bit scrub-friendly decodable sources. Revisit with evidence the saved transcodes matter.
