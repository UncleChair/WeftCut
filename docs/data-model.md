# Data Model

The project state is the single source of truth. UI, audio IR
compiler, MCP server, and persistence are all clients of it.

## Foundational decisions

### Time: integer microseconds (`i64`)
Precise (1 µs ≪ any frame), fps-independent, integer arithmetic. f64 seconds is exposed only at API surfaces for ergonomics.

### Timeline-field alignment: composition frame
Every persisted layer `t_start_us`/`t_end_us` and the
`composition.duration_us` is on a composition-frame boundary. The actor
snap-rounds (half-up) every TimeUs parameter at the top of each
mutator against `composition.fps`, so UI / MCP / future agents all
produce aligned state without re-implementing the rule. Source-time
fields (`src_in_us`/`src_out_us`) are NOT snapped — they're in the
source media's own time space, and the renderer's
`sampleIndexForPtsUs` naturally handles whatever value lands there.

Display format follows the same grid: timecode reads SMPTE
`HH:MM:SS:FF`, NDF (non-drop-frame) at every fps — at 29.97/59.94 the
displayed timecode drifts vs. wall-clock by ~3.6s/hour. v1 is
consumer-NLE territory; DF is reserved for a future per-project flag.

Changing `composition.fps` re-snaps every layer's timeline fields
atomically in the same patch transaction.

The **playhead** is the one exception to boundary semantics. Every
boundary entity above (`t_start_us`, `t_end_us`, `composition.duration_us`,
trim handles) is exclusive and may equal `duration_us`. The playhead,
in contrast, is a frame-anchor: it sits on the START of a real,
displayable frame and is clamped to `[0, lastFrameAnchorUs]` where
`lastFrameAnchorUs = max(0, duration_us − frameDurUs)`. The
post-last-frame slot at exactly `duration_us` is unreachable for the
playhead — pressing End in a 10 s 30 fps comp lands at `00:00:09:29`
(the start of frame 299), not `00:00:10:00`. Helper:
`lastFrameAnchorUs` in `apps/desktop/src/frames.ts`. The clamp lives in
the App-level `seekTo` so every UI seek path inherits it once; the
PlaybackEngine's auto-pause parks at the same value so the displayed
timecode and the painted frame agree at the end of the timeline.

Seeking is the time ruler's job alone. A click or drag on the ruler
strip scrubs the playhead, and the ruler is the only surface that does —
clicks in the track body select or deselect clips and never move the
playhead. Seeking and selection are therefore independent: scrubbing
never clears the current selection, and selecting a clip never moves the
playhead. `Timeline.tsx` routes the ruler's pointer gesture through
`beginRulerScrub`; the timeline-root `onClick` is the single
background-deselect, and clip and ruler clicks `stopPropagation` so they
never reach it. (The ruler keeps scrubbing in blade mode — blade only
governs clip clicks.)

### Identity: UUID v7 everywhere
Stable, opaque, time-sortable. Never use array indices for identity — they shift on every insert and break agent-held references mid-conversation.

```rust
type MediaId = Uuid;
type TrackId = Uuid;
type LayerId = Uuid;
type KeyframeId = Uuid;
type MarkerId = Uuid;
type CheckpointId = Uuid;
type OpId = Uuid;
type GroupId = Uuid;
type TransitionId = Uuid;
```

### History: persistent-snapshot tree
Every mutation produces a new `Arc<Project>`. Old `Arc`s stay alive in the history ring. Built on `imbl` (`im::Vector`, `im::HashMap`) so memory cost per edit is `O(depth)`, not `O(state)`.

### Track-based timeline
Layers belong to one track. Tracks are kind-agnostic — any layer kind
can live on any track. **Layers of the same class (video-class vs.
audio-class) must not overlap in time on the same track** — a hard
invariant; agents that violate it get a structured error suggesting
"create new track" or "trim existing." Cross-class overlap on one
track (e.g. a Video and an Audio layer at the same time) is allowed
and is the default for paired AV imports.

## Top-level shape

```rust
struct Project {
    schema_version: u32,
    project_id: Uuid,                             // stable across saves
    metadata: ProjectMetadata,
    composition: Composition,
    media_pool: imbl::HashMap<MediaId, MediaItem>,
    tracks: imbl::Vector<Track>,                  // 0 = bottom z-stack, last = top
    markers: imbl::Vector<Marker>,
    transitions: imbl::Vector<Transition>,
    groups: imbl::Vector<Group>,
    audio_roles: imbl::HashMap<AudioRole, RoleMixSettings>,  // per-role mix buses
    settings: ProjectSettings,                    // proxy res, autosave, etc.
}
```

`audio_roles` holds one `RoleMixSettings { gain_db, muted, solo }` per
mixing role. The map is sparse: an absent role resolves to defaults
(0 dB, unmuted, unsoloed) through `Project::role_mix`, so a project that
never opened the Mixer plays every role at unity. The field carries
`#[serde(default)]`, so older `.vproj` files load with an empty table
(every role at unity) without a schema bump. The mixing model itself —
how the bus folds into layer envelopes, how mute/solo gate selection —
is described in [docs/audio.md](audio.md) and [ADR 0023](adr/0023-audio-mixes-by-role-not-track.md).

## `Composition`

```rust
struct Composition {
    width: u32,
    height: u32,
    fps: Rational,            // (num, den) — handles 23.976, 29.97 cleanly
    duration_us: i64,         // auto-fits to max(layer.t_end_us) while !duration_pinned
    duration_pinned: bool,    // explicit user override; cleared by fit_composition_to_layers
    sample_rate: u32,         // 48000 default
    channels: u8,             // 2 default
    color_space: ColorSpace,  // Bt709 default
    background: Rgba,
}
```

`fps` MUST be rational. `30000/1001 ≠ 29.97`, and ffmpeg cares.

`duration_us` follows `max(layer.t_end_us)` bidirectionally — growing on adds, shrinking on deletes / inward trims — until the user pins it by calling `set_composition { duration_us }`. While pinned, only an overflow guard moves the value (a new layer extending past the pinned duration still bumps it up; the pin stays set). `fit_composition_to_layers` clears the pin and snaps duration to the live high-water mark. See ADR 0005.

## `MediaItem`

```rust
struct MediaItem {
    id: MediaId,
    label: Option<String>,
    path_abs: PathBuf,                // computed at load = workspace.join(path_rel)
    path_rel: Option<PathBuf>,        // authoritative; relative to workspace root
    kind: MediaKind,                  // Video | Audio | Image | Subtitle
    metadata: MediaMetadata,
    proxy_path: Option<PathBuf>,      // export master: source-res (≤4K) H.264 in Cache/proxies/
    proxy_format_version: u32,        // a bump forces proxy regen on next load
    quick_proxy_path: Option<PathBuf>,// 720p short-GOP scrub proxy; the preview source
    proxy_bypassed: bool,             // source decodes directly for preview+export; no proxy
    export_uses_original: bool,       // export decodes the original; preview uses the quick proxy
    waveform_path: Option<PathBuf>,
    conform_path: Option<PathBuf>,    // canonical 48 kHz PCM (VCONF); see docs/audio.md
    thumbnails_dir: Option<PathBuf>,
    file_hash_blake3: String,         // for relink-by-content + cache key
    file_size: u64,
    file_mtime: u64,
    imported_at: Timestamp,
}
```

`path_rel` is the on-disk anchor (workspace-relative, e.g. `Media/clip.mp4`). On load, `io::load_from_dir` rewrites `path_abs = workspace.join(path_rel)` so workspace moves between machines don't break references. `path_abs` is the in-memory convenience path consumed by the IR compiler + background jobs. If `path_rel` is missing (legacy v1 project before migration) or the resolved file doesn't exist, the pool item gets a "missing media" badge — the project still loads.

The proxy fields encode a video's decode routing, decided per source on
two independent axes (ADR 0009): an **export source** axis (can the export
Worker decode this source directly?) and a **preview source** axis (does the
original scrub acceptably — friendly H.264, <=1080p, moderate bitrate, known
short GOP?). The combinations:

- **Bypass** (`proxy_bypassed = true`): a friendly short-GOP H.264 source;
  no proxy generated — preview and export both read the original.
- **DirectExport** (`export_uses_original = true`): export reads the original
  at full quality, while a 720p short-GOP `quick_proxy_path` is generated as
  the preview scrub source.
- **Proxied** (neither flag; `proxy_path` set): a source WebCodecs can't
  decode directly (non-H.264-family codec, or 10-bit/HDR) — a 720p
  `quick_proxy_path` is the preview source and a source-resolution
  `proxy_path` is the export master.

`proxy_path` is a pure **export master** at source resolution (≤4K,
ADR 0011) — never used for preview. `quick_proxy_path` is the **permanent
preview source**: it is NOT cleared when the master lands, and preview
prefers it over `proxy_path`. Preview readiness is therefore
`quick_proxy_path || proxy_path || proxy_bypassed || export_uses_original`;
export readiness is `proxy_path || proxy_bypassed || export_uses_original`.

The static import route is intentionally narrow. H.264 and AV1 8-bit,
browser-friendly sources can be marked DirectExport; HEVC, VP9, ProRes, and
10-bit/HDR sources route to a full export master. The renderer still verifies
DirectExport sources with a real `probeSourceDecodable` key-frame decode before
export. If the probe fails on the current machine, `ensure_full_proxy`
route-corrects the media by clearing `export_uses_original` and enqueueing a
full proxy, and the export waits for the store to show a usable path.

Import also runs a session-scoped preview decodability sweep for sources that
would otherwise be blank until a proxy lands. A successful probe lets preview
temporarily read the original via `previewPlaybackPathFor(...,
{ previewDecodable: true })`; this bridge is not persisted and is replaced by
the quick proxy once it exists. The import optimization dialog classifies the
same states as `checking`, `bridged`, `transcoding`, `failed`, `ready`, or
`direct`; it is an informational, non-blocking surface.

Background derivative jobs may start before `file_hash_blake3` is final, keyed
on a temporary `pending-{media_id}` hash that migrates to the content hash when
the import copy finishes (ADR 0007).

### Media kinds & import classification

`kind` is decided at import by `io::probe::detect_kind`, ffprobe-first with an
extension fallback:

- A probed **video stream** means `Video` — except three ffprobe traps. Embedded
  cover art (mp3/m4a/flac/ogg) probes as a video stream with
  `disposition.attached_pic`; those streams are skipped entirely (neither kind
  evidence nor metadata). Still images (png/jpg/webp/gif/bmp/tiff) probe as a
  single-frame video stream; an image-codec stream counts as `Video` only when
  it actually moves with a true video codec (demuxed `nb_frames > 1`, or a real
  duration — think motion-JPEG in an AVI/MOV container). Animated still-image
  formats — GIF, animated WebP, APNG, and animated AVIF — are the third trap:
  they probe as multi-frame but their codec is an image codec (gif, webp, png,
  or av1 in an image container). `detect_kind` uses the `MediaMetadata.container_format`
  field (populated by ffprobe's `format_name`) to distinguish animated AVIF
  (container `avif`/`heif`) from a true AV1 video stream (container `mp4`/`matroska`
  etc.), and checks the codec name for the other three. All four classify as
  `Image`, not `Video`, so they land as `ImageOverlay` layers with no proxy or
  conform jobs. Motion-JPEG (codec `mjpeg`) in a movie container stays `Video`.
- A probed **audio stream** (and no counting video stream) means `Audio`.
- No probe (ffprobe missing/unreadable) falls back to the extension lists
  below; anything unrecognized defaults to `Video`.

Supported formats per kind — the import dialog offers exactly these, and the
extension fallback recognizes them plus `tif`/`tiff`:

| Kind | Dialog extensions | Notes |
| --- | --- | --- |
| Video | mp4, mov, mkv, webm, avi, m4v | Decode routing per the proxy axes above. |
| Audio | wav, mp3, flac, aac, m4a, ogg, opus | Anything ffmpeg decodes conforms; the VCONF cache is the only contract (docs/audio.md). |
| Image | png, jpg/jpeg, gif, webp, bmp, avif | Rendered from the ORIGINAL with no derivatives. Still images use `createImageBitmap` (single frame, 3 s default duration). Animated formats (GIF, animated WebP, APNG, animated AVIF) decode all frames once via WebCodecs `ImageDecoder` (downscaled to composition size, cached per media) and loop at native speed to fill the layer; a freshly-placed animated image defaults to one native loop. |
| Subtitle | srt, ass, vtt | Preview-only (JASSUB); not burned into exports. |

TIFF classifies as `Image` when it arrives anyway (drag-drop / MCP take any
path) but Electron/Chromium's `createImageBitmap` cannot decode it — the layer
composites nothing — so the dialog doesn't offer it. SVG is unsupported:
unlisted extensions default to `Video` and won't produce a usable layer.

Derivative jobs follow the kind: `Video` gets the proxy axes + waveform +
conform + thumbnails; `Audio` gets waveform + conform only (ready as soon as
the workspace copy lands — no proxy wait); `Image`/`Subtitle` get none.

## `Track`

```rust
struct Track {
    id: TrackId,
    label: Option<String>,
    enabled: bool,                    // eye toggle: hides video + silences audio for the whole track
    muted: bool,                      // retained for back-compat load; no longer gates audio (mixing is per-role)
    solo: bool,                       // retained for back-compat load; no longer gates audio (mixing is per-role)
    locked: bool,                     // lock toggle: UI prevents edits; actor rejects structural ops on locked tracks
    removable: bool,                  // false → delete_track refuses; default tracks set this
    transient: bool,                  // auto-prune candidate when emptied
    role: Option<TrackRole>,          // "a-roll" | "b-roll" | "audio-a" | "audio-b" | None
    height_px: u16,                   // UI display preference
    layers: imbl::Vector<Layer>,      // sorted by t_start; same-class layers never overlap
}
```

Tracks are kind-agnostic — any `LayerParams` variant can live on any
track. The dominant class on a track ("Video", "Audio", "Empty") is
derived from the layers it actually contains.

The live track-header controls are the **eye** and the **lock**. The
eye sets `enabled` — the whole-track gate that hides the track's video
and silences its audio together. The lock sets `locked` (the actor
rejects `move_layer`, `trim_layer`, `split_layer`, `delete_layer`,
`update_layer`, and `update_layer_params` on layers that belong to a
locked track, including via group fan-out). Both are toggled through
`update_track_flags`, an **unrecorded** mutation (same
`replace_settings_everywhere` convention as `ProjectSettings` patches)
so undo never flips a track control back.

`muted` and `solo` are **retained on the struct for back-compat load**
but no longer gate audio. Audio mute/solo is now a property of the
mixing **role**, not the track: the per-role `{gain_db, muted, solo}`
in `Project.audio_roles` decides what is audible (see
[docs/audio.md](audio.md) and [ADR 0023](adr/0023-audio-mixes-by-role-not-track.md)).
`update_track_flags` still accepts the two fields so old callers and
projects round-trip, and they continue to deserialize, but the export
and preview mixers ignore them. Audio control therefore stacks in three
scopes: **clip mute** (`AudioParams.mute`, one layer), **role
mute/solo/gain** (`audio_roles`, a whole category of sound), and **track
`enabled`** (the eye — an entire track's picture and audio at once).

A fresh project ships with non-removable tracks tagged with A-roll /
B-roll / audio roles. They give every project a guaranteed drop
target so the UI doesn't have to handle "no tracks exist" as a
separate case, and they give agents a stable "where do I put this?"
answer when they don't have other context. Users can rename them;
they cannot delete them. `delete_track` returns
`CommandError::TrackNotRemovable` if invoked on one.

When a layer deletion empties its track, two pruning rules apply.
`transient` tracks (import-created holding tracks) are always removed.
Plain tracks — removable, unlocked, no role stamp — are removed too
when `settings.auto_delete_empty_tracks` is on (the default), folded
into the same history entry as the layer deletion so a single undo
restores layer and track together. Role-stamped tracks survive
emptying unconditionally: legacy projects predate the `removable`
field (it deserializes `true`), so the role stamp is the load-bearing
guard for their reserved skeleton. The toggle lives in the Settings
panel and travels with the project; like all `ProjectSettings`
fields it is preference-shaped, patched into every history snapshot
on change rather than recorded, so undo never flips it.

## `Layer`

Common envelope, kind-specific params:

```rust
struct Layer {
    id: LayerId,
    label: Option<String>,
    t_start_us: i64,
    t_end_us: i64,                    // exclusive
    enabled: bool,
    locked: bool,
    metadata: imbl::HashMap<String, Value>,   // extension point
    params: LayerParams,
}

enum LayerParams {
    VideoClip(VideoClipParams),
    ImageOverlay(ImageOverlayParams),
    Text(TextParams),
    Motif(MotifParams),
    Audio(AudioParams),
    Subtitles(SubtitlesParams),
    Color(ColorParams),
}
```

### `VideoClipParams`

```rust
struct VideoClipParams {
    media: MediaId,
    src_in_us: i64,
    src_out_us: i64,
    transform: Transform,
    opacity: Animated<f64>,
    crop: Option<Rect>,
    flip_h: bool,
    flip_v: bool,
    blend_mode: BlendMode,
    speed: f64,                       // 1.0 default; warns if != 1 with attached audio
}
```

### `TextParams`

```rust
struct TextParams {
    content: String,
    font: FontSpec,
    color: Animated<Rgba>,
    align: TextAlign,
    transform: Transform,
    opacity: Animated<f64>,
    shadow: Option<Shadow>,
    outline: Option<Outline>,
    intro: Option<TextAnimPreset>,    // FadeIn, SlideUp, Typewriter, ...
    outro: Option<TextAnimPreset>,
    backend_hint: TextBackend,        // Auto | DrawText | Rasterized (legacy schema field)
}
```

Preview and export render text through PixiJS `TextSprite` (native canvas text,
shadow/outline filters, intro/outro presets). The visual IR compiler that
honored `backend_hint` was deleted with the Pixi migration; the field is still
persisted for schema compatibility but does not change rendering today.

### `MotifParams`

```rust
struct MotifParams {
    motif_id: String,
    motif_version: u32,
    props: imbl::HashMap<String, Value>,   // validated against the Motif manifest's props_schema
    src_in_us: TimeUs,                      // window offset into the Motif's intrinsic content (0 = content frame 0)
    transform: Transform,
    opacity: Animated<f64>,
}
```

### `AudioParams`

```rust
struct AudioParams {
    media: MediaId,
    src_in_us: i64,
    src_out_us: i64,
    gain_db: Animated<f64>,
    pan: Animated<f64>,               // -1 .. 1
    fade_in_us: u64,
    fade_out_us: u64,
    mute: bool,                       // per-clip mute
    role: AudioRole,                  // dialogue | music | sfx | voiceover
}
```

`role` is the layer's **mix-bus tag** (kebab on the wire:
`dialogue`/`music`/`sfx`/`voiceover`; default `dialogue` via
`#[serde(default)]`). The mixer groups by this, not by track — every
layer tagged `music` shares one bus, wherever its track sits. The bus
settings live in `Project.audio_roles` (below); see [docs/audio.md](audio.md).

### `Transform`

```rust
struct Transform {
    x: Animated<f64>,                 // canvas pixels
    y: Animated<f64>,
    scale_x: Animated<f64>,
    scale_y: Animated<f64>,
    rotation_deg: Animated<f64>,
    anchor: (f64, f64),               // 0..1 normalized
}
```

## Animated values

```rust
enum Animated<T> {
    Static(T),
    Keyframed(imbl::Vector<Keyframe<T>>),    // sorted by t_us
}

struct Keyframe<T> {
    id: KeyframeId,
    t_us: i64,                               // RELATIVE to layer.t_start_us
    value: T,
    interp: Interpolation,                   // Hold | Linear | EaseIn | EaseOut | Bezier(p1,p2)
}
```

Keyframe times are **relative to the layer's start**. Otherwise moving a layer breaks its animation. Trim and split keep keyframes content-anchored: an IN-edge trim shifts every key by the edge delta, split partitions keys at the cut (right half re-based, an emptied half collapses to `Static` at the boundary value), and keys pushed outside `[0, duration]` are **retained, not dropped** (so trims stay reversible) — `value_at` clamps out-of-range keys and the UI hides them.

`Interpolation` is per-segment, stored on the segment's left keyframe (`kf[i].interp` governs `kf[i] → kf[i+1]`): `Hold` (left-stick step), `Linear`, `EaseIn`/`EaseOut` (the CSS cubics `cubic-bezier(.42,0,1,1)` / `cubic-bezier(0,0,.58,1)`), and `Bezier{p1,p2}` — an arbitrary `cubic-bezier(x1,y1,x2,y2)` timing function. There are no per-keyframe in/out handles; velocity continuity through a keyframe is produced by the authoring-side Smooth command, which bakes matching tangents into the two adjacent segments.

For MVP: only `opacity`, `position`, `scale`, `rotation`, `gain_db`, `pan` are animatable.

## `Marker`

```rust
struct Marker {
    id: MarkerId,
    t_us: i64,
    end_t_us: Option<i64>,            // makes it a region marker
    label: String,
    color: Rgba,
    metadata: imbl::HashMap<String, Value>,   // agent notes, todos, etc.
}
```

## History

```rust
struct History {
    snapshots: VecDeque<HistoryEntry>,        // bounded ring; default 200
    cursor: usize,
    checkpoints: imbl::HashMap<CheckpointId, NamedCheckpoint>,
    lock: Option<String>,                     // when set, undo/redo/restore reject
}

struct HistoryEntry {
    op_id: OpId,
    actor: Actor,                              // User | Agent { client: String }
    timestamp: Timestamp,
    summary: String,                           // "Moved 'intro' to 4.20s"
    affected_ids: Vec<Uuid>,
    snapshot: Arc<Project>,
}

struct NamedCheckpoint {
    id: CheckpointId,
    label: String,
    actor: Actor,
    created_at: Timestamp,
    snapshot: Arc<Project>,
}
```

- **Undo/redo**: move `cursor`, broadcast snapshot at cursor.
- **Checkpoint**: explicit named snapshot stored separately; survives undo-truncation; persists in save file.
- v1 is linear undo; tree-of-edits is v2 (the snapshot model already supports it — just add parent pointers).
- **Several mutation classes sit outside the undo stack** — see `docs/undo-stack-scope.md` for the full per-op table. The pattern: patch every snapshot (and checkpoint) in place via `replace_media_pool_everywhere` or `replace_composition_canvas_everywhere`, broadcast a non-recorded `ChangeEvent`, cursor unchanged. Covers media imports/removals of unreferenced media, derivative and workspace-path updates, canvas setup fields, and project open/new (`replace_state` resets history instead). Timeline edits, duration changes, and cascade media removals still record normally.

## Concurrency: single-writer actor

```rust
struct ProjectActor {
    current: Arc<Project>,
    history: History,
    subscribers: Vec<Sender<ChangeEvent>>,
    inbox: Receiver<Command>,
}
```

```
   UI command (IPC)              MCP tool call
         │                              │
         └──────────► inbox ◄───────────┘
                       │
                  ProjectActor
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   new Arc<Project> history append broadcast
                       │
        ┌──────────────┼─────────────────────┐
        ▼              ▼                     ▼
       UI       IR compiler           MCP change feed
```

- One writer; UI and MCP both submit `Command`s.
- Reads are lock-free (`Arc` clone).
- Bounded inbox (capacity ~100); under sustained agent flood, reject-oldest with backpressure error.

## `ChangeEvent`

```rust
struct ChangeEvent {
    op_id: OpId,
    actor: Actor,
    timestamp: Timestamp,
    summary: String,
    affected: Vec<EntityRef>,                  // (kind, id) pairs
    new_snapshot: Arc<Project>,
    diff_hint: DiffHint,                       // Coarse | Layer(id) | Composition | ...
}
```

`diff_hint` lets consumers do partial work — see [architecture.md](architecture.md) for the IR-compiler contract.

## Validation invariants (enforced inside the actor on every commit)

| Invariant | Failure |
|---|---|
| `t_start_us < t_end_us` | reject |
| `t_start_us`, `t_end_us`, `composition.duration_us` snap to composition-frame grid | snap-round (half-up) before validation |
| `0 ≤ src_in_us < src_out_us ≤ media.duration_us` | reject |
| No two layers in the same track overlap in `[t_start, t_end)` | reject (with structured options) |
| `composition.duration_us == max(layer.t_end_us)` while `duration_pinned == false` | auto-fit bidirectionally (grow on adds, shrink on deletes/inward trims) |
| `composition.duration_us ≥ max(layer.t_end_us)` while `duration_pinned == true` | overflow guard only — pinned value grows if a layer extends past it, never shrinks |
| `composition.fps.den > 0`, `width/height > 0` | reject |
| All references (`MediaId`/`LayerId`/`GroupId`/`TransitionId`) resolve | reject |
| Keyframe `t_us` outside `[0, layer.duration]` | **allowed** — trim/split intentionally keep out-of-range keys (non-destructive); `value_at` clamps and the UI hides them |
| Motif props match the Motif manifest's `props_schema` | reject |
| `Animated` with empty keyframes ⇔ `Static` | normalize |

A failed invariant returns a structured error to the caller (UI shows toast; MCP returns tool error with a reason and, where useful, suggested alternative actions).

## Mutation surface

Every command maps directly to one MCP tool with the same name. Patches are **strongly typed**, not JSON Patch.

The MCP surface mirrors this 1:1 (same names, schemars-derived schemas);
the UI uses the same actor via backend commands.

| Command | Notes |
|---|---|
| `import_media(path)` → `MediaId` | hashes, probes metadata, fans out proxy / thumbnails / waveform jobs |
| `remove_media(id, force?)` | rejects with `MediaInUse { referenced_by }` if any layer references it unless `force=true` |
| `add_track(label?)` → `TrackId` | tracks are kind-agnostic — any layer kind can be placed on any track |
| `remove_track(id, force?)` | rejects if non-empty unless `force` |
| `move_track(id, new_position)` | |
| `update_track_flags(id, patch)` | unrecorded; patch any subset of `{enabled, muted, solo, locked}`; undo never reverts these. `muted`/`solo` round-trip but no longer gate audio (mixing is per-role) |
| `set_role_gain(role, gain_db)` | **recorded** (undoable); sets a mixing role's bus gain, folded into that role's layers at mix time |
| `update_role_flags(role, patch)` | unrecorded (like `update_track_flags`); patch `{muted?, solo?}` on a role's mix bus; undo never reverts these |
| `add_color_layer(track_id, t_start_us, t_end_us, color, width?, height?)` → `LayerId` | rejects on overlap |
| `add_video_layer(track_id, media_id, t_start_us, t_end_us, src_in_us, src_out_us)` → `LayerId` | rejects on overlap |
| `add_motif(motif_id, t_start_us, t_end_us?, track_id?, props?)` → `LayerId` | `t_end_us` defaults to `default_duration_s`; `track_id` auto-creates an "Overlay" track when absent |
| `apply_subtitles(body, format?, track_id?, t_start_us?, t_end_us)` | body inline; format sniffed from `[Script Info]` |
| `duplicate_layer(layer_id, t_offset_us)` → `LayerId` | |
| `update_layer(layer_id, patch)` | envelope-only patch (label, time range, enabled, locked) |
| `update_layer_params(layer_id, patch)` | kind-specific params |
| `update_layer_param_track(layer_id, param_key, track)` / `update_layer_param_tracks(layer_id, entries)` | replace one / several `Animated<f64>` tracks; normalized (frame-snap / sort / dedupe-last-wins), recorded, rejects empty-keyframed / unknown-param / locked-track |
| `move_layer(layer_id, new_track_id, new_t_start_us, escape_group?)` | rejects on overlap; group-aware (see `groups.md`) |
| `split_layer(layer_id, at_t_us, escape_group?)` → `(LayerId, LayerId)` | |
| `trim_layer(layer_id, edge, new_t_us, escape_group?)` | `edge` ∈ `"in" | "out"` |
| `delete_layer(layer_id)` | |
| `groups_create(layer_ids, label?, reassign?)` → `GroupId` | |
| `groups_dissolve(group_id)` / `groups_add_members(group_id, layer_ids, reassign?)` / `groups_remove_members(group_id, layer_ids)` / `groups_rename(group_id, label?)` | |
| `groups_list()` / `groups_get(group_id)` | |
| `add_marker(t_us, label, color, end_t_us?)` → `MarkerId` | |
| `update_marker(marker_id, patch)` / `remove_marker(marker_id)` | |
| `set_composition(patch)` | |
| `checkpoint(label)` → `CheckpointId` | |
| `list_checkpoints()` / `restore_checkpoint(checkpoint_id)` | restore clears redo |
| `undo()` / `redo()` | |
| `lock_history(reason)` / `unlock_history()` | freeze undo while a tool batch runs |
| `dry_run(operations)` | applies the batch against a clone; halts at the first validation error; does not commit |
| `replace_state(snapshot)` | for paste/template-instantiation; full validation; resets history |

Keyframe authoring is exposed to agents as a small family of MCP tools —
`get_param_track`, `set_keyframe`, `remove_keyframe`, `retime_keyframe`,
`set_keyframe_easing`, `smooth_keyframes`, `clear_keyframes`, and the
low-level `set_param_track`. These are the one place the surface is **not**
1:1 with a same-named command: they are handler-side helpers that read the
layer, apply a pure transform, and write the whole track back through
`update_layer_param_track`. Keyframe times in / out are timeline-absolute
(converted to layer-local at the boundary). The transform math is shared
with the timeline UI and locked Rust↔TS by a golden fixture. See
[`mcp.md`](mcp.md).

## On-disk format: workspace folder

The workspace folder *is* the project. Opening a workspace folder = opening the project; zipping the folder = backing up the project. Originals get copied in on import so the bundle is self-contained.

```
<workspace>/
├── project.json              ← canonical state, auto-saved 500ms-debounced
├── Media/                    ← imported originals (workspace owns the bytes)
│   ├── interview.mov
│   └── b-roll-001.mp4
├── Cache/                    ← all derivatives; safe to delete
│   ├── proxies/              ← per-source H.264: a 720p scrub proxy (preview) + a source-res export master
│   ├── thumbnails/           ← per-source thumb strips
│   ├── waveforms/            ← .peaks files for waveform display
│   ├── frames/               ← on-demand video frames (media://{id}/frame/{t})
│   ├── raster/               ← persisted Motif frame captures (L2)
│   ├── preview/              ← state-hashed preview MP4s (see `rendering.md`)
│   └── voiceover/            ← TTS output
├── Backups/                  ← periodic project.json snapshots (rolling 20)
└── Renders/                  ← export outputs default here
```

**Authoritative path is `MediaItem.path_rel`** (relative to the workspace root). At load time `io::load_from_dir` rewrites `path_abs` as `workspace.join(path_rel)` so moving the workspace folder between machines doesn't break references. `path_abs` is kept in the struct as a convenience for the IR compiler + jobs that read media by absolute path.

`Backups/` rolls every 50 commits or 5 minutes (whichever first), retains the 20 most recent. `project_save_as` is gone in favor of the auto-save subscriber; Cmd-S is a force-flush hook reserved for future UI. The save model is "the folder is the truth" — closing the app loses nothing.

## Versioning

`project.json` embeds a `schema_version: u32` field. `SCHEMA_VERSION`
is bumped whenever the on-disk shape changes incompatibly.

The load path is a cut-over gate (`io/migrate.rs`), not a migration
chain: a project at the build's `SCHEMA_VERSION` loads; anything
below it is rejected with guidance to re-create the project in a
fresh workspace; anything above it is rejected with "update the
app". There is no carry-forward of older folders — maintaining
migration code for unshipped formats is pure overhead.

Within a schema version, additive fields use `#[serde(default)]` so
existing `project.json` files keep loading without a version bump;
the default fills in and the field materializes on next save. Be
permissive at deserialization (unknown fields are ignored) so a
binary can load projects authored by a slightly newer binary without
crashing — the unknown fields drop on next save.

## Pitfalls

1. **Float-time bugs.** Never round-trip `t_start_us` through `f64` except at API boundaries. One `as f64 / 1_000_000.0` and back loses precision near the hour mark.
2. **Layer-overlap rule cuts both ways.** When the agent says "add this clip from t=5 to t=10" and there's already content at t=7, the API must return a structured error with options ("create new track" / "trim existing" / "abort"), not a brick-wall reject.
3. **`media_pool` cleanup.** Don't auto-remove a `MediaItem` when its last reference goes away — the user might be mid-edit. Mark unreferenced; sweep on save with consent.
4. **`enabled: false` ≠ deleted.** Disabled layers still serialize, still occupy their time range for layout. Agents will toggle these for A/B variations.
5. **Keyframes are relative.** Document this prominently — it's the kind of bug that bites once and forever.
6. **Schema migrations under MCP.** Including `schema_version` in every resource response is the simplest defense; agents holding `project://` reads then adapt.
7. **Motif raster invalidation.** Patch `MotifParams.props`
   field-wise rather than replacing whole `params` — otherwise the
   raster cache thrashes on every prop tweak.
