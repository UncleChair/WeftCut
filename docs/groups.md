# Groups

A first-class group concept that lets a user or agent bundle any set of
layers — across any tracks — into a unit that moves, trims, and splits
together. Unifies two use cases under one mechanism: **auto-paired AV
from a single source** (so audio doesn't desync when the video moves)
and **manual scene bundling** (B-roll + voiceover + lower-third that
travel together).

## What it is, in one paragraph

A `Group` is a project-level entity owning a set of `LayerId`s as
members. Membership is flat (a layer is in at most one group). When a
member is moved, trimmed, or split, the actor fans the operation out
to other members under deterministic rules. Edits to per-member fields
that aren't structural (keyframes, opacity, gain, etc.) stay local. A
caller can bypass fan-out for any single op with `escape_group: true`.

Groups have **no rendering significance**. They're a pure UX
abstraction: a layer's group membership affects how the actor batches
structural edits, nothing else. The renderer composes every member as
an independent sprite.

## The design decisions

1. **One unified `Group` concept** — auto-link AV and manual scene
   bundling are the same mechanism. Auto-link is just a group created
   by the importer instead of by the user.
2. **Scope of fan-out: structural ops only** — move, trim, split.
   Delete is local (the group auto-dissolves below 2 members).
   Keyframes stay local.
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

## Data model

```rust
// state/group.rs
pub type GroupId = uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Group {
    pub id: GroupId,
    pub label: Option<String>,
    pub members: imbl::OrdSet<LayerId>,
}
```

Projects carry a top-level `imbl::Vector<Group>`. The actor holds a
derived index `HashMap<LayerId, GroupId>` rebuilt on every `apply` that
touches `Project.groups` or `Project.tracks`. Reads go through the
index; writes update both ground truth (`Project.groups`) and the
index in the same step.

## Actor operations

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
targeted layer being locked also rejects. Additionally, the actor
rejects structural ops (`move_layer`, `trim_layer`, `split_layer`,
`delete_layer`, `update_layer`, `update_layer_params`) on any layer
whose **track** has `Track.locked == true` — the track lock acts as a
blanket guard; group fan-out respects it the same way layer-level lock
does.

### Validation invariants

`state/validate.rs` runs on every commit:

1. **Member existence** — every `Group.members` LayerId resolves to a
   real layer in some track.
2. **At-most-one-group** — no LayerId appears in two `Group.members`
   sets.
3. **Auto-dissolve below 2** — `groups_remove_members` and
   `delete_layer` both check the affected group's member count after
   the mutation; groups with `<2` members are dropped from
   `Project.groups` *in the same commit*. This is corrective, not a
   rejection.
4. **Reassign discipline** — `groups_create` and `groups_add_members`
   reject if any target layer is already in another group, unless
   `reassign: true`. With `reassign: true`, the actor removes the
   layer from its prior group (auto-dissolving if needed) before
   adding it to the new one.

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

`move_layer`, `trim_layer`, `split_layer` accept an optional
`escape_group?: bool` parameter (defaults `false`).

Read paths: `Project.groups` is returned as-is in `get_project`. There
is no per-`Layer` `group_id` field on the wire — agents call
`groups_list` once and build their own index, mirroring how
`transitions` are surfaced. The existing `project:changed` event
covers group mutations.

## Import auto-pair

When a video source with an audio stream is imported and
`Project.settings.auto_pair_audio_on_import` is `true` (default):

1. Probe records `has_audio_stream` on the `MediaItem.metadata`.
2. The import path creates **two** layers: a `VideoClip` on a video
   track and an `Audio` layer (same `MediaId`, same `t_start_us` /
   `t_end_us`, `src_in_us=0`, `src_out_us=duration_us`) on the first
   audio track (auto-created via `ensure_audio_track` if absent).
3. The same code path calls `groups_create([video_layer_id,
   audio_layer_id])` atomically. The group is unnamed.

When the setting is `false`, behavior reverts to single-layer import.
When the source has no audio stream, no pair / group is created
regardless of setting.

`VideoClip` lowering does not emit audio; the paired `Audio` layer is
what produces audible output.

## UI

### Selection model

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

### Keybindings

- `Ctrl+G` (`Cmd+G` on mac): `groups_create` from the current
  selection. Disabled if `<2` layers selected.
- `Ctrl+Shift+G`: `groups_dissolve` on every group represented in the
  current selection.

Bound via the TS keybindings store (`src/main/keybindings.ts`) so users can rebind.
