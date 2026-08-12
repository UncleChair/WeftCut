# Features

Behavior contracts for small, self-contained editor features — pieces too
small for a subsystem doc but with rules worth writing down. Subsystem
context lives in the linked docs.

## Undo-stack scope

What records into the editing undo stack and what doesn't, so non-editing
operations (project load, media library, canvas setup) never pollute the
history Ctrl-Z walks. Implemented in the TS state layer: the history stack
and out-of-band snapshot patching in `apps/desktop/src/main/state/history.ts`;
per-op record vs unrecorded routing in `state/actor.ts` (tests:
`history.test.ts`, `actor.test.ts`).

**Recording rule.** A state mutation records a `HistoryEntry` iff it changes
the timeline structure of the currently-loaded project — layers, tracks,
markers, transitions, or layers cascade-deleted by a media removal.
Everything else broadcasts a non-recorded `ChangeEvent`. The **whole
composition envelope** is on the non-recording side: size, rate, colour and
audio-target fields *and* `duration_us` / `duration_pinned`. It is project
setup, not editing — `set_composition` and `fit_composition_to_layers` never
add an entry, and Ctrl-Z walks straight past them.

| Op | Recorded? |
|---|---|
| `add_track`, `delete_track`, `move_track` | yes |
| `rename_track` | yes — a name is content, and the layer label already records; the two rename surfaces cannot disagree about undo |
| `update_track_flags` (eye/M/S/lock toggles) | no — patched into every history snapshot; undo never flips a track control |
| `add_layer`, `update_layer`, `update_layer_params`, `move_layer`, `duplicate_layer`, `split_layer`, `delete_layer` | yes |
| `add_marker`, `update_marker`, `remove_marker` | yes |
| `add_transition`, `update_transition`, `remove_transition` | yes |
| `add_media_item` | no |
| `set_media_workspace_paths`, `set_media_derivatives` | no |
| `remove_media`, no references / `force=false` | no — mirror import |
| `remove_media`, `force=true` cascade-delete | yes (layers actually got deleted) |
| `set_composition`, any field or mix of fields | **no** — setup, not editing. One patch, applied to every snapshot + checkpoint |
| `fit_composition_to_layers` | no — same fan-out; each snapshot unpins and refits to **its own** high-water mark |
| Passive duration shrink on layer delete / inward trim (unpinned) | **no separate entry** — rides the layer-edit commit that triggered it |
| `replace_state` (open / new project) | **no** — resets `History` to a fresh one-entry stack and clears checkpoints |
| `undo`, `redo` | cursor-only, no new entry |
| `jump_to { index }` (history panel: click a row) | cursor-only, no new entry — `undo`/`redo` generalized to an arbitrary stack index, so it records nothing for the same reason and rejects under `lock_history` for the same reason |
| `restore_checkpoint` | yes (deliberate user/agent action) |
| `create_checkpoint { label }`, `delete_checkpoint { checkpoint_id }` | **no entry and no `project:changed` broadcast** — neither changes project state, so waking autosave would rewrite `project.json` for nothing. Neither is gated on `lock_history` either: the lock rejects revert paths, and creating or dropping a checkpoint reverts nothing. A surface showing the checkpoint list must refetch it itself after either — the History panel does |

**Why the snags.** Imports are additive — no reference in any older snapshot
can break, so `add_media_item` patches every snapshot in place. `remove_media`
lacks that property when layers reference the media, hence the split: the
no-reference branch behaves like an import; the cascade branch records
because deleting layers is a real edit. `replace_state` is a wholesale
project swap — the old history is incoherent against the new `project_id`,
so the stack and checkpoints reset instead of carrying forward.

**Why the composition envelope stopped recording.** `duration_us` and `fps`
used to record, for two reasons that both turn out to be arguments about the
*shape of the fan-out*, not about whether it belongs in history:

- a shrinking `duration_us` could strand layers past the end in an older
  snapshot that held longer content;
- an `fps` change re-snaps layer geometry and markers.

Both dissolve once the patch is applied as a **transform run per snapshot**
rather than a value copied across them (`History.replaceCompositionEverywhere`).
Ctrl-Z is therefore not the safety net for these fields, and the UI carries the
guard instead: Settings → Canvas mounts with its "Lock canvas settings" switch
engaged, so the resolution and rate are inert until the user turns it off, and
re-engaging it abandons any in-progress size edit. Widen the undo scope again and
that guard becomes redundant — it exists to price in the missing undo, not for
its own sake.
`applyDurationAutofit` already floors a pinned duration at the *live* content
high-water mark, so running it inside each snapshot makes the overflow guard
per-snapshot for free: the snapshot with the 10 s layer keeps a 10 s duration
while the head sits at 3 s, and nothing is ever stranded. The fps re-snap
likewise runs against each snapshot's own markers.

**The rate lock is history-scoped, and has to be.** An unrecorded `fps` change
lands in *every* stored snapshot, so judging `FpsLockedByContent` on the
current state alone would leave `undo` (and `restore_checkpoint`) as a
backdoor: empty the timeline, change the rate, undo the deletion, and layers
authored on the old grid reappear at the new rate — a state neither revert
path re-validates. So the rule is **judgement scope == write scope**: the rate
is refused if the live timeline holds a layer *or* any snapshot or checkpoint
does (`History.storedSnapshotsHoldLayer`). `locked_by` on the error names
which. Practically the rate is settable only on a project whose timeline has
never held anything, and the escape hatch is the one Premiere and Resolve both
prescribe — empty the timeline, then reopen the project, since `replace_state`
resets the stack and checkpoints. The settings panel reads this off
`composition.fps_locked` to disable the control rather than offer a click that
always errors.

**User vs agent.** Both surfaces write the same `History`; entries carry an
`Actor::User` / `Actor::Agent { client }` tag so the history panel can
distinguish them, but Ctrl-Z walks back across both — selective undo on a
shared mutable state graph is the "history as DAG" problem and out of scope.
While an agent holds `lock_history(reason)`, every revert path (`undo`,
`redo`, `jump_to`, `restore_checkpoint`) rejects with `HistoryLocked`; the lock is
ephemeral (released via `unlock_history` or workspace swap) and never
affects what records. Deferred: `begin_transaction`/`commit_transaction`
bracketing to collapse an agent batch into one undoable entry — revisit
when stack-flooding actually hurts.

## Groups

A `Group` is a project-level entity owning a flat set of member `LayerId`s —
a layer is in at most one group, no nesting. Moving, trimming, or splitting
a member fans the edit out to the other members under the rules below;
everything else (keyframes, opacity, gain, delete) stays local. Groups have
no rendering significance — the renderer composes every member
independently. One mechanism serves both auto-paired AV from a single
source and manual scene bundles (B-roll + voiceover + lower-third that
travel together).

**Fan-out rules** — any single op can bypass them with `escape_group: true`:

- **Move** propagates the time delta to every member's `t_start_us`/`t_end_us`;
  the track change applies only to the targeted layer. Rejects if any
  member's new range would overlap its track or leave the composition.
  Dragged toward the origin the group **stops as a set**: the clamp applies to
  the shared delta, so the earliest member lands on 0 and everyone keeps their
  spacing — no member is shortened in place. Each member then re-snaps on *its
  own* lattice, which is what preserves a slipped A/V sync offset.
- **Trim** propagates only to members whose corresponding edge sits at the
  same exact `t` (alignment is recomputed per op — there is no stored
  "linked" state), with the delta clamped so no member crosses its source
  bounds (`src_in_us`/`src_out_us`) or inverts.
- **Split** cuts every member spanning `T`, distributing source in/out
  proportionally for media-bearing kinds; all pieces stay in the group.
- **Raise to a new track** is not a fan-out: `move_layers_to_new_track` moves
  exactly the layers it is handed, onto one fresh lane, with every time carried
  verbatim — there is no delta for a member to follow. What differs between its
  two entry points is only which layers they name. The **Move to a new track**
  command names the selection; a clip dragged into the **drop strip** names the
  drag's subject set, so a grouped clip takes its group up with it and every
  member changes lane, unlike a plain Move (above), where only the targeted layer
  does.
- **Locks reject the whole op:** if a fan-out would touch a member with
  `locked == true` — or any layer on a `Track.locked` track — the op fails
  with `GroupLockedMember` / `TrackLocked` rather than partially applying.

**Invariants** (validated on every commit): every member resolves to a real
layer; no layer appears in two groups; a group auto-dissolves below 2
members *in the same commit* (delete is always local — `delete_layer` never
fans out); `groups_create`/`groups_add_members` reject already-grouped
layers unless `reassign: true`, which moves the layer over.

**Import auto-pair.** When `auto_pair_audio_on_import` is on (default) and
an imported video source has an audio stream, import creates a `VideoClip`
plus an `Audio` layer (same media, same span) and groups them atomically.
`VideoClip` lowering does not emit audio — the paired `Audio` layer is the
audible one.

**UI.** Click a member → select the whole group; `Shift+click` extends by
group; `Alt+click` selects only the clicked layer, and `Alt+trim` escapes
that one trim (body `Alt+drag` instead duplicates the single layer at the
drop position). Grouped layers show a 2 px left accent in a hue derived
deterministically from `group_id` plus a small chain-link icon. `Ctrl+G`
creates from the selection, `Ctrl+Shift+G` dissolves — rebindable via the
TS keybindings store.

**A/V sync offset.** An audio member can be slipped off its video partner
(audio lives on the 48 kHz sample lattice — see [audio.md](audio.md)), and the
resulting offset is **derived from the geometry, never stored**: it is
`audio.t_start_us − video.t_start_us`, measured in sample indices so the
~10 µs residue between the two lattices at 29.97 / 59.94 does not read as a
slip. With no field, nothing can disagree with where the clips actually are.

A non-zero offset shows as a badge on the audio clip (`+3 smp`, `−2.00 ms`).
The two existing fan-out rules already behave correctly for it, and this is
worth stating because it looks like an inconsistency and is not: a
**whole-group move preserves the offset** (every member shifts by the same
delta, then lands on its own lattice), while a **video trim does not drag
slipped audio** (the aligned set requires coinciding edges — which is the
right outcome for a deliberately slipped track).

`Alt+←/→` nudges a selected audio layer one sample, `Alt+Shift+←/→` one
millisecond (48 samples), and `Alt+Shift+S` re-syncs it to its video. All five
are real commands, so the search palette lists them, Settings → Keyboard
rebinds them, and an agent can call them. **Pointer drags never reach sample
precision** and are not meant to: one sample is 0.042 px at the 2000 px/s zoom
ceiling, so dragging keeps snapping to the visible quantum. Sample precision
arrives through the nudges and through the inspector's numeric fields, whose
unit (timecode / milliseconds / samples) is switchable per the audio-units
selector — audio readouts only; the ruler and playhead stay frame-based.

Mutations live in `apps/desktop/src/main/state/mutations/groups.ts`, with
fan-out enforcement in `move.ts` / `trim.ts` / `split.ts`. MCP tools
(`groups_create` … `groups_rename`, plus `escape_group` on the structural
ops) and the read surface (`groups` on `project://current`; there is no
`groups_list` tool): [mcp.md](mcp.md). Wire shape: [data-model.md](data-model.md).

## Timeline zoom

Two gestures scale the timeline, differing in one thing — what they hold still.
**Ctrl+wheel** is continuous and holds the time under the **cursor**. **`=` /
`-`** step one doubling per press and hold the **playhead**, because a key press
has no pointer to hold. Geometry in
`apps/desktop/src/renderer/timeline/zoom.ts`; the state, the bounds and the one
`scrollLeft` write in `hooks/useTimelineView.ts`.

Both share the same range. The ceiling is a flat 2000 px/s. The floor is
computed per gesture: **fit-to-project** — the scale at which the project extent
(before the post-roll padding) exactly fills the lane — so zooming out always
stops at the whole timeline and never past it, and the stop widens as the
project grows or the panel resizes. Pressing into a stop is a no-op, not a
nudge: the view doesn't move.

**When the playhead is off screen**, a keyboard zoom anchors the lane's centre
instead. A zoom is a magnification, not a seek — a user who scrolled to a
distant region and pressed `-` to widen it wants *that* region to widen. The
complement is the property the anchoring exists for: a playhead that is on
screen **stays** on screen, at every rung, because holding its offset from the
lane's left edge survives both end-stop clamps.

`=` / `-` rather than the `Mod+=` / `Mod+-` half of the convention, and this is a
hard constraint rather than a preference: `hardenWindow`
(`src/main/windows.ts`) consumes every Ctrl/Cmd +/−/0 at `before-input-event` to
kill Chromium's page zoom, which would otherwise shrink the whole application —
and that `preventDefault()` stops the keydown from reaching the renderer at all.
A chorded binding would look right in Settings → Keyboard and never fire. Bare
keys also stay dead inside text fields, so a minus still types into a numeric
inspector field.

Both are real commands (search palette, Settings → Keyboard, agent-callable) and
are **unscoped** — the timeline is the only zoomable surface in the app, so `=`
means the same thing whichever panel holds focus.

## Follow playhead

The timeline keeps the playhead on screen by **paging** its view: when the
playhead crosses to within 12 px of a viewport edge, the view jumps so the
playhead sits one lead (8 % of the viewport, min 12 px) inside the edge it
crossed. Geometry in
`apps/desktop/src/renderer/timeline/followPlayhead.ts`; the DOM side —
transient playhead subscription, one `scrollLeft` write per page — in
`hooks/useFollowPlayhead.ts`.

**Paging, not tracking.** Pinning the playhead to a fixed column and sliding
content under it would rewrite `scrollLeft` on every composition frame, and
each write publishes to `timelineScrollStore` and re-renders the ruler. A page
touches the view once per screenful.

**Forward vs backward are asymmetric.** Forward pages leave a lead behind the
playhead and a near-full screen of lookahead. Backward pages jump a full screen
so the playhead lands near the *right* edge — the gesture that ran it off the
left edge (stepping back a frame, seeking to the previous edit) is one the user
repeats, and a lead-sized jump would re-page on the next press.

**What moves the view and what doesn't.** Playback and jumps (shortcut seeks,
edit-point steps, timecode entry, palette navigation) follow. Two things
deliberately don't: a **ruler scrub drag**, because the user is aiming at a
point they can see and paging would move the target out from under the pointer;
and **zoom**, which owns its own anchor ([Timeline zoom](#timeline-zoom)) — the
follow only ever reacts to the playhead moving, never to the view changing
shape around a stationary one. That split is why a wheel tick cannot silently
re-anchor on the playhead, and why the keyboard zoom's playhead anchor is the
zoom's decision rather than the follow reaching in.

App-level pref `timeline_follow_playhead` (default on), so it is one answer per
machine rather than per project: View → Follow playhead, `Shift+F`, or the
search palette. Absent from an older `app_settings.json` reads as **on**.

## Global search palette

`Mod+K` (also a menu item) opens a Spotlight-style overlay that searches,
in one box: **commands** (every user-invocable app action), **media-pool
items**, **tracks**, **clips** (timeline layers by label), **captions /
text** (`Text` layer content — captions are Text layers, ADR 0026), and
**markers**. Selecting a result either executes (commands) or navigates
(everything else: select the item, move the playhead, scroll the timeline).
Navigating never changes play state — seek-while-playing keeps playing, the
Premiere/Resolve convention. Chinese text matches three ways: original
characters, full pinyin ("zimu" → 字幕), and pinyin initials ("zm");
command entries index their en-US label as an extra haystack, so "export"
matches 导出 on a Chinese locale. Out of scope: effect parameters, keyframe
values, project-settings values, persistent search history.

**Stale-but-instant index.** Palette queries never block on indexing; they
always hit the last completed index (like an IDE search during re-indexing):

```
project:changed ─▶ debounce 300 ms ─▶ async full rebuild ─▶ atomic swap
palette open / keystroke ───────────▶ query the last completed index
```

Every rebuild is a full rebuild from the canonical `projectStore.summary`
snapshot, so ghost-entry / missed-update sync bugs are impossible by
construction. The corpus is one project's summary — single-digit
milliseconds on the main thread, cheaper than structured-cloning the
summary into a Worker (`buildEntries` is pure, so the Worker escalation
seam stays open). Pinyin haystacks are memoized per source string, which
makes full rebuilds behave like increments.

**Ranking & activation.** fuzzysort scores every haystack and keeps the
best per entry, with a floor that drops scatter matches and small boosts
for commands and exact prefixes; results group in fixed order (commands →
media → tracks → clips → captions → markers), capped per group with a
"show more" expander. Pinyin-matched results skip highlighting — fuzzysort
indexes don't map 1:1 onto CJK label chars, so no highlight beats a wrong
one. Media rows open a second level (reveal in pool + one row per timeline
usage). Activation re-validates ids against the live project; an entry
deleted since the last index build logs via LogBus and no-ops. `cmdk` was
rejected — its dialog binds Radix while the app is on Base UI, and
multi-haystack pinyin matching needs a custom filter anyway; the deps are
`fuzzysort` + `pinyin-pro`.

Code: `renderer/search/` (index store, matcher, pinyin, palette UI). The
command registry the palette executes from is
`renderer/commands/registry.ts` + `appCommands.ts`; navigation verbs live
in `renderer/state/navigation.ts`.

## Color picker (eyedropper)

One global pick session serves every color surface
(`renderer/colorpick/pickColor.ts`). At session start it freezes two
buffers — the composited preview via `extract.pixels` (working-space-true,
composition resolution) and a `capturePage()` window snapshot — then every
hover sample is a CPU read. The native `EyeDropper` API handles
whole-screen picks (`S` during a session); it returns only a color — no
coordinates, no hover — which is why it cannot carry the in-app session.

**Why the sample source is frozen:** chromakey hover live-applies the key
color while you move; sampling the live composite would read the keyed
result (the background), not the source pixel — a feedback loop. The
session freezes a pre-key frame (`excludeEffectId` disables that filter for
the freeze) and sampling never touches the live pipeline.

**Seams:** `previewSamplerRegistry` — PixiPreview registers capture/mapping
on mount; the picker never imports Pixi. `effectOverrides` — transient
per-effect param overrides + disable flags consulted by
`EffectChain.sync()`; never recorded, never in React state; PixiPreview
re-composites on every change so hover edits render while paused.
`AppColorField` — eyedropper button by default (`withEyeDropper={false}` to
opt out). Effect descriptors declare `colorGroups` (RGB scalar triplets);
the inspector commits all three tracks as one undo entry.

**Limits:** screen picks have no hover preview or custom magnifier
(platform API limit; `screenPick.ts` is the seam to replace with a
full-screen custom overlay). Under Electron the native dropper's magnifier
clips at the app window's edge and the pick click activates the clicked
foreign window (electron#27980; sampling itself is screen-wide and
correct) — `screenPick` snaps focus back after every pick as mitigation;
see `docs/notes/electron-chromium-behavior.md` § EyeDropper. The
composition buffer is an 8-bit extract — HDR/10-bit picks read the
tone-mapped value. The window snapshot is frozen at session start; UI
changes mid-session are not reflected.

## On-canvas transform (gizmo)

The primary selected layer shows its footprint as a box over the preview:
dragging inside the box moves it, handles on its corners and edges resize it, a
knob on a stalk above its top edge rotates it, and a target reticle at the pivot
moves its anchor. Only the four transform-bearing visual kinds get one (Color
fills the composition, Audio is not visual), and only while the playhead is
inside the layer's span.

**Why the box is an SVG overlay and not Pixi children:** `app.stage` is a
read-back surface — the eyedropper's `extract.pixels`, the e2e
`sampleComposite` hook and the conformance `captureFrame` PNG all read it, so
anything staged would land in those buffers. And the canvas is contain-fitted:
a box drawn in composition space would be sub-pixel on a 4K composition shown
in a small panel, while a screen-space overlay has handles in CSS pixels by
construction. (The ecosystem's Pixi gizmo, `@pixi-essentials/transformer`, is
also v7-only — it peer-depends on the `@pixi/*` sub-packages v8 removed.)

**Why the drag doesn't write per pointermove:** one write per move event is a
full renderer→main→`project:changed`→refetch round trip and would pile up undo
steps. The gesture instead sets a transient delta in `transformOverrides` (same
idiom as `effectOverrides`: consulted after `resolveView`, never recorded, never
in React state), and commits once on release through `updateLayerParamTracks` —
one batch, one undo. The override is held until the new summary arrives, so the
layer never snaps back for a frame between commit and refetch. The box itself
reads that same override map rather than the in-flight gesture's own state, so
the outline and the footprint it outlines cannot drift apart mid-drag whichever
handle is moving — and an anchor gesture, which moves four fields at once, lands
all of them on one frame.

**Why rotation writes one track and nothing else:** the engine rotates about the
anchor and `x`/`y` mean the *unrotated* top-left, so turning a layer about its
anchor moves neither — the commit is `rotation_deg` alone. A handle that rotated
about the box's visual centre instead would need compensating `x`/`y` in the same
batch, time-dependent on a keyframed layer.
The gesture accumulates per-move angle increments folded into (−180, 180°]
rather than diffing against its start angle: `atan2`'s ±180° branch cut would
otherwise read a +20° drag across the seam as −340°, and accumulating is also
what makes a multi-turn drag mean multiple turns. Shift snaps the resulting angle
to an absolute 15° grid while the true angle is kept alongside, so releasing
Shift resumes from the cursor rather than from the grid.

**Why the anchor target writes four tracks and the inspector field writes one:**
moving the anchor moves the pivot, and the pivot enters the composed position, so
an anchor change generally moves the picture. The canvas gesture is *pan-behind*
— it commits the anchor pair plus compensating `x`/`y` together, so the picture
stays exactly where it was and only the reticle moves. The inspector's `Anchor
X`/`Anchor Y` fields write the anchor alone, which does move a rotated or Text
layer; the split is deliberate and matches After Effects, and nothing else is
available to the panel, which has no natural size to compute a compensation with.
The compensation is zero for an unrotated, unflipped media layer, so the common
gesture writes two tracks and never stamps a redundant key on position. A drag is
converted client → composition → the layer's own *local* frame before it becomes
an anchor delta (the anchor is stored unrotated and unscaled), which is what keeps
the reticle under the cursor on a rotated layer. Both surfaces keyframe: the
anchor pair is `Animated` like the rest of the transform.

**Why a resize handle pins the anchor:** the handles scale the layer about its
anchor, matching After Effects and Premiere and matching what the reticle already
shows — the engine's own rotation and scale origin. That needs compensating
`x`/`y`, because the composed position is `(x, y) + |scale|·pivot`, so scale alone
would walk the pivot; pinning it is `Δ = pivot·(|scale₀| − |scale₁|)` per axis,
with no rotation term at all. It is the exact mirror of the anchor gesture: there
a media layer usually needs no compensation and Text always does, here Text needs
none (its position *is* the pivot) and a media layer always does. With the pivot
pinned the solve is direct rather than iterative — `scale·offset = R⁻¹·(cursor −
pivot)` — so the grabbed handle tracks the cursor exactly however the layer is
rotated, flipped or non-uniformly scaled.

A `scale_linked` layer shows its **corners only**. An edge handle there has no
honest behaviour: a single-axis write is what the twin invariant reads as
divergence, and it would silently clear the flag. Shift constrains proportions on
an unlinked layer by fitting one factor to the handle's own axes — the diagonal
projection on a corner, the plain axis ratio on an edge. Which axes a handle
drives comes from its identity and never from "its offset from the pivot is
zero": an off-centre anchor puts the top edge's midpoint off the pivot's column,
and inferring the mask there would let a horizontal drag scale it sideways.

The handles are **round** so they carry no orientation to keep in sync with the
box: a square would have to be re-rotated every frame to match it, and on a
flipped or non-uniformly scaled layer — where the quad's winding reverses and its
edges stop being perpendicular — no single angle for it is correct. The direction
that matters is carried by the cursor instead.

Deltas below `1e-9` are dropped rather than committed. `Math.cos(±π/2)` is `6e-17`,
so anything downstream of the inverse rotation — a resize solve, an anchor drag —
leaves `~1e-16` on the axis the cursor did not move, and against exact zero that
reads as an edit and stamps a keyframe with an invisible value change.

**Why snapping decides the two axes independently:** a move or a resize pulls onto
the composition's four edges and two centre lines and onto every other staged
layer's screen-space bounding box, with each axis decided on its own. A single
global best — the right rule for the timeline, where time is one-dimensional —
would make "flush against the left edge *and* vertically centred" unreachable.
Ties go to a composition line, so a layer line has to be strictly nearer to win;
in the timeline an implicit tie-break is safe only because its boundary set has a
stable track order. Strength is a **screen**-pixel radius
(`preview_snap_strength_px`, default 12, with `preview_snap_enabled` beside it),
converted to composition pixels per move through the contain fit so the pull feels
the same at any composition resolution. It is deliberately its own app-level pair
rather than a reuse of the timeline's, whose target density differs by an order of
magnitude. Holding Ctrl suppresses the snap while it is down — not Alt, which
opens the self-drawn menu bar on Windows. Guides are magenta (the palette is
achromatic by design, and magenta's low green keeps it legible over skin, sky,
foliage and water alike), at most one per axis, painted under the box and the
handles with a dark under-stroke.

The solver is pure (`preview/previewSnap.ts`) and runs *before* the override is
written, against the gesture's raw un-snapped box: the box depends on the
override, the override on the snap result, and the snap result on the box, so
measuring after the write is the one ordering of those three that fails to
terminate. A free resize snaps the handle's **target point**, which is exact at
any rotation because the solve lands the handle on the point it was given
identically — masked to the axes the handle drives, since a scale the solve would
discard must not draw a guide first. A uniform resize (a linked layer, or Shift)
has one degree of freedom — `scale = t · scale₀`, so the handle travels a fixed
ray — which makes a snapped point generally unreachable; it solves `t` by
ray/line intersection instead, and at most one axis can be hit. That branch ranks
by the resulting **displacement**, not by perpendicular distance to the line: a
near-parallel ray needs an enormous `t` to reach a line a few pixels away, so a
nudge would become a 500× scale-up. The target set is frozen at pointerdown, so
guides do not follow layers that animate mid-gesture.

**Why a commit's base comes from a ledger:** every gesture commits an absolute
track built from `base + delta`, and the project mirror is two IPC round trips
behind — commit → `project:changed` → refetch → re-render. A second gesture
released inside that window would read the pre-commit base and *replace* the first
gesture's track instead of stacking on it. The gizmo therefore keeps a
renderer-local ledger of `param key → the track it wrote`, entered before the round
trip starts and read ahead of the mirror by every commit and by the rotation grid
(which would otherwise quantize a Shift-rotate against an angle no longer on
screen). The override carries the matching gap as a per-channel **carry**,
`resolve(written) − resolve(mirror)`, because `setTransformOverride` replaces
rather than merges: without it the next gesture's first pointermove drops the held
override and the layer visibly snaps back by the previous displacement. The carry
is self-cancelling — once the summary carrying the write lands, both tracks
resolve to the same value and every channel goes to zero — so the override lifts
itself, nothing has to decide when the round trip finished, and a summary arriving
mid-gesture just moves the carry into the base. The ledger is dropped on the first
summary that arrives with no commit still in flight, which is how undo, the
inspector or an MCP agent takes the authority back.

**Seams:** `gizmoProbeRegistry` — PixiPreview registers `canvasRect` +
`naturalSizeOf`; the gizmo never imports Pixi. `gizmoGeometry.ts` — pure
composition-space quad, pivot, handle placement and the `object-fit: contain`
mapping, so the geometry is unit-tested without a renderer (and shares
`anchorPivot.ts` with the renderer, which is what keeps box and picture aligned).
`autoKeyTrack` — the shared commit rule: a Static track takes a value, a
Keyframed one gets a key at the frame-snapped playhead, exactly like the
inspector.

**Limits:** move, resize, rotate and anchor — no crop, no corner-pin. Single
selection only. The box follows animated values during playback via rAF; it is
hidden while the preview dock tab is not visible. The rotation knob sits a fixed
26 CSS px outside the box (screen space, so the affordance is
resolution-independent), so the overlay runs `overflow: visible` and the panel is
the real clip bound — a layer flush against the top of a panel-filling
composition has no room for its knob. An edge handle whose edge is under 24
screen px is hidden, since it would sit under the two corners it lives between; a
box small enough for its corners to overlap keeps them all, and the interior left
for the move drag shrinks with it. The commit ledger is renderer-local, so it
composes a burst of gestures from this gizmo and nothing else: a *concurrent*
writer editing the same tracks mid-burst — an MCP agent, say — would need the
base resolved on the main side instead.

## Window geometry memory

The main window reopens at last session's position, size, and maximize
state, persisted to `<userData>/window_geometry.json` (`main/windowGeometry.ts`,
wired in `main/windows.ts`). Writes are debounced through drags and flushed
on window close and before quit. A move never dirties the Project or enters
undo — it is app-level state, like the Workspace layout.

**Restore is validated, never trusted.** A saved rect may name a monitor
that has been unplugged or a resolution that has shrunk, and this window is
frameless on Windows/Linux — no OS titlebar, no system Move menu — so an
off-screen restore would be unrecoverable without deleting the file.
`sanitizeGeometry` requires the rect to present a grabbable strip
(≥120×48px) on some display's work area, clamps the size to the host
display, and otherwise falls back to a centered default. A window
deliberately straddling two monitors or hanging past an edge survives;
that is a deliberate divergence from `electron-window-state`, whose
full-containment rule discards both.

**Landmine — the save/restore ratchet.** Electron's bounds API is not
idempotent on a fractionally-scaled display: hand a rect to the
`BrowserWindow` constructor and the value read back differs, because the
DIP↔physical conversion rounds in both directions. Measured at
`scaleFactor` 1.1, feeding each accessor's own output back into the
constructor grows the window monotonically — `ctor → getBounds` runs
1182 → 1189 → 1196 → 1202 → 1209, and `getContentBounds` /
`useContentSize` / `setBounds` all ratchet too, so no accessor pair fixes
it. Persisting what you measure therefore inflates the window every launch
until it hits the screen edge. The fix breaks the feedback loop instead:
`rememberGeometry` keeps persisting the rect it *requested* while the
measurement stays within `BOUNDS_DEADBAND_PX`, and abandons the deadband
permanently at the first genuine resize. `e2e/electron/window-geometry.spec.ts`
gates it by asserting three untouched launches leave byte-identical
geometry on disk.

**Also load-bearing:** capture `getNormalBounds()`, not `getBounds()` —
the latter reports the *maximized* rect, so persisting it makes "restore
down" a no-op next launch. Minimized windows are skipped (unreliable
bounds; `isMaximized()` reads false). Fullscreen is restored only on
macOS, where the green traffic light can also leave it; on Windows/Linux
F11 is dev-gated, so a restored fullscreen would be inescapable in a
release build.

**Landmine — restoring fullscreen must not pass `false`.** Electron reads an
explicit `fullscreen: false` in the constructor as "disable this window's
fullscreen capability": `isFullScreenable()` goes false, the macOS green
stoplight degrades to a plain zoom, and `setFullScreen(true)` becomes a
silent no-op. Since the saved flag is false on every normal launch, feeding
it straight to the constructor turned native fullscreen off for everyone.
The key is spread in only when actually true. Passing `undefined` disables
it just the same — only omitting the key works. Guarded by
`e2e/electron/window-chrome.spec.ts`.

## macOS window caption

The main window is frameless on Windows/Linux (the renderer draws
`<WindowControls/>`), but on macOS it uses `titleBarStyle: 'hidden'` and keeps
the OS-drawn traffic lights — so the green button gives real native fullscreen
and the window keeps its native rounded frame and shadow. Two things that
follow from that, both of which were wrong once:

**The inset comes from CSS, not IPC.** Each self-drawn bar
(`.app-header`, `.startup-titlebar`, `.perf-titlebar`, the agent-mode
titlebar row) starts its content at `env(titlebar-area-x)` and is at least
`env(titlebar-area-height)` tall — the real button geometry, published by
`titleBarOverlay: true`. The fallback in each `env()` covers every
no-overlay case (macOS fullscreen, and Win/Linux where there are no traffic
lights), so none of these rules needs a platform or fullscreen selector.
Driving the inset off the `enter-/leave-full-screen` IPC events instead is
what produced the visible bug: those land only *after* the fullscreen
animation, ~500ms after Chromium has already moved the buttons, so the title
overlapped them for the whole exit animation. `titleBarOverlay` is macOS-only
— on Windows the same flag has the OS paint native caption buttons over ours.

**Centring is one number, and it is derived.** The buttons occupy a 14px-tall
band whose top is `trafficLightPosition.y` (fractional values round to whole
points), and Chromium reports `env(titlebar-area-height)` as `2y + 14` — so the
band's centre is always exactly half that env value. The invariant that follows:
**a bar is vertically centred if and only if its own height equals
`env(titlebar-area-height)`**. Bars that size themselves to the env value
satisfy it for free; `.app-header` is the only one with a height of its own
(42.5px, content-driven), so `y = (42.5 - 14) / 2 = 14`. Getting this wrong is
not subtle — at the previous `y = 11` the buttons sat 3px high in the editor.

**The window's appearance must be declared.** macOS draws the traffic lights
through the *window's* appearance, so with `nativeTheme.themeSource` left at
`'system'` a light-mode host drew the INACTIVE buttons in light-chrome grey —
invisible against the `#0a0a0a` caption, making an unfocused window look like
it had no buttons at all. `color-scheme: dark` cannot reach them; it governs
only what Chromium paints. `themeSource = 'dark'` is set before the first
window, which also carries the dark appearance into native menus, sheets, and
the file picker.
