---
status: accepted
---

# UI icons come from lucide-react

## Context

Icons grew ad hoc alongside the hand-rolled widgets: Unicode glyphs sized by
`font-size` (✕ close buttons, ▾ menu chevrons, ✓ check marks, the ▶⏸⏮⏭
transport row — stored in the i18n resource files as if icons were
translations), plus per-component inline `<svg>` drawings (the locale globe,
the startup folder). Every glyph rendered at the mercy of the active font,
sizes were coupled to text metrics, and there was no single place to look
when a new icon was needed. Meanwhile `lucide-react` was already a dependency
— the shadcn registry components import it — but nothing else used it.

## Decision

- **[lucide](https://lucide.dev/icons) is the icon source.** New icons are
  picked from the lucide catalog and imported as named components from
  `lucide-react` (the `*Icon`-suffixed aliases, matching the vendored shadcn
  components): `<XIcon size={16} aria-hidden />`. No new inline `<svg>`
  drawings, no Unicode glyphs as icons, no second icon package.
- **Size explicitly, color via `currentColor`.** Icons take `size={n}` from
  their context (they no longer inherit `font-size`); stroke color follows
  the surrounding `color`, so the legacy hover/state rules keep working
  unchanged. The default scaled stroke width is the norm; override
  `strokeWidth` only to match a neighboring icon's weight.
- **Decorative by default.** Icon-only buttons carry the accessible name
  (`aria-label`); the icon itself is `aria-hidden`.
- **Deliberate exceptions, in two places only:**
  - `WindowControls` keeps its hand-drawn 10px hairline caption glyphs —
    they must read as native Windows chrome, which lucide's 24px-grid
    stroke-2 style cannot.
  - CSS `cursor:` values (the blade cursor in `styles.css`) stay data-URI
    SVGs — a cursor can't be a React component.

## Alternatives considered and rejected

- **Keep Unicode glyphs**: zero-dependency, but rendering varies by font and
  platform (several glyphs render as emoji on Windows), sizing rides
  `font-size`, and half-icon-half-text buttons can't be styled coherently.
- **A second icon set** (Heroicons, Tabler, Radix Icons): lucide is already
  installed via shadcn, its catalog is large and actively maintained, and
  mixing drawing grids/stroke styles produces visibly inconsistent chrome.
- **An app-level `<Icon name=…>` wrapper**: indirection without benefit —
  named imports tree-shake, type-check, and grep better.

## Consequences

- Existing icon sites were migrated (transport row, close buttons, menu
  chevron/check, startup actions, the globe, peek-list kind fallbacks); the
  transport glyphs left the i18n resource files, which no longer contain
  icons.
- The `font-size`/`line-height` rules that existed solely to size text
  glyphs were dropped from `styles.css`; buttons that held bare glyphs are
  now `inline-flex` centered.
- Residual textual indicators (status ✓/✗ inside translated strings, the
  PerfHUD debug readout) are not icons in the UI-chrome sense and migrate
  opportunistically when their components are next touched.
