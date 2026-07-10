# Global Search Palette — Design

**Date:** 2026-07-10
**Status:** approved (design review with user)

## Goal

A global fuzzy-search palette (`Mod+K`) that searches, in one box:

1. **Commands** — every user-invocable app action (shortcut actions + menu-only actions)
2. **Media** — media-pool items by label
3. **Tracks** — by label / role
4. **Clips** — timeline layers by label
5. **Captions / text** — `Text` layer `content` (captions are Text layers per ADR 0026)
6. **Markers** — by label

Selecting a result either **executes** (commands) or **navigates** (everything else:
select the item, move the playhead to it, scroll the timeline to show it).

Chinese text matches by original characters, **full pinyin** ("zimu" → 字幕), and
**pinyin initials** ("zm" → 字幕). English command labels are indexed alongside
zh-CN labels, so "export" matches 导出 on a Chinese locale.

## Non-goals (v1)

- No search over effect parameters, keyframes, or project settings values.
- No persistent search history / recents.
- No Worker or separate indexing process (seam reserved, see §Index).
- No changes to the main-process `Project` model, schema, or IPC — the renderer's
  `ProjectSummary` already carries everything searchable.

## Architecture

Four new renderer modules; zero main-process changes.

```
apps/desktop/src/renderer/
├── commands/registry.ts        command registry (module-level store)
├── search/searchIndexStore.ts  background-maintained index
├── search/matcher.ts           fuzzy scorer (fuzzysort + pinyin haystacks)
└── search/SearchPalette.tsx    overlay UI (AppDialog pattern, mounted in App.tsx)
```

New dependencies: `fuzzysort` (scoring + highlight ranges), `pinyin-pro`
(full-pinyin and initials generation). `cmdk` was rejected: its Dialog binds
Radix while the app is on Base UI, and multi-haystack pinyin matching needs a
custom filter anyway — the remaining value (list keyboard nav) is ~150 lines.

## Command registry (`commands/registry.ts`)

The largest structural change. Today user actions live in two disconnected
places: `App.tsx shortcutHandlers` (~22 `ActionId` handlers) and menu `on*`
props in `AppMenuBar.tsx`/`ViewMenu.tsx`. The registry unifies them.

- `CommandDef = { id, labelKey, section, enabled?, run }` where `id` is an
  existing `ActionId` when one exists, else a new command id for menu-only
  actions (add text/color layer, motifs, connect, settings, …).
- Module-level registry (same idiom as `playbackStore`): the palette reads it
  without prop threading. Registration happens inside React — App.tsx calls
  `useRegisterCommands(defs)` on mount because handlers close over App state;
  unregister on unmount.
- Shortcut hints come from the existing `useEffectiveBindings` /
  `resolveAccelerator`, displayed at the right edge of command rows.
- Follow-up benefit (not in scope to execute, but the registry enables it):
  menus can later be driven from the registry so `ACTION_DEFS` and menu markup
  stop being parallel books.

## Index (`search/searchIndexStore.ts`) — IDE-style background index

Behavioral contract: palette queries never block on indexing; they always hit
the **last completed** index (stale-but-instant, like an IDE search during
re-indexing).

```
project:changed ─▶ debounce ~300 ms ─▶ async rebuild (idle-scheduled) ─▶ atomic swap
palette open / keystroke ────────────▶ query the last completed index
```

Implementation judgment, agreed in review: **backgrounding = debounced async
task on the main thread, not a Worker or process.** The corpus is one editing
project's summary (hundreds of entries), a full rebuild is single-digit
milliseconds, and a Worker would pay a structured-clone of the whole summary
per rebuild — more than the indexing itself costs. The escalation seam is kept
open: `buildEntries(summary, commands) → SearchEntry[]` is a pure function and
can move into a Worker unchanged if project sizes ever demand it.

- **Full rebuild, not incremental diff.** Every rebuild starts from the
  canonical `projectStore.summary` snapshot, so ghost-entry / missed-update
  sync bugs are impossible by construction (the same reasoning that retired
  the Rust read-mirror).
- **Pinyin memoization makes full rebuilds behave like increments.** A
  module-level `Map<sourceString, {full, initials}>` survives rebuilds; only
  strings never seen before pay pinyin-generation cost.
- Entry shape:

  ```ts
  type SearchEntry = {
    type: 'command' | 'media' | 'track' | 'clip' | 'caption' | 'marker'
    label: string          // display label (t(labelKey) for commands)
    context?: string       // e.g. track name + timecode for clips/captions
    haystacks: string[]    // [original, pinyin-full, pinyin-initials, extra…]
    payload:               // what activation needs — discriminated by `type`
      | { commandId: string }
      | { mediaId: string; usages: { layerId: string; trackId: string; tStartUs: number }[] }
      | { trackId: string; firstLayerId: string | null }
      | { layerId: string; tStartUs: number }        // clip & caption
      | { markerId: string; tUs: number }
  }
  ```

  Command entries additionally index the en-US label as an extra haystack.
  Caption entries index the layer `content` (the searchable subtitle text).

## Matcher (`search/matcher.ts`)

- Normalize query → run `fuzzysort` across each entry's haystacks → keep the
  best score per entry.
- Ranking: base fuzzysort score, with a small boost for commands and for exact
  prefix matches. Group results by `type`; cap each group at 5 with a
  "show more" expander.
- CJK-containing queries match original text directly; Latin queries match
  English labels and both pinyin haystacks.

## Navigation layer — the global data-structure changes

The complete list of changes to existing structures (all renderer-side):

1. **`selectionStore` (new).** `selectedLayerId` moves from an App.tsx
   `useState` into a module-level store (same pattern as `playheadStore`);
   App/Timeline/RightPanel consume atomic selectors. Timeline-internal
   multi-select state stays local.
2. **`seekTo` lifted.** App.tsx's clamped `seekTo` (clamps to
   `[0, lastFrameAnchorUs]`) moves into `navigation.ts`, reading the anchor
   from `projectStore`; App delegates to it. The palette gets clamped seeking
   without touching refs.
3. **Timeline horizontal scroll-to-time (net-new capability).**
   `scrollToTimeUs(tUs)`: Timeline registers an imperative handle on mount
   (same pattern as `playbackStore`'s `TransportHandle`); safe no-op when no
   timeline is mounted.
4. **`navigation.ts` verbs** composed from the above, called by the palette:
   - `jumpToLayer(layerId)` — validate via `layerById`, select, seek to
     `t_start_us`, horizontal scroll, `revealTrack` if the owning track is
     hidden.
   - `jumpToTimeUs(tUs)` — clamped seek + scroll.
   - `revealInMediaPool(mediaId)` — open the MediaPool panel if hidden,
     scroll to and highlight the item.

## Interaction & UI

- **Trigger:** new `ActionId: openSearchPalette`, default `Mod+K` (a chord, so
  it fires even while a text input has focus — desired). Also exposed as a
  menu item.
- **Surface:** top-centered overlay on the AppDialog/Base-UI pattern, mounted
  in App.tsx's overlay block behind a `paletteOpen` flag, inside
  `ShortcutBindingsProvider`. Search field uses `AppInput`. Grouped list with
  ↑/↓ navigation, Enter to activate, Esc to close, matched characters
  highlighted from fuzzysort ranges.
- **Activation semantics:**
  - **Command** → `run()`, close. Commands whose `enabled()` is false render
    greyed out and inert.
  - **Media** → expands to a second-level list: "Reveal in media pool" plus
    one row per timeline usage (track label + timecode). Unused media shows
    only the reveal row. Enter on the media row enters the sub-list; Esc goes
    back one level.
  - **Track** → `revealTrack` + playhead to the track's first clip.
  - **Clip / caption / marker** → `jumpToLayer` / `jumpToTimeUs`. Caption rows
    show a text snippet + timecode.
- Navigating does **not** change play state (seek-while-playing keeps playing —
  Premiere/Resolve convention, consistent with the project's native-NLE norms).

## Edge cases & error handling

- No project open → command results only.
- Entry deleted between index build and activation → `navigation` re-validates
  ids against `layerById`/`mediaById`; on miss, log via LogBus and no-op
  (never throw).
- `available: false` media → badge on the row; navigation still works.
- Index rebuild in flight while typing → results come from the previous index;
  swap is atomic so a keystroke never sees a half-built index.

## Testing

- **matcher**: unit tests — pinyin full/initial cases, CJK-direct cases,
  ranking goldens (command boost, prefix boost).
- **buildEntries**: pure-function tests against a fixture `ProjectSummary`
  (covers media/track/clip/caption/marker extraction and haystack shapes).
- **e2e** (Playwright `_electron`, `VITE_WEFTCUT_E2E=1`): open with `Mod+K`,
  type a caption substring, Enter, assert playhead moved to the cue start;
  type a command name, Enter, assert the command's effect.
