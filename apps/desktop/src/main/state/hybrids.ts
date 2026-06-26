// apps/desktop/src/main/state/hybrids.ts
//
// Native-compute → TS-write hybrid orchestrator (Phase 3d-e). Under
// WEFTCUT_TS_ACTOR a write-bearing native channel splits into two halves: Rust
// does the heavy/impure COMPUTE (probe/hash/parse/synthesize) and hands back a
// serializable result; the TS host applies the WRITE through the authoritative
// TS actor. This file is the shared dispatcher both the renderer router
// (router.ts `{kind:'hybrid'}`) and the MCP handler (server.ts) call via the
// host's `hybridDeps`. One arm per hybrid tool; the rest land in later tasks.
import type { ActorHandle } from './actor'

/** Rust compute facade — each method runs a native (no-actor-write) computation
 *  and returns a serialized result. Built in index.ts from the Backend napi; the
 *  later-task methods are wired as their hybrids land (Tasks 4-6). */
export interface ComputeNapi {
  /** Probe + hash a media file → serialized MediaItem JSON. (import_media) */
  probeMedia(path: string): Promise<string>
  /** Parse a subtitle body → {cues, simplified, label} JSON. (apply_subtitles, Task 4) */
  parseSubtitles(body: string, format: string | null): Promise<string>
  /** synthesize_speech: TTS + cache + probe → {media_item, …} JSON. (Task 6) */
  synthesizeSpeechCompute(argsJson: string): Promise<string>
}

export type HybridDeps = {
  actor: ActorHandle
  compute: ComputeNapi
  /** Kick the existing derivative jobs (proxy/conform/thumb/waveform) for a set
   *  of pool items — thin wrapper over the Backend `enqueueJobsForMedia` napi. */
  enqueueDerivatives: (items: unknown[]) => Promise<void>
  /** Queue the background workspace-copy job for an inserted media item. No-op
   *  napi when no workspace; the copy's path/hash write-back is seam-routed. */
  enqueueWorkspaceCopy: (mediaId: string, sourcePath: string) => Promise<void>
  /** Current workspace dir, or null. Gate for the workspace-copy enqueue. */
  workspaceDir: () => string | null
  /** node:fs readFile (utf8) — for the subtitle hybrid (Task 4). */
  readFile: (p: string) => string
  /** Current composition geometry — for caption layout (Task 4) / placement (Task 6). */
  snapshotComposition: () => { width: number; height: number; duration_us: number }
}

/** Return the id of the topmost (last) track, or create a new "Voiceover"
 *  track and return its id. "Topmost" = last in the `tracks` array. */
function ensureAudioTrack(deps: HybridDeps): string {
  const snap = deps.actor.snapshot()
  if (snap.tracks.length > 0) {
    return snap.tracks[snap.tracks.length - 1].id
  }
  // No tracks at all — create a "Voiceover" track. Pathological-only branch:
  // production projects always carry the reserved, non-removable A/B-roll tracks,
  // so a zero-track project is unconstructable through the validated actor.
  const r = deps.actor.dispatch('add_track', { label: 'Voiceover' })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as string
}

/** Parse a subtitle body via Rust (compute only) then write the caption track
 *  through the TS actor. Used by both the MCP `apply_subtitles` arm and the
 *  `import_media` `.srt`/`.ass`/`.vtt` branch.
 *
 *  Returns `{ track_id, simplified }`. Both call sites UNWRAP it: the renderer
 *  import branch returns the bare `track_id` string (flag-off parity — see
 *  media.rs), and the MCP arm builds the `ToolResult::text` message (tools.rs).
 *  Do NOT return this object straight out of `runHybrid` — server.ts stringifies
 *  the hybrid result, so an object would surface as "[object Object]". */
async function applySubtitleBody(
  body: string,
  format: string | null,
  label: string | null,
  deps: HybridDeps,
): Promise<{ track_id: string; simplified: boolean }> {
  const { cues, simplified } = JSON.parse(await deps.compute.parseSubtitles(body, format)) as {
    cues: unknown[]
    simplified: boolean
  }
  const { width, height } = deps.snapshotComposition()
  const r = deps.actor.dispatch('add_caption_track', { cues, comp_w: width, comp_h: height, label })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return { track_id: r.value as string, simplified }
}

/** Run a hybrid tool: Rust compute then TS-actor write. Returns the tool's
 *  result — a STRING in every arm: a media id (import_media), the bare caption
 *  track id (import_media `.srt` branch, flag-off parity), or the MCP
 *  ToolResult text (apply_subtitles). server.ts stringifies the result, so the
 *  arms must not return objects. Throws on a rejected actor write or an
 *  unhandled tool. */
export async function runHybrid(tool: string, args: Record<string, unknown>, deps: HybridDeps): Promise<unknown> {
  switch (tool) {
    case 'import_media': {
      const path = args.path as string
      // Subtitles are CONSUMED into a caption track (not pooled into the media
      // pool). Read the file, derive a label from the filename, hand off to
      // applySubtitleBody (format null → sniff from body), and return the BARE
      // track id string — flag-off import_media returns `Ok(track_id)` (media.rs)
      // and discards `simplified`, so the hybrid path must match.
      if (/\.(srt|ass|vtt)$/i.test(path)) {
        const body = deps.readFile(path)
        // Full filename WITH extension as the label — flag-off uses file_name()
        // (e.g. "captions.srt"), so match that for parity.
        const label = path.replace(/\\/g, '/').split('/').pop() ?? null
        return (await applySubtitleBody(body, null, label, deps)).track_id
      }
      const item = JSON.parse(await deps.compute.probeMedia(path)) as { id: string }
      const r = deps.actor.dispatch('add_media_item', { media: item })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      // Derivative jobs (proxy/conform/thumb/waveform) — content-addressed, so
      // they read the original until the workspace copy completes.
      await deps.enqueueDerivatives([item])
      // Workspace copy: copies the source into <workspace>/Media, rehashes (the
      // probe deferred the hash to "pending-{id}" when a workspace exists), and
      // writes set_media_workspace_paths back via the media:workspace_paths seam
      // (commit_media_workspace_paths). No-op napi if no workspace.
      if (deps.workspaceDir()) await deps.enqueueWorkspaceCopy(item.id, path)
      return item.id
    }
    case 'apply_subtitles': {
      // MCP-only: body + optional format tag. Label is always "Captions" to
      // match the Rust flag-off path (tools.rs apply_subtitles → "Captions").
      // Return the exact ToolResult text the Rust tool emits (tools.rs:462-466):
      // the bare track id, or the id + a simplified-styling annotation. server.ts
      // wraps this string into `{content:[{type:'text', text}]}`.
      const { track_id, simplified } = await applySubtitleBody(
        args.body as string,
        (args.format as string | null | undefined) ?? null,
        'Captions',
        deps,
      )
      return simplified ? `${track_id} (some ASS styling was simplified)` : track_id
    }
    case 'synthesize_speech': {
      // Rust: TTS compute (validate text → pick synthesizer → cache key →
      // synthesize+write → spawn_blocking probe → build MediaItem). Returns
      // {media_item, duration_us, cached}. The TS host applies the WRITES:
      // add_media_item + enqueueDerivatives + resolve track + add Audio layer
      // (Voiceover role, single commit). Mirrors synthesize_speech (tools.rs:2673)
      // flag-off write tail.
      const { media_item, duration_us, cached } = JSON.parse(
        await deps.compute.synthesizeSpeechCompute(JSON.stringify(args)),
      ) as { media_item: { id: string }; duration_us: number; cached: boolean }

      const addR = deps.actor.dispatch('add_media_item', { media: media_item })
      if (!addR.ok) throw new Error(JSON.stringify(addR.error))

      await deps.enqueueDerivatives([media_item])

      const tStart = (args.t_start_us as number | undefined) ?? deps.snapshotComposition().duration_us
      const tEnd = tStart + duration_us

      const trackId = (args.target_track_id as string | undefined) ?? ensureAudioTrack(deps)

      // Add the Audio layer in a SINGLE commit with role:'voiceover' — mirrors
      // synthesize_speech's one `add_layer(AudioParams{role:Voiceover})`
      // (tools.rs:2803-2819). The add_layer 'audio' arm accepts the optional
      // `role` override (actor.ts), so no separate update_layer_params commit —
      // matching the Rust history granularity (one entry for the layer add).
      const layerR = deps.actor.dispatch('add_layer', {
        kind: 'audio',
        track: trackId,
        media: media_item.id,
        src_in_us: 0,
        src_out_us: duration_us,
        role: 'voiceover',
        t_start_us: tStart,
        t_end_us: tEnd,
      })
      if (!layerR.ok) throw new Error(JSON.stringify(layerR.error))
      const layerId = layerR.value as string

      // Return a JSON STRING — server.ts wraps via String(result), so returning
      // an object would surface as "[object Object]" (the Task-4 apply_subtitles
      // trap). Mirrors SynthesizeSpeechResult snake_case serde (tools.rs:2396).
      return JSON.stringify({ layer_id: layerId, media_id: media_item.id, t_start_us: tStart, t_end_us: tEnd, cached })
    }
    default:
      throw new Error(`runHybrid: unhandled tool ${tool}`)
  }
}
