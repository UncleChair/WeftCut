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
markers, transitions, composition `duration_us`, or layers cascade-deleted
by a media removal. Everything else broadcasts a non-recorded `ChangeEvent`.

| Op | Recorded? |
|---|---|
| `add_track`, `delete_track`, `move_track` | yes |
| `update_track_flags` (eye/M/S/lock toggles) | no — patched into every history snapshot; undo never flips a track control |
| `add_layer`, `update_layer`, `update_layer_params`, `move_layer`, `duplicate_layer`, `split_layer`, `delete_layer` | yes |
| `add_marker`, `update_marker`, `remove_marker` | yes |
| `add_transition`, `update_transition`, `remove_transition` | yes |
| `add_media_item` | no |
| `set_media_workspace_paths`, `set_media_derivatives` | no |
| `remove_media`, no references / `force=false` | no — mirror import |
| `remove_media`, `force=true` cascade-delete | yes (layers actually got deleted) |
| `set_composition` canvas-only fields (`width`/`height`/`sample_rate`/`channels`/`color_space`/`background`) | no — setup, not editing |
| `set_composition` patch containing `duration_us` | yes (also sets `duration_pinned = true`) |
| `set_composition` patch changing `fps` | yes — re-snaps every layer's `t_start_us`/`t_end_us` to the new grid |
| `set_composition` mixed patch (canvas + duration, no fps change) | **split internally**: canvas part patched everywhere; duration delta recorded as one entry |
| `fit_composition_to_layers` | yes (clears `duration_pinned`; the duration shrink rides the same entry) |
| Passive duration shrink on layer delete / inward trim (unpinned) | **no separate entry** — rides the layer-edit commit that triggered it |
| `replace_state` (open / new project) | **no** — resets `History` to a fresh one-entry stack and clears checkpoints |
| `undo`, `redo` | cursor-only, no new entry |
| `restore_checkpoint` | yes (deliberate user/agent action) |

**Why the snags.** Imports are additive — no reference in any older snapshot
can break, so `add_media_item` patches every snapshot in place. `remove_media`
lacks that property when layers reference the media, hence the split: the
no-reference branch behaves like an import; the cascade branch records
because deleting layers is a real edit. `set_composition` has the same
shape — canvas fields patch everywhere; a `duration_us` shrink could strand
layers past the end in older snapshots, so it records; an `fps` change
re-snaps layer geometry, so it records. `replace_state` is a wholesale
project swap — the old history is incoherent against the new `project_id`,
so the stack and checkpoints reset instead of carrying forward.

**User vs agent.** Both surfaces write the same `History`; entries carry an
`Actor::User` / `Actor::Agent { client }` tag so the history panel can
distinguish them, but Ctrl-Z walks back across both — selective undo on a
shared mutable state graph is the "history as DAG" problem and out of scope.
While an agent holds `lock_history(reason)`, every revert path (`undo`,
`redo`, `restore_checkpoint`) rejects with `HistoryLocked`; the lock is
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
