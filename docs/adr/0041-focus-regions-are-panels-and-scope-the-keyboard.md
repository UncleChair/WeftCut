---
status: accepted
---

# A focus region is a Panel, DOM focus always lands on one, and that is what scopes the keyboard

## Context

The renderer had no notion of a focus *region*. Across `src/renderer` every
`tabIndex` was control-level — buttons, list items, dialog tab-lists — and no
main surface was focusable: not the timeline root, not the preview canvas, not
the media pool. Focus was therefore always in one of two bad states: parked on
a text input the user had visually left, or dropped on `<body>`, where no part
of the app owned the keyboard.

The reported symptom was narrow. Clicking a transform-gizmo handle did not
release the property field the user was typing in, so the typed value was never
applied — every field commits on blur. The mechanism is not obvious: the gizmo's
pointerdown handlers call `preventDefault()` to suppress native drag and text
selection, and a canceled `pointerdown` suppresses the compatibility `mousedown`
whose default action is what moves focus. The same shape sat in the keyframe
curve graph, the transition chip, the track-height splitter, and the layer
block. All of those `preventDefault()` calls are correct, and all of them stay.

Underneath the symptom, four independent mechanisms had grown to answer "who
owns this key":

1. The dispatcher's four knobs — `isEditableTarget`, `isInTransientWidget`,
   `captureGlobal`, `fireWhenEditing`.
2. Raw capture-phase `keydown` listeners racing each other with
   `stopImmediatePropagation()`: the keyframe diamond, the keyframe lane, the
   transition chip, the gizmo's Escape.
3. Selection-state mutual exclusion — clicking a clip body cleared the keyframe
   selection so that Delete "targets the layer again".
4. `blurAfterMouseActivation`, which dropped focus on `body` after a mouse
   activation because there was nowhere better to put it.

`captureGlobal`'s own comment named the missing piece: *Space must toggle
playback even when focus is parked on a menubar trigger / toolbar button after a
click.* The workaround existed because there was no region to hand focus back
to. And the three capture-phase Delete listeners had drifted apart — the
transition chip checked `isEditableTarget`, the two keyframe listeners did not,
so Delete aimed at a character in a text field silently removed a keyframe and
ate the keystroke.

## Decision

### A focus region is a dock Panel, and it needs no new taxonomy

`PANEL_REGISTRY` already enumerates the Panel kinds and `WeftCutPanelRenderer`
already wraps every Panel's content in one element, so the Panel root becomes
the region: `tabIndex={-1}` plus `data-focus-region={kind}`. One edit covers
every Panel, present and future.

The attribute is deliberately **separate from `data-panel-kind`**, which also
appears on the tab renderers — chrome, not regions. Keying regions off the
existing attribute would make a tab its own region.

`tabIndex={-1}` is load-bearing: a region is a programmatic focus target and
never a Tab stop, so it cannot swallow a Tab press or reorder the keyboard
walk. Its focus ring is suppressed, because a region gets focused on almost
every click and a ring there would read as "this whole panel is selected".
Which Panel owns the keyboard is already visible in Dockview's active-group tab
treatment.

### Focus release is a capture-phase `pointerdown` at `window`, and nothing else

`useFocusRegions` focuses the region root when a press lands on non-focusable
Panel content. Capture at `window` is the only phase that runs ahead of the
gesture handlers' `preventDefault()` — React attaches at the root container, a
descendant of window, so even React's capture handlers are later.

Releasing by *focusing the region* rather than by calling `blur()` is the whole
design. Blur-to-nowhere is what made `captureGlobal` necessary; landing focus on
a region means the keyboard always has a real owner, and the parked field's
blur — and therefore its commit — falls out as a side effect of the native focus
transfer.

Presses that would move focus on their own are left alone; `focusin` records
where they landed. Determining "would move focus" needs the region passed in
explicitly, because the region root is focusable by construction and Dockview's
wrappers above it may be too.

### A composite field is one focus group

`data-focus-group` marks a widget whose satellite controls belong to the focused
input: a NumberField's steppers, a clearable input's ✕, the sibling segments of
a timecode field. A press inside the group is not "outside the field".

Without it the model would actively break working behaviour. `AppInput`'s ✕
keeps focus with an `onMouseDown` preventDefault that a capture-phase listener
now precedes. And `AppTimecodeField` commits when focus leaves the whole
control, testing `relatedTarget` — which is null on a programmatic release — so
every segment-to-segment click would have committed the whole timecode, one undo
entry each.

### Escape reverts, and release is separate from revert

`Escape` in a field discards the edit and hands the keyboard back. The two
halves are deliberately different concerns: `useFocusRegions` always releases;
the *revert* belongs to the widget, so a field with no cancel semantics still
gives the keyboard back.

The release is deferred one microtask, and that ordering is the correctness
argument: focusing the region fires the field's blur, and a blur landing before
the field's own Escape handler would commit the value Escape was supposed to
discard. React dispatches component handlers synchronously inside the native
event, so by the time the microtask runs the field has already set its cancel
flag. It is still a *capture*-phase listener, because a field may
`stopPropagation()` on keydown — the timeline rename input does — and a bubble
listener would never see the key.

`AppNumberField` needs no call-site cooperation: `lastCommitted`, captured on
focus rather than synced from `value`, already *is* the pre-edit snapshot, and
restoring it makes the release blur hit the existing dedup guard, so cancelling
cannot log an undo entry. `AppInput` cannot revert alone — the call site owns
`value` — so it takes an `onCancel` and the call site both restores its draft
and flags the imminent blur as a cancel. Inside a dialog, menu, or listbox no
field consumes Escape: there it closes the widget, and consuming it to revert
would strand the user one level in.

### `activeRegion` scopes the keyboard, strictly

`ActionDef.scope?: readonly PanelKind[]` gates dispatch on the region derived
from DOM focus. Absent means global: transport, seeking, mark in/out, tool
arming, save/export are app commands wherever focus sits.

The gate is **strict** — a scoped action yields whenever the active region is
not in its list, `null` included — and yields *without* `preventDefault`, like
every other stand-down, so the key stays available to whatever does own the
focused region. Strict is only safe because release lands focus on a real region
for every press on Panel content: a user who can see a selection has already
focused the Panel holding it.

`activeRegion` is the region of the last `focusin` and deliberately does **not**
reset on `focusout`. A control blurring to `<body>` — a menu closing, an element
unmounting, alt-tab away and back — leaves the last-touched Panel in charge,
which is what an NLE's panel highlight shows. `null` is reserved for focus
genuinely leaving every Panel, because that is the case the gate must catch.

Scoped to the timeline: `deleteSelected`, `copySelected`, `pasteAtPlayhead`,
`groupSelected`, `dissolveSelectedGroup`. The sub-frame audio nudges and resync
are deliberately left global — nudging audio sync while watching and listening
to the preview is the workflow those keys exist for, and scoping `Alt+Arrow` to
the timeline would kill it exactly when it is most useful.

### The capture-phase Delete preemptors owe the dispatcher's rules

The keyframe diamond, the keyframe lane, and the transition chip claim
Delete for a timeline *sub-selection* before the app-level delete-selected-layer
shortcut can see it. Winning that race is why they are raw capture-phase
listeners rather than catalogue entries — and the cost of bypassing the
dispatcher is that they must reproduce its stand-down rules by hand. Every rule
one of them forgets becomes "Delete does something different depending on which
selection happens to be armed". They now share one predicate,
`subSelectionDeleteYields`, carrying both of `deleteSelected`'s rules.

### `focusRegion.ts` must not import the Panel registry

The DOM primitives are imported by the shared field widgets, and
`panelRegistry` pulls in `../i18n` — which turned every widget into an i18n
consumer and broke suites that partially mock `react-i18next`. Region strings
leave that module raw; `useFocusRegions` narrows them to `PanelKind`.

## Consequences

- The reported bug is fixed at the mechanism rather than per call site: a new
  gesture handler cannot reintroduce it by forgetting a `blur()`, because no
  gesture handler participates.
- `captureGlobal` and `fireWhenEditing` stay, unchanged, but stop being the only
  tools available. New bare-key bindings can be scoped instead of fighting a
  parked control.
- **Strict scope has a test cost.** Any suite that renders a Panel's component
  in isolation and drives a scoped shortcut must declare the region, because
  there is no Panel wrapper to be one. Three existing tests needed that line.
  The alternative — a lenient gate that fires when no region owns the keyboard —
  would have made the gate untestable in exactly the harnesses that exercise it.
- Delete while the Attribute or Effect panel is focused now does nothing. The
  property panels edit the timeline selection, so an argument exists for
  widening `TIMELINE_SELECTION` to include them; it is a one-line change.
  Premiere and Resolve are strict, so strict is where this starts.
- Dockview's `activePanel` and `activeRegion` remain **separate**, and neither
  drives the other. `activePanel` is tab activation — what `focusNextPanel`
  moves and what the tab strip paints; `activeRegion` is keyboard ownership.
  Coupling them would mean either a focus move silently reordering tabs or a tab
  click stealing the keyboard from a field mid-edit.
- Dragging a native scrollbar counts as a press on Panel content, so it releases
  a focused field (and commits it). Wheel scrolling does not — it fires no
  `pointerdown`. A geometry test could exclude scrollbar presses if it ever
  bites; it is not worth pre-empting.
- The **selection-priority races are untouched**. Keyframe, transition, and
  layer Delete all live inside the timeline Panel, so region scope cannot
  disambiguate them; they share the region gate but still resolve their own
  priority by capture-phase ordering and selection mutual-exclusion.

## Where this lives

- `src/renderer/focus/focusRegion.ts` (DOM primitives, no React, no store —
  and no panel registry), `focusRegionStore.ts` (`activeRegion`),
  `useFocusRegions.ts` (the three listeners), mounted once in `main.tsx`'s
  `Root` so it also covers the startup screen.
- `src/renderer/workspace/DockWorkspace.tsx` (the Panel root becomes the
  region), `src/renderer/styles/workspace.css` (ring suppression).
- `src/renderer/shortcuts/match.ts` (`isEditableTarget` as a type predicate,
  `isInTransientWidget` lifted here so the field widgets can share it),
  `defs.ts` (`scope`, `TIMELINE_SELECTION`), `useShortcuts.ts` (the gate).
- `src/renderer/components/{AppInput,AppNumberField,AppTimecodeField}.tsx`
  (focus groups + Escape), `blurAfterMouseActivation.ts` (blur → region),
  `src/renderer/properties/PropertyPanel.tsx` (`onCancel` wiring).
- `src/renderer/timeline/subSelectionDelete.ts` and its three call sites in
  `LayerBlock.tsx`, `KeyframeLane.tsx`, `Timeline.tsx`.
- Gates: `src/renderer/focus/useFocusRegions.test.tsx` (release under a canceled
  pointerdown, focus-group exemption, Escape-before-commit ordering, chrome ⇒ no
  region), `src/renderer/timeline/subSelectionDelete.test.ts` (all three
  preemptors by contract), `src/renderer/shortcuts/useShortcuts.test.tsx` (the
  scope gate), `e2e/electron/focus-regions.spec.ts` (every open Panel is a
  region; a real click and a canceled `pointerdown` both release and commit —
  the two things jsdom cannot model).

## Industry baseline

No standard prescribes NLE focus behaviour. These are the comparison points this
decision was measured against — comparison points, not a requirement to copy
another editor.

- [Adobe Premiere Pro panel focus](https://helpx.adobe.com/premiere-pro/using/customizing-workspaces.html)
  — the focused panel is highlighted and determines which panel a command acts on.
- [DaVinci Resolve keyboard customization](https://documents.blackmagicdesign.com/UserManuals/DaVinci_Resolve_19_Reference_Manual.pdf)
  — keyboard shortcuts are scoped per page/panel context.
- [Final Cut Pro command editor](https://support.apple.com/guide/final-cut-pro/command-editor-ver2e2f8b1c/mac)
  — commands bound per focused area.
- [WAI-ARIA APG: managing focus](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
  — `tabindex="-1"` for programmatic focus targets that stay out of the Tab order.
