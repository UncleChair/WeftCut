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
  /** install_motif Update: store ops stay Rust; compute the rebind updates. (Task 5) */
  computeMotifRebind(installArgsJson: string): Promise<string>
  /** acknowledge_motif_staleness: compute the ack rebind entries. (Task 5) */
  computeAckMotifRebind(): Promise<string>
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

/** Parse a subtitle body via Rust (compute only) then write the caption track
 *  through the TS actor. Used by both the MCP `apply_subtitles` arm and the
 *  `import_media` `.srt`/`.ass`/`.vtt` branch.
 *
 *  Returns `{ track_id, simplified }` — matching the Rust `apply_subtitles`
 *  ToolResult shape so the MCP caller can forward it verbatim. */
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
 *  result (a media id for import_media, a {track_id, simplified} object for
 *  apply_subtitles and the subtitle import_media branch). Throws on a rejected
 *  actor write or an unhandled tool. */
export async function runHybrid(tool: string, args: Record<string, unknown>, deps: HybridDeps): Promise<unknown> {
  switch (tool) {
    case 'import_media': {
      const path = args.path as string
      // Subtitles are CONSUMED into a caption track (not pooled into the media
      // pool). Read the file, derive a label from the filename, and hand off to
      // applySubtitleBody — format is always null (sniff from body).
      if (/\.(srt|ass|vtt)$/i.test(path)) {
        const body = deps.readFile(path)
        // Derive label from filename stem (e.g. "captions" from "captions.srt").
        const stem = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? null
        return applySubtitleBody(body, null, stem, deps)
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
      return applySubtitleBody(
        args.body as string,
        (args.format as string | null | undefined) ?? null,
        'Captions',
        deps,
      )
    }
    // install_motif / acknowledge_motif_staleness → Task 5; synthesize_speech → Task 6.
    default:
      throw new Error(`runHybrid: unhandled tool ${tool}`)
  }
}
