# Audio-Master Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The preview playhead derives from `audioContext.currentTime` against a single shared anchor (structural zero A/V drift), with wall-clock fallback while the context is suspended; the audio mixers consume the SAME anchor (their self-anchor + 40 ms reconciler is deleted).

**Architecture:** One `ClockAnchor` (compUs ↔ ctxTime mapping) owned by `PlaybackEngine`. `SyntheticClock` uses it to derive the raw position when the bound `AudioContext` is running (anchor re-taken on play/seek/state-flip; wall-delta accumulation otherwise — the dead DOM-era absolute-nudge drift path is replaced). The Compositor forwards the engine's anchor to `AudioMixer`s the same way it forwards `setMasterPlayState`; mixers schedule chunks off that anchor directly. Spec: `docs/audio.md` (the Clock paragraph + Out-of-scope entry move into the body).

**Tech Stack:** TypeScript only. No Rust changes.

**Worktree:** `.claude/worktrees/audio-clock`, branch `feat/audio-master-clock`, base includes audio engine v1.

---

### Task 1: Shared ClockAnchor in chunkSchedule.ts

**Files:** Modify `apps/desktop/src/render/audio/chunkSchedule.ts` (+ its test), Modify `apps/desktop/src/render/audio/AudioMixer.ts` (helper dedup only here; behavior change in Task 3)

- [ ] Export from `chunkSchedule.ts` (the scheduling-math home):

```ts
/// THE clock anchor: one (composition µs, AudioContext seconds) pair maps
/// between the two time domains. PlaybackEngine owns the single live
/// instance; the playhead derivation (SyntheticClock) and every
/// AudioMixer's chunk schedule consume the same one — the mapping is
/// implemented HERE and nowhere else.
export interface ClockAnchor {
  compUs: number;
  ctxTime: number;
}

export function ctxTimeAtCompUs(a: ClockAnchor, compUs: number): number {
  return a.ctxTime + (compUs - a.compUs) / 1_000_000;
}

export function compUsAtCtxTime(a: ClockAnchor, ctxTime: number): number {
  return a.compUs + (ctxTime - a.ctxTime) * 1_000_000;
}

export function usToFrames(us: number): number {
  return Math.round((us * 48) / 1000);
}

export function framesToUs(frames: number): number {
  return (frames * 1000) / 48;
}
```

- [ ] Rewrite `planChunks` to take `anchor: ClockAnchor` (replacing `anchorCompUs`/`anchorCtxTime` fields in `ChunkPlanInput`) and compute `whenIdeal = ctxTimeAtCompUs(anchor, chunkCompUs)`. Delete `shouldReanchor` + `REANCHOR_THRESHOLD_S` (the single-anchor design has nothing to reconcile).
- [ ] Update `chunkSchedule.test.ts`: inputs use `anchor: { compUs, ctxTime }`; drop the `shouldReanchor` describe; add tests for `ctxTimeAtCompUs`/`compUsAtCtxTime` round-trip and `usToFrames` exactness.
- [ ] `AudioMixer.ts`: delete its private `usToFrames`/`framesToUs`, import from `chunkSchedule`.
- [ ] Run vitest (mixer still compiles; behavior unchanged until Task 3) + typecheck. Commit: `refactor(audio): single ClockAnchor owns the comp↔ctx mapping`.

### Task 2: SyntheticClock audio derivation

**Files:** Modify `apps/desktop/src/render/clock.ts`, Modify `apps/desktop/src/render/clock.test.ts`

- [ ] Replace the dead absolute-nudge drift path. New behavior (TDD — tests first with a fake ctx `{ state, currentTime }`):
  - `bindAudio(ctx)` keeps its name; drop `setDriftFraction` + `_driftFraction` + `baseLatency` use (no callers).
  - New private state: `_anchor: ClockAnchor | null` (uses the Task 1 type), `_lastCtxState: AudioContextState | null`.
  - `play()` / `setPosition()` while playing: re-take the anchor when the ctx is running: `_anchor = { compUs: this._rawTUs, ctxTime: ctx.currentTime }` (note: anchor stores RAW µs, pre-snap).
  - `tick()` while playing:
    - ctx bound AND `ctx.state === "running"`: if state just flipped from non-running (or `_anchor === null`), re-anchor from the CURRENT `_rawTUs` (seamless source switch, zero position jump); then `_rawTUs = compUsAtCtxTime(_anchor, ctx.currentTime)`.
    - else (no ctx / suspended): wall-delta accumulation exactly as today; `_anchor = null`.
  - `pause()`: `_anchor = null` (next play re-anchors).
  - Expose `getAnchor(): ClockAnchor | null` — the engine forwards this to the Compositor.
  - Fix the stale "(or per encode step in export)" doc comment — the export Worker iterates the frame grid and never constructs a clock.
- [ ] Tests: derivation follows fake ctx.currentTime exactly (no drift over many ticks); wall fallback when suspended; suspended→running mid-play keeps position continuous (no jump at the seam); setPosition during play re-anchors; pause/play round-trip; frame snap still applied to `positionUs()`.
- [ ] Run + commit: `feat(audio): playhead derives from the audio clock (anchor-based)`.

### Task 3: Mixers consume the engine anchor

**Files:** Modify `apps/desktop/src/render/audio/AudioMixer.ts`, Modify `apps/desktop/src/render/Compositor.ts`, Modify `apps/desktop/src/render/PlaybackEngine.ts`

- [ ] `PlaybackEngine`: in the constructor, `this.clock.bindAudio(init.compositor.getAudioGraph()?.ctx ?? null)`. Each `tick()`, forward `this.compositor.setClockAnchor(this.clock.getAnchor())` (cheap reference set).
- [ ] `Compositor`: new `setClockAnchor(a: ClockAnchor | null)` storing `this.clockAnchor`; the audio pass passes it into `mixer.tick(tUsSnapped, this.playing, layer.t_end_us, this.clockAnchor)`.
- [ ] `AudioMixer`: delete the private `anchor` state, the re-anchor branch, and `rampTrimIn`'s re-anchor call site. `tick(masterUs, playing, layerTEndUs, anchor: ClockAnchor | null)`:
  - `!playing || !inside || mute || anchor === null` → teardown (no micro-fade) as today.
  - Anchor IDENTITY change (engine re-anchored: seek during play, ctx state flip) → teardown(true) + ramp trim in, then schedule against the new anchor. Track `lastAnchor` by reference.
  - `planChunks({ masterUs, anchor, ctxNow, ... })`.
  - The late-resolve skip-into-buffer fix (6f8a60c4) stays untouched — it's about async read latency, not anchoring.
- [ ] Wall-fallback subtlety: while the ctx is suspended the engine anchor is null → mixers stay silent (correct: a suspended ctx makes no sound anyway). When ctx resumes, the clock re-anchors → mixers see a fresh anchor and schedule. No special casing.
- [ ] Run vitest + typecheck. Commit: `feat(audio): mixers schedule off the engine's single anchor`.

### Task 4: Docs + gates + live verification

- [ ] `docs/audio.md`: rewrite the **Clock** paragraph (audio-master is now the behavior; wall fallback while suspended; single shared anchor; reconciler gone) and delete the audio-master entry from Out of scope. `docs/render.md` clock.ts line: "synthetic clock + Web Audio drift" → "anchor-derived audio-master clock (wall fallback)".
- [ ] Full gates: vitest, typecheck, cargo (untouched but cheap).
- [ ] E2E regression: `audio_envelope.e2e.js` + `export_range_audio.e2e.js` (playback/seek paths exercised via hooks; kill lingering weftcut/msedgedriver/tauri-driver first — the stale-binary trap).
- [ ] Live smoke (tauri dev + bridge): play a clip with audio → console clean; seek during playback → audio follows without artifacts; pause at end parks correctly; PerfHUD playhead advances smoothly.
- [ ] Commit docs. Finish via superpowers:finishing-a-development-branch.

## Out of scope

Scrub audio, playbackRate, the mixer UI, anything Rust-side. The export path has no clock and is untouched.
