# Audio Tracks × A/B-Roll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: SHIPPED — all 6 tasks implemented and merged to main.** The
checkboxes below were never back-ticked during execution; the work landed in
commits `fc2eaa63` (Task 1), `502a441f` (Task 2), `dc56806e` (Task 3),
`5ce38614` (Task 4), `4f3a8238` (Task 5), `022672a0` (Task 6). Verified against
the live tree 2026-06-14. Kept as the execution record.

**Goal:** Make Mute/Solo unambiguous on the kind-agnostic timeline by rendering header controls conditionally on each track's content, and let audio integrate with A/B-roll through an enhanced (filter + sections) peek list rather than new persistent track rows.

**Architecture:** Frontend-only. Two pure, unit-tested classifiers drive the UI: `trackHeaderControls(track)` decides which of eye/M/S a track header shows (reusing the existing `layerOverlapClass`), and `peekCategory(layer)` + `groupPeekItems(items, filter)` drive the peek list's category filter and sections. The Rust mixer (`mix.rs`) and the `TrackSummary`/`LayerSummary` IPC contract are unchanged — `TrackSummary.layers` already carries everything the classifiers need.

**Tech Stack:** TypeScript + React, Vitest (pure-logic unit tests; the project has no React Testing Library — component wiring is verified by `tsc -b` + manual real-app smoke), Tailwind v4 + a legacy `styles.css` for the right panel, i18next with TS locale modules (en-US + zh-CN).

---

## Spec

`docs/superpowers/specs/2026-06-13-audio-track-abroll-integration-design.md`

## File Structure

- `apps/desktop/src/timeline/geometry.ts` — **modify.** Add `trackHeaderControls()` next to the existing `layerOverlapClass`/`computeLayerSlices` classifiers.
- `apps/desktop/src/timeline/geometry.test.ts` — **modify.** Add `trackHeaderControls` unit tests (file already has `track()`/`layer()` fixtures).
- `apps/desktop/src/timeline/TrackHeader.tsx` — **modify.** Consume `trackHeaderControls`; render eye/M/S conditionally; show a music glyph on pure-audio lanes.
- `apps/desktop/src/panels/peek.ts` — **create.** Move `PeekItem` + `buildPeekItems` out of `RightPanel.tsx` (export them) and add `peekCategory` + `groupPeekItems`. All pure.
- `apps/desktop/src/panels/peek.test.ts` — **create.** Unit tests for `peekCategory` + `groupPeekItems`.
- `apps/desktop/src/panels/RightPanel.tsx` — **modify.** Import from `./peek`; add the filter-chip row + per-category sections.
- `apps/desktop/src/styles.css` — **modify.** Add `.peek-filter*` / `.peek-section-header` styles next to the existing `.right-panel-peek*` block.
- `apps/desktop/src/i18n/locales/en-US.ts` and `zh-CN.ts` — **modify.** Add `peek.filter_*` / `peek.cat_*` strings.

All commands below run from `apps/desktop/`.

---

### Task 1: `trackHeaderControls` classifier (pure, TDD)

**Files:**
- Modify: `apps/desktop/src/timeline/geometry.ts` (add after the `layerOverlapClass` function, ~line 47)
- Test: `apps/desktop/src/timeline/geometry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/timeline/geometry.test.ts`. The file already defines `layer(partial)` and `track(partial)` helpers and imports the types; add `trackHeaderControls` to the existing import from `./geometry`, then append:

```ts
describe("trackHeaderControls", () => {
  const audio = () =>
    layer({ id: "a", kind: "Audio", params: { kind: "Audio" } as LayerSummary["params"] });
  const video = () =>
    layer({ id: "v", kind: "VideoClip", params: { kind: "VideoClip" } as LayerSummary["params"] });

  it("pure visual track: eye only, no M/S", () => {
    expect(trackHeaderControls(track({ layers: [video()] }))).toEqual({
      showEye: true,
      showMute: false,
      showSolo: false,
    });
  });

  it("combined row (visual + audio): eye + M + S", () => {
    expect(trackHeaderControls(track({ layers: [video(), audio()] }))).toEqual({
      showEye: true,
      showMute: true,
      showSolo: true,
    });
  });

  it("pure audio lane: M + S, no eye", () => {
    expect(trackHeaderControls(track({ layers: [audio()] }))).toEqual({
      showEye: false,
      showMute: true,
      showSolo: true,
    });
  });

  it("empty track: eye only", () => {
    expect(trackHeaderControls(track({ layers: [] }))).toEqual({
      showEye: true,
      showMute: false,
      showSolo: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/timeline/geometry.test.ts`
Expected: FAIL — `trackHeaderControls is not a function` / no matching export.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/timeline/geometry.ts`, immediately after the `layerOverlapClass` function, add:

```ts
/// Which header controls a track shows, derived from its content. Mute
/// and Solo are audio-only semantics (`mix.rs` gates only Audio layers),
/// so they appear only on tracks that carry audio — this is what removes
/// the "what do M/S act on" ambiguity from combined rows. A pure-audio
/// lane hides the eye: `muted` is its single audio on/off and the
/// whole-track `enabled` toggle would be redundant. Visual-only and
/// empty tracks keep the eye. (Lock is unconditional and not modeled
/// here.) See the audio-track × A/B-roll spec.
export interface TrackHeaderControls {
  showEye: boolean;
  showMute: boolean;
  showSolo: boolean;
}

export function trackHeaderControls(track: TrackSummary): TrackHeaderControls {
  const hasAudio = track.layers.some((l) => layerOverlapClass(l) === "audio");
  const hasVisual = track.layers.some((l) => layerOverlapClass(l) === "visual");
  return {
    showEye: hasVisual || !hasAudio,
    showMute: hasAudio,
    showSolo: hasAudio,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/timeline/geometry.test.ts`
Expected: PASS (all `trackHeaderControls` cases green, existing geometry tests still green).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeline/geometry.ts apps/desktop/src/timeline/geometry.test.ts
git commit -m "feat(timeline): trackHeaderControls — derive eye/M/S visibility from track content"
```

---

### Task 2: Wire conditional controls + audio glyph into `TrackHeader`

**Files:**
- Modify: `apps/desktop/src/timeline/TrackHeader.tsx`

No RTL in this project, so this task is verified by `tsc -b` plus the Task 1 unit tests (the logic) and the manual smoke in Task 6 (the rendering).

- [ ] **Step 1: Replace the imports and the control block**

Replace the top imports of `apps/desktop/src/timeline/TrackHeader.tsx`:

```ts
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import { updateTrackFlags, type TrackSummary } from "../ipc";
```

with (add `Music`, add the classifier import):

```ts
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Lock, LockOpen, Music } from "lucide-react";
import { updateTrackFlags, type TrackSummary } from "../ipc";
import { trackHeaderControls } from "./geometry";
```

- [ ] **Step 2: Compute controls and render conditionally**

Inside the `TrackHeader` component, after the `toggle` helper is defined and before the `return`, add:

```ts
  const controls = trackHeaderControls(track);
  // Pure-audio lane = has audio, no visual (eye hidden). Show a music
  // glyph so the lane reads as audio at a glance.
  const isAudioLane = controls.showMute && !controls.showEye;
```

Then change the label `<span>` to prefix the glyph, and wrap the eye/M/S `FlagButton`s in their flags. The lock button stays unconditional. The new JSX body (replacing the current `<span ...label...>` + the four `<FlagButton>`s) is:

```tsx
      {isAudioLane && (
        <Music size={11} aria-hidden className="shrink-0 text-muted-foreground/70" />
      )}
      <span
        className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-muted-foreground"
        title={track.label ?? kindLabel}
      >
        {track.label ?? kindLabel}
        {isRevealed && <span className="font-medium text-blue-400/70"> (revealed)</span>}
      </span>
      {controls.showEye && (
        <FlagButton
          active={!track.enabled}
          activeClass="bg-secondary text-foreground"
          label={t("timeline.track_eye_hint", { defaultValue: "Hide this track's output (affects export)" })}
          onToggle={toggle({ enabled: !track.enabled })}
        >
          {track.enabled ? <Eye size={11} aria-hidden /> : <EyeOff size={11} aria-hidden />}
        </FlagButton>
      )}
      {controls.showMute && (
        <FlagButton
          active={track.muted}
          activeClass="bg-red-500/20 text-red-300"
          label={t("timeline.track_mute_hint", { defaultValue: "Mute this track's audio (affects export)" })}
          onToggle={toggle({ muted: !track.muted })}
        >
          M
        </FlagButton>
      )}
      {controls.showSolo && (
        <FlagButton
          active={track.solo}
          activeClass="bg-amber-500/25 text-amber-300"
          label={t("timeline.track_solo_hint", { defaultValue: "Solo this track's audio (affects export)" })}
          onToggle={toggle({ solo: !track.solo })}
        >
          S
        </FlagButton>
      )}
      <FlagButton
        active={track.locked}
        activeClass="bg-secondary text-foreground"
        label={t("timeline.track_lock_hint", { defaultValue: "Lock this track against edits" })}
        onToggle={toggle({ locked: !track.locked })}
      >
        {track.locked ? <Lock size={11} aria-hidden /> : <LockOpen size={11} aria-hidden />}
      </FlagButton>
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). If `Music` is reported as an unused/missing icon, confirm the import line from Step 1 was applied.

- [ ] **Step 4: Run the unit suite (no regressions)**

Run: `npx vitest run`
Expected: PASS (Task 1 tests + all existing tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeline/TrackHeader.tsx
git commit -m "feat(timeline): conditional eye/M/S header controls + audio-lane glyph"
```

---

### Task 3: Extract + extend peek logic in `panels/peek.ts` (pure, TDD)

**Files:**
- Create: `apps/desktop/src/panels/peek.ts`
- Create: `apps/desktop/src/panels/peek.test.ts`
- Modify: `apps/desktop/src/panels/RightPanel.tsx` (remove the moved `PeekItem` + `buildPeekItems`, import them instead)

- [ ] **Step 1: Create `peek.ts` (move existing logic verbatim + add the new functions)**

Create `apps/desktop/src/panels/peek.ts`:

```ts
// Pure peek-list logic: which hidden-track layers sit near the playhead
// (`buildPeekItems`), what category a layer falls into (`peekCategory`),
// and how the items group under the AB-mode filter (`groupPeekItems`).
// Kept out of RightPanel.tsx so it is unit-testable without a DOM.

import type { LayerSummary, TrackSummary } from "../ipc";

/// One row in the peek list. Carries enough state to render the row +
/// drive selection / reveal on click.
export interface PeekItem {
  layer: LayerSummary;
  trackId: string;
  trackLabel: string;
  trackKind: string;
  /// Microseconds from playhead to the *layer's nearest edge* —
  /// negative when the layer ended in the past, positive when it
  /// starts in the future, zero when it spans the playhead.
  offsetUs: number;
  /// True when `playhead ∈ [t_start, t_end]` — gets the LIVE badge.
  spansPlayhead: boolean;
}

export function buildPeekItems(
  tracks: TrackSummary[],
  currentTimeUs: number,
  deltaUs: number,
): PeekItem[] {
  const lo = currentTimeUs - deltaUs;
  const hi = currentTimeUs + deltaUs;
  const items: PeekItem[] = [];
  for (const t of tracks) {
    if (t.role !== null) continue;
    for (const layer of t.layers) {
      // Window intersection: layer.t_end > lo AND layer.t_start < hi.
      if (layer.t_end_us <= lo || layer.t_start_us >= hi) continue;
      const spans =
        layer.t_start_us <= currentTimeUs && layer.t_end_us >= currentTimeUs;
      const offset = spans
        ? 0
        : layer.t_start_us > currentTimeUs
          ? layer.t_start_us - currentTimeUs
          : layer.t_end_us - currentTimeUs;
      items.push({
        layer,
        trackId: t.id,
        trackLabel: t.label ?? t.kind,
        trackKind: t.kind,
        offsetUs: offset,
        spansPlayhead: spans,
      });
    }
  }
  // Order: spanning items first (LIVE bubble), then chronologically by
  // t_start. Equal t_start ties break by track label (stable enough).
  items.sort((a, b) => {
    if (a.spansPlayhead !== b.spansPlayhead) {
      return a.spansPlayhead ? -1 : 1;
    }
    if (a.layer.t_start_us !== b.layer.t_start_us) {
      return a.layer.t_start_us - b.layer.t_start_us;
    }
    return a.trackLabel.localeCompare(b.trackLabel);
  });
  return items;
}

/// Peek filter / section buckets. Coarser than `layerOverlapClass`
/// (which is visual-vs-audio) because the user wants Text/Subtitles
/// split out from picture for fast scanning.
export type PeekCategory = "video" | "audio" | "text";

/// Render + filter order of the category sections.
export const PEEK_CATEGORY_ORDER: PeekCategory[] = ["video", "audio", "text"];

export function peekCategory(layerKind: string): PeekCategory {
  if (layerKind === "Audio") return "audio";
  if (layerKind === "Text" || layerKind === "Subtitles") return "text";
  // VideoClip | ImageOverlay | Color | Motif
  return "video";
}

export interface PeekSection {
  category: PeekCategory;
  items: PeekItem[];
}

/// Group already-sorted peek items into category sections, honoring the
/// active filter. `filter === "all"` returns every non-empty section in
/// `PEEK_CATEGORY_ORDER`; a specific filter returns just that one
/// section (empty array if it has no items). Item order within a
/// section is preserved from `buildPeekItems`.
export function groupPeekItems(
  items: PeekItem[],
  filter: "all" | PeekCategory,
): PeekSection[] {
  const sections: PeekSection[] = [];
  for (const category of PEEK_CATEGORY_ORDER) {
    if (filter !== "all" && filter !== category) continue;
    const catItems = items.filter(
      (it) => peekCategory(it.layer.params.kind) === category,
    );
    if (catItems.length > 0) sections.push({ category, items: catItems });
  }
  return sections;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/panels/peek.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupPeekItems, peekCategory, type PeekItem } from "./peek";
import type { LayerSummary } from "../ipc";

function item(id: string, kind: string): PeekItem {
  return {
    layer: {
      id,
      kind,
      label: null,
      t_start_us: 0,
      t_end_us: 1_000_000,
      enabled: true,
      locked: false,
      color_hint: "#888",
      params: { kind } as LayerSummary["params"],
    },
    trackId: `track-${id}`,
    trackLabel: id,
    trackKind: kind,
    offsetUs: 0,
    spansPlayhead: true,
  };
}

describe("peekCategory", () => {
  it("maps Audio to audio", () => expect(peekCategory("Audio")).toBe("audio"));
  it("maps Text + Subtitles to text", () => {
    expect(peekCategory("Text")).toBe("text");
    expect(peekCategory("Subtitles")).toBe("text");
  });
  it("maps every visual kind to video", () => {
    for (const k of ["VideoClip", "ImageOverlay", "Color", "Motif"]) {
      expect(peekCategory(k)).toBe("video");
    }
  });
});

describe("groupPeekItems", () => {
  const items = [item("v", "VideoClip"), item("a", "Audio"), item("s", "Subtitles")];

  it("filter=all returns sections in video/audio/text order", () => {
    const sections = groupPeekItems(items, "all");
    expect(sections.map((s) => s.category)).toEqual(["video", "audio", "text"]);
    expect(sections.map((s) => s.items.length)).toEqual([1, 1, 1]);
  });

  it("a specific filter returns only that section", () => {
    const sections = groupPeekItems(items, "audio");
    expect(sections).toHaveLength(1);
    expect(sections[0].category).toBe("audio");
    expect(sections[0].items[0].layer.id).toBe("a");
  });

  it("filter with no matching items returns no sections", () => {
    expect(groupPeekItems([item("a", "Audio")], "video")).toEqual([]);
  });

  it("preserves input order within a section", () => {
    const two = [item("a1", "Audio"), item("a2", "Audio")];
    const [section] = groupPeekItems(two, "audio");
    expect(section.items.map((i) => i.layer.id)).toEqual(["a1", "a2"]);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run src/panels/peek.test.ts`
Expected: PASS. (The implementation from Step 1 already satisfies it — this task moves working code and adds two pure functions, so the test confirms the new functions and guards the move.)

- [ ] **Step 4: Remove the moved code from `RightPanel.tsx` and import it**

In `apps/desktop/src/panels/RightPanel.tsx`:
1. Delete the local `interface PeekItem { ... }` block.
2. Delete the local `function buildPeekItems(...) { ... }` block.
3. Add to the imports near the top (after the existing `../ipc` import):

```ts
import { buildPeekItems, type PeekItem } from "./peek";
```

`PeekItem` is still referenced by the `PeekRow` component's props, and `buildPeekItems` by the `useMemo` — both now resolve to `./peek`.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. (RightPanel compiles against the imported `PeekItem`/`buildPeekItems`; no behavior change yet.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/panels/peek.ts apps/desktop/src/panels/peek.test.ts apps/desktop/src/panels/RightPanel.tsx
git commit -m "refactor(peek): extract peek logic to panels/peek.ts + add category/grouping"
```

---

### Task 4: i18n strings for the peek filter + sections

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add keys to en-US**

In `apps/desktop/src/i18n/locales/en-US.ts`, find the `peek: {` block (currently `heading`, `section_label`, `live`, `offset`) and add these keys inside it:

```ts
    filter_label: "Filter near-playhead items by kind",
    filter_all: "All",
    cat_video: "Video",
    cat_audio: "Audio",
    cat_text: "Text",
    filter_empty: "Nothing of that kind near the playhead",
```

- [ ] **Step 2: Add the same keys to zh-CN**

In `apps/desktop/src/i18n/locales/zh-CN.ts`, find the matching `peek: {` block and add:

```ts
    filter_label: "按类别筛选播放头附近的内容",
    filter_all: "全部",
    cat_video: "视频",
    cat_audio: "音频",
    cat_text: "字幕",
    filter_empty: "播放头附近没有该类别的内容",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If the locale modules are typed against a shared key union, both files must carry identical keys — this step adds them to both, so it stays balanced.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "i18n(peek): filter chip + category section strings (en-US, zh-CN)"
```

---

### Task 5: Filter chips + sections in `RightPanel`

**Files:**
- Modify: `apps/desktop/src/panels/RightPanel.tsx`
- Modify: `apps/desktop/src/styles.css`

Verified by `tsc -b` + the Task 3 unit tests + the Task 6 manual smoke (no RTL).

- [ ] **Step 1: Add imports + filter state**

In `apps/desktop/src/panels/RightPanel.tsx`:

Add `useState` to the React import and extend the `./peek` import:

```ts
import { useMemo, useState, type ReactNode } from "react";
```
```ts
import {
  buildPeekItems,
  groupPeekItems,
  PEEK_CATEGORY_ORDER,
  type PeekCategory,
  type PeekItem,
} from "./peek";
```

Inside the `RightPanel` component, after the existing `peekItems` `useMemo` and the `showPeek` line, add the filter state and the grouped sections:

```ts
  const [peekFilter, setPeekFilter] = useState<"all" | PeekCategory>("all");
  const peekSections = useMemo(
    () => groupPeekItems(peekItems, peekFilter),
    [peekItems, peekFilter],
  );
```

- [ ] **Step 2: Replace the peek `<ul>` with the chip row + sections**

In the `showPeek` block, the current markup renders one `<ul className="right-panel-peek-list">` mapping `peekItems`. Replace the chip-less header + flat list so the structure becomes: the existing `<header>` (unchanged), then a filter-chip row, then per-section lists. Replace from the `</header>` closing tag through the closing `</ul>` with:

```tsx
          </header>
          <div className="peek-filter" role="group" aria-label={t("peek.filter_label", { defaultValue: "Filter near-playhead items by kind" })}>
            {(["all", ...PEEK_CATEGORY_ORDER] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`peek-filter-chip ${peekFilter === f ? "is-active" : ""}`}
                aria-pressed={peekFilter === f}
                onClick={() => setPeekFilter(f)}
              >
                {f === "all"
                  ? t("peek.filter_all", { defaultValue: "All" })
                  : t(`peek.cat_${f}`, { defaultValue: f })}
              </button>
            ))}
          </div>
          {peekSections.length === 0 ? (
            <p className="peek-filter-empty">
              {t("peek.filter_empty", { defaultValue: "Nothing of that kind near the playhead" })}
            </p>
          ) : (
            peekSections.map((section) => (
              <div key={section.category}>
                <div className="peek-section-header">
                  {t(`peek.cat_${section.category}`, { defaultValue: section.category })}
                </div>
                <ul className="right-panel-peek-list">
                  {section.items.map((item) => (
                    <PeekRow
                      key={item.layer.id}
                      item={item}
                      isSelected={item.layer.id === selectedLayerId}
                      fpsNum={fpsNum}
                      fpsDen={fpsDen}
                      onClick={() => {
                        onSelect(item.layer.id);
                        if (onRevealTrack) {
                          onRevealTrack(item.trackId, item.layer.id);
                        }
                      }}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
```

(The `PeekRow` component, `formatOffset`, `mediaLabelFor`, and `iconForKind` below it are unchanged.)

- [ ] **Step 3: Add the chip + section styles**

In `apps/desktop/src/styles.css`, after the existing `.peek-times { ... }` rule (end of the peek block, ~line 1518), add:

```css
.peek-filter {
  display: flex;
  gap: 4px;
  padding: 2px 12px 6px;
  border-bottom: 1px solid var(--border-soft);
}

.peek-filter-chip {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--color-gray-500);
  cursor: pointer;
}

.peek-filter-chip:hover {
  color: var(--muted-foreground);
}

.peek-filter-chip.is-active {
  background: rgba(96, 165, 250, 0.18);
  color: var(--muted-foreground);
  border-color: transparent;
}

.peek-section-header {
  padding: 5px 12px 1px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-gray-500);
}

.peek-filter-empty {
  margin: 0;
  padding: 10px 12px;
  font-size: 11px;
  color: var(--color-gray-500);
}
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/panels/RightPanel.tsx apps/desktop/src/styles.css
git commit -m "feat(peek): AB-mode filter chips + per-category sections"
```

---

### Task 6: Verification — typecheck, unit suite, manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all vitest specs pass (including the new `trackHeaderControls` and `peek` tests).

- [ ] **Step 2: Manual smoke in the real app**

Run: `npm run tauri:dev` and verify (the project's established acceptance bar — there is no RTL coverage for rendering):

Header controls:
- [ ] A combined camera row (video + its audio) shows **eye + M + S + lock**.
- [ ] A visual-only track (e.g. a Text/Color-only or picture-only track) shows **eye + lock**, no M/S.
- [ ] A pure-audio lane (drop a music/VO clip on its own track, or use "Separate audio") shows a **music glyph + M + S + lock**, no eye.
- [ ] Toggling M on a combined row silences only that row's audio (picture still plays); toggling S solos audio across tracks (a Music lane ducks). No regression vs. before.

Peek (AB mode):
- [ ] Switch to A/B mode. With hidden-track content near the playhead, the peek shows the chip row **[All][Video][Audio][Text]**.
- [ ] "All" groups items under **Video / Audio / Text** headers, in that order.
- [ ] Clicking **Audio** shows only audio items; clicking a category with nothing near the playhead shows the empty hint.
- [ ] Clicking a peek **audio** item reveals its lane in the timeline (R.7), whose header exposes working **M/S**.

- [ ] **Step 3: Commit (only if smoke surfaced fixable nits you patched)**

```bash
git add -A
git commit -m "fix(timeline): address audio-track × A/B-roll smoke findings"
```

---

## Self-Review notes

- **Spec coverage:** control matrix → Tasks 1–2; Show-All audio lane distinction (music glyph; tint/waveform explicitly deferred) → Task 2; peek filter + sections → Tasks 3–5; AB audio M/S via inline-reveal (no new peek chrome) → reuses existing `onRevealTrack`, asserted in Task 6 smoke; i18n → Task 4; "no backend / schema / mix.rs change" → honored (no Rust touched).
- **Out of scope (per spec), not in this plan:** waveforms, audio-bottom sorting, eye→picture-only decoupling, filter persistence, inline peek mute, stored audio track type, audio auto-routing.
- **Type consistency:** `trackHeaderControls` returns `{showEye, showMute, showSolo}` used verbatim in Task 2; `PeekItem`/`buildPeekItems`/`peekCategory`/`groupPeekItems`/`PEEK_CATEGORY_ORDER`/`PeekCategory`/`PeekSection` defined in Task 3 and consumed with the same names/shapes in Task 5; i18n keys `peek.filter_all`/`peek.cat_{video,audio,text}`/`peek.filter_label`/`peek.filter_empty` added in Task 4 and referenced in Task 5.
```
