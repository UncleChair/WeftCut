# Realtime Preview — Fast Scrub

True frame-accurate scrub feedback in the WebCodecs realtime preview
mode. The user can drag the playhead and see the corresponding frame
at each intermediate position with sub-100ms latency, not the current
"black canvas during drag, correct frame on release" behavior.

Settled in a grilling session on 2026-05-16. Sections map 1:1 to the
decisions resolved there.

---

## What it is, in one paragraph

The realtime preview engine switches its data source from the
original media to the workspace's per-clip 540p H.264 proxy. The
proxy is re-encoded with a 1-second GOP so seeking lands close to
the target. Each `ClipDecoder` gains a `seek(localT)` capability
built on `mp4box.seek` + `VideoDecoder.flush`. The `PlaybackEngine`
runs a **coalesced seek loop**: every pointermove updates a per-clip
scrub target; a worker (driven by the existing RAF loop) drives the
decoder toward the latest target without canceling in-flight
decodes. When the proxy isn't yet generated, the recipe falls back
to the original source and the existing fallback-frame logic
(commit `5f0e13f`) covers the visual gap; once the proxy job lands,
the next `project:changed` event swaps the decoder over.

## The five design decisions

1. **Frame-accurate via proxy decoder-seek** — scrub uses
   `mp4box.seek(targetUs, useRap=true)` on the 540p proxy. No
   pre-rendered thumbnail strip; no I-frame cache.
2. **Proxy everywhere in realtime mode** — `preview_webcodecs_recipe`
   joins segmented preview in calling `with_proxies_substituted`.
   Single decoder per clip, same source for both playback and
   scrub. 540p quality for realtime preview is acceptable; users
   who want full-res preview switch to segmented/cached mode.
3. **Coalesced seek loop, latest-target-wins** — every pointermove
   updates `scrubTargets[layerId]`. The engine's worker: if not
   currently decoding-toward-target, fire `decoder.seek(target)`
   and run forward to the first frame at-or-past target. When the
   frame lands, check the target again — if it moved during the
   decode, seek to the new latest. **No `VideoDecoder.flush()` mid-
   decode** — the in-flight work is allowed to finish; the next
   iteration handles the newer target. This keeps the GPU
   producing frames at a sustainable rate (~10-30 cycles/sec on
   typical hardware) rather than thrashing.
4. **1-second GOP proxies, regenerate on first load** — the proxy
   job adds `-g 30 -keyint_min 30` to its ffmpeg args. A
   `PROXY_FORMAT_VERSION` constant bumps; existing proxies whose
   metadata records an older version are invalidated on workspace
   open and re-encoded by the existing background job.
5. **Graceful degrade when proxy isn't ready** — recipe falls back
   to original source when `proxy_path` is None, mirroring how
   segmented preview already handles this case. Scrub on the
   original is sluggish but functional; fallback-frame logic
   (`5f0e13f`) covers the cold-decode window. When the proxy job
   finishes and emits `project:changed`, the next recipe re-fetch
   picks up `proxy_path` and the engine transitions to fast scrub.

## Data model

`state/media.rs`:

```rust
pub struct MediaItem {
    // …existing fields…
    /// Format-version of the cached proxy at `proxy_path`. Compared
    /// against `jobs::proxy::PROXY_FORMAT_VERSION` on workspace
    /// open; mismatches mark `proxy_path = None` and re-enqueue
    /// generation. `#[serde(default)]` keeps pre-v3 projects
    /// loadable as version 0.
    #[serde(default)]
    pub proxy_format_version: u32,
}
```

`jobs/proxy.rs`:

```rust
pub const PROXY_FORMAT_VERSION: u32 = 1;
```

Version 1 = adds `-g 30 -keyint_min 30` to the ffmpeg command. Bump
this constant whenever the proxy ffmpeg args change. The job sets
`media.proxy_format_version = PROXY_FORMAT_VERSION` after a
successful encode (via `set_media_derivatives` actor op).

## Decoder seek (frontend)

`apps/desktop/src/preview/webcodecs/decoder.ts` — extend `Mp4Decoder`:

```typescript
async seek(localTimeUs: number): Promise<void> {
  if (!this.mp4box || !this.decoder) return;
  // 1. Tell mp4box to jump to the previous random access point
  //    (keyframe) at-or-before the target. `true` = use RAPs.
  this.mp4box.seek(localTimeUs / 1_000_000, true);
  // 2. Flush the WebCodecs decoder — drops any in-flight frames
  //    and resets internal state for the upcoming keyframe.
  await this.decoder.flush();
  // 3. Mark this decoder's "seek target" so the engine knows
  //    when the first frame at-or-past target has arrived.
  this.seekTargetLocalUs = localTimeUs;
  // 4. Re-start the sample stream from the new position.
  this.mp4box.start();
}
```

`apps/desktop/src/preview/webcodecs/playbackEngine.ts`:

```typescript
class ClipDecoder {
  // …existing fields…
  /// Set by `seek()`; cleared once `pushFrame` sees a frame whose
  /// timestamp >= this target. Lets the engine know whether this
  /// decoder is currently catching up to a recent seek.
  private seekTargetLocalUs: number | null = null;

  async seek(localTimeUs: number): Promise<void> {
    this.seekTargetLocalUs = localTimeUs;
    await this.mp4.seek(localTimeUs);
  }

  isCatchingUp(): boolean {
    return this.seekTargetLocalUs !== null;
  }
}

class PlaybackEngine {
  // …existing fields…
  /// Latest seek target per clip. Set on every `seekTo`; cleared
  /// per-clip when the decoder produces a frame at-or-past it.
  /// This is the existing `clipSeekTargets` field from the
  /// fallback-frame commit (`5f0e13f`), repurposed.
  private clipSeekTargets: Map<string, number> = new Map();

  // …in renderOnce, after syncToTime…
  // For each clip with an outstanding seek target whose decoder
  // isn't already catching up, fire a fresh decoder.seek. The
  // existing decoder retain logic (don't reset pool on seekTo)
  // means decoders persist across pointermoves; we just redirect
  // them via mp4box.seek.
  for (const [layerId, target] of this.clipSeekTargets) {
    const dec = this.decoderPool.getDecoder(layerId);
    if (dec && !dec.isCatchingUp()) {
      void dec.seek(target);
    }
  }
}
```

Key behavioral changes:

- **`decoderPool.reset()` is no longer called from `seekTo`** —
  decoders persist across seeks. They get torn down only when their
  clip leaves the prefetch window (the existing syncToTime logic)
  or when the recipe changes (`setRecipe`).
- **Fallback frame logic (`5f0e13f`) stays.** While the decoder is
  catching up to a new seek target, `buildClipLayer` keeps showing
  the previous good frame.

## Proxy substitution (backend)

`commands.rs::preview_webcodecs_recipe`:

```rust
let snap = handle.snapshot().await;
// Same substitution segmented preview already does. Falls back to
// `media.path_abs` when `proxy_path` is None (proxy not yet
// generated or generation failed) so playback still works at
// reduced scrub responsiveness.
let project_for_recipe = crate::preview::with_proxies_substituted(&snap);
let target = ir::RenderTarget::full(/* … */);
let template_renders = ir::materialize_templates(&project_for_recipe, &cache, &app).await?;
Ok(ir::emit_webcodecs(&project_for_recipe, &target, &template_renders))
```

## Proxy regeneration on first load

`io/migrate.rs` v3 → v4 (or a non-versioned reconciliation pass at
workspace open, alongside the existing path-abs reconciliation):

For each `MediaItem` with `proxy_path` set and `proxy_format_version
< PROXY_FORMAT_VERSION`:

1. Schedule a delete of the old proxy file (best effort; cached
   path is content-addressed by hash, so collisions are tractable).
2. Set `media.proxy_path = None` + `proxy_format_version =
   PROXY_FORMAT_VERSION` (the new version is now the *target*,
   meaning the next generated proxy will be at this version).
3. Re-enqueue the proxy job via `jobs::enqueue_for_media`.

The user sees:
- Workspace opens fast (migration is metadata-only).
- Scrub on existing clips initially uses original source (graceful
  degrade). Feels sluggish on those clips.
- As background proxy jobs finish (one per affected media),
  `project:changed` fires, recipe re-fetches, decoder switches.
- Within a few minutes (depending on media count and CPU), scrub
  is fast on everything.

## What's NOT in scope

- **Multi-resolution proxies** (e.g., 270p for super-fast scrub on
  weak machines). One proxy, one resolution.
- **Cancel-mid-decode if a much-later target arrives** — the
  coalesced loop is latest-wins but doesn't interrupt the current
  decode. A future optimization could `VideoDecoder.flush()` on
  big jumps (e.g., target moves > 5s ahead).
- **Audio scrub** — scrubbed audio is a different problem
  (granular synthesis, time-stretching). Out of scope; audio just
  pauses during drag.
- **Pre-decoded I-frame ImageBitmap cache** — not needed if seek
  is fast enough. Revisit only if the proxy seek isn't responsive.
- **Backward compatibility with old proxies** — the regen pass
  invalidates them. Workspaces upgrading to this version pay a
  one-time re-encode cost.
- **Original source scrub fidelity** — when the proxy isn't ready,
  scrub on the original works but is sluggish. We don't attempt to
  optimize this path.
- **Configurability of GOP size** — hardcoded at 30 (1s at 30fps).
  Bump the constant if telemetry shows it's wrong.

## Test plan

Backend:
- `jobs/proxy::tests` extends `proxy_roundtrip_against_real_ffmpeg`
  to assert keyframes appear at ≥ 1/sec in the output (via
  ffprobe's `-skip_frame nokey -show_frames`).
- New unit test: `media_item_proxy_format_version_round_trips`
  (serde default = 0; explicit value survives save/load).
- New migration test: `proxy_invalidation_on_format_bump` — seed a
  workspace with version-0 proxies, run open, assert
  `proxy_path = None` and proxy job re-enqueued.

Frontend (vitest where practical, manual otherwise):
- Unit: `Mp4Decoder.seek` advances mp4box position and flushes the
  WebCodecs decoder; subsequent frames have timestamps ≥ target.
- Engine state-machine test: simulate a drag (`scrubTargets`
  updated 10x in 100ms); verify that no more than ~3 decoder.seek
  calls fire (coalescing is working).
- Manual: drag the playhead in realtime preview mode after this
  ships — should see frames update at each intermediate position
  within ~50-150ms of the cursor. Release at any point lands on
  the exact frame.

## Implementation phases

| Phase | Subject                                            | Rough files                                                       |
|-------|----------------------------------------------------|-------------------------------------------------------------------|
| S.1   | Proxy GOP + format versioning                      | `jobs/proxy.rs`, `state/media.rs`, `state/actor.rs` (`MediaDerivativesPatch`) |
| S.2   | Workspace-open invalidation pass                   | `io/migrate.rs` (new step) or `io/mod.rs::load_from_dir`           |
| S.3   | Recipe → proxy substitution                        | `commands.rs::preview_webcodecs_recipe`                            |
| S.4   | `Mp4Decoder.seek` + `ClipDecoder.seek`             | `apps/desktop/src/preview/webcodecs/decoder.ts`, `playbackEngine.ts` |
| S.5   | Coalesced seek loop in `PlaybackEngine`            | `apps/desktop/src/preview/webcodecs/playbackEngine.ts`             |
| S.6   | Stop calling `decoderPool.reset()` from `seekTo`   | `playbackEngine.ts` (small but breaks the existing seek model)     |
| S.7   | Tests + manual verification                        | as listed in the test plan                                         |

Each phase is its own commit. S.4 and S.5 can be developed together
(the seek API is meaningless without the loop driving it), but it's
worth split-committing for git history clarity.

## Memory pointers

- [[project-group-system]] — phase G shipped right before this.
- [[feedback-async-block-on-in-async]] — relevant if the seek loop
  ends up touching async-runtime patterns in the backend.
- [[project-preview-segmented-cache]] — the existing
  `with_proxies_substituted` path this work piggybacks on.
