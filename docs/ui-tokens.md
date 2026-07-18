# UI design tokens

The single palette source is `apps/desktop/src/renderer/app.css`: shadcn
roles in `:root` / `.dark` plus a **dark-NLE semantic layer** on top.
Tailwind v4 is only the carrier — feature CSS consumes the roles as
`var(--*)`, never raw hex. Governance (Base UI + cascade contract):
[ADR 0018](adr/0018-ui-widgets-on-base-ui-with-tailwind-tokens.md).

This document is the full reference for the semantic layer. When a value
here drifts from `app.css`, `app.css` wins — update the doc in the same
commit.

## Dark-only, on purpose

WeftCut is a dark-only application: a neutral dark surround is part of an
editor's color judgment, and one theme keeps the visual QA surface of
every panel at ×1. `html.dark` is hardwired, `color-scheme: dark` is set
in `base.css`, and there is no theme switcher and no
`prefers-color-scheme` handling. The light values in `:root` are inert
theme-tool scaffolding, not a supported theme — never consume them as if
a light mode existed (decision: ADR 0018).

## Surfaces

| Token | Value | Use |
|---|---|---|
| `--background` | `#0c0e12` | App workspace. |
| `--card` | `#111419` | Panels, cards. |
| `--popover` | `#1c2028` | Floating overlays. |
| `--surface-sunken` | `#08090b` | Recessed wells: thumbnail slots, code wells, inset editors. |
| `--surface-raised` | `#181c23` | Rows/cards lifted above a panel; hover rests. |
| `--track-lane` | `#14171d` | Timeline track lane — one step above `--background` so row seams read. |
| `#000` (literal) | — | Reserved for the preview canvas and video surfaces, where color judgment matters. Never use for panel chrome. |

Structural hairlines use `--border-soft` (`#252a34`), control outlines
`--border` (`#363e4b`).

## Selection & focus

`--ring` (`#3b82f6`) is the one true accent; blue is reserved for
selection/focus.

| Token | Value | Use |
|---|---|---|
| `--selection` | `var(--ring)` | Selected outlines, active indicators. |
| `--selection-bg` | blue @ 16% | Selected backgrounds. |
| `--selection-border` | blue @ 50% | Selected borders. |
| `--focus-ring` | 2px ring, 50% mix | `box-shadow` value for `:focus-visible`. |

## Status hues

Shared feedback colors. Translucent badge/banner fills derive from these
via `color-mix(in srgb, var(--X) NN%, transparent)` instead of repeating
the hue as an rgba literal.

| Token | Value | Use |
|---|---|---|
| `--destructive` | `#f87171` | The single error role (bake errors, remove hovers, error pills/cards). |
| `--success` | `#46c46a` | Ready/ok states (bake-ready, meter green). |
| `--warning` | `#f0a020` | Warming/attention states (bake-warming, meter amber). |
| `--keyframe` | `#facc15` | Keyframe diamonds, armed stopwatches, pending badges. A domain accent, deliberately distinct from `--warning`. |

One-off categorical palettes (log category pills, kind badges, motif card
status badges) may stay literal or use the pinned `--color-*` Tailwind
shades; promote to a role only when the same hue repeats across files.

## Neutral overlays

Translucent white layers for states on otherwise-transparent controls.

| Token | Alpha | Use |
|---|---|---|
| `--surface-tint` | 0.04 | Faintest lift: quiet row hovers, inset wells, hairline seams. |
| `--hover-neutral` | 0.06 | Default hover. |
| `--hover-neutral-strong` | 0.10 | Strong hover / highlighted menu item. |
| `--active-neutral` | 0.16 | Pressed state. |
| `--border-on-dark` | 0.15 | Strokes on near-black / monitor surfaces where solid `--border` reads too strong. |
| `--border-on-dark-strong` | 0.30 | Hover step of the above. |

Deliberate exceptions that stay literal: the focused/unfocused
window-frame hairline (0.10/0.08 — OS-adjacent chrome, see `base.css`)
and the bright bake-spinner arc (0.85).

## Elevation

Three shadow levels for floating chrome. On near-black surfaces the 1px
`--border` every floating surface already carries does most of the
separation work; the shadow only lifts, so blurs stay tight.

| Token | Value | Use |
|---|---|---|
| `--shadow-menu` | `0 4px 16px`, black @ 35% | Dropdowns, context menus, small popups, editor tooltips. |
| `--shadow-popover` | `0 8px 28px`, black @ 45% | Floating panels: command palette, export/status panels, drag previews. |
| `--shadow-modal` | `0 16px 48px`, black @ 55% | Dialogs: settings, motif picker, connect agent. |

Directional exception: the log drawer opens from the bottom edge and casts
upward — it keeps a literal `0 -8px 28px` matched to `--shadow-popover`.

## Motion

| Token | Value | Use |
|---|---|---|
| `--transition-fast` | `90ms ease-out` | Hover/focus/color/opacity feedback. |
| `--transition-base` | `150ms ease-out` | Slower ambient changes (scrollbar thumb). |

Continuous data-driven transitions (meter/progress `width` updates) stay
`Nms linear` literals, and choreographed keyframe animations (drag-preview
morph, splash) keep their own timing.

## Radius

| Token | Value | Use |
|---|---|---|
| `--radius-control` | 4px | Inputs, buttons, badges. |
| `--radius-card` | 6px | Cards, thumbnails. |
| `--radius-panel` | 8px | Panels, dialogs. |

Pills stay literal `999px`. These are separate from shadcn's
`--radius-sm/md/lg` ramp so consuming a token never rescales a control.

## Type scale

| Token | Value | Use |
|---|---|---|
| `--font-size-micro` | 10px | Dense instrumentation: rulers, badges, kbd hints, monospace ids. |
| `--font-size-caption` | 11px | Captions, secondary metadata. |
| `--font-size-body` | 12px | Default UI text. |
| `--font-size-label` | 13px | Section labels, emphasized rows. |
| `--font-size-title` | 14px | Panel titles. |
| `--line-height-tight` / `--line-height-body` | 1.2 / 1.4 | Line-height roles. |

Literal by design: 9px fine print and 16px+ display type (splash, perf
HUD readouts) sit outside the compact UI scale.

## Shared dropdown chrome

`.app-menu-list` / `.app-menu-item` (+ `-check` / `-label` /
`-accelerator`) in `styles/menu.css` skin every dropdown alike — menu bar,
`AppSelect` popups, timeline context menus. New popups reuse these classes
instead of rolling their own list chrome.

## Media-kind colors

Timeline clip colors per media kind live in
`src/renderer/timeline/layerTheme.ts` (semantic-by-kind; `Color` layers
use the project color hint) — not in the CSS token layer.
