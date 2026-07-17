# Global search palette

`Mod+K` (also a menu item) opens a Spotlight-style overlay that searches, in
one box: **commands** (every user-invocable app action), **media-pool items**,
**tracks**, **clips** (timeline layers by label), **captions / text** (`Text`
layer `content` — captions are Text layers, ADR 0026), and **markers**.
Selecting a result either **executes** (commands) or **navigates** (everything
else: select the item, move the playhead to it, scroll the timeline to show
it). Navigating never changes play state — seek-while-playing keeps playing,
the Premiere/Resolve convention.

Chinese text matches three ways: original characters, full pinyin
("zimu" → 字幕), and pinyin initials ("zm" → 字幕). Command entries index
their en-US label as an extra haystack, so "export" matches 导出 on a Chinese
locale.

Out of scope: effect parameters, keyframe values, project-settings values,
and persistent search history.

## Code map

All renderer-side; the main process is untouched (`ProjectSummary` already
carries everything searchable).

| Module | Role |
| --- | --- |
| `renderer/commands/registry.ts` | Command registry (module-level store, `playbackStore` idiom) |
| `renderer/commands/appCommands.ts` | The app's `CommandDef` set; App.tsx registers on mount via hook (handlers close over App state) |
| `renderer/search/buildEntries.ts` | Pure `(summary, commands) → SearchEntry[]` extraction |
| `renderer/search/searchIndexStore.ts` | Background-maintained index (see contract below) |
| `renderer/search/pinyin.ts` | pinyin-pro haystack generation, memoized per source string |
| `renderer/search/matcher.ts` | fuzzysort ranking across haystacks |
| `renderer/search/SearchPalette.tsx` | Overlay UI (AppDialog pattern, mounted in App.tsx) |
| `renderer/state/navigation.ts` | `jumpToLayer` / `jumpToTimeUs` / `revealInMediaPool` verbs |
| `renderer/state/selectionStore.ts` | Module-level layer selection (shared with Timeline/RightPanel) |

Dependencies: `fuzzysort` (scoring + highlight ranges) and `pinyin-pro`.
`cmdk` was rejected — its dialog binds Radix while the app is on Base UI, and
multi-haystack pinyin matching needs a custom filter anyway.

## Index — stale-but-instant contract

Palette queries never block on indexing; they always hit the **last
completed** index (like an IDE search during re-indexing):

```
project:changed ─▶ debounce 300 ms ─▶ async full rebuild ─▶ atomic swap
palette open / keystroke ───────────▶ query the last completed index
```

Judgment calls behind that shape:

- **Main-thread async task, not a Worker.** The corpus is one project's
  summary (hundreds of entries); a full rebuild is single-digit milliseconds,
  and a Worker would pay a structured-clone of the whole summary per rebuild —
  more than the indexing costs. The escalation seam stays open:
  `buildEntries` is pure and can move into a Worker unchanged.
- **Full rebuild, not incremental diff.** Every rebuild starts from the
  canonical `projectStore.summary` snapshot, so ghost-entry / missed-update
  sync bugs are impossible by construction (the same reasoning that retired
  the Rust read-mirror).
- **Pinyin memoization makes full rebuilds behave like increments** — a
  module-level cache survives rebuilds; only never-seen strings pay
  pinyin-generation cost.

## Ranking & display

`matcher.ts` runs fuzzysort across each entry's haystacks and keeps the best
score per entry, with a floor (`MIN_SCORE`) that drops low-quality scatter
matches (single chars spread across a long caption) and small boosts for
commands and exact prefix matches. Results group in a fixed order
(commands → media → tracks → clips → captions → markers), capped per group
with a "show more" expander; an empty query browses commands. Matched
characters highlight from fuzzysort ranges — except when the best match came
from a pinyin haystack, whose indexes don't map 1:1 onto CJK label chars, so
highlighting is skipped rather than wrong.

## Activation semantics

- **Command** → `run()`, close. Commands whose `enabled()` is false render
  greyed out and inert. Shortcut hints come from `useEffectiveBindings` /
  `resolveAccelerator`.
- **Media** → a second-level list: "Reveal in media pool" plus one row per
  timeline usage (track label + timecode); Esc backs out one level.
- **Track** → reveal the track, playhead to its first clip.
- **Clip / caption / marker** → `jumpToLayer` / `jumpToTimeUs`; caption rows
  show a text snippet + timecode.

Edge cases: with no project open, only commands are searchable. Activation
re-validates ids against `layerById` / `mediaById` — an entry deleted since
the last index build logs via LogBus and no-ops, never throws. Unavailable
media shows a badge; navigation still works.

## Testing

Unit: `matcher.test.ts` (pinyin full/initials, CJK-direct, ranking goldens),
`buildEntries.test.ts` (extraction + haystack shapes against a fixture
summary), `registry.test.ts` / `appCommands.test.ts`, `pinyin.test.ts`,
`searchIndexStore.test.ts` (debounce + atomic-swap contract),
`SearchPalette.test.tsx` (grouping, keyboard nav, two-level media list).
