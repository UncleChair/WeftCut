Status: ready-for-agent
Spike status: passed — dockview-react 7.0.2, 19/19 checks

# NLE Dockable Workspace

## Problem Statement

WeftCut's editor is currently a fixed CSS Grid: Media Pool occupies a collapsible left drawer, Preview and Timeline occupy fixed center cells, and a monolithic right panel occupies a fixed-width column. An editor cannot rearrange these areas, resize them beyond the fixed grid, combine them into tab groups, close panels, or restore a preferred workspace. This makes the editor feel unlike a conventional NLE and forces every workflow into one layout, even when the editor wants to prioritize Timeline width, Preview size, captions, effects, or audio mixing.

The fixed right panel also combines several different semantic scopes. Contextual Layer attributes, the selected Layer's effect chain, project-wide captions, project-wide Audio Role mixing, and discovery of hidden nearby Layers currently share one container. This obscures their responsibilities and makes future layout flexibility harder because the unit being moved is not a coherent tool.

## Solution

Replace the fixed editor grid with a named, persistent, NLE-style Dock Tree. Editors can resize recursive splits, move panels into new splits, combine panels into tab groups, close and reopen singleton panels, focus panels, and temporarily maximize a panel. A compact single-panel presentation preserves the maximum usable area: when a Dock Group contains one Panel, Dockview's native single-tab header is visually reduced to a six-dot drag handle and absolutely positioned over the Panel's existing title or first row, contributing zero layout height. The same header returns to normal flow as a conventional compact tab strip only when the Dock Group contains multiple Panels.

The workspace is app-level rather than project-level. It restores the last current arrangement automatically while retaining an explicitly saved baseline for Reset Workspace. Named custom workspaces coexist with an immutable built-in Editing baseline. Layout changes never dirty a Project and never enter Project undo history.

The former right panel becomes five non-overlapping semantic Panels: Attribute, Caption, Role Mixer, Effect, and Nearby. Preview, Timeline, and Media Pool become Panels as well. Each Panel kind has exactly one instance.

The selected layout engine is `dockview-react` 7.0.2 behind a WeftCut-owned adapter. The isolated compatibility spike passed the agreed lifecycle, drag arbitration, persistence, focus, sizing, maximize, close, and React StrictMode gates. FlexLayout is no longer part of the planned implementation; it remains only a contingency if a future production-only incompatibility invalidates the measured results.

## User Stories

1. As an editor, I want to resize the Preview and Timeline independently, so that I can prioritize picture review or detailed timeline editing.
2. As an editor, I want to split the workspace recursively in any direction, so that the arrangement can match the task I am performing.
3. As an editor, I want to drag a Panel to the center of another Dock Group, so that the Panels become switchable tabs.
4. As an editor, I want to drag a Panel to an edge drop target, so that a new split is created predictably.
5. As an editor, I want empty Dock Groups to collapse automatically, so that closing or moving the last Panel does not leave unusable holes.
6. As an editor, I want splitter movement to stop at useful Panel minimum sizes, so that no Panel can be reduced to a non-operable sliver.
7. As an editor, I want Timeline to span the full lower width in the built-in Editing workspace, so that the horizontal time scale is maximized.
8. As an editor, I want Media Pool, Preview, and contextual tools arranged above Timeline by default, so that a new workspace immediately resembles a familiar NLE.
9. As an editor, I want a single-Panel Dock Group to consume no extra vertical tab-bar space, so that Preview and Timeline retain their maximum usable area.
10. As an editor, I want a visible six-dot handle on a single Panel's existing first row, so that the Panel remains discoverably draggable without extra chrome.
11. As an editor, I want a compact tab strip to appear when a Dock Group contains multiple Panels, so that I can switch and independently drag those Panels.
12. As an editor, I want the single-Panel handle and multi-Panel tab strip never to appear at the same time, so that the interface avoids duplicate controls.
13. As an editor, I want multi-Panel tabs to expose close controls, so that I can remove a specific tab directly.
14. As an editor, I want to close a single active Panel from the View menu, so that a separate permanent close button is not required in compact mode.
15. As an editor, I want the View menu to focus an existing Panel or reopen a closed Panel, so that Panels are always recoverable.
16. As an editor, I want a reopened Panel to return to its last Dock Group and tab order, so that closing a tool does not discard its placement.
17. As an editor, I want semantic fallback positions when a closed Panel's former Dock Group no longer exists, so that reopening remains deterministic.
18. As an editor, I want to close every Panel if desired, so that the workspace model does not impose an artificial permanent Panel.
19. As an editor, I want an empty-workspace recovery view with Open Panel and Reset Workspace actions, so that closing every Panel is reversible.
20. As an editor, I want my current arrangement restored after restarting WeftCut, so that routine layout changes do not require explicit saving.
21. As an editor, I want to save the current arrangement as a reset baseline, so that experimental changes can be reverted later.
22. As an editor, I want to create, rename, switch, and delete custom workspaces, so that different editing tasks can have different layouts.
23. As an editor, I want workspace switching to happen without a save prompt, so that changing layouts is immediate while the current arrangement remains auto-saved.
24. As an editor, I want the built-in Editing baseline to remain immutable, so that there is always a known-good recovery layout.
25. As an editor, I want Reset Workspace to restore the active custom workspace's saved baseline, so that reset respects my chosen workspace.
26. As an editor, I want selected tabs in each Dock Group restored with the layout, so that the visible tool context returns after restart.
27. As an editor, I want transient focus, scroll, drag, unfinished input, and temporary maximize state excluded from persistence, so that startup does not recreate confusing momentary UI states.
28. As an editor, I want the focused Dock Group indicated with a restrained accent line, so that keyboard targeting is visible without distracting from content.
29. As an editor, I want to cycle Panel focus clockwise or anticlockwise from the keyboard, so that I can navigate a dense workspace without the mouse.
30. As an editor, I want existing editing and transport shortcuts to retain their global behavior, so that the layout change does not alter established editing muscle memory.
31. As an editor, I want text fields, menus, and dialogs to retain their existing shortcut suppression rules, so that typing and widget navigation remain safe.
32. As an editor, I want to temporarily maximize the Panel under the pointer or the focused Panel, so that I can inspect detail without changing the Dock Tree.
33. As an editor, I want a second maximize command to restore the prior split geometry, so that maximization is a reversible temporary view.
34. As an editor, I want double-clicking the relevant Panel chrome to maximize or restore it, so that the operation is discoverable without learning a shortcut.
35. As an editor, I want hidden tabs to retain form drafts, scroll position, and local UI state during the current session, so that switching tabs does not reset my work.
36. As an editor, I want hidden expensive Panels to suspend unnecessary paint, polling, and animation work, so that keeping their DOM mounted does not waste resources.
37. As an editor, I want Preview and Timeline to respond immediately to Dock Group resize, so that their canvases and viewports always match the visible region.
38. As an editor, I want moving or maximizing a Panel not to recreate the Playback Engine or Compositor, so that playback and audio are uninterrupted.
39. As an editor, I want Media Pool drag-to-Timeline to continue working through the docked workspace, so that layout flexibility does not break core editing.
40. As an editor, I want OS file drops to remain imports rather than Panel docking gestures, so that native drag-and-drop is reliable.
41. As an editor, I want Timeline move and trim gestures to remain isolated from Panel docking, so that editing a Layer cannot rearrange the workspace.
42. As an editor, I want Effect chain reordering to remain isolated from Panel docking, so that rearranging Effects cannot move the Effect Panel.
43. As an editor, I want Escape to cancel an active Panel drag and restore the original arrangement, so that accidental drags are recoverable.
44. As an editor, I want Attribute to show the primary selected Layer's common and type-specific properties, so that contextual editing has one clear home.
45. As an editor, I want Attribute to show Layer name, kind, Track, group state, enabled state, lock state, Timeline Start, Timeline End, and duration, so that the Layer envelope is understandable in one place.
46. As an editor, I want Attribute timing edits to use the same move, trim, frame-snap, group, lock, and composition-autofit semantics as Timeline gestures, so that the inspector cannot create a different editing model.
47. As an editor, I want visual Layers to expose Transform and opacity in Attribute, so that spatial properties remain contextual to the selected Layer.
48. As an editor, I want Text, VideoClip, ImageOverlay, Color, Audio, and Motif Layers to expose their own relevant fields, so that Attribute remains type-aware rather than generic.
49. As an editor, I want Audio Layers to expose per-Layer gain, pan, fades, mute, and Audio Role in Attribute, so that Clip tuning remains separate from project-wide mixing.
50. As an editor, I want Motif Layers to expose Motif properties and lifecycle controls in Attribute, so that Motif-specific editing remains available without another Panel.
51. As an editor, I want the complete selection set and its primary Layer shared across Panels, so that Timeline, Caption, Nearby, Attribute, Effect, and search agree on selection.
52. As an editor, I want Attribute and Effect to edit only the primary Layer in v1, so that multi-selection does not imply undefined mixed-value behavior.
53. As an editor, I want a multi-selection indication that states which primary Layer is being edited, so that contextual changes are not surprising.
54. As an editor, I want Effect to exclusively own the primary visual Layer's ordered effect chain, so that Effects no longer compete with Attribute for semantic ownership.
55. As an editor, I want Effect cards to support enable, collapse, delete, parameter editing, keyframes, and color picking, so that the existing effect capability survives the split.
56. As an editor, I want to reorder Effects by dragging cards while retaining keyboard-accessible move commands, so that both efficient and accessible ordering are available.
57. As an editor, I want an explicit message when an Audio Layer is selected in Effect, so that the UI does not imply that audio Effects exist.
58. As an editor, I want Caption to aggregate cues from every caption-role Track in time order, so that project captions have one global management surface.
59. As an editor, I want selecting a caption cue to select its Text Layer, seek the playhead, and reveal it in Timeline, so that caption navigation and timeline context stay synchronized.
60. As an editor, I want to edit caption text inline, so that proofreading does not require opening Attribute for every cue.
61. As an editor, I want project-wide caption styling to affect all caption-role Tracks as one atomic undoable operation, so that overlapping caption lanes remain visually consistent.
62. As an editor, I want a selected caption Text Layer to remain editable as an ordinary Text Layer in Attribute, so that global caption management and contextual Layer editing complement each other.
63. As an editor, I want Role Mixer to retain Dialogue, Music, SFX, and Voiceover as its fixed grouping axis, so that project audio remains consistent with WeftCut's Audio Role model.
64. As an editor, I want each Audio Role to expose gain, numeric dB entry, mute, solo, and reset, so that project-wide audio categories are controllable.
65. As an editor, I want Role Mixer to use channel strips when wide and rows when narrow, so that it remains usable wherever it is docked.
66. As an editor, I want a real Master RMS/Peak meter in Role Mixer, so that output level is visible without pretending that folded Audio Roles are real metered buses.
67. As an editor, I want Role Gain faders to audition changes live but create one undo entry on release, so that mixing feels immediate without flooding history.
68. As an editor, I want Escape to cancel a Role Gain gesture, so that I can audition and revert without committing.
69. As an editor, I want Nearby to reveal hidden, unassigned-track Layers near the playhead in A/B Roll display mode, so that temporarily hidden material remains discoverable.
70. As an editor, I want Nearby filters for Video, Audio, and Text, so that I can scan the relevant kind quickly.
71. As an editor, I want selecting a Nearby item to reveal and select it without moving the playhead, so that the current nearby observation window remains stable.
72. As an editor, I want an explicit go-to-time action for a Nearby item, so that seeking happens only when requested.
73. As an editor, I want to rename a Nearby Layer inline by double-clicking its name, so that lightweight contextual edits do not require another Panel.
74. As an editor, I want Nearby to explain that all Tracks are already visible in Show All mode, so that the Panel never becomes an unexplained blank area.
75. As an editor, I want the built-in workspace to open Attribute, Effect, and Nearby in the upper-right tab group while leaving Caption and Role Mixer closed, so that the default remains focused and uncluttered.
76. As an editor, I want the main window to enforce a practical minimum size, so that arbitrary Dock Trees cannot make the application unusable.
77. As a developer, I want the inline Preview performance HUD removed, so that it does not compete with user workspace chrome.
78. As a developer, I want a Dev-only menu item to open or focus the existing independent Performance Monitor window, so that diagnostics remain available without becoming a user Panel.
79. As a developer, I want performance telemetry to sleep while the Performance Monitor is closed, so that diagnostics do not perturb normal Dev-mode performance.
80. As a developer, I want a Dockview compatibility spike to fail fast on lifecycle or drag-isolation problems, so that the production editor does not accumulate library-specific workarounds.
81. As a developer, I want the docking library isolated behind a WeftCut adapter, so that layout persistence and business Panels do not depend directly on third-party JSON or imperative APIs.
82. As a developer, I want invalid current layouts to fall back to the saved baseline and then the built-in Editing layout, so that a corrupted workspace cannot trap the application.
83. As a developer, I want unknown retired Panel kinds ignored during restore, so that layout evolution is tolerant of removed tools.
84. As a developer, I want an intentionally empty workspace distinguished from a corrupt layout, so that recovery logic does not override a valid user choice.
85. As a developer, I want every Panel kind enforced as a singleton even during restore, so that malformed JSON or duplicate commands cannot create unsupported duplicate tools.

## Implementation Decisions

- The editor workspace will use `dockview-react` 7.0.2 behind a WeftCut-owned adapter. Business components interact with Panel kinds and workspace commands rather than Dockview objects, group identifiers, or serialized JSON.
- The adapter is the single layout mutation boundary. It owns registration, singleton enforcement, open/focus/close/reopen, maximize/restore, focus movement, last-placement metadata, serialization, restore normalization, visibility reporting, and autosave notifications.
- Panel identity is the Panel kind. There is no Panel instance identifier because WeftCut permanently supports one instance of each Panel kind.
- The v1 Panel catalog is Media Pool, Preview, Timeline, Attribute, Caption, Role Mixer, Effect, and Nearby.
- The v1 surface is one recursive Dock Tree in the main editor window. Dockview floating groups, Dockview popout windows, and business-panel Electron windows are disabled.
- The independent Dev-only Performance Monitor remains an Electron secondary window and is explicitly outside the workspace model.
- Dock Groups support center drops into a tab stack, edge drops into a split, draggable splitters, tab reordering, and automatic collapse/merge when the last Panel leaves a group.
- The built-in Editing workspace uses a root top/bottom split. The upper region occupies approximately 62% and contains Media Pool at approximately 22%, Preview at approximately 53%, and a contextual tab group at approximately 25%. Timeline occupies the lower approximately 38% across the full workspace width.
- Attribute, Effect, and Nearby are initially open in the contextual tab group with Attribute active. Caption and Role Mixer are initially closed.
- Dockview 7.0.2 exposes no public operation for beginning its native Panel drag from an arbitrary Panel-content element. Single-Panel Dock Groups therefore retain the native single-tab header as the drag source, render its custom tab as an 18-by-18 six-dot handle, and absolutely position it over the Panel's existing title or first row. Preview uses the same non-layout overlay treatment. The Panel content begins at the top of the Dock Group and loses zero vertical pixels.
- Multi-Panel Dock Groups show a compact approximately 28-pixel tab strip with active-tab styling, the restrained focused-group accent, independent Panel dragging, and tab close controls.
- Header presentation is derived from Dockview's live single-tab group state and is not persisted. The single state is an absolutely positioned compact native header; the multiple state is the same header in normal flow. Transitioning between the states must not remount Panel content.
- A single active Panel closes through View > Close Active Panel. Multi-Panel tabs may close directly. A future Panel context menu is not required for v1.
- Double-clicking eligible Panel chrome and the configurable backquote command toggle temporary maximize. The Panel under the pointer is preferred; the focused Panel is the fallback target.
- Maximize never mutates or persists the saved Dock Tree. Restoring returns to the exact pre-maximize geometry.
- Focus is distinct from active tab and Project Layer selection. Focus is visualized with a restrained one-pixel theme accent on the active Dock Group rather than a prominent full-Panel color change.
- Clockwise and anticlockwise Panel focus commands use Control+Shift+Period and Control+Shift+Comma by default. Existing application editing and transport shortcuts remain global.
- The legacy M-to-Media-Pool shortcut is removed. M is left available for a future Marker command. The existing media drawer action and app setting are deleted without migration because the application has not released to users.
- Every Panel is added with Dockview's `renderer: 'always'` mode while it remains open. Inactive tabs retain DOM and local session state. Panel visibility events gate expensive paint, requestAnimationFrame work, polling, and other background activity.
- Closing a Panel destroys that Panel's UI instance. Reopening creates it again at its last workspace-relative placement.
- Preview hidden behind another tab retains playback resources and clock ownership while suppressing or reducing painting. Ordinary dock move, resize, header-mode transition, and maximize must not recreate the Playback Engine or Compositor.
- The main window minimum is 960 by 640 pixels. Preview has a 320 by 180 minimum, Timeline 420 by 180, and Media Pool and tool Panels 240 by 160. Splitters clamp at constraints rather than implicitly closing or collapsing Panels.
- Layout persistence is app-level and uses a dedicated, versioned workspace document in Electron user data. It does not reuse app settings, Project data, Project view state, or Project history. After adapter validation and normalization, live restoration uses Dockview's existing-panel reuse option so open Panel resources survive a workspace layout reload.
- A workspace profile stores the auto-saved current layout, an explicitly saved reset baseline, the selected tab per Dock Group, open and closed Panel state, tab order, split proportions, and last placement metadata for closed Panels.
- A workspace profile does not store DOM focus, keyboard focus, scroll positions, unfinished form input, transient drag state, temporary maximize state, or other session-only component state.
- Layout mutations write the current layout with a debounce and flush before workspace switch or application shutdown. Save Workspace promotes the current layout to the explicit reset baseline.
- The built-in Editing baseline is code-owned and immutable. Save Workspace As creates a custom workspace from the current arrangement.
- View > Workspaces lists Editing and custom workspaces. Custom workspaces support Save Workspace, Save Workspace As, Rename, Delete, and Reset Workspace. Deleting the active custom workspace first activates Editing.
- View Panel entries focus an open Panel and reopen a closed Panel. Reopen prefers the last Dock Group and tab order; if the group no longer exists, Media Pool falls back left, Preview center, Timeline bottom, and tool Panels to the contextual right group.
- Closing every Panel is valid. The empty workspace renders recovery actions without being normalized into a non-empty tree.
- Restore first validates and loads the current layout, then the workspace's saved baseline, then the built-in Editing baseline. Unknown Panel kinds are discarded, duplicates are reduced to the canonical singleton, and a successful fallback repairs the stored current layout.
- Project-specific Timeline zoom and Track heights remain in Project view state. Workspace layout never dirties the Project and is excluded from undo/redo.
- Panel docking starts only from the native Dockview tab drag source: the overlaid six-dot custom tab in a single-Panel group or a normal tab in a multi-Panel group. No Panel content region can initiate a dock gesture, and the adapter never reaches into Dockview private drag-source internals.
- V1 explicitly uses Dockview's HTML5 docking strategy for its mouse-first Electron surface. Dockview's scoped internal transfer ignores WeftCut media payloads and OS Files; an adapter guard still cancels any Dock overlay that reaches the public pre-overlay event with a business MIME. Those payloads continue through existing import and Timeline drop paths. Timeline Layer gestures and Effect card ordering use pointer interactions and never become dock gestures. Business drop targets pause while a Panel drag is active.
- Selection becomes one renderer-level model containing a primary Layer and the complete selected Layer set. All navigation surfaces write through this model.
- Attribute and Effect edit only the primary Layer in v1. Multi-selection is visible, but batch property and batch effect behavior is deferred.
- Attribute owns common Layer envelope fields and kind-specific Layer parameters. Timeline Start edits use the existing group-aware move command; Timeline End and duration edits use the existing group-aware trim command. Raw envelope patching is not used for time edits.
- Effect exclusively owns the primary visual Layer's ordered effect chain. Existing effect commands, keyframe paths, renderer-owned effect catalog, preview overrides, and undo semantics remain authoritative. Audio selection produces an explicit unsupported state rather than an add-effect surface.
- Caption is a Project-level corpus surface over every caption-role Track. Cue selection updates global Layer selection, seeks, and reveals Timeline. Inline text editing remains per Text Layer. Project-wide restyling becomes one atomic command over all caption-role Tracks.
- Caption Text Layers remain ordinary Text Layers under the accepted caption model; Attribute may edit their contextual Text and Transform properties without changing Caption's global responsibility.
- Role Mixer remains Project-level and groups by the four accepted Audio Roles: Dialogue, Music, SFX, and Voiceover. It does not become a Track mixer.
- Role Mixer provides responsive channel strips or rows for Role gain, numeric dB entry, mute, solo, and reset. It exposes the existing Master RMS/Peak analyser but does not fabricate per-Role meters.
- Role Gain uses a renderer-local transient preview override during an active gesture and commits one recorded Role gain command on release or confirmation. Cancel clears the override. Mute and solo preserve their existing unrecorded preference-shaped semantics.
- Nearby remains an A/B Roll discovery surface for Layers on hidden, unassigned-role Tracks intersecting the playhead delta window. Selection/reveal does not seek; a separate go-to action seeks and scrolls. Double-click rename uses the existing recorded Layer label command.
- Attribute, Caption, Role Mixer, Effect, and Nearby have unique primary semantic responsibilities. Duplicate lightweight write entry points such as rename are allowed when contextually appropriate.
- The inline performance HUD, its drag state, visibility shortcut, and position management are removed. A headless telemetry bridge runs only while the Dev-only Performance Monitor window exists. The Dev menu opens or focuses the singleton secondary window.
- Modal dialogs, startup, Agent Mode, settings, export flow, logs, and application chrome remain outside the Dock Tree unless a later spec explicitly promotes them to Panels.

## Testing Decisions

- Tests assert observable WeftCut behavior rather than Dockview DOM structure, private group classes, or raw serialized JSON shape.
- The primary high seam is the real Electron editor driven through the existing Playwright end-to-end harness. It covers Panel drag/split/tab behavior, dynamic single-versus-multiple header presentation, resize, maximize/restore, focus indication, View-menu recovery, media drops, Timeline gestures, and Preview continuity.
- A single adapter contract test seam supplements Electron E2E for deterministic layout commands: register singleton Panels, open, focus, close, reopen, serialize, restore, normalize duplicates, discard unknown kinds, and apply the three-level fallback. The same contract is run against the selected library adapter.
- The main-process workspace store is tested as an atomic versioned document boundary: default creation, named profile CRUD, current-versus-saved baseline, active workspace, invalid data, repair writes, and no Project mutation.
- React integration tests mount the real Dock Workspace under StrictMode and verify that Panel renderers, subscriptions, autosave listeners, and visibility listeners are not duplicated.
- Lifecycle tests use stateful probe Panels to prove that switching tabs and transitioning header modes preserves mounted state, while actual close destroys and reopen recreates the instance.
- Preview integration tests observe stable Playback Engine and Compositor identities across dock move, split resize, tab activation, and maximize/restore. They also verify that hidden visibility gates painting without destroying playback state.
- Drag arbitration tests use real DataTransfer payloads and pointer sequences. They prove that WeftCut media payloads, OS Files, Timeline move/trim, Effect reordering, and Panel docking are mutually exclusive.
- Persistence tests restore a deeply nested Dock Tree with tab order, active tabs, split proportions, closed Panel metadata, and an intentionally empty workspace.
- Focus and accessibility tests cover restrained focus indication, focus cycling, keyboard activation of tabs and View actions, backquote maximize, Escape cancellation, and existing editable/transient-widget shortcut suppression.
- Attribute tests reuse existing move, trim, keyframe, and property command seams rather than testing duplicate timing math in UI code.
- Caption tests extend existing caption Panel and actor tests to cover cross-Track aggregation, cue selection/seek/reveal, and one-undo project-wide restyle.
- Role Mixer tests extend existing Role gate, actor, and Mixer tests to cover responsive presentation, transient live gain override, one final recorded commit, cancellation, Master meter display, and unchanged mute/solo semantics.
- Effect tests extend the existing effect-chain and transient-override tests to cover the standalone Panel and drag reordering without changing the accepted effect ownership model.
- Nearby tests extend existing pure nearby-window grouping tests and navigation tests to cover Show All explanation, selection without seek, explicit go-to, and rename.
- Dev Performance Monitor tests verify that no inline HUD renders, the Dev menu is absent from production builds, the singleton secondary window is reused, and telemetry subscriptions and polling exist only while that window is open.
- The compatibility spike was a hard gate rather than a demo and passed 19 of 19 automated browser checks. It verified StrictMode singleton safety, dynamic zero-height single headers, a real six-dot HTML5 dock drag, always-mounted lifecycle, business-MIME drag isolation, deep restore with existing-Panel reuse, Preview resize, stable resource identity, focus navigation, maximize/restore, and close destruction.
- The spike confirmed that an arbitrary external six-dot content element cannot initiate Dockview dragging through public API. The permitted absolutely positioned custom Dockview header is therefore the selected implementation, not a deferred fallback. Production Electron E2E must preserve the same observable gates before the feature is considered complete.

## Out of Scope

- Independent Electron windows for user Panels.
- Dockview popout windows, in-window floating groups, or arbitrary overlay Panels.
- More than one instance of any Panel kind.
- Multiple compositions, sequences, timelines, or viewers that would require instance identity.
- Panel context menus and general Panel-management chrome beyond the v1 tab controls and View commands.
- Persistent scroll positions, unfinished form drafts, keyboard focus, temporary maximize state, or other transient UI state across application restarts.
- Workspace layout in Project files, Project dirty state, or Project undo/redo.
- Panel-scoping the existing Timeline, edit, and transport shortcuts.
- Batch Attribute editing or batch Effect chain editing for multi-selection.
- Track-based audio mixing, real per-Role summing buses, per-Role meters, Role pan, Role Effects, or Audio Layer Effects.
- New effect kinds, changes to the accepted effect instance/catalog ownership split, or audio DSP work.
- New caption data types, soft-subtitle export, sidecar export, multiple caption-set identity, or changes to the accepted captions-as-Text-Layers model.
- Compatibility migration for the legacy Media Pool drawer preference or shortcut because the application has not released.
- A permanent single-Panel tab strip or extra vertical Panel chrome.
- Expansion of logs, settings, export, startup, Agent Mode, or other overlays into dockable Panels.

## Further Notes

- The terms Project, Layer, Track, Decode Engine, Audio Role, and Motif follow the project glossary and accepted ADRs. UI copy may use Clip where it is already the editor-facing convention, but implementation contracts continue to target Layer identity.
- The Role Mixer design preserves the accepted decision that Audio Roles, not Tracks, are the grouping axis and that v1 folds Role gain instead of creating real buses.
- The Caption design preserves the accepted decision that every cue is a first-class Text Layer on a caption-role Track.
- The Effect design preserves the accepted decision that the Project owns ordered effect instances while the renderer owns the effect catalog.
- UI components continue to use the project's Base UI primitives and token/cascade conventions.
- The initial library research is captured in the [React/Electron docking research note](../../docs/notes/react-electron-docking-layout-research.md).
- The isolated [spike results](./spike/results.md) passed 19 of 19 checks. The spike used fake but stateful Preview and Timeline surfaces to measure React lifecycle continuity, ResizeObserver delivery, maximize/restore, real HTML5 docking, DataTransfer arbitration, serialization, and close destruction. It did not modify production dependencies or production editor code.
- Measured single-Panel geometry was an 18-pixel native-header overlay with zero content offset; measured multi-Panel geometry was a 28-pixel header with a 28-pixel content offset. Preview retained one resource token while resizing from 474 by 606 to 434 by 526, maximizing, restoring, moving, tabbing, and reloading the Dock Tree.
