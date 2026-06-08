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
    settings: ProjectSettings,                    // proxy res, autosave, etc.
}
```

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
    thumbnails_dir: Option<PathBuf>,
    file_hash_blake3: String,         // for relink-by-content + cache key
    file_size: u64,
    file_mtime: u64,
    imported_at: Timestamp,
}
```

`path_rel` is the on-disk anchor (workspace-relative, e.g. `Media/clip.mp4`). On load, `io::load_from_dir` rewrites `path_abs = workspace.join(path_rel)` so workspace moves between machines don't break references. `path_abs` is the in-memory convenience path consumed by the IR compiler + background jobs. If `path_rel` is missing (legacy v1 project before migration) or the resolved file doesn't exist, the pool item gets a "missing media" badge — the project still loads.

The proxy fields encode a video's decode routing, decided per source on
two independent axes (ADR 0009): an **export source** axis (can WebCodecs
decode this codec / bit-depth?) and a **preview source** axis (does the
original scrub acceptably — friendly H.264, ≤1080p, short GOP?). The
combinations:

- **Bypass** (`proxy_bypassed = true`): a friendly short-GOP H.264 source;
  no proxy generated — preview and export both read the original.
- **DirectExport** (`export_uses_original = true`): export reads the
  original at full quality, while a 720p short-GOP `quick_proxy_path` is
  generated as the preview scrub source.
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

Codec decodability is not predicted from a stored capability profile — the
export path tries to decode the original and falls back to generating a
`proxy_path` if it can't (ADR 0010), so HEVC/AV1 export from the original
on capable machines and get proxied on machines that can't decode them.
Background derivative jobs may start before `file_hash_blake3` is final,
keyed on a temporary `pending-{media_id}` hash that migrates to the content
hash when the import copy finishes (ADR 0007).

## `Track`

```rust
struct Track {
    id: TrackId,
    label: Option<String>,
    enabled: bool,                    // hides/mutes whole track
    locked: bool,                     // UI prevents edits; MCP can override with explicit flag
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

A fresh project ships with non-removable tracks tagged with A-roll /
B-roll / audio roles. They give every project a guaranteed drop
target so the UI doesn't have to handle "no tracks exist" as a
separate case, and they give agents a stable "where do I put this?"
answer when they don't have other context. Users can rename them;
they cannot delete them. `delete_track` returns
`CommandError::TrackNotRemovable` if invoked on one.

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
    backend_hint: TextBackend,        // Auto | DrawText | Rasterized
}
```

The compiler picks `DrawText` (ffmpeg-native) for simple styles and `Rasterized` (bitmap-baked) for animated/styled text. Agents don't need to know which.

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
    mute: bool,
}
```

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

Keyframe times are **relative to the layer's start**. Otherwise moving a layer breaks its animation.

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
   UI command (Tauri)            MCP tool call
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
| Keyframe times in `[0, layer.duration]` | reject |
| Motif props match the Motif manifest's `props_schema` | reject |
| `Animated` with empty keyframes ⇔ `Static` | normalize |

A failed invariant returns a structured error to the caller (UI shows toast; MCP returns tool error with a reason and, where useful, suggested alternative actions).

## Mutation surface

Every command maps directly to one MCP tool with the same name. Patches are **strongly typed**, not JSON Patch.

The MCP surface mirrors this 1:1 (same names, schemars-derived schemas);
the UI uses the same actor via Tauri commands.

| Command | Notes |
|---|---|
| `import_media(path)` → `MediaId` | hashes, probes metadata, fans out proxy / thumbnails / waveform jobs |
| `remove_media(id, force?)` | rejects with `MediaInUse { referenced_by }` if any layer references it unless `force=true` |
| `add_track(kind, label?)` → `TrackId` | `kind` is `"video" | "audio" | "subtitle"` |
| `remove_track(id, force?)` | rejects if non-empty unless `force` |
| `move_track(id, new_position)` | |
| `add_color_layer(track_id, t_start_us, t_end_us, color, width?, height?)` → `LayerId` | rejects on overlap |
| `add_video_layer(track_id, media_id, t_start_us, t_end_us, src_in_us, src_out_us)` → `LayerId` | rejects on overlap |
| `add_motif(motif_id, t_start_us, t_end_us?, track_id?, props?)` → `LayerId` | `t_end_us` defaults to `default_duration_s`; `track_id` auto-creates an "Overlay" track when absent |
| `apply_subtitles(body, format?, track_id?, t_start_us?, t_end_us)` | body inline; format sniffed from `[Script Info]` |
| `duplicate_layer(layer_id, t_offset_us)` → `LayerId` | |
| `update_layer(layer_id, patch)` | envelope-only patch (label, time range, enabled, locked) |
| `update_layer_params(layer_id, patch)` | kind-specific params |
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

`add_keyframe` / `update_keyframe` / `remove_keyframe` are not yet
implemented at the MCP surface — `Animated<T>` lowering is
static-or-first-keyframe only, so exposing them now would succeed at
the actor level but produce zero visual change. They land alongside
the per-frame `Animated<T>` IR pass.

## On-disk format: workspace folder

The workspace folder *is* the project. Opening a workspace folder = opening the project; zipping the folder = backing up the project. Originals get copied in on import so the bundle is self-contained.

```
<workspace>/
├── project.json              ← canonical state, auto-saved 500ms-debounced
├── schema_version            ← redundant copy for tooling that reads only this
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

```json
{ "schema_version": N, "project": { ... } }
```

`SCHEMA_VERSION` is bumped whenever the on-disk shape changes.
`io/migrate.rs` carries a per-version migration chain; on load the
migration chain `vN → vN+1 → ... → current` runs and mutates the
in-memory Project before save-back. Missing source files stay in
legacy mode with a "missing media" badge on the pool item; the
editor still loads.

On load:
1. Read `schema_version`.
2. Run the migration chain.
3. Refuse to load a `schema_version` newer than the binary supports.

Be permissive at deserialization (unknown fields are ignored) so a
shipped binary can load projects authored by a slightly newer binary
without crashing — the unknown fields drop on next save.

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
