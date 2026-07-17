# React/Electron docking layout research

Date: 2026-07-17

## Question

Which existing layout manager best fits WeftCut's editor workspace: recursive
splits, tab stacks, edge/centre docking, resizable splitters, singleton panels,
named app-level workspace persistence, and a possible later path to floating or
secondary-window surfaces?

## Repository constraints

- The renderer is React 19.2 under `React.StrictMode`, Electron 42, ESM,
  TypeScript 6 with strict options, and an Electron sandbox with no Node globals.
- The editor is currently a fixed CSS grid. Timeline and preview sizing depends
  on `min-width: 0`, `min-height: 0`, and explicit overflow boundaries; a dock
  host must preserve those constraints.
- Media Pool to Timeline uses native HTML5 drag-and-drop with the custom
  `application/x-weftcut-media` MIME type. OS file drops use `Files`. Panel
  docking must not consume either drag class.
- App-level JSON persistence already has a main-process-owned atomic-store
  pattern. Named workspace layouts should follow it and remain outside project
  state and undo history.
- Renderer-created `window.open` is currently denied. Library popout features
  are therefore out of scope for the first phase even if a candidate supports
  them.

Relevant local sources: [desktop dependencies](../../apps/desktop/package.json),
[current fixed layout](../../apps/desktop/src/renderer/styles/app.css),
[editor mounting](../../apps/desktop/src/renderer/App.tsx), and
[window hardening](../../apps/desktop/src/main/windows.ts).

## Candidates

### Dockview

Dockview is the closest functional match. Its core model is panels inside groups
on a resizable grid. It supplies tab reordering, centre-to-stack and edge-to-split
docking, floating groups, popout groups, and JSON serialization. Panel IDs are
unique, which maps directly to WeftCut's one-instance-per-panel-kind rule.
Layout mutation events provide an explicit persistence seam, and `fromJSON` can
reuse existing panels rather than recreating their content.

Version 7 adds keyboard navigation, screen-reader announcements, focus recovery,
and keyboard docking. `dockview-react` declares React 19 compatibility and is
MIT licensed. The main trade-off is that layout mutation is performed through
an imperative `DockviewApi`, not an application-owned immutable React value.
WeftCut should wrap the API behind a small workspace adapter and persist only
the serialized form.

Dockview's built-in popouts open a same-origin browser window and require a
separate host page. That conflicts with WeftCut's current `window.open` denial
and does not solve the app's renderer-local playback/selection/GPU-preview
routing. Do not enable it in phase 1. Its serialized floating/popout model is
still useful as a future seam.

Primary sources:

- [Dockview introduction](https://dockview.dev/docs/overview/introduction/)
- [Core panel/group and serialization model](https://dockview.dev/docs/core/overview/)
- [Layout mutation and panel events](https://dockview.dev/docs/core/events/)
- [Popout-window contract and limitations](https://dockview.dev/docs/core/groups/popoutGroups/)
- [Dockview v7 accessibility changes](https://dockview.dev/docs/overview/whats-new-v7/)
- [`dockview-react` package metadata](https://www.npmjs.com/package/dockview-react)

### FlexLayout

FlexLayout is the strongest fallback. It exposes an explicit tree `Model`, JSON
round-tripping, typed model actions, action interception, unique node IDs,
splitters, tabsets, edge docking, component-state preservation during moves,
keyboard/ARIA behavior, and Playwright-tested stable layout selectors. Its
application-owned model is easier to reason about than Dockview's imperative
API and fits strict singleton validation well.

Its popout implementation uses React portals: content remains in the main
window's JavaScript realm and renders into another document. That can preserve
React state, but global `window`/`document` listeners, timers, resize observers,
and third-party portals need owner-document awareness. WeftCut has many direct
global listeners, and renderer `window.open` is denied, so this feature must
also stay disabled in phase 1.

Primary sources:

- [FlexLayout repository, model and feature documentation](https://github.com/caplin/FlexLayout)
- [`flexlayout-react` package metadata](https://www.npmjs.com/package/flexlayout-react)

### rc-dock

rc-dock supports saved layouts, docking moves, floating panels, and popup
windows, but the current package line is an alpha major and has a larger
dependency surface. It offers no decisive advantage over Dockview or
FlexLayout for this project.

Primary sources:

- [rc-dock repository](https://github.com/ticlo/rc-dock)
- [rc-dock package/API metadata](https://www.npmjs.com/package/rc-dock)

### Lumino

Lumino's `DockPanel` is mature and actively maintained through JupyterLab, but
it is a general widget/message-loop framework rather than a React-first layout
component. Integrating React panels requires a widget/React bridge and adopts a
second UI lifecycle. That is justified for JupyterLab's plugin platform, not
for WeftCut's small fixed panel catalogue.

Primary sources:

- [Lumino DockPanel API](https://lumino.readthedocs.io/en/latest/api/modules/widgets.DockPanel.html)
- [Lumino repository](https://github.com/jupyterlab/lumino)

## Recommendation

Use **Dockview v7 behind a WeftCut-owned workspace adapter**, subject to a small
throwaway compatibility spike before implementation. Keep FlexLayout as the
fallback if the spike shows that Dockview's imperative model or drag handling
cannot be isolated cleanly.

The spike should prove all of the following:

1. React 19 StrictMode mounts each panel without duplicate registration or
   leaked subscriptions.
2. A tab can join a group, split on all four edges, resize, close, and reopen
   with a stable singleton panel ID.
3. `toJSON`/`fromJSON` round-trips the default and a deeply nested layout.
4. Media MIME drags and OS `Files` drops still reach their existing handlers.
5. Preview and Timeline correctly resize without overflow and without recreating
   the playback engine during an ordinary dock move.
6. Keyboard tab/group navigation remains usable after WeftCut theme overrides.

Do not expose Dockview's floating or popout commands in phase 1. Do not let
library JSON become WeftCut's durable public schema directly: wrap it in a
versioned workspace record so a future library migration can be handled at one
boundary.
