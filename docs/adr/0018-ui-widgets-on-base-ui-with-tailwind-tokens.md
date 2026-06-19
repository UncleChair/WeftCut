---
status: accepted
---

# UI widgets ride Base UI primitives; Tailwind v4 carries the design tokens

## Context

The webview UI grew as one large hand-written stylesheet plus per-feature
markup: every widget (dialogs, the menu bar, selects, sliders, tooltips, the
timeline context menu) was hand-rolled, with no shared components, no design
tokens (the palette was repeated as hardcoded hex across hundreds of rules),
and none of the behavior a widget library supplies — no focus trapping, no
Escape/outside-press conventions, no keyboard navigation, no portals (popups
were clipped by their containers), and assorted state-machine bugs (two menu
dropdowns could sit open at once). Roughly 12% of the stylesheet was generic
widget chrome; the rest is editor-specific layout no library replaces.

## Decision

- **Copy-source component model.** Components are vendored into the repo via
  the shadcn registry (`components.json`, `src/components/ui/`,
  `src/lib/utils.ts`) rather than imported from a styled npm package. We own
  the code; the registry is a source of skeletons, not a runtime dependency
  on someone else's design language. [Base UI](https://base-ui.com) supplies
  the headless primitives (`@base-ui/react`).
- **Behavior from the library, skin from the legacy classes.** App-level
  wrappers — `AppDialog`, `AppSelect`, `AppSlider`, `CornerNotice`, the
  `Menu`/`MenuBar` internals, the property-panel hint `Tooltip`, and the
  timeline context menu — compose Base UI parts for portal, positioning,
  focus, dismissal, and aria wiring, while the popup/panel elements keep the
  existing CSS classes as their visual identity. Migrations are therefore
  behavior upgrades with near-zero visual churn, and dropdown chrome is
  shared (`.menu-list` / `.menu-item` skin the menubar, `AppSelect` popups,
  and the context menu alike).
- **Tailwind v4 is the token carrier.** `src/app.css` is the Tailwind entry:
  the shadcn token convention (`--background`, `--primary`, `--radius`, …)
  holds the app palette in the `.dark` block, hex-verbatim from the legacy
  stylesheet so later `var(--*)` sweeps stay greppable. The app is dark-only:
  `html.dark` is hardwired in `index.html`; `:root` keeps inert light
  defaults for theme-tool compatibility.
- **The cascade contract.** Everything Tailwind emits is layered
  (`@layer theme/base/utilities`); `styles.css` stays **unlayered** and
  therefore wins wherever both target the same element. Two corollaries every
  migration must respect:
  - Preflight resets only show through where legacy CSS relied on UA
    defaults. Those reliances get pinned explicitly when found
    (`:root { line-height: normal }` is the canonical example — fixed-height
    containers sized to text rows are the tripwire).
  - Stacking a Tailwind utility onto an element a legacy rule also targets
    silently loses; migrate by removing the legacy rule, not by piling
    classes.
- **Scope.** Feature-specific layout (timeline tracks, media pool, panels —
  the bulk of the stylesheet) stays hand-written. Native `<select>` /
  `<input type="range">` are gone from the app; new dialogs must use
  `AppDialog` (undismissable mode = omit `onClose`); components that consume
  Escape inside a dialog must `stopPropagation()` or the dialog closes too.

## Alternatives considered and rejected

- **Packaged component libraries** (MUI, Ant Design, Mantine, Chakra): a
  bespoke dark editor skin means fighting their theme systems indefinitely,
  for complex widgets (data grids, form frameworks) this app doesn't use.
- **Keeping native form controls**: Chromium/Electron renders selects/sliders with OS
  popups that can't be styled to match, and they carry none of the shared
  keyboard/typeahead conventions; `color-scheme: dark` only goes so far.
- **Headless-only (no registry)**: workable but discards the shadcn
  ecosystem's vendored skeletons and tooling for no saving — the registry
  output is owned source either way.
- **CSS-in-JS**: runtime cost in a render-loop-sensitive app, and the
  existing stylesheet would have to be rewritten wholesale instead of
  coexisting under the cascade contract.

## Consequences

- The widget layer is uniform and accessible; popups escape their containers
  (portals), and dismissal semantics are consistent app-wide.
- The legacy palette still lives as hardcoded hex inside `styles.css`; the
  open follow-up is sweeping it onto the `var(--*)` tokens, after which the
  shared dropdown chrome classes deserve token-era names.
- Remote/automated UI driving must account for Base UI listening to real
  pointer streams: synthesized clicks without `pointerdown` (and synthetic
  hover without human-scale timing) don't move sliders or trigger
  hover-coordination; in-page `PointerEvent` dispatch is the reliable hook.
