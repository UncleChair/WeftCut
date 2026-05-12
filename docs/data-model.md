# Data Model

> **Implementation status:** This is the design spec for the type tree, mutation surface, and on-disk format. Implementation status (which mutation commands are wired today, which deferred) lives in [`roadmap.md`'s Phase 4 closeout](roadmap.md#phase-4-status-2026-05-08). At time of writing: layer / track / marker / media / composition / checkpoint / undo+redo / replace_state actor commands are all in; `update_marker`, `remove_marker`, `move_track`, `remove_media` shipped in Phase 4 Stage 1. Effect and keyframe commands remain intentionally absent until their IR lowering lands (see `project_phase4_scope.md`).

The project state is the single source of truth. UI, IR compiler, MCP server, and persistence are all clients of it.

## Foundational decisions

### Time: integer microseconds (`i64`)
Precise (1 µs ≪ any frame), fps-independent, integer arithmetic. f64 seconds is exposed only at API surfaces for ergonomics.

### Identity: UUID v7 everywhere
Stable, opaque, time-sortable. Never use array indices for identity — they shift on every insert and break agent-held references mid-conversation.

```rust
type MediaId = Uuid;
type TrackId = Uuid;
type LayerId = Uuid;
type EffectId = Uuid;
type KeyframeId = Uuid;
type MarkerId = Uuid;
type CheckpointId = Uuid;
type OpId = Uuid;
```

### History: persistent-snapshot tree
Every mutation produces a new `Arc<Project>`. Old `Arc`s stay alive in the history ring. Built on `imbl` (`im::Vector`, `im::HashMap`) so memory cost per edit is `O(depth)`, not `O(state)`.

### Track-based timeline
Layers belong to one track; tracks are typed (`Video` / `Audio` / `Subtitle`). **Layers in the same track must not overlap in time** — a hard invariant; agents that violate it get a structured error suggesting "create new track" or "trim existing."

## Top-level shape

```rust
struct Project {
    schema_version: u32,                          // 1 today
    project_id: Uuid,                             // stable across saves
    metadata: ProjectMetadata,
    composition: Composition,
    media_pool: imbl::HashMap<MediaId, MediaItem>,
    tracks: imbl::Vector<Track>,                  // 0 = bottom z-stack, last = top
    markers: imbl::Vector<Marker>,
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
    path_abs: PathBuf,
    path_rel: Option<PathBuf>,        // relative to .vproj folder if applicable
    kind: MediaKind,                  // Video | Audio | Image | Subtitle
    metadata: MediaMetadata,
    proxy_path: Option<PathBuf>,
    waveform_path: Option<PathBuf>,
    thumbnails_dir: Option<PathBuf>,
    file_hash_blake3: String,         // for relink-by-content
    file_size: u64,
    file_mtime: u64,
    imported_at: Timestamp,
}
```

On load: try `path_rel` first (project moved with media), then `path_abs` (media stayed put), then prompt to relink — find by hash within a user-pointed directory.

## `Track`

```rust
struct Track {
    id: TrackId,
    kind: TrackKind,                  // Video | Audio | Subtitle
    label: Option<String>,
    enabled: bool,                    // hides/mutes whole track
    locked: bool,                     // UI prevents edits; MCP can override with explicit flag
    removable: bool,                  // false → delete_track refuses; default tracks set this
    height_px: u16,                   // UI display preference
    layers: imbl::Vector<Layer>,      // sorted by t_start, never overlapping
}
```

A fresh project ships with two non-removable video tracks labelled **"A roll"** (index 0 = bottom of z-stack, video base) and **"B roll"** (index 1 = top of z-stack, overlays / supplementary footage). This matches the Premiere/Resolve/FCP convention where V1 is the base and V2+ are overlays. They give every project a guaranteed drop target so the UI doesn't have to handle "no tracks exist" as a separate case, and they give agents a stable "where do I put this?" answer when they don't have other context. Users can rename them; they cannot delete them. `delete_track` returns `CommandError::TrackNotRemovable` if invoked on one.

`removable` defaults to `true` via `#[serde(default)]` so `.vproj` files written before this field existed deserialize as fully-removable tracks.

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
    effects: imbl::Vector<Effect>,
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

## `Effect`

```rust
struct Effect {
    id: EffectId,
    kind: EffectKind,                 // ColorCorrect | Blur | ChromaKey | Speed | Vignette | ...
    enabled: bool,
    params: EffectParams,             // kind-specific; animatable values inside
}
```

Effects live on the layer, not as separate timeline tracks. Order in `Layer.effects` = render order (first applied first). `[ColorCorrect, Blur]` produces different pixels than `[Blur, ColorCorrect]`.

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
| All references (`MediaId`/`LayerId`/`EffectId`) resolve | reject |
| Keyframe times in `[0, layer.duration]` | reject |
| Template props match template manifest's `props_schema` | reject |
| `Animated` with empty keyframes ⇔ `Static` | normalize |

A failed invariant returns a structured error to the caller (UI shows toast; MCP returns tool error with a reason and, where useful, suggested alternative actions).

## Mutation surface

Every command maps directly to one MCP tool with the same name. Patches are **strongly typed**, not JSON Patch.

| Command | Notes |
|---|---|
| `import_media(path)` → `MediaId` | hashes, probes metadata, may schedule proxy gen |
| `remove_media(id)` | rejects if any layer references it (unless `force`) |
| `add_track(kind, position)` → `TrackId` | |
| `remove_track(id)` | rejects if non-empty unless `force` |
| `move_track(id, new_position)` | |
| `add_layer(track_id, params, t_start_us, t_end_us)` → `LayerId` | rejects on overlap |
| `update_layer(id, patch)` | typed partial update |
| `move_layer(id, new_track_id, new_t_start_us)` | rejects on overlap |
| `split_layer(id, at_t_us)` → `(LayerId, LayerId)` | |
| `delete_layer(id)` | |
| `duplicate_layer(id, t_offset_us)` → `LayerId` | |
| `add_effect(layer_id, effect)` → `EffectId` | |
| `update_effect(id, patch)` | |
| `move_effect(id, new_index)` | reorder within layer |
| `remove_effect(id)` | |
| `add_keyframe(layer_id, prop_path, t_us, value)` → `KeyframeId` | `prop_path` e.g. `"opacity"` or `"transform.x"` |
| `update_keyframe(id, t_us?, value?, interp?)` | |
| `remove_keyframe(id)` | |
| `add_marker(t_us, label, color, end_t_us?)` → `MarkerId` | |
| `update_marker(id, patch)` / `remove_marker(id)` | |
| `set_composition(patch)` | |
| `checkpoint(label)` → `CheckpointId` | |
| `restore_checkpoint(id)` | clears redo, replaces current |
| `undo()` / `redo()` | |
| `replace_state(snapshot)` | for paste/template-instantiation; full validation |

## On-disk format: `.vproj` folder

```
my-edit.vproj/
  project.json              ← canonical state (10 KB – few MB)
  schema_version            ← redundant copy for tooling that reads only this
  cache/
    proxies/<media_hash>.mp4
    waveforms/<media_hash>.dat
    thumbnails/<media_hash>/000.jpg ...
    raster/<key>/           ← per-project rasterized template outputs
  history/
    operations.log          ← optional persisted op log
    checkpoints/<id>.json
  media/                    ← optional consolidated copies of imported media
```

- `project.json` is JSON for diffability and debug-readability. Switch to a binary format only if profiling demands.
- `cache/` is fully derived; safe to delete.
- Imported media is referenced by path by default. A "consolidate to project folder" action copies into `media/` for sharing/archiving.

## Versioning

```json
{ "schema_version": 1, "project": { ... } }
```

On load:
1. Read `schema_version`.
2. Run migration chain `1 → 2 → ... → current`. Each migration is a pure function over the JSON value.
3. Refuse to load a `schema_version` newer than the binary supports.

Be **strict** at deserialization (unknown fields error in v1) — catches typos and forgotten migrations early.

## Pitfalls

1. **Float-time bugs.** Never round-trip `t_start_us` through `f64` except at API boundaries. One `as f64 / 1_000_000.0` and back loses precision near the hour mark.
2. **Layer-overlap rule cuts both ways.** When the agent says "add this clip from t=5 to t=10" and there's already content at t=7, the API must return a structured error with options ("create new track" / "trim existing" / "abort"), not a brick-wall reject.
3. **`media_pool` cleanup.** Don't auto-remove a `MediaItem` when its last reference goes away — the user might be mid-edit. Mark unreferenced; sweep on save with consent.
4. **`enabled: false` ≠ deleted.** Disabled layers still serialize, still occupy their time range for layout. Agents will toggle these for A/B variations.
5. **Keyframes are relative.** Document this prominently — it's the kind of bug that bites once and forever.
6. **Schema migrations under MCP.** Including `schema_version` in every resource response is the simplest defense; agents holding `project://` reads then adapt.
7. **Rasterized template invalidation.** Patch `TemplateParams.props` field-wise rather than replacing whole `params` — otherwise rasterizer cache thrashes on every prop tweak.

## Implementation footprint

| Component | LoC est. |
|---|---|
| Type definitions + serde derives | ~1500 |
| `Animated<T>` evaluator | ~200 |
| Validation pass | ~400 |
| Mutation actor + commands | ~800 |
| History (snapshots + checkpoints) | ~300 |
| Save/load + migrations | ~400 |
| MCP resource serializers (`schemars` export) | ~200 |
| Tauri command bridge (`ts-rs` types) | ~150 |
| Tests (invariants, round-trip, migrations) | ~1500 |

**Total: ~5K LoC of Rust** for the schema + actor + persistence layer. Build in this order:

1. Type definitions + JSON round-trip.
2. Single-writer actor with two commands (`add_layer`, `delete_layer`) — prove the model.
3. History.
4. Validation invariants.
5. Full mutation surface.
6. Save/load with `schema_version: 1`.
7. MCP resource serialization + tool wiring.
8. UI bridge.

Don't parallelize stages 1–4 — they're load-bearing.
