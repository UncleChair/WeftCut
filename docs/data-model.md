# Data Model

The project state is the single source of truth, authored by the
single-writer actor in the Electron **main** process (TypeScript,
`src/main/state/`); the Rust core holds no resident copy — it deserializes
the same shapes from the slice it is handed per compute call (audio export,
`project://compiled`, single-media reads). UI, MCP server, and persistence
are all clients of the actor — the struct syntax throughout this doc
describes the shared model, not a Rust-exclusive owner.

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

`transition.duration_us` and marker `t_us` / `end_t_us` are on that grid
too. A transition duration is a whole number of composition frames
measured **from the cut**, which is what lets the outgoing layer's
auto-extended `t_end_us` stay on the grid *and* keep the
`overlap == duration_us` invariant — at 29.97 / 23.976 a duration derived
from the rate alone cannot satisfy both. Requests below half a frame are
rejected, not rounded down: a transition and a region marker each span at
least one frame. Markers being frame-quantized matches Premiere/Resolve,
so a marker dropped mid-frame moves up to half a frame.

Alignment is **structural**, not merely per-mutation. The commit validator
rejects any layer endpoint, `composition.duration_us`, or marker time that
is not `round(i × 1e6 × den / num)` for an integer index on that field's own
grid, so a mutator that forgets to snap fails loudly instead of quietly
persisting a sub-quantum time.

### Two grids: composition frames, and the 48 kHz audio lattice

Visual layer endpoints are on the composition frame grid. **Audio layer
endpoints are on the fixed 48 kHz mix lattice** — `round(i × 1e6 / 48000)`,
~20.83 µs apart — because the mixer already converts `t_start_us` /
`src_in_us` / `src_out_us` to 48 kHz sample frames. Choosing samples makes the
authoring grid and the render grid *literally the same lattice*, so there is no
rounding at the seam: the authoring index is the mixer's sample index.

The rate is a **constant**, not `composition.sample_rate`. That field is read
only as the export target, so it is a delivery parameter — it moves no edit and
is never locked. Raising the video fps used to silently change the available
audio precision; it no longer does.

One function, `gridForLayerKind(kind, fps)` in
`apps/desktop/src/main/state/snap.ts`, picks the lattice, and all three
enforcement sites ask it: the validator's predicate, every mutation snap
(including `move`'s group fan-out), and the load repair. That single seam is not
tidiness — a kind-blind fan-out drags a slipped audio member back onto the
nearest video frame on any unrelated group move, and a kind-blind load repair
does it on *every open*. Both destroy authored sync silently, because a snap
that "succeeds" looks like a no-op.

A frame boundary is exactly a sample boundary at 24, 25, 30, 50, 60 and
23.976 fps (integer samples per frame), so a co-aligned A/V pair is exact
there. At 29.97 and 59.94 it is not — 1601.6 and 800.8 samples per frame — so a
paired audio layer sits on the sample boundary nearest the video frame, up to
~10 µs away. That is where the mixer would have played it regardless; storing it
means the file now says what renders.

`composition.duration_us` stays a frame count in all cases: the autofit rounds
the layer high-water mark **up** to the enclosing frame, so a sub-frame audio
tail is contained rather than clipped.

Audio automation (`gain_db`, `pan`, the audio-role envelopes) quantizes on the
sample lattice at write time too, so an audio envelope is no longer coarser than
the mixer that renders it. Keyframe times remain unenforced by the validator for
the reason below.

Two fields are deliberately outside that rule. `transition.duration_us` is
a *distance* between two canonical boundaries, and at 29.97 / 23.976 a
distance is not itself a boundary time — so what is enforced is
`overlap == duration_us`, and canonical participant endpoints then make the
duration a whole frame count automatically. Keyframe `t_us` is snapped on
write but not enforced: trim and split rebase keys by a delta, and
re-snapping the shifted set would dedupe-merge two keys that landed on one
frame, losing authored data.

Timeline time also starts at **zero**: a layer may not begin before the
origin. This is a bounds rule (`NegativeLayerStart`) kept separate from the
grid rules, because a negative time is usually perfectly canonical —
`-1_000_000` is frame -30 at 30 fps — so reporting it as off-grid would point
at the wrong fix. A move dragged toward the origin stops *as a set*: the
clamp applies to the shared delta, so the earliest member of a group lands on
0 and every other member keeps its spacing, rather than individual layers
being shortened in place.

Off-grid times already on disk **repair on load rather than reject**.
`project_open` reaches the actor through `replace_state`, which runs that
same validator, so a hard rule alone would make any project written by an
older build unopenable. `parseProject` snaps every grid-bound field inside
its single normalize pass — beside the additive-field backfills, one pass in
one place — re-derives each transition duration from the repaired geometry,
and reports what it moved so a migrated project is visible rather than
mysterious. The same pass brings negative starts back: a layer straddling
zero has its start lifted (its visible span is preserved exactly, and it can
collide with nothing), while a layer lying *entirely* before zero is parked
after everything else on its track with its duration intact — lifting that
one would collapse it onto the head of the track and the "repair" would
manufacture an overlap the project could not open with. The pass is
idempotent: saving a repaired project and reopening it repairs nothing.

The repair report reaches the status log. It is captured during the parse but
emitted only after the workspace commit, because that commit rotates the
per-workspace LogBus — a row emitted where the repair happens lands in the
bus being discarded.

Display format follows the same grid: timecode reads SMPTE `HH:MM:SS:FF`,
NDF (non-drop-frame) at every fps. Project starting timecode is zero, with
no persisted offset. At 23.976 / 29.97 / 59.94 an NDF label therefore spans
more wall-clock time than its digits suggest — a displayed hour is 3603.6 s,
~3.6 s per hour. That is correct NDF counting, not a rounding error, and it
is invisible while reading a *position*: a position makes no claim about
elapsed time.

Where a **duration** is displayed, it does make that claim, so at fractional
rates the wall-clock figure is shown beside the timecode — the export
dialog's range duration and the composition duration / content-end floor in
Settings. Integer rates show one figure only, because the second would be
the same instant twice.

Drop-frame is **declined, not deferred**. DF changes no stored microsecond;
it is purely a relabelling, and its consumers are interchange formats
(EDL / AAF / OTIO / FCPXML) that do not exist here — export writes no
timecode track. Building it would cost a persisted field, a schema
migration, `;` parsing, and skipped-label rejection to relabel numbers that
are already correct. If interchange is ever built, DF and a non-zero
starting timecode are revisited **together**: they share one migration and
one insertion point (`formatTimecode` / `parseTimecode` in
`apps/desktop/src/renderer/frames.ts`, the choke point all 14 timecode
consumers already go through).

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

### Boundary semantics: which frame a surface shows or stores

Two conventions coexist by design — the mainstream NLE pairing
(Premiere / Resolve / Avid behave the same way):

- **Frame-anchor display.** The playhead at time `t` displays the frame
  *starting* at `t` (half-open `[t, t + 1 frame)`). Parked exactly on a cut
  it shows the incoming clip's first frame; the outgoing clip's last frame
  is one `←` away. At frame-level zoom the playhead draws a one-frame-wide
  shadow to its right (`playheadFrameShadowPx` in `timeline/geometry.ts`)
  to make this visible.
- **Inclusive-out display.** A tool that presents an *exclusive end
  boundary* to the user shows the last frame the boundary KEEPS, not the
  frame past it: a tail-trim drag previews `boundary − 1 frame` in the
  monitor, and "set out point from playhead" stores the *end* of the
  displayed frame so that frame is included.

The one-frame gap between the two conventions is bridged only by the
named helpers in `apps/desktop/src/renderer/frames.ts` — never by a bare
`±1` at a call site:

| Surface | Rule | Helper |
| --- | --- | --- |
| Playhead / monitor display | frame starting at `t` | `displayedFrameStartUs` |
| Playhead upper bound, End key, auto-pause park | start of last frame | `lastFrameAnchorUs` via `clampSeekUs` |
| In point, range start, paste-at-playhead | inclusive; store the playhead value as-is | — |
| Out point / range end set from the playhead | store the displayed frame's exclusive end | `inclusiveOutBoundaryUs` |
| Trim-drag monitor preview | out side shows last kept frame, in side the first | `boundaryDisplayFrameUs` |
| Edit-point navigation (`↑`/`↓`) | park ON the cut (shows incoming frame) | `seekToPrevEdit` / `seekToNextEdit` |
| Attribute panel End field | shows the exclusive boundary's timecode, so Start + Duration = End holds and frame counts match `out − in + 1` editors | displayed as stored |

Interval math *inside* the render and export pipelines (active-set
queries, export tail mapping, ring lookups) legitimately subtracts a
microsecond from a half-open `endUs` where an inclusive query is needed;
those sites are µs-interval arithmetic, not user-facing frame
translation, and each carries its own why-comment. The review rule for
everything user-facing: a new surface that displays a boundary or stores
a time sourced from the playhead picks its row in this table and goes
through the helper — a hand-written `frameIndex + 1` or `endUs − 1` in UI
code is the bug class this section exists to prevent.

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
    kind: MediaKind,                  // Video | Audio | Image (subtitle files are consumed at import)
    metadata: MediaMetadata,
    decode_route: DecodeRoute,        // where preview and export each read their pixels; see below
    waveform_path: Option<PathBuf>,
    conform_path: Option<PathBuf>,    // canonical 48 kHz PCM (VCONF); see docs/audio.md
    thumbnails_dir: Option<PathBuf>,
    file_hash_blake3: String,         // for relink-by-content + cache key
    file_size: u64,
    file_mtime: u64,
    imported_at: Timestamp,
}

enum DecodeRoute {
    // Preview and export both read the original source directly; no proxy is generated.
    Bypass,
    // Export reads the original source; preview reads a 720p short-GOP quick proxy.
    // quick_proxy is None until the derivative lands.
    DirectExport { quick_proxy: Option<PathBuf> },
    // Preview reads the quick proxy; export reads the source-resolution export master.
    // Both Option fields represent readiness: None = derivative not yet generated.
    Proxied {
        quick_proxy: Option<PathBuf>,
        full_proxy: Option<PathBuf>,
        format_version: u32,          // bump forces proxy regen on next load
    },
    // A WebCodecs-blind source (ProRes today) that a native libavcodec
    // software decoder can preview directly. Carries the same readiness
    // fields as Proxied so the experimental toggle being off previews via
    // the proxy with no regression; toggle-on overlays the native original.
    NativeSw {
        quick_proxy: Option<PathBuf>,
        full_proxy: Option<PathBuf>,
        format_version: u32,
    },
}
```

`path_rel` is the on-disk anchor (workspace-relative, e.g. `Media/clip.mp4`). On load, `io::load_from_dir` rewrites `path_abs = workspace.join(path_rel)` so workspace moves between machines don't break references. `path_abs` is the in-memory convenience path consumed by the IR compiler + background jobs. If `path_rel` is missing (legacy v1 project before migration) or the resolved file doesn't exist, the pool item gets a "missing media" badge — the project still loads.

`decode_route` is the **persisted source of truth** for where preview and
where export each read their pixels (ADR 0009, ADR 0028; see also
[`CONTEXT.md`](../CONTEXT.md#decode-routing) for canonical term definitions).
The route is decided per source on two axes: whether the export worker can
decode the original directly and whether the original scrubs acceptably as a
preview source. The four legal routes, all represented by distinct variants:

- **`Bypass`**: a friendly short-GOP H.264 source; no proxy generated —
  preview and export both read the original.
- **`DirectExport { quick_proxy }`**: export reads the original at full
  quality; preview reads a 720p short-GOP quick proxy. `quick_proxy` is
  `None` until the derivative lands.
- **`Proxied { quick_proxy, full_proxy, format_version }`**: a source
  WebCodecs cannot decode directly (non-H.264-family codec, or 10-bit/HDR)
  — preview reads the quick proxy; export reads the source-resolution
  export master (`full_proxy`). Both fields are `None` while the respective
  derivative is pending. `format_version` forces proxy regeneration when bumped.
- **`NativeSw { quick_proxy, full_proxy, format_version }`**: a WebCodecs-blind
  source (ProRes today) that a native libavcodec software decoder can
  preview directly. Fields mirror `Proxied` exactly. With the experimental
  `experimental_native_sw_decode` AppSettings toggle off, preview reads
  `quick_proxy` just as `Proxied` would; with the toggle on, preview reads
  the original via the native software decoder (`SwSourceHandle`) instead.
  See [ADR 0029](adr/0029-native-sw-decode-ships-bytes-not-shared-texture.md).

The `Option` payloads express **readiness**: preview is ready when
`quick_proxy` is `Some`, or the route is `Bypass`; export is ready when
`full_proxy` is `Some`, or the route is `DirectExport` or `Bypass`. `NativeSw`
follows `Proxied`'s readiness exactly — the toggle only changes which ready
path preview reads, not readiness itself. The illegal combination — FullProxy
export with Original preview — is unrepresentable by construction.
`resolveDecode(media)` is the single resolver that maps a `DecodeRoute` and
optional session bridge to `{ previewPath, exportPath }`, replacing ad-hoc
flag reads at every call site. See
[ADR 0028](adr/0028-persist-decode-route-as-folded-enum.md).

The static import route is intentionally narrow. H.264 and AV1 8-bit,
browser-friendly sources can be marked DirectExport; HEVC, VP9, ProRes, and
10-bit/HDR sources route to a full export master. The renderer still verifies
DirectExport sources with a real `probeSourceDecodable` key-frame decode before
export. If the probe fails on the current machine, `ensure_full_proxy`
route-corrects the media by transitioning the route from `DirectExport` to
`Proxied` and enqueueing a full proxy, and the export waits for the store to
show a usable path.

Import also runs a session-scoped preview decodability sweep for sources that
would otherwise be blank until a proxy lands. A successful probe lets preview
temporarily read the original via `previewPlaybackPathFor(...,
{ previewDecodable: true })`; this bridge is not persisted and is replaced by
the quick proxy once it exists. `importOptimizeStatus` classifies the same
states as `checking`, `bridged`, `transcoding`, `failed`, `ready`, or `direct`
for every pool entry, and the Media Pool card carries the verdict: a corner dot
while work is outstanding, the codec-named reason in the badge tooltip. It is
informational — the one state that needs the user to act, `failed`, also reaches
the status log, because the pool can be hidden behind another dock tab.

This is a second, orthogonal axis to `mediaReadiness`, which answers "may the
user drag this?" rather than "is a job still running?". The two stay separate
functions: a bridged clip is simultaneously fully usable and still optimizing,
so folding them into one enum would have no state to express it.

On import the clip appears immediately from a stat-only probe (the item carries
a provisional `file_hash_blake3`); a lightweight standalone BLAKE3 pass then sets
the real content hash before any derivative job is enqueued, so jobs are always
keyed on the final content hash and the workspace copy runs in parallel.
(Supersedes the former pending-hash/migrate scheme, ADR 0007.)

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
  (container `avif`) from a true AV1 video stream (container `mp4`/`matroska`
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
| Video | mp4, mov, mkv, webm, avi, m4v | Decode routing per the `DecodeRoute` above. |
| Audio | wav, mp3, flac, aac, m4a, ogg, opus | Anything ffmpeg decodes conforms; the VCONF cache is the only contract (docs/audio.md). |
| Image | png, jpg/jpeg, gif, webp, bmp, avif | Rendered from the ORIGINAL with no derivatives. Still images use `createImageBitmap` (single frame, 3 s default duration). Animated formats (GIF, animated WebP, APNG, animated AVIF) decode all frames once via WebCodecs `ImageDecoder` (downscaled to composition size, cached per media) and loop at native speed to fill the layer; a freshly-placed animated image defaults to one native loop. APNG files are named with the `.png` extension. |

**Subtitle files (srt, ass, vtt)** are consumed at import: `import_media` on a
subtitle extension reads the body, parses it through `subtitles::parse`, and
calls `add_caption_track` to build a caption-role track of `Text` layers. The
file is never copied to `Media/`, never added to the media pool, and no
`MediaItem` is created. The `MediaKind::Subtitle` enum variant exists in the
Rust codebase but is unreachable through normal import; subtitle files are routed
before the pool-entry path. See [captions.md](captions.md) for the full caption
model (parser, fonts, panel).

TIFF classifies as `Image` when it arrives anyway (drag-drop / MCP take any
path) but Electron/Chromium's `createImageBitmap` cannot decode it — the layer
composites nothing — so the dialog doesn't offer it. SVG is unsupported:
unlisted extensions default to `Video` and won't produce a usable layer.

Derivative jobs follow the kind: `Video` gets decode-route derivatives + waveform +
conform + thumbnails; `Audio` gets waveform + conform only (ready as soon as
the workspace copy lands — no proxy wait); `Image` gets none.

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
    effects: Vec<Effect>,                     // ordered Pixi-filter chain (v1: Blur)
}

enum LayerParams {
    VideoClip(VideoClipParams),
    ImageOverlay(ImageOverlayParams),
    Text(TextParams),
    Motif(MotifParams),
    Audio(AudioParams),
    Color(ColorParams),
}

// A per-layer effect instance. Rust stores the ordered instances + their
// animatable params; the renderer (effectRegistry.ts) owns the catalog of
// which filters exist and how to build them. The two join on `kind`, which
// Rust does not validate (an unknown kind is skipped + warned renderer-side).
// v1 params are scalar `Animated<f64>` only. See render.md, ADR 0027.
struct Effect {
    id: EffectId,
    kind: String,                             // catalog key, e.g. "blur"
    enabled: bool,
    params: BTreeMap<String, Animated<f64>>,
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
    anchor_x: Animated<f64>,          // 0..1 normalized; the transform PIVOT
    anchor_y: Animated<f64>,
    scale_linked: bool,               // uniform-scale intent; default true
}
```

The anchor pair is the **pivot**: what `rotation_deg` turns around and what a
flip mirrors about, in normalized layer coordinates (`(0.5, 0.5)` = center, the
default). It is `Animated` like the rest of the transform, so the pivot can be
keyframed — a rotation whose centre travels needs nothing else. The pair is
**unbounded**: a pivot outside the layer's own box is a legitimate authoring
choice. It is additive on the wire: a save predating the split carries a single
`anchor: [x, y]`, which the load pass converts into two Static tracks
(`state/serialize.ts`). That backfill must READ the legacy tuple rather than
default the two fields — ASS `\an` import writes an off-centre anchor on every
caption layer, so defaulting them to the centre would re-position every imported
subtitle. What `x`/`y` mean depends on the kind, and the difference is
deliberate:

| Kind | `x`/`y` is | why |
|---|---|---|
| VideoClip, ImageOverlay, Motif | the **unrotated top-left** | natural size is fixed, so a corner is a stable origin — and it is what stored projects already mean |
| Text | the **anchor point itself** | measured text bounds move with the content, so only an anchor-relative origin is stable (ASS `\an` import writes anchor + position together — `subtitles/layout.rs`) |

The media kinds get there by compensating the position for the pivot
(`render/anchorPivot.ts`): the pivot goes at the anchor in texture space and the
position adds `pivot × |effective scale|` back. The absolute value is what makes
a flip mirror **in place** instead of jumping to the other side of `x`. At
`rotation_deg = 0` with no flip, the top-left lands on `(x, y)` at any scale.

That asymmetry decides what *moving* the anchor does, and the two editing
surfaces answer differently — deliberately, matching After Effects:

| Surface | Writes | Effect on the picture |
|---|---|---|
| Inspector `Anchor X`/`Anchor Y` (and MCP / timeline lanes) | the anchor track alone | unchanged for an unrotated, unflipped media layer; **moves** a rotated, flipped, or Text layer |
| The preview's on-canvas target | the anchor pair **plus** compensating `x`/`y`, in one commit | never moves — the pan-behind gesture |

The compensation is `anchorCompensation` in `renderer/preview/gizmoGeometry.ts`,
which is the negation of the anchor-dependent part of the composed position:
`−R·S·q` for the anchor origin and `(|S| − R·S)·q` for the top-left one, where
`q` is the anchor change in local pixels. For an unrotated media layer that term
is exactly zero, so the common gesture writes two tracks, not four, and never
stamps a redundant key on `x`/`y`.

**Scaling** splits the same way, and mirrors it. Because the media kinds' position
adds `pivot × |scale|` back, changing scale alone holds the unrotated **top-left**
still and walks the pivot — which is what the inspector's Scale field does. The
preview's resize handles instead pin the **anchor**, the way After Effects and
Premiere do, by committing `scaleCompensation` = `pivot·(|scale₀| − |scale₁|)` per
axis in the same batch. That term has no rotation in it (the position never had
one), and it is exactly zero for Text — whose `x`/`y` *is* the pivot, so scale
cannot move it — the reverse of the anchor case above.

`scale_linked` records **uniform-scale intent**: while `true`, the two scale
tracks are structural twins — same mode, and when keyframed the same
`(t_us, value, interp)` sequence (keyframe `id`s are per-track identities and
legitimately differ) — and every editing surface shows and writes them as one
"Scale"; the preview's resize handles do it by offering **corners only**, since a
linked layer has no honest single-axis handle. The invariant is enforced on
**results**, not write paths
(`main/state/mutations/scaleLink.ts`): after any mutation that touches a scale
track of a linked layer, a twin check runs in the same commit and clears the
flag on divergence, so the flag can never lie regardless of which write path
(UI, MCP, or anything else) produced the state. Re-linking (`set_scale_linked
{ linked: true }`) is the one destructive edit: `scale_y` becomes a fresh-id
whole-track copy of `scale_x`, atomically with the flag. The field is additive
on the wire — absent on older saves — and the load pass backfills it from the
twin check (never a blind `true`), which also repairs a hand-edited
`true`-over-diverged-tracks file. Rust carries the field for wire fidelity
only; no compute reads it.

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
    interp: Interpolation,                   // Hold | Linear | Bezier(p1,p2) | Elastic{dir,amplitude,period} | Bounce{dir}
}
```

Keyframe times are **relative to the layer's start**. Otherwise moving a layer breaks its animation. Trim and split keep keyframes content-anchored: an IN-edge trim shifts every key by the edge delta, split partitions keys at the cut (right half re-based, an emptied half collapses to `Static` at the boundary value), and keys pushed outside `[0, duration]` are **retained, not dropped** (so trims stay reversible) — `value_at` clamps out-of-range keys and the UI hides them.

`Interpolation` is per-segment, stored on the segment's left keyframe (`kf[i].interp` governs `kf[i] → kf[i+1]`), and splits into two classes. **Spline** segments: `Hold` (left-stick step), `Linear`, and `Bezier{p1,p2}` — an arbitrary `cubic-bezier(x1,y1,x2,y2)` timing function. Named easing presets (the CSS eases plus the sine/quad/cubic/quart/quint/expo/circ/back families) are not schema variants: the authoring layer bakes them to their canonical `Bezier` params and recovers the name for display by exact-param reverse lookup against the append-only table in `src/shared/easing.ts` (params in that table are never retuned — a changed feel is a new id). **Procedural** segments: `Elastic{dir, amplitude, period}` and `Bounce{dir}` — oscillating curves a single cubic segment cannot express, evaluated closed-form in the eval leaf; they have parameters instead of handles. There are no per-keyframe in/out handles; velocity continuity through a keyframe is produced by the authoring-side Smooth command, which bakes matching tangents into the two adjacent segments (a procedural neighbour reads as the identity diagonal for this purpose).

Animatable params, by kind: the visual kinds carry `x`, `y`, `scale_x`,
`scale_y`, `rotation_deg`, `anchor_x`, `anchor_y` and `opacity`; Audio carries
`gain_db` and `pan`; Color carries none. Effect params are addressed as
`effects[<id>].params[<key>]`. The list has ONE home per side —
`animatableParams` in `renderer/keyframe/descriptors.ts` and
`TRANSFORM_F64_KEYS` + `f64Lens` in `main/state/mutations/params.ts`, mirrored by
`resolve_animated_f64` in `native/src/state/layer.rs`. A param missing from the
descriptor list has no stopwatch, no timeline lane and no curve, however
writable its track is.

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
- **Several mutation classes sit outside the undo stack** — see `docs/features.md#undo-stack-scope` for the full per-op table. The pattern: patch every snapshot (and checkpoint) in place via `replace_media_pool_everywhere` or `replaceCompositionEverywhere`, broadcast a non-recorded `ChangeEvent`, cursor unchanged. Covers media imports/removals of unreferenced media, derivative and workspace-path updates, the **entire composition envelope** (`set_composition` / `fit_composition_to_layers`, duration included), and project open/new (`replace_state` resets history instead). Timeline edits and cascade media removals still record normally.
- The composition fan-out is a **transform applied per snapshot**, not a value copied across them: a pinned `duration_us` is floored at each snapshot's own content high-water mark (so an older snapshot never ends up shorter than its own layers), and an `fps` re-snap runs against each snapshot's own markers. Because the write spans every stored snapshot, the `fps` rate lock is judged over them too — see the rate-lock note in features.md.

## Concurrency: single-writer actor

The actor runs in the Electron **main** process (TypeScript, `src/main/state/`)
and is the sole writer; the shape below is illustrative of what it holds.

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
| `t_start_us >= 0` | clamped in the mutator (a group move stops as a set), then reject as a backstop (`NegativeLayerStart`); a project loaded from disk is repaired in `parseProject` instead of rejected |
| Visual `t_start_us`, `t_end_us`, `composition.duration_us`, marker `t_us`/`end_t_us` on the composition-frame grid | snap-round (half-up) in the mutator, then reject as a backstop (`OffGridLayerBoundary` / `OffGridTime`); a project loaded from disk is repaired in `parseProject` instead of rejected. Both errors carry `snap_to`, the value the caller should have sent |
| Audio `t_start_us`, `t_end_us` on the fixed 48 kHz sample lattice | same three-site enforcement, against the audio grid; the error carries `grid: "sample"` and `fps: 48000/1` |
| `fps` immutable once the timeline — or any stored snapshot / checkpoint — holds a layer | reject (`FpsLockedByContent`, carrying `locked_by: current \| history`). History scope, because the unrecorded rate change writes to every snapshot: judging on the live state alone would let `undo` resurrect old-grid layers at the new rate. Set the rate on a project whose timeline has never held anything |
| `transition.duration_us` == the geometric overlap of its participants | reject — this *is* the transition's grid rule; a duration is a distance, not a boundary time |
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
| `apply_subtitles(body, format?, track_id?, t_start_us?, t_end_us?)` | Parses `body` (SRT/VTT/ASS) and builds a new caption-role track of editable `Text` layers. `format` is sniffed when omitted. `track_id`, `t_start_us`, and `t_end_us` are accepted on the wire for backward compatibility but are ignored — cue timings come from the body and each import always creates its own caption track. Advanced ASS tags (karaoke, drawings) are stripped; the tool notes when `simplified=true`. Returns the new caption track id. |
| `duplicate_layer(layer_id, t_offset_us)` → `LayerId` | |
| `update_layer(layer_id, patch)` | envelope-only patch (label, time range, enabled, locked) |
| `update_layer_params(layer_id, patch)` | kind-specific params |
| `update_layer_param_track(layer_id, param_key, track)` / `update_layer_param_tracks(layer_id, entries)` | replace one / several `Animated<f64>` tracks; normalized (frame-snap / sort / dedupe-last-wins), recorded, rejects empty-keyframed / unknown-param / locked-track |
| `move_layer(layer_id, new_track_id, new_t_start_us, escape_group?)` | rejects on overlap; group-aware (see `features.md#groups`) |
| `split_layer(layer_id, at_t_us, escape_group?)` → `(LayerId, LayerId)` | |
| `trim_layer(layer_id, edge, new_t_us, escape_group?)` | `edge` ∈ `"in" | "out"` |
| `delete_layer(layer_id)` | |
| `groups_create(layer_ids, label?, reassign?)` → `GroupId` | |
| `groups_dissolve(group_id)` / `groups_add_members(group_id, layer_ids, reassign?)` / `groups_remove_members(group_id, layer_ids)` / `groups_rename(group_id, label?)` | |
| `add_marker(t_us, label, color, end_t_us?)` → `MarkerId` | |
| `update_marker(marker_id, patch)` / `remove_marker(marker_id)` | |
| `set_composition(patch)` | never recorded (setup, not editing); `fps` refused with `FpsLockedByContent` once the timeline — or any stored snapshot/checkpoint — holds a layer |
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
│   ├── audio/                ← canonical conformed PCM, 48 kHz f32le (see `audio.md`)
│   ├── frames/               ← on-demand video frames (media://{id}/frame/{t})
│   ├── raster/               ← persisted Motif L2 pre-bake PNGs (opt-in; see `motifs.md`)
│   ├── inline-subs/          ← reserved; currently unused
│   ├── transcribe-audio/     ← mono 16 kHz WAV slices for transcription (cloud + local sidecars)
│   └── voiceover/            ← TTS output
├── Backups/                  ← periodic project.json snapshots (rolling 20)
└── Renders/                  ← export outputs default here
```

**Authoritative path is `MediaItem.path_rel`** (relative to the workspace root). At load time `io::load_from_dir` rewrites `path_abs` as `workspace.join(path_rel)` so moving the workspace folder between machines doesn't break references. `path_abs` is kept in the struct as a convenience for the IR compiler + jobs that read media by absolute path.

`Backups/` rolls every 50 commits or 5 minutes (whichever first), retains the 20 most recent. `project_save_as` is gone in favor of the auto-save subscriber; Cmd-S is a force-flush hook reserved for future UI. The save model is "the folder is the truth" — closing the app loses nothing.

## App-level storage: the data root

Everything above is **per-project** — it lives inside the workspace folder and
travels with it. Orthogonal to that is **app-level** storage: state and large
assets that belong to the installation, not to any one project. This splits in
two, by whether the user should be able to relocate it.

**Small config/state + secrets stay in `<userData>/`** (Electron's per-user app
data dir), each an atomically-written JSON owned by the TS main process:
`app_settings.json`, `keybindings.json`, `workspaces.json`, `recents.json`,
`decode_capability.json`, and the secrets `cloud_keys.json` / `mcp_auth.json`
(plus the OS keyring). These are tiny and their location is fixed — the data
root's own path has to live somewhere the resolver can read before anything
else, so it cannot itself live under the data root (bootstrap chicken-and-egg).

**Large, app-managed, relocatable content lives under a single user-configurable
DATA ROOT**, default `<userData>/data/`, with a fixed internal layout WeftCut
owns:

```
<dataRoot>/            default: <userData>/data  (any absolute path via setting)
├── motifs/            user-authored Motifs (see motifs.md) — user content, not regenerable
├── cache/             the backend's app-level (cross-project) cache — regenerable
└── downloads/         reserved for future downloaded assets (e.g. a runtime ffmpeg)
```

`<dataRoot>/cache/` is the **app-level** backend cache (the second argument to
the `Backend` constructor). Do not confuse it with the per-project
`<workspace>/Cache/` above — that one holds a project's proxies/thumbnails/
waveforms and is deleted with the project; this one is global to the install and
regenerable. Nesting it here also retires a long-standing collision: it used to
be `<userData>/Cache`, the exact path Chromium uses for its own disk cache
(`<sessionData>/Cache`, and `sessionData` defaults to `userData`). Chromium's
cache is deliberately left where it is; the collision is gone simply because the
backend cache moved under the data root.

A single seam, `apps/desktop/src/main/dataRoot.ts` (`resolveDataRoot`), resolves
the root **once, early at boot** — before the `Backend`, the `UserMotifStore`,
and the fs guard are constructed — from a `data_root` field in
`app_settings.json`, and exposes `{ dataRoot, motifsDir, cacheDir, downloadsDir }`.
Every consumer takes its path from the seam; nothing string-joins `userData` for
these buckets. The resolved root is also admitted to the renderer's `fs:*` guard
allow-list (`isAllowed`, alongside `temp` / `userData` / the active workspace),
since it can live outside `userData`.

Resolution rules:

- `data_root` unset/empty → default `<userData>/data`, created silently.
- set + available (creatable **and** write-probed) → used as-is.
- set + unavailable (unmounted drive, revoked permission, deleted path) → a
  **blocking native dialog** (main window not up yet) offering **Re-set** (native
  folder picker; the choice is persisted and used for this boot) or **Quit**.
  Never a silent fallback — a user who deliberately placed data elsewhere makes a
  conscious choice rather than landing in an empty default library.

### Changing the data root

Relocation is offered from Settings → "Data location" and is a first-class,
verified migration (core: `apps/desktop/src/main/dataRootMigration.ts`, pure +
fs-injected; IPC glue on the `dataRoot:*` channels). Semantics: **copy, preserve
original, verify, roll back, prompt-to-delete-after-success.**

1. The user picks a folder. If it is already a valid WeftCut data root
   (`motifs/`+`cache/`+`downloads/` present), it is **adopted as-is** — no copy,
   no merge. Otherwise the migration **copies** into it.
2. Copy `motifs/` and `downloads/` (source read-only; originals untouched);
   `cache/` is **not** copied — the new root gets an empty `cache/` that refills
   naturally. Nested source/target picks are rejected (self-overwrite guard).
3. **Verify** — Motifs by content hash (reusing `motif/contentHash`), downloads
   by file count + size.
4. **On failure → roll back** exactly what the run created at the new root; the
   old root is never touched and `data_root` is left unchanged. No data loss.
5. **On success** → write `data_root`, then relaunch (`app.relaunch()`) to apply
   (the root is fixed early at boot; a live swap would rebuild too much).
6. A userData-resident marker (`data-root-migration.json`, which survives the
   switch) carries the old path across the relaunch. After the app comes back up
   on the new root, Settings offers to delete the old copy — **only in copy mode**
   (in adopt mode nothing was copied, so the old root is the user's separate prior
   library, never proposed for deletion). Deletion is explicit-confirm-only and
   never removes `userData` itself; "Keep" is a one-time dismiss that clears the
   marker.

"No migration" elsewhere in this repo refers to **legacy on-disk formats** (the
project has no shipped users, so there is no upgrade-from-old-layout path); the
data-root *change* flow above is fully migrated and reversible.

## Versioning

`project.json` embeds a `schema_version: u32` field. `SCHEMA_VERSION`
is bumped whenever the on-disk shape changes incompatibly.

The load path is a cut-over gate, not a migration chain: a project at
the build's `SCHEMA_VERSION` loads; anything below it is rejected with
guidance to re-create the project in a fresh workspace; anything above
it is rejected with "update the app". The gate is enforced in two
TypeScript readers — `state/persistence.ts` (the load guard) and
`state/serialize.ts` (`parseProject`) — and `SCHEMA_VERSION` itself
lives in `state/model.ts`. There is no carry-forward of older folders:
maintaining migration code for unshipped formats is pure overhead.

**This is a pre-release stance with a one-way expiry.** Once the format
ships, the first bump makes every existing project unopenable, and a
chain added afterwards cannot rescue files already written. Replacing
this gate with a version-keyed upgrade chain is therefore a release
blocker rather than a nice-to-have — see
[issue #14](https://github.com/UncleChair/WeftCut/issues/14).

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
