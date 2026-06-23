// apps/desktop/src/main/state/jobs-writeback.ts
//
// Main-process adapter for the Rust jobs derivative write-back (spec 3c-ii / D5).
// When the TS actor is authoritative, a completed background job (proxy /
// thumbnail / waveform / conform) emits `media:derivatives { media_id, patch }`
// (native/src/jobs/mod.rs commit_media_derivatives) instead of writing the Rust
// actor; the onEvent bridge routes it here (live route wired in 3c-ii-d). This
// is a thin adapter over the gated `set_media_derivatives` dispatch arm
// (actor.ts:374) — the patch's proxy fields carry the absent/null/string
// tri-state (`'key' in patch`, mutations/media.ts:67) the Rust serialize
// preserves. UNRECORDED on the actor (durable across undo; 1 broadcast id).
import type { ActorHandle, DispatchResult } from './actor'
import type { MediaDerivativesPatch } from './mutations/media'

export interface MediaDerivativesEvent {
  media_id: string
  patch: MediaDerivativesPatch
}

/** Apply a `media:derivatives` event to the TS actor. Returns the dispatch
 *  result. A `MediaNotFound` is benign (the media may have been removed between
 *  job enqueue and completion) — logged, not thrown, matching the Rust path's
 *  `warn!`-and-continue on a `set_media_derivatives` Err. */
export function applyDerivativesEvent(
  actor: Pick<ActorHandle, 'dispatch'>,
  payload: MediaDerivativesEvent,
): DispatchResult {
  const r = actor.dispatch('set_media_derivatives', { media: payload.media_id, patch: payload.patch })
  if (!r.ok) {
    console.warn(`[jobs-writeback] set_media_derivatives failed for ${payload.media_id}: ${r.error.error}`)
  }
  return r
}
