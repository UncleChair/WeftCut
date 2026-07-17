# Dockview Compatibility Spike Results

Status: passed (19/19 checks)

## Environment

- `dockview-react@7.0.2`
- `react@19.2.6`
- `react-dom@19.2.6`
- Vite 8.0.13
- Playwright driving system Google Chrome in headless mode
- Spike code and dependencies isolated under this directory; the production dependency graph was not changed

## Accepted implementation shape

- Use Dockview's native tab element as the only Panel drag source. Dockview 7.0.2 has no public API for initiating its native Panel drag from an arbitrary element in Panel content.
- In a one-Panel group, style Dockview's `.dv-single-tab` header as an 18 by 18 pixel absolutely positioned six-dot control over the Panel's existing first row. The header remains a native Dockview drag source but contributes zero layout height.
- In a group with two or more Panels, the same header returns to normal document flow as a 28-pixel tab strip. No Panel content remount is involved in either transition.
- Use `renderer: 'always'` for open Panels and subscribe to Panel visibility to gate expensive work.
- Restore layouts with `fromJSON(layout, { reuseExistingPanels: true })` after adapter validation and normalization.
- Keep Dockview floating groups and popouts disabled. The spike used the HTML5 docking strategy, matching the mouse-first Electron v1 and preserving real DataTransfer-based business drops.

## Measured results

- React StrictMode ran its expected development setup/cleanup cycle, but the adapter still produced exactly six singleton Panels in four Dock Groups with no duplicate registrations.
- All three one-Panel groups measured an 18-pixel overlay header and a zero-pixel content offset. The three-Panel group measured a 28-pixel header and a 28-pixel content offset.
- Adding and removing a second tab changed header mode without changing Preview or Effect resource tokens or mount/unmount counts.
- A real HTML5 drag beginning on the six-dot control center-dropped Effect onto Preview. Both Panels became one tab group without remounting Effect.
- Activating Preview, resizing the browser from 1440 by 900 to 1320 by 820, maximizing, and restoring changed Preview from 474 by 606 to 434 by 526 and advanced its ResizeObserver count from 4 to 6 while preserving its resource token.
- Deep `toJSON` serialization and `fromJSON` restore with panel reuse restored six Panels in four groups without recreating Preview.
- A `application/x-weftcut-media` DataTransfer produced no Dockview overlay and reached the Media Pool content drop handler with its payload intact.
- Closing Effect removed its Panel and DOM and advanced its unmount count, confirming that close destroys the open-Panel instance.
- Public focus traversal and maximize/restore APIs behaved as required. The active group accepted a one-pixel focus outline.
- The browser reported no runtime errors during the passing run.

## Reproduction

With the isolated Vite server running on port 4317, execute:

```sh
node .scratch/nle-dockable-workspace/spike/run-spike.mjs
```
