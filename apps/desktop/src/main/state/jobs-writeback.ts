// apps/desktop/src/main/state/jobs-writeback.ts
//
// Main-process adapter for the Rust jobs derivative write-back. A completed
// background job (proxy / thumbnail / waveform / conform) emits
// `media:derivatives { media_id, patch }` (native/src/jobs/mod.rs
// commit_media_derivatives); the onEvent bridge routes it here. This
// is a thin adapter over the gated `set_media_derivatives` dispatch arm
// (actor.ts) — the patch's proxy fields carry the absent/null/string
// tri-state (`'key' in patch`, mutations/media.ts) the Rust serialize
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

/** `media:workspace_paths` event payload (native/src/jobs/mod.rs
 *  commit_media_workspace_paths): the result of the background workspace-copy
 *  job. Carries the full 5-field WorkspacePaths so the TS actor's
 *  set_media_workspace_paths dispatch is fully populated. */
export interface MediaWorkspacePathsEvent {
  media_id: string
  path_abs: string
  path_rel: string
  file_hash_blake3: string
  file_size: number
  file_mtime: number
}

/** Apply a `media:workspace_paths` event to the TS actor (sibling of
 *  applyDerivativesEvent; the workspace-copy job's path/hash write-back).
 *  The dispatch arg shape is `{ media, paths }` (actor.ts
 *  set_media_workspace_paths arm — `paths` is the 5-field WorkspacePaths).
 *  MediaNotFound is benign (the media may have been removed between import
 *  and copy-completion) — logged, not thrown. */
export function applyWorkspacePathsEvent(
  actor: Pick<ActorHandle, 'dispatch'>,
  payload: MediaWorkspacePathsEvent,
): DispatchResult {
  const r = actor.dispatch('set_media_workspace_paths', {
    media: payload.media_id,
    paths: {
      path_abs: payload.path_abs,
      path_rel: payload.path_rel,
      file_hash_blake3: payload.file_hash_blake3,
      file_size: payload.file_size,
      file_mtime: payload.file_mtime,
    },
  })
  if (!r.ok) {
    console.warn(`[jobs-writeback] set_media_workspace_paths failed for ${payload.media_id}: ${r.error.error}`)
  }
  return r
}
