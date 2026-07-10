# Global Search Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `Mod+K` global fuzzy-search palette over commands, media, tracks, clips, captions and markers, with pinyin (full + initials) matching; selecting a result executes the command or navigates (select + seek + scroll).

**Architecture:** Four new renderer modules — `commands/registry.ts` (unified command surface), `search/searchIndexStore.ts` (debounced background index rebuilt from `projectStore.summary`), `search/matcher.ts` (fuzzysort over label/pinyin haystacks), `search/SearchPalette.tsx` (Base UI dialog). Navigation verbs live in `state/navigation.ts` with playbackStore-style registered handles. Zero main-process / schema / IPC changes.

**Tech Stack:** React 19, zustand 5, Base UI dialog primitives, i18next, vitest (+ @testing-library/react), Playwright `_electron`. New deps: `fuzzysort` (v3, MIT) + `pinyin-pro` (v3, MIT) — both pure-JS, renderer-bundled.

**Spec:** `docs/superpowers/specs/2026-07-10-global-search-palette-design.md` — read it first.

## Global Constraints

- All work under `apps/desktop/`; run commands from `apps/desktop` unless noted.
- Unit test cycle: `npx vitest run <path>` (NOT `npm test` — that prebuilds wasm and runs the whole suite; use it once at the end of a task if you want a full sweep).
- Zustand: atomic selectors only — composite-object selectors infinite-loop `useSyncExternalStore` (`projectStore.ts` header comment).
- Playhead gate: never put frame-rate values in React state above a leaf; event handlers read `playheadTimeUs()` imperatively (`playheadStore.ts` header).
- Write files with the Edit/Write tools only (PowerShell `Set-Content` writes cp1252, corrupting CJK locale files).
- `en-US.ts` is the locale source of truth; every new key must also land in `zh-CN.ts` in the same commit.
- Conventional commits (`feat:`, `test:`, …), one commit per task minimum, stage by explicit path (`git add <paths>`) — the user may have concurrent edits in this checkout.
- Comment style: `docs/comment-style.md` — summary/why/landmine/pointer comments only.
- Worktree bootstrap (if executing in a fresh worktree): `npm install`, `npm run build:wasm`, `npm run napi:build` — see memory `reference_worktree_bootstrap`. Close any running dev app before `napi:build` (file lock).
- No changes to `apps/desktop/src/main/**` anywhere in this plan.

---

### Task 1: Dependencies + pinyin haystack module

**Files:**
- Modify: `apps/desktop/package.json` (via npm install)
- Create: `apps/desktop/src/renderer/search/pinyin.ts`
- Test: `apps/desktop/src/renderer/search/pinyin.test.ts`

**Interfaces:**
- Produces: `pinyinHaystacks(text: string): { full: string; initials: string } | null` — null for text with no CJK chars; memoized by content.

- [ ] **Step 1: Install dependencies**

```powershell
cd apps/desktop; npm install fuzzysort@^3 pinyin-pro@^3
```

Expected: both land in `dependencies` in `apps/desktop/package.json`.

- [ ] **Step 2: Write the failing test**

`apps/desktop/src/renderer/search/pinyin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pinyinHaystacks } from "./pinyin";

describe("pinyinHaystacks", () => {
  it("generates full pinyin + initials for Chinese text", () => {
    const h = pinyinHaystacks("字幕");
    expect(h).not.toBeNull();
    expect(h!.full).toBe("zimu");
    expect(h!.initials).toBe("zm");
  });

  it("returns null for pure-Latin text", () => {
    expect(pinyinHaystacks("export video")).toBeNull();
  });

  it("keeps Latin runs intact in mixed text", () => {
    const h = pinyinHaystacks("导出mp4");
    expect(h!.full).toBe("daochump4");
    expect(h!.initials).toBe("dcmp4");
  });

  it("memoizes by content (same object identity)", () => {
    expect(pinyinHaystacks("字幕")).toBe(pinyinHaystacks("字幕"));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/renderer/search/pinyin.test.ts`
Expected: FAIL — cannot resolve `./pinyin`.

- [ ] **Step 4: Implement**

`apps/desktop/src/renderer/search/pinyin.ts`:

```ts
import { pinyin } from "pinyin-pro";

/// Pinyin search haystacks for one display string: full pinyin ("zimu")
/// and initials ("zm"), both lowercase with no separators so a contiguous
/// query like "zimu" matches. Null when the string contains no CJK —
/// callers skip the extra haystacks entirely for Latin labels.
export interface PinyinHaystacks {
  full: string;
  initials: string;
}

const CJK_RE = /[㐀-䶿一-鿿]/;

// Content-keyed memo. Survives index rebuilds (module-level), which is
// what makes the "full rebuild every time" index strategy cheap — only
// never-seen strings pay pinyin generation. Cleared wholesale at the cap
// rather than LRU-tracked; caption corpora are far below the cap.
const cache = new Map<string, PinyinHaystacks | null>();
const CACHE_CAP = 20_000;

export function pinyinHaystacks(text: string): PinyinHaystacks | null {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let result: PinyinHaystacks | null = null;
  if (CJK_RE.test(text)) {
    const opts = { toneType: "none", type: "array", nonZh: "consecutive", v: true } as const;
    const full = pinyin(text, opts).join("").toLowerCase();
    const initials = pinyin(text, { ...opts, pattern: "first" }).join("").toLowerCase();
    result = { full, initials };
  }
  if (cache.size >= CACHE_CAP) cache.clear();
  cache.set(text, result);
  return result;
}
```

If the `pinyin-pro` option types reject this exact shape, consult `node_modules/pinyin-pro/types` — the intent is: no tones, array output, non-Chinese runs passed through unchanged (`nonZh: "consecutive"`), ü→v.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/search/pinyin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/src/renderer/search/pinyin.ts apps/desktop/src/renderer/search/pinyin.test.ts
git commit -m "feat(search): pinyin haystack generation (full + initials, memoized)"
```

---

### Task 2: Search entry types + fuzzy matcher

**Files:**
- Create: `apps/desktop/src/renderer/search/types.ts`
- Create: `apps/desktop/src/renderer/search/matcher.ts`
- Test: `apps/desktop/src/renderer/search/matcher.test.ts`

**Interfaces:**
- Consumes: `pinyinHaystacks` (Task 1) — only in tests, to build realistic haystacks.
- Produces:
  - `SearchEntry { key, type, label, context, haystacks, payload }` and `SearchPayload` (discriminated union, mirrors the spec §payload) in `types.ts`.
  - `rankEntries(query: string, entries: SearchEntry[], limitPerGroup?: number): Map<SearchEntryType, RankedResult[]>` and `GROUP_ORDER: SearchEntryType[]` in `matcher.ts`. `RankedResult { entry, score, highlight: number[] }`.

- [ ] **Step 1: Write `types.ts`** (no test of its own — it's types only)

`apps/desktop/src/renderer/search/types.ts`:

```ts
import type { ActionId } from "../shortcuts/defs";

export type SearchEntryType =
  | "command"
  | "media"
  | "track"
  | "clip"
  | "caption"
  | "marker";

export interface MediaUsage {
  layerId: string;
  trackId: string;
  trackLabel: string;
  tStartUs: number;
}

/// What activation needs, discriminated by `type`. Ids only (+ the times
/// needed to seek) — the index may be stale, so navigation re-validates
/// ids against projectStore's live maps at activation time.
export type SearchPayload =
  | { type: "command"; commandId: string; actionId?: ActionId }
  | { type: "media"; mediaId: string; available: boolean; usages: MediaUsage[] }
  | { type: "track"; trackId: string; firstLayerId: string | null }
  | { type: "clip"; layerId: string; tStartUs: number }
  | { type: "caption"; layerId: string; tStartUs: number }
  | { type: "marker"; markerId: string; tUs: number };

export interface SearchEntry {
  /// `${type}:${id}` — stable React list key.
  key: string;
  type: SearchEntryType;
  /// Display label; always haystacks[0].
  label: string;
  /// Secondary display line (media kind, "track · timecode", …).
  context: string;
  /// [0] = label; then extra text (en-US command label) and pinyin strings.
  haystacks: string[];
  payload: SearchPayload;
}
```

- [ ] **Step 2: Write the failing matcher test**

`apps/desktop/src/renderer/search/matcher.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rankEntries } from "./matcher";
import { pinyinHaystacks } from "./pinyin";
import type { SearchEntry, SearchEntryType } from "./types";

let n = 0;
function mk(type: SearchEntryType, label: string, extra: string[] = []): SearchEntry {
  const hay = [label, ...extra];
  const p = pinyinHaystacks(label);
  if (p) hay.push(p.full, p.initials);
  n += 1;
  return {
    key: `${type}:${n}`,
    type,
    label,
    context: "",
    haystacks: hay,
    payload: { type: "marker", markerId: String(n), tUs: 0 },
  };
}

describe("rankEntries", () => {
  it("matches full pinyin against a Chinese label", () => {
    const out = rankEntries("zimu", [mk("caption", "字幕第一行")]);
    expect(out.get("caption")).toHaveLength(1);
  });

  it("matches pinyin initials", () => {
    const out = rankEntries("zm", [mk("caption", "字幕第一行")]);
    expect(out.get("caption")).toHaveLength(1);
  });

  it("matches CJK queries against the original label", () => {
    const out = rankEntries("字幕", [mk("caption", "字幕第一行"), mk("caption", "别的内容")]);
    expect(out.get("caption")).toHaveLength(1);
    expect(out.get("caption")![0]!.entry.label).toBe("字幕第一行");
  });

  it("matches an extra haystack (en label on a zh entry)", () => {
    const out = rankEntries("export", [mk("command", "导出…", ["Export…"])]);
    expect(out.get("command")).toHaveLength(1);
  });

  it("drops non-matches", () => {
    const out = rankEntries("qqqq", [mk("media", "beach.mp4")]);
    expect(out.size).toBe(0);
  });

  it("empty query lists commands only (browse mode)", () => {
    const out = rankEntries("", [mk("command", "Save"), mk("media", "beach.mp4")]);
    expect(out.get("command")).toHaveLength(1);
    expect(out.has("media")).toBe(false);
  });

  it("caps each group at limitPerGroup", () => {
    const entries = Array.from({ length: 9 }, (_, i) => mk("clip", `clip ${i}`));
    const out = rankEntries("clip", entries, 5);
    expect(out.get("clip")).toHaveLength(5);
  });

  it("highlight indexes point into the label only for direct label matches", () => {
    const direct = rankEntries("bea", [mk("media", "beach.mp4")]).get("media")![0]!;
    expect(direct.highlight.length).toBeGreaterThan(0);
    const viaPinyin = rankEntries("zm", [mk("caption", "字幕")]).get("caption")![0]!;
    expect(viaPinyin.highlight).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/renderer/search/matcher.test.ts`
Expected: FAIL — cannot resolve `./matcher`.

- [ ] **Step 4: Implement `matcher.ts`**

```ts
import fuzzysort from "fuzzysort";
import type { SearchEntry, SearchEntryType } from "./types";

export interface RankedResult {
  entry: SearchEntry;
  score: number;
  /// Char indexes into entry.label to emphasize. Empty when the best
  /// match came from a pinyin/extra haystack — those indexes don't map
  /// 1:1 onto the label's CJK chars, so we skip char highlighting.
  highlight: number[];
}

/// Display + iteration order for result groups.
export const GROUP_ORDER: SearchEntryType[] = [
  "command",
  "media",
  "track",
  "clip",
  "caption",
  "marker",
];

// fuzzysort v3 scores are 0..1. Floor keeps low-quality scatter matches
// (single chars spread across a long caption) out of the list.
const MIN_SCORE = 0.25;
const COMMAND_BOOST = 0.1;
const PREFIX_BOOST = 0.15;

export function rankEntries(
  query: string,
  entries: SearchEntry[],
  limitPerGroup = 5,
): Map<SearchEntryType, RankedResult[]> {
  const grouped = new Map<SearchEntryType, RankedResult[]>();
  const q = query.trim();
  if (!q) {
    // Browse mode: no query yet — list commands in registration order.
    const rows = entries
      .filter((e) => e.type === "command")
      .slice(0, Math.max(limitPerGroup, 8))
      .map((entry) => ({ entry, score: 0, highlight: [] as number[] }));
    if (rows.length > 0) grouped.set("command", rows);
    return grouped;
  }

  const scored: RankedResult[] = [];
  for (const entry of entries) {
    let bestScore = -1;
    let bestHighlight: number[] = [];
    for (let i = 0; i < entry.haystacks.length; i++) {
      const r = fuzzysort.single(q, entry.haystacks[i]!);
      if (!r || r.score <= bestScore) continue;
      bestScore = r.score;
      bestHighlight = i === 0 ? Array.from(r.indexes) : [];
    }
    if (bestScore < MIN_SCORE) continue;
    let score = bestScore;
    if (entry.type === "command") score += COMMAND_BOOST;
    if (entry.label.toLowerCase().startsWith(q.toLowerCase())) score += PREFIX_BOOST;
    scored.push({ entry, score, highlight: bestHighlight });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const type of GROUP_ORDER) {
    const rows = scored.filter((r) => r.entry.type === type).slice(0, limitPerGroup);
    if (rows.length > 0) grouped.set(type, rows);
  }
  return grouped;
}
```

fuzzysort v3 API notes: `fuzzysort.single(search, target)` returns `null` or a result with `.score` (0..1) and `.indexes` (iterable of matched char positions). If the installed version differs, check `node_modules/fuzzysort/index.d.ts` and keep the contract of this function unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/search/matcher.test.ts`
Expected: PASS (8 tests). If `MIN_SCORE` filtering makes a legitimate test case fail, tune `MIN_SCORE` down (0.2) rather than deleting the test.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/src/renderer/search/types.ts apps/desktop/src/renderer/search/matcher.ts apps/desktop/src/renderer/search/matcher.test.ts
git commit -m "feat(search): entry types + fuzzysort matcher with pinyin haystacks and group ranking"
```

---

### Task 3: Command registry

**Files:**
- Create: `apps/desktop/src/renderer/commands/registry.ts`
- Test: `apps/desktop/src/renderer/commands/registry.test.ts`

**Interfaces:**
- Produces:
  - `CommandDef { id: string; labelKey: string; actionId?: ActionId; enabled?: () => boolean; run: () => void | Promise<void> }`
  - `registerCommandProvider(p: () => CommandDef[]): () => void`
  - `listCommands(): CommandDef[]` (provider order, duplicate ids dropped with a console.warn)
  - `getCommand(id: string): CommandDef | undefined`
  - `subscribeCommandRegistry(l: () => void): () => void` (fires on provider register/unregister)
  - `useCommandProvider(getDefs: () => CommandDef[]): void` React hook (ref-read pattern, registers once per mount)

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/renderer/commands/registry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  getCommand,
  listCommands,
  registerCommandProvider,
  subscribeCommandRegistry,
  type CommandDef,
} from "./registry";

const def = (id: string): CommandDef => ({ id, labelKey: `actions.${id}`, run: () => {} });

describe("command registry", () => {
  it("lists commands from registered providers and unregisters cleanly", () => {
    const un = registerCommandProvider(() => [def("save"), def("undo")]);
    expect(listCommands().map((c) => c.id)).toEqual(["save", "undo"]);
    expect(getCommand("undo")?.labelKey).toBe("actions.undo");
    un();
    expect(listCommands()).toHaveLength(0);
  });

  it("drops duplicate ids from later providers", () => {
    const un1 = registerCommandProvider(() => [def("save")]);
    const un2 = registerCommandProvider(() => [def("save"), def("redo")]);
    expect(listCommands().map((c) => c.id)).toEqual(["save", "redo"]);
    un1();
    un2();
  });

  it("notifies subscribers on register and unregister", () => {
    const spy = vi.fn();
    const unsub = subscribeCommandRegistry(spy);
    const un = registerCommandProvider(() => []);
    expect(spy).toHaveBeenCalledTimes(1);
    un();
    expect(spy).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("reads provider defs lazily (fresh flags each list call)", () => {
    let enabled = false;
    const un = registerCommandProvider(() => [
      { ...def("export"), enabled: () => enabled },
    ]);
    expect(listCommands()[0]!.enabled!()).toBe(false);
    enabled = true;
    expect(listCommands()[0]!.enabled!()).toBe(true);
    un();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/commands/registry.test.ts`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 3: Implement `registry.ts`**

```ts
import { useEffect, useRef } from "react";
import type { ActionId } from "../shortcuts/defs";

/// The unified user-invocable command surface. Today's actions live in two
/// disconnected places — App.tsx's shortcut HandlerMap and menu `on*`
/// props; providers registered here are the one catalog the search
/// palette (and, later, menus) read. Module-level, playbackStore-style:
/// readers don't thread props; components register providers on mount.
export interface CommandDef {
  /// Unique id. Shortcut-backed commands reuse their ActionId string so
  /// ids stay one namespace.
  id: string;
  labelKey: string;
  /// Set for shortcut-backed commands — the palette shows the effective
  /// binding via useEffectiveBindings(actionId).
  actionId?: ActionId;
  /// Evaluated at palette render time; absent = always enabled.
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

type Provider = () => CommandDef[];

const providers = new Set<Provider>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function registerCommandProvider(p: Provider): () => void {
  providers.add(p);
  notify();
  return () => {
    if (providers.delete(p)) notify();
  };
}

/// Registry-change signal — the search index re-snapshots command labels
/// when providers mount/unmount (App mount lands after wireSearchIndex).
export function subscribeCommandRegistry(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function listCommands(): CommandDef[] {
  const out: CommandDef[] = [];
  const seen = new Set<string>();
  for (const p of providers) {
    for (const d of p()) {
      if (seen.has(d.id)) {
        console.warn(`commands: duplicate id "${d.id}" ignored`);
        continue;
      }
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

export function getCommand(id: string): CommandDef | undefined {
  return listCommands().find((c) => c.id === id);
}

/// React binding: register a provider for this component's lifetime.
/// `getDefs` is read through a ref so handler identities may churn per
/// render without re-registering (same pattern as useShortcuts).
export function useCommandProvider(getDefs: () => CommandDef[]): void {
  const ref = useRef(getDefs);
  ref.current = getDefs;
  useEffect(() => registerCommandProvider(() => ref.current()), []);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/commands/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/src/renderer/commands/registry.ts apps/desktop/src/renderer/commands/registry.test.ts
git commit -m "feat(commands): module-level command registry with provider pattern"
```

---

### Task 4: selectionStore + App.tsx migration

**Files:**
- Create: `apps/desktop/src/renderer/state/selectionStore.ts`
- Modify: `apps/desktop/src/renderer/App.tsx` (line refs against current HEAD: state decl ~78, reset effect ~108, everything else is find-usages of `selectedLayerId`/`setSelectedLayerId` inside App)
- Test: `apps/desktop/src/renderer/state/selectionStore.test.ts`

**Interfaces:**
- Produces:
  - `setSelectedLayerId(id: string | null): void` (module-level, no-op when unchanged)
  - `selectedLayerId(): string | null` (imperative read)
  - `useSelectedLayerId(): string | null` (atomic hook)
  - `useSelectionStore` (zustand store, for tests/subscription)

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/renderer/state/selectionStore.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  selectedLayerId,
  setSelectedLayerId,
  useSelectionStore,
} from "./selectionStore";

beforeEach(() => setSelectedLayerId(null));

describe("selectionStore", () => {
  it("sets and reads the selected layer id", () => {
    setSelectedLayerId("layer-1");
    expect(selectedLayerId()).toBe("layer-1");
    setSelectedLayerId(null);
    expect(selectedLayerId()).toBeNull();
  });

  it("does not notify subscribers on a same-value write", () => {
    setSelectedLayerId("layer-1");
    const spy = vi.fn();
    const unsub = useSelectionStore.subscribe(spy);
    setSelectedLayerId("layer-1");
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/state/selectionStore.test.ts`
Expected: FAIL — cannot resolve `./selectionStore`.

- [ ] **Step 3: Implement `selectionStore.ts`**

```ts
import { create } from "zustand";

/// App-global single-selection (which layer the inspector shows). Lifted
/// out of App.tsx useState so non-React callers — search-palette
/// navigation, future MCP-driven UI — can select without threading the
/// component tree. Timeline's multi-select set for group ops stays
/// Timeline-local.
interface State {
  selectedLayerId: string | null;
}

export const useSelectionStore = create<State>(() => ({
  selectedLayerId: null,
}));

export function setSelectedLayerId(id: string | null): void {
  if (useSelectionStore.getState().selectedLayerId !== id) {
    useSelectionStore.setState({ selectedLayerId: id });
  }
}

export function selectedLayerId(): string | null {
  return useSelectionStore.getState().selectedLayerId;
}

export const useSelectedLayerId = (): string | null =>
  useSelectionStore((s) => s.selectedLayerId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/state/selectionStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Migrate App.tsx**

In `apps/desktop/src/renderer/App.tsx`:

1. Add import:
   ```ts
   import { setSelectedLayerId, useSelectedLayerId } from "./state/selectionStore";
   ```
2. Replace the state declaration (currently `const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);`) with:
   ```ts
   const selectedLayerId = useSelectedLayerId();
   ```
   The imported `setSelectedLayerId` takes over every existing call site unchanged (`revealTrack`, `deleteSelected`, `onSelect={setSelectedLayerId}` props, the R.7 effects).
3. In the existing fresh-session effect (`useEffect(() => { setPlayheadTimeUs(0); }, []);`) add `setSelectedLayerId(null);` — the store is module-global and would otherwise carry the previous project's selection across close/open (same rationale as the playhead reset above it).
4. `deleteSelected`'s `useCallback` dep array keeps `[selectedLayerId, refresh]` — the subscribed value still changes identity correctly.

- [ ] **Step 6: Typecheck + run renderer tests**

Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run src/renderer/state`
Expected: PASS (no regressions in the state suite).

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src/renderer/state/selectionStore.ts apps/desktop/src/renderer/state/selectionStore.test.ts apps/desktop/src/renderer/App.tsx
git commit -m "feat(state): lift selectedLayerId into module-level selectionStore"
```

---

### Task 5: Navigation verbs + handle registrations

**Files:**
- Create: `apps/desktop/src/renderer/state/navigation.ts`
- Modify: `apps/desktop/src/renderer/App.tsx` (register `revealTrack`)
- Modify: `apps/desktop/src/renderer/timeline/Timeline.tsx` (register horizontal scroll; `rootRef` is declared ~line 154, `useTimelineView` call ~line 164)
- Modify: `apps/desktop/src/renderer/panels/MediaPool.tsx` (register reveal-in-pool + flash)
- Modify: `apps/desktop/src/renderer/styles/media.css` (flash style)
- Test: `apps/desktop/src/renderer/state/navigation.test.ts`

**Interfaces:**
- Consumes: `setSelectedLayerId` (Task 4), `transportSeek`/`registerTransport` (playbackStore), `setPlayheadTimeUs`/`playheadTimeUs` (playheadStore), `useProjectStore` indices, `lastFrameAnchorUs` (frames.ts), `setMediaPoolDrawerOpen` (appSettingsStore).
- Produces:
  - `clampSeekUs(tUs: number): number`
  - `seekToClamped(tUs: number): void`
  - `jumpToTimeUs(tUs: number): void` (clamped seek + horizontal scroll)
  - `jumpToLayer(layerId: string): boolean` (false when the id no longer exists)
  - `revealInMediaPool(mediaId: string): boolean`
  - `registerRevealTrack / registerScrollToTime / registerRevealMedia` — each `(fn) => unregister`, identity-guarded like `releaseTransport`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/renderer/state/navigation.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../settings/appSettingsStore", () => ({
  setMediaPoolDrawerOpen: vi.fn(() => Promise.resolve()),
}));

import {
  clampSeekUs,
  jumpToLayer,
  jumpToTimeUs,
  registerRevealMedia,
  registerRevealTrack,
  registerScrollToTime,
  revealInMediaPool,
  seekToClamped,
} from "./navigation";
import { setMediaPoolDrawerOpen } from "../settings/appSettingsStore";
import { registerTransport } from "./playbackStore";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";
import { selectedLayerId, setSelectedLayerId } from "./selectionStore";
import type { ProjectSummary } from "../ipc";

/// 10 s 30 fps summary with one video track (one clip at 2 s) and one
/// media item. Only the fields navigation touches need to be realistic.
function fixtureSummary(): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
    track_count: 1,
    layer_count: 1,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [
      {
        id: "m1", label: "beach.mp4", path: "C:/x/beach.mp4", kind: "Video",
        duration_us: 5_000_000, width: 1920, height: 1080, size_bytes: 1,
        available: true, decode_route: { kind: "Original" } as never,
        codec: "h264", pix_fmt: "yuv420p",
      },
    ],
    tracks: [
      {
        id: "t1", kind: "Video", label: "A-Roll", enabled: true, locked: false,
        muted: false, solo: false, role: "a-roll", transient: false,
        layers: [
          {
            id: "l1", label: null, t_start_us: 2_000_000, t_end_us: 4_000_000,
            kind: "VideoClip", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "VideoClip", media_id: "m1", media_label: "beach.mp4",
              src_in_us: 0, src_out_us: 2_000_000,
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              opacity: { mode: "Static", value: 1 },
              speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
            },
          },
        ],
      },
    ],
    markers: [],
    groups: [],
    audio_roles: [],
  };
}

beforeEach(() => {
  useProjectStore.getState().apply(fixtureSummary());
  setSelectedLayerId(null);
  setPlayheadTimeUs(0);
  vi.clearAllMocks();
});

describe("clampSeekUs / seekToClamped", () => {
  it("clamps to [0, lastFrameAnchorUs]", () => {
    expect(clampSeekUs(-5)).toBe(0);
    // 10 s @ 30 fps → last frame anchor 9_966_667
    expect(clampSeekUs(99_000_000)).toBe(9_966_667);
    expect(clampSeekUs(2_000_000)).toBe(2_000_000);
  });

  it("writes playheadStore optimistically and seeks the transport", () => {
    const seek = vi.fn();
    registerTransport({ play() {}, pause() {}, seek, isPlaying: () => false });
    seekToClamped(2_000_000);
    expect(playheadTimeUs()).toBe(2_000_000);
    expect(seek).toHaveBeenCalledWith(2_000_000);
  });
});

describe("jumpToLayer", () => {
  it("selects, seeks to t_start, scrolls, and reveals the owner track", () => {
    const reveal = vi.fn();
    const scroll = vi.fn();
    const unReveal = registerRevealTrack(reveal);
    const unScroll = registerScrollToTime(scroll);
    expect(jumpToLayer("l1")).toBe(true);
    expect(reveal).toHaveBeenCalledWith("t1", "l1");
    expect(playheadTimeUs()).toBe(2_000_000);
    expect(scroll).toHaveBeenCalledWith(2_000_000);
    unReveal();
    unScroll();
  });

  it("falls back to plain selection when no reveal handle is registered", () => {
    expect(jumpToLayer("l1")).toBe(true);
    expect(selectedLayerId()).toBe("l1");
  });

  it("returns false for a stale layer id and changes nothing", () => {
    expect(jumpToLayer("ghost")).toBe(false);
    expect(selectedLayerId()).toBeNull();
    expect(playheadTimeUs()).toBe(0);
  });
});

describe("revealInMediaPool", () => {
  it("opens the drawer and calls the registered handle", () => {
    const flash = vi.fn();
    const un = registerRevealMedia(flash);
    expect(revealInMediaPool("m1")).toBe(true);
    expect(setMediaPoolDrawerOpen).toHaveBeenCalledWith(true);
    expect(flash).toHaveBeenCalledWith("m1");
    un();
  });

  it("returns false for a stale media id", () => {
    expect(revealInMediaPool("ghost")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/state/navigation.test.ts`
Expected: FAIL — cannot resolve `./navigation`.

- [ ] **Step 3: Implement `navigation.ts`**

```ts
import { lastFrameAnchorUs } from "../frames";
import { setMediaPoolDrawerOpen } from "../settings/appSettingsStore";
import { transportSeek } from "./playbackStore";
import { setPlayheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";
import { setSelectedLayerId } from "./selectionStore";

/// Imperative navigation verbs for callers outside the React ref chain
/// (search palette, future agent-driven UI). Handles that need component
/// internals — App's R.7 reveal-track state, Timeline's scroll container,
/// MediaPool's list DOM — are registered on mount, playbackStore-style;
/// every verb is a safe no-op for whatever isn't mounted.

type RevealTrackFn = (trackId: string, layerId: string) => void;
type ScrollToTimeFn = (tUs: number) => void;
type RevealMediaFn = (mediaId: string) => void;

let revealTrackFn: RevealTrackFn | null = null;
let scrollToTimeFn: ScrollToTimeFn | null = null;
let revealMediaFn: RevealMediaFn | null = null;

// Identity-guarded unregister (releaseTransport pattern): a stale cleanup
// from an old mount can't tear down a newer registration.
export function registerRevealTrack(fn: RevealTrackFn): () => void {
  revealTrackFn = fn;
  return () => {
    if (revealTrackFn === fn) revealTrackFn = null;
  };
}

export function registerScrollToTime(fn: ScrollToTimeFn): () => void {
  scrollToTimeFn = fn;
  return () => {
    if (scrollToTimeFn === fn) scrollToTimeFn = null;
  };
}

export function registerRevealMedia(fn: RevealMediaFn): () => void {
  revealMediaFn = fn;
  return () => {
    if (revealMediaFn === fn) revealMediaFn = null;
  };
}

/// Clamp a target playhead time to [0, lastFrameAnchorUs] against the
/// current summary — the same rule App.tsx's seekTo applies (Q5 of the
/// frame-anchor spec).
export function clampSeekUs(tUs: number): number {
  const summary = useProjectStore.getState().summary;
  const fpsNum = summary?.composition.fps_num ?? 30;
  const fpsDen = summary?.composition.fps_den ?? 1;
  const upper = lastFrameAnchorUs(summary?.duration_us ?? 0, fpsNum, fpsDen);
  return Math.max(0, Math.min(tUs, upper));
}

/// Clamped seek through the module-level transport. Optimistic
/// playheadStore write first: with no preview mounted there is no engine
/// emit, yet the playhead UI must still move (mirrors App.tsx seekTo).
/// Play state is untouched — seek-while-playing keeps playing (NLE norm).
export function seekToClamped(tUs: number): void {
  const clamped = clampSeekUs(tUs);
  setPlayheadTimeUs(clamped);
  transportSeek(clamped);
}

export function jumpToTimeUs(tUs: number): void {
  const clamped = clampSeekUs(tUs);
  seekToClamped(clamped);
  scrollToTimeFn?.(clamped);
}

/// Select + seek + scroll to a layer. Validates against the live index —
/// the caller may hold a stale search entry (index rebuilds are
/// debounced). Returns false (and changes nothing) when the layer is gone.
export function jumpToLayer(layerId: string): boolean {
  const { layerById, trackIdByLayerId } = useProjectStore.getState();
  const layer = layerById.get(layerId);
  if (!layer) return false;
  const trackId = trackIdByLayerId.get(layerId);
  if (trackId && revealTrackFn) {
    // App's revealTrack both reveals a hidden track (R.7) and selects the
    // layer; revealing an already-visible track is harmless.
    revealTrackFn(trackId, layerId);
  } else {
    setSelectedLayerId(layerId);
  }
  jumpToTimeUs(layer.t_start_us);
  return true;
}

/// Open the MediaPool drawer and flash the item. Returns false when the
/// media id no longer exists.
export function revealInMediaPool(mediaId: string): boolean {
  if (!useProjectStore.getState().mediaById.has(mediaId)) return false;
  void setMediaPoolDrawerOpen(true);
  revealMediaFn?.(mediaId);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/state/navigation.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Register the three handles + delegate App's clamp**

**App.tsx** — after the `revealTrack` useCallback (~line 136):

```ts
// Palette navigation reaches R.7 reveal-track through the module-level
// registry (state/navigation.ts) — App owns the revealedTrackId state.
useEffect(() => registerRevealTrack(revealTrack), [revealTrack]);
```

with import `import { clampSeekUs, registerRevealTrack } from "./state/navigation";`.

Also delegate App's `seekTo` clamp to the lifted rule (spec §Navigation item 2 — one clamp implementation, not two that can drift). Replace the body of `seekTo` (~line 118):

```ts
const seekTo = useCallback((tUs: number) => {
  const clamped = clampSeekUs(tUs);
  // Optimistic store write: with no preview mounted (empty composition)
  // there is no engine emit, yet the playhead UI must still move.
  setPlayheadTimeUs(clamped);
  previewRef.current?.seekTo(clamped);
}, []);
```

`clampSeekUs` reads `projectStore` — the parallel, equally-fresh mirror of the same actor state App's local `summary` tracks — so the `useCallback` dep array drops the three `summary?.…` deps (now `[]`). The `frameDurUs`/`lastFrameAnchorUs` imports in App may become partially unused; prune only what the compiler flags.

**Timeline.tsx** — after the `useTimelineView` call (~line 164). `rootRef` and `pxPerSec` are already in scope; `HEADER_COL_PX` comes from `./geometry` (extend the existing geometry import if one exists, else add one):

```ts
// Net-new capability: horizontal scroll-to-time for palette jumps.
// pxPerSec is React state; the registered closure reads it through a ref
// so registration happens once per mount.
const pxPerSecForScrollRef = useRef(pxPerSec);
pxPerSecForScrollRef.current = pxPerSec;
useEffect(
  () =>
    registerScrollToTime((tUs) => {
      const root = rootRef.current;
      if (!root) return;
      const x = (tUs / 1_000_000) * pxPerSecForScrollRef.current;
      const viewport = root.clientWidth - HEADER_COL_PX;
      // Center the target time in the lane area (the first HEADER_COL_PX
      // of the viewport is the sticky track-header column).
      root.scrollLeft = Math.max(0, x - viewport / 2);
    }),
  [],
);
```

with import `import { registerScrollToTime } from "../state/navigation";`.

**MediaPool.tsx** — inside the `MediaPool` component, BEFORE the early `if (media.length === 0)` return (hooks must be unconditional):

```ts
// Palette "reveal in media pool": clear any filter (the target must be
// in the filtered list), then flash + scroll the row into view.
const [flashId, setFlashId] = useState<string | null>(null);
useEffect(
  () =>
    registerRevealMedia((id) => {
      setQuery("");
      setFlashId(id);
    }),
  [],
);
useEffect(() => {
  if (flashId === null) return;
  document
    .querySelector(`[data-media-id="${CSS.escape(flashId)}"]`)
    ?.scrollIntoView({ block: "nearest" });
  const t = setTimeout(() => setFlashId(null), 1600);
  return () => clearTimeout(t);
}, [flashId]);
```

with imports `import { useEffect } from "react"` (extend existing) and `import { registerRevealMedia } from "../state/navigation";`. On the `<li>` (the `media-item` element): add `data-media-id={m.id}` and append to its class array:

```ts
flashId === m.id ? "is-search-flash" : "",
```

**styles/media.css** — append:

```css
/* Search-palette "reveal in media pool" flash (cleared after ~1.6 s). */
.media-item.is-search-flash {
  outline: 2px solid #6ea8ff;
  outline-offset: -2px;
  border-radius: 4px;
}
```

- [ ] **Step 6: Typecheck + full unit suite**

Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run src/renderer/state src/renderer/panels`
Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src/renderer/state/navigation.ts apps/desktop/src/renderer/state/navigation.test.ts apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/timeline/Timeline.tsx apps/desktop/src/renderer/panels/MediaPool.tsx apps/desktop/src/renderer/styles/media.css
git commit -m "feat(state): navigation verbs (jumpToLayer/jumpToTimeUs/revealInMediaPool) + mount-registered handles"
```

---

### Task 6: buildEntries — summary → search entries

**Files:**
- Create: `apps/desktop/src/renderer/search/buildEntries.ts`
- Test: `apps/desktop/src/renderer/search/buildEntries.test.ts`

**Interfaces:**
- Consumes: `SearchEntry`/`MediaUsage` (Task 2), `pinyinHaystacks` (Task 1), `formatTimecode` (frames.ts), `ProjectSummary` types (ipc).
- Produces:
  - `CommandInput { id: string; label: string; enLabel: string; actionId?: ActionId }`
  - `buildEntries(summary: ProjectSummary | null, commands: CommandInput[]): SearchEntry[]` — pure function, the Worker seam from the spec.

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/renderer/search/buildEntries.test.ts`. Reuse the Task 5 fixture shape (copy the `fixtureSummary()` helper — tests are read stand-alone, don't import across test files) and extend it with: a Text layer (`content: "字幕第一行"`, `t_start_us: 1_000_000`) on a second track with `role: "caption"`, `label: null`, and one marker (`{ id: "mk1", t_us: 5_000_000, end_t_us: null, label: "章节一", color_hint: "" }`).

```ts
import { describe, expect, it } from "vitest";
import { buildEntries } from "./buildEntries";
import type { SearchEntry } from "./types";

// … fixtureSummary() as described above …

const CMDS = [
  { id: "save", label: "保存", enLabel: "Save", actionId: "save" as const },
];

function byKey(entries: SearchEntry[], key: string): SearchEntry {
  const e = entries.find((x) => x.key === key);
  if (!e) throw new Error(`missing entry ${key}`);
  return e;
}

describe("buildEntries", () => {
  it("null summary → command entries only", () => {
    const out = buildEntries(null, CMDS);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("command");
    // zh label + en label + pinyin of the zh label
    expect(out[0]!.haystacks).toContain("保存");
    expect(out[0]!.haystacks).toContain("Save");
    expect(out[0]!.haystacks).toContain("baocun");
    expect(out[0]!.haystacks).toContain("bc");
  });

  it("emits media entries with timeline usages sorted by start", () => {
    const m = byKey(buildEntries(fixtureSummary(), []), "media:m1");
    expect(m.label).toBe("beach.mp4");
    expect(m.payload).toMatchObject({
      type: "media",
      mediaId: "m1",
      usages: [{ layerId: "l1", trackId: "t1", tStartUs: 2_000_000 }],
    });
  });

  it("emits track entries with the earliest layer as jump target", () => {
    const t = byKey(buildEntries(fixtureSummary(), []), "track:t1");
    expect(t.payload).toMatchObject({ type: "track", firstLayerId: "l1" });
  });

  it("Text layers become caption entries (content = haystack), not clips", () => {
    const out = buildEntries(fixtureSummary(), []);
    const cap = out.find((e) => e.type === "caption");
    expect(cap).toBeDefined();
    expect(cap!.label).toBe("字幕第一行");
    expect(cap!.haystacks).toContain("zimudiyihang");
    expect(out.some((e) => e.type === "clip" && e.key.includes(cap!.key.split(":")[1]!))).toBe(false);
  });

  it("clip entries fall back label → media_label and carry track · timecode context", () => {
    const clip = byKey(buildEntries(fixtureSummary(), []), "clip:l1");
    expect(clip.label).toBe("beach.mp4");
    expect(clip.context).toBe("A-Roll · 00:00:02:00");
  });

  it("markers with labels become entries; unlabeled ones are skipped", () => {
    const out = buildEntries(fixtureSummary(), []);
    expect(byKey(out, "marker:mk1").payload).toMatchObject({ type: "marker", tUs: 5_000_000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/search/buildEntries.test.ts`
Expected: FAIL — cannot resolve `./buildEntries`.

- [ ] **Step 3: Implement `buildEntries.ts`**

```ts
import { formatTimecode } from "../frames";
import type { ProjectSummary, TrackSummary } from "../ipc";
import type { ActionId } from "../shortcuts/defs";
import { pinyinHaystacks } from "./pinyin";
import type { MediaUsage, SearchEntry } from "./types";

/// Command snapshot the index builder consumes — labels pre-resolved by
/// the caller (searchIndexStore) so this stays a pure function of its
/// arguments: the spec's Worker seam.
export interface CommandInput {
  id: string;
  /// Active-locale label.
  label: string;
  /// en-US label — extra haystack so English queries hit on zh-CN UI.
  enLabel: string;
  actionId?: ActionId;
}

const CAPTION_SNIPPET_MAX = 80;

function withPinyin(haystacks: string[]): string[] {
  const out = [...haystacks];
  for (const h of haystacks) {
    const p = pinyinHaystacks(h);
    if (p) out.push(p.full, p.initials);
  }
  return out;
}

function trackDisplayLabel(track: TrackSummary, index: number): string {
  return track.label ?? `${track.kind} ${index + 1}`;
}

export function buildEntries(
  summary: ProjectSummary | null,
  commands: CommandInput[],
): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const c of commands) {
    entries.push({
      key: `command:${c.id}`,
      type: "command",
      label: c.label,
      context: "",
      haystacks: withPinyin(c.label === c.enLabel ? [c.label] : [c.label, c.enLabel]),
      payload: { type: "command", commandId: c.id, actionId: c.actionId },
    });
  }
  if (!summary) return entries;

  const { fps_num: fpsNum, fps_den: fpsDen } = summary.composition;
  const tc = (us: number) => formatTimecode(us, fpsNum, fpsDen);

  const usagesByMedia = new Map<string, MediaUsage[]>();
  summary.tracks.forEach((track, ti) => {
    const trackLabel = trackDisplayLabel(track, ti);
    for (const layer of track.layers) {
      const p = layer.params as { media_id?: string };
      if (typeof p.media_id !== "string") continue;
      const list = usagesByMedia.get(p.media_id) ?? [];
      list.push({
        layerId: layer.id,
        trackId: track.id,
        trackLabel,
        tStartUs: layer.t_start_us,
      });
      usagesByMedia.set(p.media_id, list);
    }
  });
  for (const list of usagesByMedia.values()) {
    list.sort((a, b) => a.tStartUs - b.tStartUs);
  }

  for (const m of summary.media) {
    entries.push({
      key: `media:${m.id}`,
      type: "media",
      label: m.label,
      context: m.kind,
      haystacks: withPinyin([m.label]),
      payload: {
        type: "media",
        mediaId: m.id,
        available: m.available,
        usages: usagesByMedia.get(m.id) ?? [],
      },
    });
  }

  summary.tracks.forEach((track, ti) => {
    const trackLabel = trackDisplayLabel(track, ti);
    const first = track.layers.reduce<{ id: string; t: number } | null>(
      (acc, l) => (acc === null || l.t_start_us < acc.t ? { id: l.id, t: l.t_start_us } : acc),
      null,
    );
    entries.push({
      key: `track:${track.id}`,
      type: "track",
      label: trackLabel,
      context: track.role ?? track.kind,
      haystacks: withPinyin([trackLabel]),
      payload: { type: "track", trackId: track.id, firstLayerId: first?.id ?? null },
    });

    for (const layer of track.layers) {
      const context = `${trackLabel} · ${tc(layer.t_start_us)}`;
      if (layer.params.kind === "Text") {
        const snippet = layer.params.content.replace(/\s+/g, " ").trim().slice(0, CAPTION_SNIPPET_MAX);
        if (!snippet) continue;
        entries.push({
          key: `caption:${layer.id}`,
          type: "caption",
          label: snippet,
          context,
          haystacks: withPinyin([snippet]),
          payload: { type: "caption", layerId: layer.id, tStartUs: layer.t_start_us },
        });
      } else {
        const p = layer.params as { media_label?: string };
        const clipLabel = layer.label ?? p.media_label ?? layer.kind;
        entries.push({
          key: `clip:${layer.id}`,
          type: "clip",
          label: clipLabel,
          context,
          haystacks: withPinyin([clipLabel]),
          payload: { type: "clip", layerId: layer.id, tStartUs: layer.t_start_us },
        });
      }
    }
  });

  for (const mk of summary.markers) {
    if (!mk.label.trim()) continue;
    entries.push({
      key: `marker:${mk.id}`,
      type: "marker",
      label: mk.label,
      context: tc(mk.t_us),
      haystacks: withPinyin([mk.label]),
      payload: { type: "marker", markerId: mk.id, tUs: mk.t_us },
    });
  }

  return entries;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/search/buildEntries.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/src/renderer/search/buildEntries.ts apps/desktop/src/renderer/search/buildEntries.test.ts
git commit -m "feat(search): pure summary→entries index builder (media usages, captions, markers)"
```

---

### Task 7: searchIndexStore — debounced background index

**Files:**
- Create: `apps/desktop/src/renderer/search/searchIndexStore.ts`
- Modify: `apps/desktop/src/renderer/app/useAppWiring.ts` (wire alongside `wireProjectStore`, ~line 140)
- Test: `apps/desktop/src/renderer/search/searchIndexStore.test.ts`

**Interfaces:**
- Consumes: `buildEntries`/`CommandInput` (Task 6), `listCommands`/`subscribeCommandRegistry` (Task 3), `useProjectStore`, i18n default export.
- Produces:
  - `useSearchIndexStore` (zustand: `{ entries: SearchEntry[]; version: number }`)
  - `useSearchEntries(): SearchEntry[]` atomic hook
  - `wireSearchIndex(): () => void` — one-shot wiring (idempotent), returns teardown
  - `markSearchIndexDirty(): void`

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/renderer/search/searchIndexStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommandProvider } from "../commands/registry";
import { useProjectStore } from "../state/projectStore";
import { useSearchIndexStore, wireSearchIndex } from "./searchIndexStore";

// Reuse the Task 5/6 fixtureSummary() shape — copy it in (one media m1,
// one track t1 with clip l1). Vary media label per test via a parameter:
// fixtureSummary(label = "beach.mp4").

let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  useProjectStore.getState().apply(null);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(301); // debounce window
  await vi.advanceTimersByTimeAsync(1);   // async rebuild slice
}

describe("searchIndexStore", () => {
  it("builds an initial index on wire and rebuilds after a debounced summary change", async () => {
    teardown = wireSearchIndex();
    const v0 = useSearchIndexStore.getState().version;

    useProjectStore.getState().apply(fixtureSummary("beach.mp4"));
    // Not yet — debounce pending.
    expect(useSearchIndexStore.getState().entries.some((e) => e.label === "beach.mp4")).toBe(false);
    await flushDebounce();
    const s = useSearchIndexStore.getState();
    expect(s.version).toBeGreaterThan(v0);
    expect(s.entries.some((e) => e.key === "media:m1")).toBe(true);
  });

  it("coalesces a burst of changes into one rebuild", async () => {
    teardown = wireSearchIndex();
    const v0 = useSearchIndexStore.getState().version;
    useProjectStore.getState().apply(fixtureSummary("a.mp4"));
    await vi.advanceTimersByTimeAsync(100);
    useProjectStore.getState().apply(fixtureSummary("b.mp4"));
    await vi.advanceTimersByTimeAsync(100);
    useProjectStore.getState().apply(fixtureSummary("c.mp4"));
    await flushDebounce();
    const s = useSearchIndexStore.getState();
    expect(s.version).toBe(v0 + 1);
    expect(s.entries.some((e) => e.label === "c.mp4")).toBe(true);
    expect(s.entries.some((e) => e.label === "a.mp4")).toBe(false);
  });

  it("re-snapshots command labels when a provider registers", async () => {
    teardown = wireSearchIndex();
    const un = registerCommandProvider(() => [
      { id: "save", labelKey: "actions.save", run: () => {} },
    ]);
    await flushDebounce();
    expect(
      useSearchIndexStore.getState().entries.some((e) => e.key === "command:save"),
    ).toBe(true);
    un();
    await flushDebounce();
    expect(
      useSearchIndexStore.getState().entries.some((e) => e.key === "command:save"),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/search/searchIndexStore.test.ts`
Expected: FAIL — cannot resolve `./searchIndexStore`.

- [ ] **Step 3: Implement `searchIndexStore.ts`**

```ts
import { create } from "zustand";
import { listCommands, subscribeCommandRegistry } from "../commands/registry";
import i18n from "../i18n";
import { useProjectStore } from "../state/projectStore";
import { buildEntries, type CommandInput } from "./buildEntries";
import type { SearchEntry } from "./types";

/// IDE-style background index (spec §Index): dirty signals (summary
/// change via projectStore, locale change, command-registry change) →
/// debounce → async FULL rebuild from the canonical snapshot → atomic
/// swap. Queries always read the last completed build — never a
/// half-built one. Full rebuild (not incremental diff) makes ghost
/// entries impossible by construction; pinyinHaystacks' content memo
/// makes rebuilds cheap. buildEntries is pure — the Worker escalation
/// seam if project sizes ever demand it.
interface State {
  entries: SearchEntry[];
  version: number;
}

export const useSearchIndexStore = create<State>(() => ({
  entries: [],
  version: 0,
}));

export const useSearchEntries = (): SearchEntry[] =>
  useSearchIndexStore((s) => s.entries);

const DEBOUNCE_MS = 300;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let wired = false;

function commandInputs(): CommandInput[] {
  const tEn = i18n.getFixedT("en-US");
  return listCommands().map((c) => ({
    id: c.id,
    label: i18n.t(c.labelKey),
    enLabel: tEn(c.labelKey),
    actionId: c.actionId,
  }));
}

function rebuildNow(): void {
  const summary = useProjectStore.getState().summary;
  const entries = buildEntries(summary, commandInputs());
  useSearchIndexStore.setState((s) => ({ entries, version: s.version + 1 }));
}

export function markSearchIndexDirty(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Extra async slice keeps the rebuild off the dirty signal's own
    // stack — project:changed subscribers must stay cheap.
    setTimeout(rebuildNow, 0);
  }, DEBOUNCE_MS);
}

/// One-shot wiring, called alongside wireProjectStore (useAppWiring).
/// Idempotent for HMR/StrictMode: a second call while wired only marks
/// dirty. Returns teardown.
export function wireSearchIndex(): () => void {
  if (wired) {
    markSearchIndexDirty();
    return () => {};
  }
  wired = true;
  const unsubProject = useProjectStore.subscribe((s, prev) => {
    if (s.summary !== prev.summary) markSearchIndexDirty();
  });
  const unsubRegistry = subscribeCommandRegistry(markSearchIndexDirty);
  const onLocale = () => markSearchIndexDirty();
  i18n.on("languageChanged", onLocale);
  rebuildNow();
  return () => {
    unsubProject();
    unsubRegistry();
    i18n.off("languageChanged", onLocale);
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    wired = false;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/search/searchIndexStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire in useAppWiring**

In `apps/desktop/src/renderer/app/useAppWiring.ts`, in the same effect where `wireProjectStore()` is awaited (~line 140):

```ts
const u = await wireProjectStore();
const unwireSearch = wireSearchIndex();
```

and call `unwireSearch()` in that effect's existing cleanup path (next to where `u` is invoked/torn down — match the surrounding teardown structure exactly). Import: `import { wireSearchIndex } from "../search/searchIndexStore";`.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → clean.

```powershell
git add apps/desktop/src/renderer/search/searchIndexStore.ts apps/desktop/src/renderer/search/searchIndexStore.test.ts apps/desktop/src/renderer/app/useAppWiring.ts
git commit -m "feat(search): debounced background index store wired to project/locale/registry signals"
```

---

### Task 8: `openSearchPalette` action, locale keys, App/Timeline command providers

**Files:**
- Modify: `apps/desktop/src/renderer/shortcuts/defs.ts` (ActionId union ~line 25, ACTION_DEFS ~line 57)
- Modify: `apps/desktop/src/renderer/i18n/locales/en-US.ts` (actions ~line 106; new `search` namespace at top level)
- Modify: `apps/desktop/src/renderer/i18n/locales/zh-CN.ts` (mirror keys)
- Create: `apps/desktop/src/renderer/commands/appCommands.ts`
- Modify: `apps/desktop/src/renderer/App.tsx` (extract two Insert-menu callbacks; register provider)
- Modify: `apps/desktop/src/renderer/timeline/Timeline.tsx` (register group-commands provider)
- Test: `apps/desktop/src/renderer/commands/appCommands.test.ts`

**Interfaces:**
- Consumes: `CommandDef`/`useCommandProvider` (Task 3), `ACTION_DEFS`/`ActionId`/`HandlerMap` (shortcuts).
- Produces:
  - New `ActionId` `"openSearchPalette"` bound to `Mod+K`, labelKey `actions.open_search`.
  - `buildAppCommands(handlers: HandlerMap, menu: MenuCommandDeps, flags: AppCommandFlags): CommandDef[]` — derives shortcut-backed commands from the HandlerMap + `ACTION_DEFS` (skipping `openSearchPalette`), appends the five menu-only commands (`addColorLayer`, `addTextLayer`, `openMotifPicker`, `openConnect`, `openSettings`).

- [ ] **Step 1: defs.ts — add the action**

Add `| "openSearchPalette"` to the `ActionId` union and to `ACTION_DEFS`:

```ts
  // Global search palette. A chord, so it fires while a text input is
  // focused (default chord behavior) — expected for a Spotlight-style UI.
  openSearchPalette: { defaultKeys: ["Mod+K"], labelKey: "actions.open_search" },
```

- [ ] **Step 2: Locale keys**

`en-US.ts` — inside `actions`, after `dissolve_selected_group`:

```ts
    open_search: "Search everything…",
```

and a new top-level `search` block (sibling of `actions`, `menu`, …):

```ts
  search: {
    placeholder: "Search commands, media, clips, captions…",
    no_results: "No results for “{{query}}”",
    group_command: "Commands",
    group_media: "Media",
    group_track: "Tracks",
    group_clip: "Clips",
    group_caption: "Captions",
    group_marker: "Markers",
    reveal_in_pool: "Reveal in media pool",
    unused: "Not on the timeline",
    missing_badge: "missing",
    show_more: "Show {{count}} more…",
  },
```

`zh-CN.ts` — mirror both:

```ts
    open_search: "全局搜索…",
```

```ts
  search: {
    placeholder: "搜索命令、素材、片段、字幕…",
    no_results: "没有与“{{query}}”匹配的结果",
    group_command: "命令",
    group_media: "素材",
    group_track: "轨道",
    group_clip: "片段",
    group_caption: "字幕",
    group_marker: "标记",
    reveal_in_pool: "在素材库中显示",
    unused: "未在时间线上使用",
    missing_badge: "缺失",
    show_more: "再显示 {{count}} 条…",
  },
```

- [ ] **Step 3: Write the failing appCommands test**

`apps/desktop/src/renderer/commands/appCommands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAppCommands } from "./appCommands";
import { ACTION_DEFS } from "../shortcuts/defs";
import type { HandlerMap } from "../shortcuts";
import en from "../i18n/locales/en-US";

const noop = () => {};

// App's real HandlerMap keys (everything except the Timeline-local group
// ops), including the palette action itself.
const handlers: HandlerMap = {
  save: noop, saveAs: noop, closeProject: noop, undo: noop, redo: noop,
  togglePlay: noop, deleteSelected: noop, importMedia: noop, export: noop,
  toggleBladeMode: noop, toggleLog: noop, focusLogSearch: noop,
  toggleDisplayMode: noop, toggleMediaPool: noop,
  seekFrameBack: noop, seekFrameForward: noop, seekSecondBack: noop,
  seekSecondForward: noop, seekStart: noop, seekEnd: noop,
  openSearchPalette: noop,
};

const menu = {
  addColorLayer: noop, addTextLayer: noop,
  openMotifPicker: noop, openConnect: noop, openSettings: noop,
};

const flags = { busy: false, canUndo: true, canRedo: false, canBlade: true, exportLocked: true };

function resolveKey(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<any>((acc, k) => acc?.[k], obj);
}

describe("buildAppCommands", () => {
  it("derives one command per handled ActionId, excluding openSearchPalette", () => {
    const defs = buildAppCommands(handlers, menu, flags);
    const ids = defs.map((d) => d.id);
    expect(ids).toContain("save");
    expect(ids).toContain("seekStart");
    expect(ids).not.toContain("openSearchPalette");
    expect(ids).not.toContain("groupSelected"); // Timeline registers those
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("appends the five menu-only commands", () => {
    const ids = buildAppCommands(handlers, menu, flags).map((d) => d.id);
    for (const id of ["addColorLayer", "addTextLayer", "openMotifPicker", "openConnect", "openSettings"]) {
      expect(ids).toContain(id);
    }
  });

  it("every labelKey resolves in the en-US locale", () => {
    for (const d of buildAppCommands(handlers, menu, flags)) {
      expect(typeof resolveKey(en, d.labelKey), d.labelKey).toBe("string");
    }
  });

  it("wires enabled gates to the flags", () => {
    const defs = buildAppCommands(handlers, menu, flags);
    const by = (id: string) => defs.find((d) => d.id === id)!;
    expect(by("undo").enabled!()).toBe(true);
    expect(by("redo").enabled!()).toBe(false);
    expect(by("export").enabled!()).toBe(false);
    expect(by("togglePlay").enabled).toBeUndefined();
  });

  it("shortcut-backed commands reuse ACTION_DEFS labelKeys", () => {
    const save = buildAppCommands(handlers, menu, flags).find((d) => d.id === "save")!;
    expect(save.labelKey).toBe(ACTION_DEFS.save.labelKey);
    expect(save.actionId).toBe("save");
  });
});
```

Note: this test imports the en-US locale module — check its export shape (`export default { … }` vs named) and adjust the import line accordingly.

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/renderer/commands/appCommands.test.ts`
Expected: FAIL — cannot resolve `./appCommands`.

- [ ] **Step 5: Implement `appCommands.ts`**

```ts
import type { HandlerMap } from "../shortcuts";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import type { CommandDef } from "./registry";

/// App-level command catalog for the palette: derived from the shortcut
/// HandlerMap (so new shortcut actions appear automatically) plus the
/// five menu-only actions that have no binding. Pure factory — App calls
/// it inside useCommandProvider's getter, so flags are read fresh on
/// every listCommands().
export interface AppCommandFlags {
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canBlade: boolean;
  exportLocked: boolean;
}

export interface MenuCommandDeps {
  addColorLayer: () => void | Promise<void>;
  addTextLayer: () => void | Promise<void>;
  openMotifPicker: () => void;
  openConnect: () => void;
  openSettings: () => void;
}

export function buildAppCommands(
  handlers: HandlerMap,
  menu: MenuCommandDeps,
  flags: AppCommandFlags,
): CommandDef[] {
  const enabledFor: Partial<Record<ActionId, () => boolean>> = {
    save: () => !flags.busy,
    saveAs: () => !flags.busy,
    closeProject: () => !flags.busy,
    undo: () => !flags.busy && flags.canUndo,
    redo: () => !flags.busy && flags.canRedo,
    importMedia: () => !flags.busy,
    export: () => !flags.exportLocked,
    toggleBladeMode: () => !flags.busy && flags.canBlade,
  };

  const defs: CommandDef[] = [];
  for (const id of Object.keys(handlers) as ActionId[]) {
    // The palette shouldn't list "open the palette" inside itself.
    if (id === "openSearchPalette") continue;
    const run = handlers[id];
    if (!run) continue;
    defs.push({
      id,
      actionId: id,
      labelKey: ACTION_DEFS[id].labelKey,
      enabled: enabledFor[id],
      run,
    });
  }

  defs.push(
    { id: "addColorLayer", labelKey: "actions.add_color_layer", run: menu.addColorLayer },
    { id: "addTextLayer", labelKey: "actions.add_text_layer", run: menu.addTextLayer },
    { id: "openMotifPicker", labelKey: "actions.motifs", run: menu.openMotifPicker },
    { id: "openConnect", labelKey: "actions.connect_agent", run: menu.openConnect },
    { id: "openSettings", labelKey: "actions.settings", run: menu.openSettings },
  );
  return defs;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/renderer/commands/appCommands.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Register providers in App.tsx and Timeline.tsx**

**App.tsx:**

1. Extract the two inline Insert-menu callbacks (currently inline in the `<AppMenuBar>` props, ~lines 464-473) into named `useCallback`s above the JSX so both the menu and the palette share one implementation:
   ```ts
   const handleAddColorLayer = useCallback(async () => {
     const layerId = await addColorLayer({ tStartUs: playheadTimeUs() });
     setPendingRevealLayerId(layerId);
     await refresh();
   }, [refresh]);

   const handleAddTextLayer = useCallback(async () => {
     const layerId = await addTextLayer({ tStartUs: playheadTimeUs() });
     setPendingRevealLayerId(layerId);
     await refresh();
   }, [refresh]);
   ```
   and pass them to `onAddColorLayer={handleAddColorLayer}` / `onAddTextLayer={handleAddTextLayer}`.
2. After the `useShortcuts({...})` call, register the provider:
   ```ts
   useCommandProvider(() =>
     buildAppCommands(
       shortcutHandlers,
       {
         addColorLayer: handleAddColorLayer,
         addTextLayer: handleAddTextLayer,
         openMotifPicker: () => setMotifPickerOpen(true),
         openConnect: () => setConnectOpen(true),
         openSettings: () => setSettingsOpen(true),
       },
       {
         busy,
         canUndo: !!summary?.history.can_undo,
         canRedo: !!summary?.history.can_redo,
         canBlade: !!summary && summary.layer_count > 0,
         exportLocked:
           busy || exportState?.kind === "starting" || exportState?.kind === "progress",
       },
     ),
   );
   ```
   Imports: `import { useCommandProvider } from "./commands/registry";` and `import { buildAppCommands } from "./commands/appCommands";`.

**Timeline.tsx:** find its `useShortcuts({ handlers: … })` call (the one carrying `groupSelected` / `dissolveSelectedGroup`) and register the same two handler functions:

```ts
useCommandProvider(() => [
  {
    id: "groupSelected",
    actionId: "groupSelected",
    labelKey: ACTION_DEFS.groupSelected.labelKey,
    run: /* the exact function passed as handlers.groupSelected below */,
  },
  {
    id: "dissolveSelectedGroup",
    actionId: "dissolveSelectedGroup",
    labelKey: ACTION_DEFS.dissolveSelectedGroup.labelKey,
    run: /* the exact function passed as handlers.dissolveSelectedGroup */,
  },
]);
```

If those handlers are currently inline in the HandlerMap literal, extract them to named consts first so both sites reference the same function. Imports: `useCommandProvider` from `../commands/registry`, `ACTION_DEFS` from `../shortcuts/defs` (may already be imported).

- [ ] **Step 8: Typecheck + shortcut tests**

Run: `npm run typecheck` → clean.
Run: `npx vitest run src/renderer/shortcuts src/renderer/commands` → PASS.

- [ ] **Step 9: Commit**

```powershell
git add apps/desktop/src/renderer/shortcuts/defs.ts apps/desktop/src/renderer/i18n/locales/en-US.ts apps/desktop/src/renderer/i18n/locales/zh-CN.ts apps/desktop/src/renderer/commands/appCommands.ts apps/desktop/src/renderer/commands/appCommands.test.ts apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/timeline/Timeline.tsx
git commit -m "feat(commands): openSearchPalette action + app/timeline command providers + locale keys"
```

---

### Task 9: SearchPalette UI

**Files:**
- Create: `apps/desktop/src/renderer/search/SearchPalette.tsx`
- Create: `apps/desktop/src/renderer/styles/search.css`
- Modify: `apps/desktop/src/renderer/styles.css` (add `@import "./styles/search.css";`)
- Modify: `apps/desktop/src/renderer/App.tsx` (palette state + handler + mount)
- Modify: `apps/desktop/src/renderer/app/AppMenuBar.tsx` (Tools-menu entry, new `onOpenSearch` prop)
- Test: `apps/desktop/src/renderer/search/SearchPalette.test.tsx`

**Interfaces:**
- Consumes: `useSearchEntries` (Task 7), `rankEntries`/`GROUP_ORDER` (Task 2), `getCommand` (Task 3), `jumpToLayer`/`jumpToTimeUs`/`revealInMediaPool` (Task 5), `useEffectiveBindings` (shortcuts), `AppInput`, Base UI dialog primitives (`Dialog`, `DialogOverlay`, `DialogPortal` from `@/components/ui/dialog`, `Dialog as DialogPrimitive` from `@base-ui/react/dialog` — copy the composition in `AppDialog.tsx`).
- Produces: `SearchPalette({ onClose }: { onClose: () => void })`.

**Behavior contract (from the spec):**
- Top-centered overlay; `AppInput type="search" clearable autoFocus`; grouped list in `GROUP_ORDER`; ↑/↓ move an active row (wraps not required), Enter activates, Esc closes (one level at a time when in a media sub-list), matched label chars wrapped in `<mark>` (only for direct label matches).
- Groups display max 5 rows; when a group was truncated, a "Show N more…" row (mouse-clickable, not keyboard-focusable) expands that group for this palette session. Call `rankEntries(query, entries, 50)` and slice to 5 per unexpanded group in the component.
- Command rows: shortcut hint via `useEffectiveBindings(actionId)` rendered in a `<kbd>`; `enabled?.() === false` renders `.is-disabled` and refuses activation. Activation order: `onClose()` first, then `void cmd.run()` (a command may open its own dialog).
- Media rows: Enter opens the sub-list — first row `t("search.reveal_in_pool")`, then one row per usage labeled `` `${usage.trackLabel} · ${formatTimecode(usage.tStartUs, fpsNum, fpsDen)}` `` (fps via atomic selectors `useProjectStore((s) => s.summary?.composition.fps_num ?? 30)` / fps_den ?? 1). Media with zero usages: Enter goes straight to `revealInMediaPool` (skip the one-row sub-list); show `t("search.unused")` as its context. `available === false` → badge `t("search.missing_badge")`.
- Track rows: `payload.firstLayerId ? jumpToLayer(firstLayerId) : undefined`, then close. Clip/caption: `jumpToLayer(layerId)`. Marker: `jumpToTimeUs(tUs)`. When a `jumpToLayer`/`revealInMediaPool` returns `false` (stale entry), emit `void logEmit({ level: "info", category: { kind: "System" }, source: { kind: "User" }, message: "search: target no longer exists" })` (import `logEmit` from `../ipc`; copy the call shape from App.tsx's `run`) and still close.
- Esc/backdrop handling: don't intercept keydown for close; instead
  ```tsx
  <Dialog open onOpenChange={(open) => {
    if (open) return;
    if (subRef.current) { setSub(null); setActive(0); return; }
    onClose();
  }}>
  ```
  with `subRef` a ref mirroring the sub-list state — this catches Esc AND backdrop clicks uniformly, one level at a time.
- Query edits reset `active` to 0 and exit any sub-list.
- Active row calls `el?.scrollIntoView({ block: "nearest" })` via its ref callback; rows use `onMouseDown={(e) => e.preventDefault()}` so clicks don't steal focus from the input (AppInput clear-button precedent).

- [ ] **Step 1: Write the failing component test**

`apps/desktop/src/renderer/search/SearchPalette.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../state/navigation", () => ({
  jumpToLayer: vi.fn(() => true),
  jumpToTimeUs: vi.fn(),
  revealInMediaPool: vi.fn(() => true),
}));

import "../i18n"; // side-effect: init global i18next (en-US fallback)
import { jumpToLayer, revealInMediaPool } from "../state/navigation";
import { registerCommandProvider } from "../commands/registry";
import { useSearchIndexStore } from "./searchIndexStore";
import { buildEntries } from "./buildEntries";
import { SearchPalette } from "./SearchPalette";

// fixtureSummary(): copy the Task 6 fixture (media m1 "beach.mp4" used
// by clip l1 on track t1 "A-Roll"; caption layer lc "字幕第一行" at 1 s;
// marker mk1 "章节一" at 5 s).

const runSpy = vi.fn();
let unregister: (() => void) | undefined;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  unregister?.();
  unregister = registerCommandProvider(() => [
    { id: "save", labelKey: "actions.save", actionId: "save", run: runSpy },
  ]);
  useSearchIndexStore.setState({
    entries: buildEntries(fixtureSummary(), [
      { id: "save", label: "Save", enLabel: "Save", actionId: "save" },
    ]),
    version: 1,
  });
});

describe("SearchPalette", () => {
  it("runs a command on Enter and closes", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("save");
    await userEvent.keyboard("{Enter}");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("jumps to a caption matched via pinyin initials", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("zmdyh");
    expect(await screen.findByText(/字幕第一行/)).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(jumpToLayer).toHaveBeenCalledWith("lc");
    expect(onClose).toHaveBeenCalled();
  });

  it("expands a media row into reveal + usage sub-actions", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("beach");
    await userEvent.keyboard("{Enter}"); // media row (top-ranked) → sub-list
    expect(await screen.findByText(/Reveal in media pool/i)).toBeTruthy();
    await userEvent.keyboard("{ArrowDown}{Enter}"); // first usage row
    expect(jumpToLayer).toHaveBeenCalledWith("l1");
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter on the reveal row calls revealInMediaPool", async () => {
    const onClose = vi.fn();
    render(<SearchPalette onClose={onClose} />);
    await userEvent.keyboard("beach");
    await userEvent.keyboard("{Enter}{Enter}");
    expect(revealInMediaPool).toHaveBeenCalledWith("m1");
  });
});
```

Typing goes to the palette input because it autofocuses on mount. If `media` outranks nothing and the first `{Enter}` in the media tests hits a different row, assert the active row first or type a more specific query — the media row must be top-ranked for "beach" (nothing else matches).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/search/SearchPalette.test.tsx`
Expected: FAIL — cannot resolve `./SearchPalette`.

- [ ] **Step 3: Implement `SearchPalette.tsx`**

Full component (the behavior contract above is the requirements checklist; this code implements all of it):

```tsx
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AppInput } from "../components/AppInput";
import { getCommand } from "../commands/registry";
import { formatTimecode } from "../frames";
import { logEmit } from "../ipc";
import { useEffectiveBindings } from "../shortcuts";
import { jumpToLayer, jumpToTimeUs, revealInMediaPool } from "../state/navigation";
import { useProjectStore } from "../state/projectStore";
import { GROUP_ORDER, rankEntries, type RankedResult } from "./matcher";
import { useSearchEntries } from "./searchIndexStore";
import type { MediaUsage, SearchEntryType } from "./types";

const VISIBLE_PER_GROUP = 5;
const RANK_CAP = 50;

interface MediaSubList {
  label: string;
  mediaId: string;
  usages: MediaUsage[];
}

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const entries = useSearchEntries();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [sub, setSubState] = useState<MediaSubList | null>(null);
  const [expanded, setExpanded] = useState<Set<SearchEntryType>>(new Set());
  const subRef = useRef<MediaSubList | null>(null);
  const setSub = (v: MediaSubList | null) => { subRef.current = v; setSubState(v); };
  const fpsNum = useProjectStore((s) => s.summary?.composition.fps_num ?? 30);
  const fpsDen = useProjectStore((s) => s.summary?.composition.fps_den ?? 1);

  const grouped = useMemo(() => rankEntries(query, entries, RANK_CAP), [query, entries]);
  // Visible rows after per-group slicing; `flat` drives keyboard order.
  const { flat, truncatedCounts } = useMemo(() => {
    const flat: RankedResult[] = [];
    const truncatedCounts = new Map<SearchEntryType, number>();
    for (const g of GROUP_ORDER) {
      const rows = grouped.get(g) ?? [];
      const visible = expanded.has(g) ? rows : rows.slice(0, VISIBLE_PER_GROUP);
      flat.push(...visible);
      if (rows.length > visible.length) truncatedCounts.set(g, rows.length - visible.length);
    }
    return { flat, truncatedCounts };
  }, [grouped, expanded]);

  type SubAction =
    | { kind: "reveal"; mediaId: string }
    | { kind: "usage"; usage: MediaUsage };
  const subActions: SubAction[] = useMemo(() => {
    if (!sub) return [];
    return [
      { kind: "reveal" as const, mediaId: sub.mediaId },
      ...sub.usages.map((usage) => ({ kind: "usage" as const, usage })),
    ];
  }, [sub]);

  const count = sub ? subActions.length : flat.length;
  const clampedActive = Math.min(active, Math.max(0, count - 1));

  const logStaleTarget = () =>
    void logEmit({
      level: "info",
      category: { kind: "System" },
      source: { kind: "User" },
      message: "search: target no longer exists",
    });

  const activate = (idx: number) => {
    if (sub) {
      const a = subActions[idx];
      if (!a) return;
      if (a.kind === "reveal") {
        if (!revealInMediaPool(a.mediaId)) logStaleTarget();
      } else if (!jumpToLayer(a.usage.layerId)) {
        logStaleTarget();
      }
      onClose();
      return;
    }
    const r = flat[idx];
    if (!r) return;
    const p = r.entry.payload;
    switch (p.type) {
      case "command": {
        const cmd = getCommand(p.commandId);
        if (!cmd || cmd.enabled?.() === false) return;
        onClose(); // close first — the command may open its own dialog
        void cmd.run();
        return;
      }
      case "media":
        if (p.usages.length === 0) {
          // Unused media: skip the one-row sub-list, reveal directly.
          if (!revealInMediaPool(p.mediaId)) logStaleTarget();
          onClose();
          return;
        }
        setSub({ label: r.entry.label, mediaId: p.mediaId, usages: p.usages });
        setActive(0);
        return;
      case "track":
        if (p.firstLayerId && !jumpToLayer(p.firstLayerId)) logStaleTarget();
        onClose();
        return;
      case "clip":
      case "caption":
        if (!jumpToLayer(p.layerId)) logStaleTarget();
        onClose();
        return;
      case "marker":
        jumpToTimeUs(p.tUs);
        onClose();
        return;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((v) => Math.min(v + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((v) => Math.max(v - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(clampedActive);
    }
    // Escape is NOT handled here — the Dialog's onOpenChange intercept
    // below unwinds one level at a time (sub-list → results → closed)
    // and catches backdrop clicks through the same path.
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        if (subRef.current) {
          setSub(null);
          setActive(0);
          return;
        }
        onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/50 supports-backdrop-filter:backdrop-blur-none" />
        <DialogPrimitive.Popup className="search-palette" aria-label={t("actions.open_search")}>
          <div className="search-palette-input">
            <AppInput
              type="search"
              clearable
              autoFocus
              placeholder={t("search.placeholder")}
              ariaLabel={t("search.placeholder")}
              clearAriaLabel={t("media_pool.clear_search")}
              value={query}
              onValueChange={(v) => {
                setQuery(v);
                setActive(0);
                setSub(null);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="search-palette-list" role="listbox">
            {sub ? (
              <>
                <div className="search-group-header">{sub.label}</div>
                {subActions.map((a, i) => (
                  <SubActionRow
                    key={a.kind === "reveal" ? "reveal" : a.usage.layerId}
                    action={a}
                    fpsNum={fpsNum}
                    fpsDen={fpsDen}
                    active={i === clampedActive}
                    onHover={() => setActive(i)}
                    onActivate={() => activate(i)}
                  />
                ))}
              </>
            ) : flat.length === 0 ? (
              <div className="search-empty">{t("search.no_results", { query })}</div>
            ) : (
              GROUP_ORDER.filter((g) => grouped.has(g)).map((g) => (
                <div key={g}>
                  <div className="search-group-header">{t(`search.group_${g}`)}</div>
                  {(expanded.has(g)
                    ? grouped.get(g)!
                    : grouped.get(g)!.slice(0, VISIBLE_PER_GROUP)
                  ).map((r) => {
                    const idx = flat.indexOf(r);
                    return (
                      <ResultRow
                        key={r.entry.key}
                        r={r}
                        active={idx === clampedActive}
                        onHover={() => setActive(idx)}
                        onActivate={() => activate(idx)}
                      />
                    );
                  })}
                  {truncatedCounts.has(g) && (
                    <div
                      className="search-show-more"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setExpanded((prev) => new Set(prev).add(g))}
                    >
                      {t("search.show_more", { count: truncatedCounts.get(g) })}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}

function HighlightedLabel({ label, indexes }: { label: string; indexes: number[] }) {
  if (indexes.length === 0) return <>{label}</>;
  const set = new Set(indexes);
  return (
    <>
      {Array.from(label).map((ch, i) =>
        set.has(i) ? <mark key={i}>{ch}</mark> : <span key={i}>{ch}</span>,
      )}
    </>
  );
}

function ResultRow({
  r,
  active,
  onHover,
  onActivate,
}: {
  r: RankedResult;
  active: boolean;
  onHover: () => void;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const p = r.entry.payload;
  const binding = useEffectiveBindings(p.type === "command" ? p.actionId : undefined);
  const disabled =
    p.type === "command" && getCommand(p.commandId)?.enabled?.() === false;
  const unused = p.type === "media" && p.usages.length === 0;
  return (
    <div
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      className={cn("search-row", active && "is-active", disabled && "is-disabled")}
      // Keep focus in the input (AppInput clear-button precedent).
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onActivate}
      ref={(el) => {
        if (active) el?.scrollIntoView({ block: "nearest" });
      }}
    >
      <span className="search-row-label">
        <HighlightedLabel label={r.entry.label} indexes={r.highlight} />
      </span>
      {p.type === "media" && !p.available && (
        <span className="search-row-badge">{t("search.missing_badge")}</span>
      )}
      <span className="search-row-context">
        {unused ? t("search.unused") : r.entry.context}
      </span>
      {binding && <kbd className="search-row-kbd">{binding}</kbd>}
    </div>
  );
}

function SubActionRow({
  action,
  fpsNum,
  fpsDen,
  active,
  onHover,
  onActivate,
}: {
  action: { kind: "reveal"; mediaId: string } | { kind: "usage"; usage: MediaUsage };
  fpsNum: number;
  fpsDen: number;
  active: boolean;
  onHover: () => void;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const label =
    action.kind === "reveal"
      ? t("search.reveal_in_pool")
      : `${action.usage.trackLabel} · ${formatTimecode(action.usage.tStartUs, fpsNum, fpsDen)}`;
  return (
    <div
      role="option"
      aria-selected={active}
      className={cn("search-row", active && "is-active")}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onActivate}
      ref={(el) => {
        if (active) el?.scrollIntoView({ block: "nearest" });
      }}
    >
      <span className="search-row-label">{label}</span>
    </div>
  );
}
```

And the `search.css` stylesheet:

```css
/* Global search palette (Mod+K). The Base UI Popup carries positioning
   only; rows/groups own the look. Top-anchored, unlike the centered
   AppDialog skins. */
.search-palette {
  position: fixed;
  top: 12vh;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  width: min(560px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  background: #1e1f24;
  border: 1px solid #33353c;
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  outline: none;
}
.search-palette-input { padding: 10px; border-bottom: 1px solid #33353c; }
.search-palette-input .app-input-wrap, .search-palette-input .app-input { width: 100%; }
.search-palette-list { max-height: 48vh; overflow-y: auto; padding: 6px 0; }
.search-group-header {
  padding: 6px 12px 2px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.55;
}
.search-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; }
.search-row.is-active { background: rgba(255, 255, 255, 0.08); }
.search-row.is-disabled { opacity: 0.4; cursor: default; }
.search-row-label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-row-label mark { background: none; color: #6ea8ff; font-weight: 600; }
.search-row-context {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 11px; opacity: 0.55; text-align: right;
}
.search-row-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  background: rgba(255, 99, 99, 0.2); color: #ff9b9b;
}
.search-row-kbd { font-size: 10px; opacity: 0.6; border: 1px solid #33353c; border-radius: 4px; padding: 1px 5px; }
.search-show-more { padding: 4px 12px; font-size: 11px; opacity: 0.6; cursor: pointer; }
.search-show-more:hover { opacity: 1; }
.search-empty { padding: 18px 12px; text-align: center; opacity: 0.55; }
```

Register the stylesheet: add `@import "./styles/search.css";` to `apps/desktop/src/renderer/styles.css` (alphabetical-ish with the others).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/search/SearchPalette.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Mount in App.tsx + menu entry**

**App.tsx:**
1. `const [paletteOpen, setPaletteOpen] = useState(false);`
2. In `shortcutHandlers`: `openSearchPalette: () => setPaletteOpen(true),`
3. In the overlay block (next to `{logConsoleOpen && …}`):
   ```tsx
   {paletteOpen && <SearchPalette onClose={() => setPaletteOpen(false)} />}
   ```
4. Pass `onOpenSearch={() => setPaletteOpen(true)}` to `<AppMenuBar …>`.

**AppMenuBar.tsx:** add `onOpenSearch: () => void;` to props and a Tools-menu item above the Settings separator:

```tsx
<MenuItem
  actionId="openSearchPalette"
  label={t("actions.open_search")}
  onSelect={onOpenSearch}
/>
```

- [ ] **Step 6: Typecheck + full unit suite + live smoke**

Run: `npm run typecheck` → clean.
Run: `npm test` → full suite PASS.
Live check (see the `/verify` skill or memory `reference_dev_app_cdp_driving` for driving the dev app): launch `npm run dev`, press `Ctrl+K` — palette opens, typing filters, `Esc` closes, a command row shows its shortcut hint.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src/renderer/search/SearchPalette.tsx apps/desktop/src/renderer/search/SearchPalette.test.tsx apps/desktop/src/renderer/styles/search.css apps/desktop/src/renderer/styles.css apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/app/AppMenuBar.tsx
git commit -m "feat(search): SearchPalette overlay — grouped fuzzy results, media sub-actions, keyboard nav"
```

---

### Task 10: E2E — palette drives playhead + commands

**Files:**
- Modify: `apps/desktop/src/renderer/testhook/e2eHook.ts` (add `getPlayheadUs` hook)
- Create: `apps/desktop/e2e/electron/search-palette.spec.ts`

**Interfaces:**
- Consumes: `launchApp`/`newProject`/`invokeCmd` from `e2e/electron/helpers/driver.ts`; backend command `add_text_layer { trackId?, content?, tStartUs, durationUs? }` (see `ipc/index.ts:481`).
- Produces: `window.__weftcutTest.getPlayheadUs(): number` (E2E builds only).

- [ ] **Step 1: Add the playhead hook**

In `apps/desktop/src/renderer/testhook/e2eHook.ts`, wherever the existing `window.__weftcutTest` fields are assigned (follow the `installExportHook` pattern), add:

```ts
getPlayheadUs: () => playheadTimeUs(),
```

with `import { playheadTimeUs } from "../state/playheadStore";`. Keep it inside the same install path so it only exists on `VITE_WEFTCUT_E2E=1` builds.

- [ ] **Step 2: Write the spec**

`apps/desktop/e2e/electron/search-palette.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp, newProject, invokeCmd, waitForHook } from './helpers/driver'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

test('palette jumps the playhead to a caption found by content', async () => {
  const { app, page } = await launchApp()
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-palette-'))
    await newProject(page, { parentFolder: parent, name: 'palette', canvas: CANVAS })
    await invokeCmd(page, 'add_text_layer', {
      tStartUs: 2_000_000,
      durationUs: 1_000_000,
      content: 'FindMe subtitle line',
    })

    await page.keyboard.press(`${MOD}+K`)
    const input = page.locator('.search-palette input')
    await expect(input).toBeVisible()
    await input.fill('FindMe')
    // Index rebuild is debounced ~300 ms after the mutation; the row
    // appearing IS the rebuild signal.
    await expect(
      page.locator('.search-row', { hasText: 'FindMe subtitle line' }),
    ).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Enter')

    await waitForHook(page, 'getPlayheadUs')
    await expect
      .poll(() => page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs()))
      .toBe(2_000_000)
    await expect(page.locator('.search-palette')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('palette executes a command (toggle media pool drawer)', async () => {
  const { app, page } = await launchApp()
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-palette-'))
    await newProject(page, { parentFolder: parent, name: 'palette-cmd', canvas: CANVAS })

    const drawerOpen = () =>
      page.evaluate(() => document.querySelector('.app-main')!.classList.contains('drawer-open'))
    const before = await drawerOpen()

    await page.keyboard.press(`${MOD}+K`)
    await page.locator('.search-palette input').fill('media pool')
    await expect(page.locator('.search-row.is-active')).toBeVisible()
    await page.keyboard.press('Enter')

    await expect.poll(drawerOpen).toBe(!before)
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 3: Build with the E2E hook + run the spec**

```bash
cd apps/desktop && VITE_WEFTCUT_E2E=1 npm run build && npx playwright test -c playwright.config.ts search-palette
```

(PowerShell: `$env:VITE_WEFTCUT_E2E="1"; npm run build; npx playwright test -c playwright.config.ts search-palette`.)
Expected: 2 passed. If the `add_text_layer` args are rejected, check the exact backend arg names against `ipc/index.ts:481` (`trackId`/`content`/`tStartUs`/`durationUs`).

- [ ] **Step 4: Full gates**

Run: `npm run typecheck && npm test`
Expected: clean + full unit suite PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/src/renderer/testhook/e2eHook.ts apps/desktop/e2e/electron/search-palette.spec.ts
git commit -m "test(e2e): search palette — caption jump moves playhead, command execution"
```

---

## Post-plan follow-ups (explicitly out of scope)

- Consolidate the spec + this plan into evergreen docs (`docs/`) once shipped, per `feedback_evergreen_docs` — likely a short `docs/search.md` + deleting these two files.
- Driving menus from the command registry (kills the ACTION_DEFS/menu double-entry) — noted in the spec as a follow-up benefit.
- Formatting the `<kbd>` hint (raw chord string like `Mod+K` v1; platform-pretty `⌘K`/`Ctrl+K` later, reusing whatever `MenuItem` does).
