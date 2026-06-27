import type { AudioParams, LayerParams, MediaItem, Project, Track, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { defaultTransform } from './add'

/** commands/mutations.rs:91 — the canonical VideoClip layer shape. blend_mode
 *  default = Normal, transform default per defaultTransform. */
export function videoClipParams(media: Uuid, srcInUs: number, srcOutUs: number): LayerParams {
  return { kind: 'VideoClip', media, src_in_us: srcInUs, src_out_us: srcOutUs,
    transform: defaultTransform(), opacity: { mode: 'Static', value: 1 }, crop: null,
    flip_h: false, flip_v: false, blend_mode: 'Normal', speed: 1, fade_in_us: 0, fade_out_us: 0 }
}
/** commands/mutations.rs:109 — standalone Audio layer. AudioRole is
 *  #[serde(rename_all="kebab-case")] (audio_role.rs:14), so Rust AudioRole::Music
 *  serializes to the lowercase wire form "music" — the TS model's AudioRole. */
export function audioParams(media: Uuid, srcInUs: number, srcOutUs: number): AudioParams {
  return { kind: 'Audio', media, src_in_us: srcInUs, src_out_us: srcOutUs,
    gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
    fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' }
}
/** commands/mutations.rs:123 — Image overlay (no src range; validator checks
 *  only the media ref). */
export function imageOverlayParams(media: Uuid): LayerParams {
  return { kind: 'ImageOverlay', media, transform: defaultTransform(),
    opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal', fade_in_us: 0, fade_out_us: 0 }
}

/** Fixed-defaults media-pool item; the byte-identical twin of the driver's
 *  media_item helper. imported_at is reconciled against the regenerated oracle
 *  (the only Rust-DateTime-fragile field). path_abs uses forward slashes so
 *  Rust PathBuf serialization is platform-stable.
 *  withAudio mirrors prod_driver.rs AudioStreamMeta { sample_rate:0, channels:0, codec:"" }
 *  — the auto-pair predicate checks audio.is_some(), not the field values. */
export function mediaItemTemplate(id: Uuid, kind: MediaItem['kind'], durationUs: number | null, withAudio = false): MediaItem {
  return {
    id, label: null, path_abs: 'media/clip.bin', path_rel: null, kind,
    metadata: { duration_us: durationUs, video: null,
      audio: withAudio ? { sample_rate: 0, channels: 0, codec: '' } : null,
      container_format: null },
    file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '2026-01-01T00:00:00Z',
    proxy_path: null, quick_proxy_path: null, proxy_bypassed: false, export_uses_original: false,
    proxy_format_version: 0, conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
}

/** actor.rs:269-286 MediaDerivativesPatch. proxy_path/quick_proxy_path are
 *  Option<Option<PathBuf>> — tri-state: key absent = leave, null = clear, string
 *  = set. The rest are plain Option<T> (set-or-leave; never cleared here). */
export interface MediaDerivativesPatch {
  proxy_path?: string | null
  quick_proxy_path?: string | null
  proxy_format_version?: number
  proxy_bypassed?: boolean
  export_uses_original?: boolean
  waveform_path?: string | null
  conform_path?: string | null
  thumbnails_dir?: string | null
}
export interface WorkspacePaths {
  path_abs: string; path_rel: string; file_hash_blake3: string; file_size: number; file_mtime: number
}

/** do_set_media_derivatives (actor.rs:3534) — patch one pool item's derivative
 *  fields, returning a new pool. MediaNotFound if absent. No validation (mirrors
 *  Rust). The caller replaces the pool everywhere + broadcasts unrecorded. */
export function applySetMediaDerivatives(pool: Record<string, MediaItem>, id: Uuid, patch: MediaDerivativesPatch): Record<string, MediaItem> {
  const item = pool[id]
  if (!item) throw new CommandFailure({ error: 'MediaNotFound', media: id })
  const next: MediaItem = { ...item }
  // tri-state (Option<Option<PathBuf>>): presence distinguishes leave from clear.
  if ('proxy_path' in patch) next.proxy_path = patch.proxy_path ?? null
  if ('quick_proxy_path' in patch) next.quick_proxy_path = patch.quick_proxy_path ?? null
  if (patch.proxy_format_version !== undefined) next.proxy_format_version = patch.proxy_format_version
  if (patch.proxy_bypassed !== undefined) next.proxy_bypassed = patch.proxy_bypassed
  if (patch.export_uses_original !== undefined) next.export_uses_original = patch.export_uses_original
  // plain Option<PathBuf> (Rust `if let Some(p)`): set only when present-and-non-null.
  if (patch.waveform_path != null) next.waveform_path = patch.waveform_path
  if (patch.conform_path != null) next.conform_path = patch.conform_path
  if (patch.thumbnails_dir != null) next.thumbnails_dir = patch.thumbnails_dir
  return { ...pool, [id]: next }
}

/** do_set_media_workspace_paths (actor.rs:3500) — set the workspace-relative
 *  path + file fingerprint after the import copy. path_rel is always set. */
export function applySetMediaWorkspacePaths(pool: Record<string, MediaItem>, id: Uuid, paths: WorkspacePaths): Record<string, MediaItem> {
  const item = pool[id]
  if (!item) throw new CommandFailure({ error: 'MediaNotFound', media: id })
  return { ...pool, [id]: { ...item, path_abs: paths.path_abs, path_rel: paths.path_rel,
    file_hash_blake3: paths.file_hash_blake3, file_size: paths.file_size, file_mtime: paths.file_mtime } }
}

/** Set ONLY the source content hash on a pool item — used by the hash-first
 *  import (stateless-compute Phase 4): the standalone BLAKE3 pass result replaces
 *  the provisional probe hash BEFORE any derivative job is enqueued. UNRECORDED,
 *  no validation (mirrors the sibling setters). MediaNotFound if absent. */
export function applySetMediaHash(pool: Record<string, MediaItem>, id: Uuid, hash: string): Record<string, MediaItem> {
  const item = pool[id]
  if (!item) throw new CommandFailure({ error: 'MediaNotFound', media: id })
  return { ...pool, [id]: { ...item, file_hash_blake3: hash } }
}

/** do_remove_media (actor.rs:3439-3451) — layer ids referencing this media,
 *  scanned in track-then-layer order. VideoClip/Audio/ImageOverlay only. */
export function referencingLayers(p: Project, id: Uuid): Uuid[] {
  const out: Uuid[] = []
  for (const t of p.tracks) for (const l of t.layers) {
    const k = l.params.kind
    if ((k === 'VideoClip' || k === 'Audio' || k === 'ImageOverlay') && l.params.media === id) out.push(l.id)
  }
  return out
}

/** actor.rs:2573 do_separate_audio — lift an Audio layer onto a fresh
 *  non-reserved track inserted directly BEFORE its source. The new-track id is
 *  minted AFTER the locate + kind checks (so LayerNotFound/WrongLayerKind burn
 *  no id) but BEFORE commit's op_id (the keystone). Track defaults mirror
 *  Track::new() (== applyAddTrack). No autofit (no time change). */
export function applySeparateAudio(p: Project, idGen: IdGen, layerId: Uuid): Uuid {
  let ti = -1, li = -1
  for (let t = 0; t < p.tracks.length; t++) {
    const idx = p.tracks[t].layers.findIndex((l) => l.id === layerId)
    if (idx >= 0) { ti = t; li = idx; break }
  }
  if (ti < 0) throw new CommandFailure({ error: 'LayerNotFound', layer: layerId })
  const source = p.tracks[ti]
  const layer = source.layers[li]
  if (layer.params.kind !== 'Audio') throw new CommandFailure({ error: 'WrongLayerKind', layer: layerId, expected: 'Audio' })

  const newId = idGen() // after the checks, before commit's op_id (keystone)
  const srcLabel = source.label
  const label = srcLabel && srcLabel.length > 0 ? `${srcLabel} (audio)` : 'Audio'
  source.layers.splice(li, 1)
  const newTrack: Track = { id: newId, label, enabled: true, locked: false, muted: false, solo: false,
    removable: true, role: null, transient: false, height_px: 64, layers: [layer] }
  p.tracks.splice(ti, 0, newTrack)
  return newId
}
