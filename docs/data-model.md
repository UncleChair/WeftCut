# Data Model

The project state is the single source of truth. UI, audio IR
compiler, MCP server, and persistence are all clients of it.

## Foundational decisions

### Time: integer microseconds (`i64`)
Precise (1 µs ≪ any frame), fps-independent, integer arithmetic. f64 seconds is exposed only at API surfaces for ergonomics.

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
    duration_us: i64,         // computed from layers; user-overridable
    sample_rate: u32,         // 48000 default
    channels: u8,             // 2 default
    color_space: ColorSpace,  // Bt709 default
    background: Rgba,
}
```

`fps` MUST be rational. `30000/1001 ≠ 29.97`, and ffmpeg cares.

## `MediaItem`

```rust
struct MediaItem {
    id: MediaId,
    label: Option<String>,
    path_abs: PathBuf,                // computed at load = workspace.join(path_rel)
    path_rel: Option<PathBuf>,        // authoritative; relative to workspace root
    kind: MediaKind,                  // Video | Audio | Image | Subtitle
    metadata: MediaMetadata,
    proxy_path: Option<PathBuf>,      // 540p H.264 in workspace/Cache/proxies/
    waveform_path: Option<PathBuf>,
    thumbnails_dir: Option<PathBuf>,
    file_hash_blake3: String,         // for relink-by-content + cache key
    file_size: u64,
    file_mtime: u64,
    imported_at: Timestamp,
}
```

`path_rel` is the on-disk anchor (workspace-relative, e.g. `Media/clip.mp4`). On load, `io::load_from_dir` rewrites `path_abs = workspace.join(path_rel)` so workspace moves between machines don't break references. `path_abs` is the in-memory convenience path consumed by the IR compiler + background jobs. If `path_rel` is missing (legacy v1 project before migration) or the resolved file doesn't exist, the pool item gets a "missing media" badge — the project still loads.

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
    Template(TemplateParams),
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

The compiler picks `DrawText` (ffmpeg-native) for simple styles and `Rasterized` (template-baked) for animated/styled text. Agents don't need to know which.

### `TemplateParams`

```rust
struct TemplateParams {
    template_id: String,
    template_version: u32,
    props: imbl::HashMap<String, Value>,   // validated against template manifest's props_schema
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
- **Media pool sits outside the undo stack.** `add_media_item` writes the new pool into every snapshot in `History` (and every checkpoint), then broadcasts a non-recorded `ChangeEvent`. The history `cursor` doesn't move and no new entry is recorded. Rationale: importing a media file is a workflow event, not an editing decision — users expect imported clips to stay in the bin even after they undo their way past the import. Mirrors Premiere/DaVinci semantics. The `imbl` structural sharing keeps the cost of patching every snapshot's `media_pool` cheap (one `Project` clone per snapshot, but the `tracks`/`markers`/`composition` subtrees are reference-counted).

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
| `0 ≤ src_in_us < src_out_us ≤ media.duration_us` | reject |
| No two layers in the same track overlap in `[t_start, t_end)` | reject (with structured options) |
| `composition.duration_us ≥ max(layer.t_end_us)` | auto-extend |
| `composition.fps.den > 0`, `width/height > 0` | reject |
| All references (`MediaId`/`LayerId`/`GroupId`/`TransitionId`) resolve | reject |
| Keyframe times in `[0, layer.duration]` | reject |
| Template props match template manifest's `props_schema` | reject |
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
| `add_template(template_id, t_start_us, t_end_us?, track_id?, props?)` → `LayerId` | `t_end_us` defaults to `default_duration_s`; `track_id` auto-creates an "Overlay" track when absent |
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
│   ├── proxies/              ← 540p H.264 per source (used by preview render)
│   ├── thumbnails/           ← per-source thumb strips
│   ├── waveforms/            ← .peaks files for waveform display
│   ├── frames/               ← on-demand video frames (media://{id}/frame/{t})
│   ├── raster/               ← rasterized template renders
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
7. **Template raster invalidation.** Patch `TemplateParams.props`
   field-wise rather than replacing whole `params` — otherwise the
   raster cache thrashes on every prop tweak.
