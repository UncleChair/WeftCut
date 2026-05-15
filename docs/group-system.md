# Group System

A first-class group concept that lets a user or agent bundle any set of
layers — across any tracks — into a unit that moves, trims, and splits
together. Unifies two use cases under one mechanism: **auto-paired AV
from a single source** (so the audio doesn't desync when the video
moves) and **manual scene bundling** (B-roll + voiceover + lower-third
that travel together).

Settled in a grilling session on 2026-05-15. Sections map 1:1 to the
decisions resolved there.

---

## What it is, in one paragraph

A `Group` is a project-level entity owning a set of `LayerId`s as
members. Membership is flat (a layer is in at most one group). When a
member is moved, trimmed, or split, the actor fans the operation out
to other members under deterministic rules. Edits to per-member fields
that aren't structural (effects, keyframes, opacity, gain, etc.) stay
local. A caller can bypass fan-out for any single op with
`escape_group: true`.

## The ten design decisions

1. **One unified `Group` concept** — auto-link AV and manual scene
   bundling are the same mechanism. Auto-link is just a group created
   by the importer instead of by the user.
2. **Scope of fan-out: structural ops only** — move, trim, split.
   Delete is local (the group auto-dissolves below 2 members). Effects
   and keyframes stay local.
3. **Flat membership** — a layer is in at most one group. No nesting.
4. **Storage mirrors `transitions`** — project-level
   `imbl::Vector<Group>`, with a derived `HashMap<LayerId, GroupId>`
   index in the actor for O(1) lookup.
5. **Aligned-edge coupling for trim** — trimming an edge propagates
   only to members whose corresponding edge sits at the same exact
   `t`. Clamps the whole op to the tightest aligned member. There is
   no stored "linked" state — alignment is recomputed each op.
6. **Split spans, group survives** — every member whose interval
   contains `T` is split at `T`; non-spanning members stay whole. All
   resulting pieces remain in the same group.
7. **Move propagates time only** — track changes stay local. There is
   no kind-relative-index arithmetic.
8. **Per-op `escape_group` flag, default `false`** — `Alt+drag` /
   `Alt+click` in the UI sets it; MCP exposes it as a tool parameter.
9. **Locked member rejects the whole op** — if a fan-out would touch a
   `Layer.locked == true` member, the op fails with a structured
   error. Caller can unlock or escape.
10. **v1 = MCP + minimal UI + import refactor** — data model, actor
    ops, MCP, multi-select, tinted-border indicator, AND auto-pair on
    import when source has an audio stream.

## Data model

New module `state/group.rs`:

```rust
pub type GroupId = uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Group {
    pub id: GroupId,
    pub label: Option<String>,
    pub members: imbl::OrdSet<LayerId>,
}
```

Project schema v3 adds:

```rust
// state/project.rs
pub const SCHEMA_VERSION: u32 = 3;

#[serde(default)]
pub groups: imbl::Vector<Group>,
```

`#[serde(default)]` keeps every v2 `.vproj` loadable as a v3 project
with `groups = []`. The migration is a no-op on the wire; only the
version bump is recorded.

The actor holds a derived index `HashMap<LayerId, GroupId>` rebuilt on
every `apply` that touches `Project.groups` or `Project.tracks`. Reads
go through the index; writes update both ground truth (`Project.groups`)
and the index in the same step.

## Actor operations

Five new ops on the project actor:

```rust
groups_create(layer_ids: Vec<LayerId>, label: Option<String>, reassign: bool)
    -> GroupId
groups_dissolve(group_id: GroupId) -> ()
groups_add_members(group_id: GroupId, layer_ids: Vec<LayerId>, reassign: bool)
    -> ()
groups_remove_members(group_id: GroupId, layer_ids: Vec<LayerId>) -> ()
groups_rename(group_id: GroupId, label: Option<String>) -> ()
```

Three existing ops gain a `escape_group: bool` parameter (default
`false`):

- `move_layer(layer_id, new_track_id, new_t_start_us, escape_group)`
- `trim_layer(layer_id, edge, new_t_us, escape_group)`
- `split_layer(layer_id, t_us, escape_group)`

`delete_layer` does **not** take `escape_group` — delete is always
local; the group auto-dissolves below 2 members as a corrective
invariant (see below). Callers who want "delete the whole group"
should call `groups_dissolve` first or iterate.

### Fan-out rules

**Move.** With `escape_group=false`, compute `delta_t = new_t_start_us
- layer.t_start_us` and apply it to every member's `t_start_us` and
`t_end_us`. `new_track_id` is applied only to the targeted layer.
Track changes never propagate. Reject the op if any aligned member's
new range would overlap an existing layer on its current track, or
fall outside the composition.

**Trim.** With `escape_group=false`, find the set of aligned members:
`{ m ∈ group(L).members | m.edge_at(E) == L.edge_at(E) }`. Compute the
requested delta. Clamp `delta` so no member crosses its source-trim
bound (`src_in_us` / `src_out_us` for VideoClip and Audio) or violates
`t_start < t_end`. Apply the clamped delta to every aligned member's
matching edge.

**Split.** With `escape_group=false`, identify spanning members
`{ m ∈ group(L).members | m.t_start_us < T < m.t_end_us }`. For each,
produce two new layers `m1`, `m2` with the cut at `T`, distributing
`src_in_us` / `src_out_us` proportionally for media-bearing kinds. The
group's `members` set replaces each `m` with both halves. Non-spanning
members stay untouched and stay in the group.

**Lock interaction.** Before any fan-out, the actor enumerates the
members the op would touch. If any has `locked == true`, the whole op
rejects with `GroupLockedMember { group, locked_layer }`. The
targeted layer being locked also rejects (current behavior).

### Validation invariants

`state/validate.rs` gains four checks, run on every commit:

1. **Member existence** — every `Group.members` LayerId resolves to a
   real layer in some track. Mirrors the `transitions.from_layer /
   to_layer` check.
2. **At-most-one-group** — no LayerId appears in two `Group.members`
   sets.
3. **Auto-dissolve below 2** — `groups_remove_members` and
   `delete_layer` both check the affected group's member count after
   the mutation; groups with `<2` members are dropped from
   `Project.groups` *in the same commit*. This is corrective, not a
   rejection.
4. **Reassign discipline** — `groups_create` and
   `groups_add_members` reject if any target layer is already in
   another group, unless `reassign: true`. With `reassign: true`, the
   actor removes the layer from its prior group (auto-dissolving if
   needed) before adding it to the new one.

## MCP surface

Mirror the actor 1:1:

| Tool                       | Args                                                      |
|----------------------------|-----------------------------------------------------------|
| `groups_list`              | none                                                      |
| `groups_get`               | `group_id: GroupId`                                       |
| `groups_create`            | `layer_ids: [LayerId], label?, reassign?`                 |
| `groups_dissolve`          | `group_id`                                                |
| `groups_add_members`       | `group_id, layer_ids, reassign?`                          |
| `groups_remove_members`    | `group_id, layer_ids`                                     |
| `groups_rename`            | `group_id, label?`                                        |

`move_layer`, `trim_layer`, `split_layer` gain an optional
`escape_group?: bool` parameter (defaults `false`).

Read paths: `Project.groups` is returned as-is in `get_project`. There
is no per-`Layer` `group_id` field on the wire — agents call
`groups_list` once and build their own index, mirroring how
`transitions` are surfaced.

The existing `project:changed` Tauri event covers group mutations.
No new event names.

## Import refactor (auto-pair AV)

When a video source with an audio stream is imported (via the UI
`place_media` command or the MCP `add_media` tool), and the
`Project.settings.auto_pair_audio_on_import: bool` setting is `true`
(default):

1. Probe records `has_audio_stream` on the `MediaItem.metadata`.
2. `place_media` / `add_media` create **two** layers: a `VideoClip`
   on a video track and an `Audio` layer (same `MediaId`, same
   `t_start_us` / `t_end_us`, `src_in_us=0`, `src_out_us=duration_us`)
   on the first audio track (auto-created via `ensure_audio_track`
   if absent).
3. The same code path calls `groups_create([video_layer_id,
   audio_layer_id])` atomically. The group is unnamed (`label =
   None`).

When the setting is `false`, behavior reverts to today's single-layer
import. When the source has no audio stream, no pair / group is
created regardless of setting.

The IR is unchanged — `VideoClip` lowering already drops embedded
audio (`ir/lower.rs:79–127`). The new `Audio` layer is what produces
audible output.

**No retroactive migration.** Existing v2 projects with silent
VideoClip layers stay silent on v3 load. Changing render output on
load would surprise users. A future "find videos with embedded audio
and pair them" command can land separately.

## UI surface

### Selection model

`apps/desktop/src/timeline/Timeline.tsx`:

- `selectedLayerId: string | null` → `selectedLayerIds: Set<LayerId>`.
- Plain click on a member of group G: select **all members of G**.
- `Shift+click`: extend selection by adding the clicked layer (or its
  whole group, if grouped) to the existing set.
- `Alt+click`: select **only** the clicked layer; subsequent ops
  treat this as the `escape_group=true` path.
- `Alt+drag`: same — escape-group on the resulting move.

### Indicator

Each grouped layer gets:

- A 2 px tinted left-border in a hue deterministically derived from
  `group_id` (HSL hue = `hash(group_id) mod 360`, fixed S/L).
- A small chain-link icon (8 px) in the top-left corner of the layer
  chip.

No badge text. No bracket connector across tracks (rejected as too
expensive vs. v1 budget; revisit if user feedback asks).

### Keybindings

- `Ctrl+G` (`Cmd+G` on mac): `groups_create` from the current
  selection. Disabled if `<2` layers selected.
- `Ctrl+Shift+G`: `groups_dissolve` on every group represented in the
  current selection.

Bind via the existing `keybindings.rs` config so users can rebind.

### i18n

New keys under `group.*` (en-US + zh-CN): create-from-selection,
dissolve, members-count, locked-member-rejected error, escape-group
toggle hint.

## Test plan

Backend (Rust):

- `state::group` unit tests: serialize round-trip, OrdSet ordering,
  `Default` for `imbl::Vector<Group>` on v2 deserialize.
- `state::validate` tests for each of the four invariants (positive
  + negative).
- `state::actor` tests for each new op + fan-out tests for move /
  trim / split with mixed-length and aligned-edge fixtures. Cover
  `reassign=true` reassignment, auto-dissolve below 2, locked-member
  rejection, `escape_group=true` local behavior.
- IR / lowering tests unchanged — groups don't reach the IR.
- Import test: AV file → two layers + one group; audio-only file → one
  layer + no group; `auto_pair_audio_on_import=false` → one layer.

Frontend (vitest + manual):

- Selection reducer tests for the three click modes.
- Timeline render: tinted border + chain-link icon visible on grouped
  layers; absent on ungrouped.
- Manual: `Ctrl+G` / `Ctrl+Shift+G` on a multi-select; `Alt+drag` of a
  grouped video clip leaves audio behind.

## What's NOT in v1

- **Group inspector panel** — listing all groups, click-to-select,
  per-group color picker, inline rename UI. Deferred. CLI / MCP can
  rename via `groups_rename` for now.
- **Bracket connector across tracks** — too expensive vs. the
  tinted-border budget.
- **Nesting** — groups inside groups. Out of scope; revisit only if a
  real workflow needs it.
- **Retroactive audio pairing on project load** — would change render
  output unexpectedly. A separate explicit command can do this when /
  if asked for.
- **Premiere-style "select linked clip" right-click** — implicit in
  click-selects-group; the explicit menu item can ride later.
- **Effect / keyframe coupling** — out of scope by decision #2. Could
  layer on as a separate "Linked Effects" feature.

## Implementation phases

| Phase | Subject                                | Files (rough)                                          |
|-------|----------------------------------------|--------------------------------------------------------|
| G.1   | Data model + schema v3                 | `state/group.rs`, `state/project.rs`, `state/validate.rs`, `state/mod.rs`, `io/migrate.rs` |
| G.2   | Actor group ops                        | `state/actor.rs`                                       |
| G.3   | Group-aware move / trim / split        | `state/actor.rs`                                       |
| G.4   | MCP tools + `escape_group` params      | `mcp/mod.rs`                                           |
| G.5   | Import refactor (auto-pair AV)         | `io/probe.rs`, `commands.rs`, `mcp/mod.rs`, `state/project.rs` |
| G.6   | UI: multi-select + indicator           | `apps/desktop/src/timeline/Timeline.tsx`, related stores, `i18n/locales/*.ts`, `styles.css`, `keybindings.rs` |

Each phase is its own commit. Tests added in the same phase that
introduces the surface they cover.
