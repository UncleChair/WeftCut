# Subtitle → Text-Layer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the opaque libass/JASSUB-rendered `Subtitles` layer with a CapCut-style model where every imported subtitle cue becomes an independent, first-class Text layer on a dedicated caption-role track — collapsing preview and export onto one render path and fixing the silent export drop.

**Architecture:** A new Rust parser (the single chokepoint for file import, MCP `apply_subtitles`, and Whisper transcribe) turns SRT/VTT/ASS text into `Cue`s, then one atomic mutation builds a `role: Caption` track of `Text` layers. The existing PixiJS `Text` render path — which already runs in both preview and the export Worker — renders them. A bundled-font set (incl. CJK) is loaded into the export Worker via `FontFace` so burned-in captions don't tofu; user-chosen fonts are resolved best-effort from the OS (no determinism guarantee). The old JASSUB chain, the `Subtitles` layer variant, and `MediaKind::Subtitle` pooling are deleted.

**Tech Stack:** Rust (napi-rs, serde, schemars, tokio actor), TypeScript (PixiJS v8, React 19, Zustand, i18next, Vitest + testing-library), Electron main (Node `fs` / `ipcMain`), fonts (Noto Sans SC + Liberation Sans, `FontFace` API, OffscreenCanvas).

## Global Constraints

- **Determinism contract:** bundled fonts MUST load identically in preview and export Worker; they carry the cross-OS byte-identity guarantee (export SSIM gate, threshold 0.98). User-resolved OS fonts are explicitly OUTSIDE this contract — best-effort, may differ cross-machine.
- **Fallback rule (never tofu):** any font that fails to resolve falls back to the bundled default chain `"Liberation Sans, Noto Sans SC"`. A caption must never render as blank boxes.
- **Hard break:** no migration of old `.vproj` files containing `Subtitles` layers. Bump the project format version; old subtitle layers are unsupported.
- **Single chokepoint:** file import, MCP `apply_subtitles`, and transcribe all flow through ONE parser (`subtitles::parse`) and ONE mutation (`add_caption_track_from_cues`). No second parsing path.
- **Tier-3 ASS only:** map the V4+ Style table + the inline overrides `\an \pos \c/\1c \b \i \fs \fn \fad`. Drop karaoke `\k`, drawing `\p`, clip `\clip`, animated transform `\t`/`\move`, rotation `\frx/\fry/\frz`, blur — strip the tags, keep the text, set `ParsedSubtitles.simplified = true`.
- **v1 export = burn-in only.** No soft-subtitle / sidecar / mux. "Export text-only" is a deferred follow-up (out of scope here).
- **v1 scope exclusions:** word-level/karaoke highlight, automatic safe-area word-wrap, cue merge/split UI, in-panel drag-retime, per-project user-supplied font files. VTT = SRT-level (text + timing only; ignore regions/cue-settings).
- **Comment style:** evergreen + landmine only (`docs/comment-style.md`). No dates/commit-hashes/phase-numbers in `docs/` design docs (this plan file is exempt — plans are dated working docs).
- **Frame grid:** the actor snaps every layer `t_start_us`/`t_end_us` to the comp-frame grid on mutation; cue times need no pre-snapping.
- **Rust test command:** `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud,motifs`
- **TS test command:** `npm --workspace apps/desktop test` (runs `vitest run`, excludes `*.browser.test.ts`; `pretest` builds the eval wasm).
- **Typecheck:** `npm --workspace apps/desktop run typecheck` (`tsc -b`).

---

## File Structure

**New files:**
- `apps/desktop/native/src/subtitles/mod.rs` — parser module root: `Cue`, `CueStyle`, `ParsedSubtitles`, `SubFormat`, `parse(body, format)`.
- `apps/desktop/native/src/subtitles/srt.rs` — SRT → `Vec<Cue>`.
- `apps/desktop/native/src/subtitles/vtt.rs` — VTT → `Vec<Cue>` (text + timing).
- `apps/desktop/native/src/subtitles/ass.rs` — ASS Tier-3 → `Vec<Cue>` + simplified flag.
- `apps/desktop/native/src/subtitles/layout.rs` — `cue_to_text_params(cue, comp_w, comp_h)` → `TextParams` (default style, 9-grid → anchor+xy).
- `apps/desktop/src/renderer/render/fonts/registry.ts` — bundled-font URLs + `loadBundledFontBytes()` and `BUNDLED_FONT_FAMILIES`.
- `apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.ts` — `FontFace`-into-`self.fonts`/`document.fonts` loader (shared by worker + preview).
- `apps/desktop/src/renderer/panels/CaptionsPanel.tsx` — the captions list + batch-style panel.
- `apps/desktop/src/renderer/panels/CaptionsPanel.test.tsx` — component tests.
- `apps/desktop/assets/fonts/NotoSansSC-VF.ttf` — bundled CJK font (subset acceptable; see Task 1.1).
- `apps/desktop/assets/fonts/LiberationSans-Regular.woff2` — bundled Latin font (copy of the JASSUB-bundled face, now owned by us).
- `docs/adr/0026-captions-as-text-layers.md` — the decision record.

**Modified files:**
- `apps/desktop/native/src/state/track.rs` — add `TrackRole::Caption`.
- `apps/desktop/native/src/state/layer.rs` — DELETE `SubtitlesParams`/`SubtitlesSource`; remove `Subtitles` from `LayerParams`; widen the Text view builder.
- `apps/desktop/native/src/commands/media.rs` — branch `import_media` on subtitle extension.
- `apps/desktop/native/src/commands/mutations.rs` — DELETE `add_subtitles_layer`; add `add_caption_track_from_cues` + `import_subtitles` + `restyle_caption_track`.
- `apps/desktop/native/src/mcp/tools.rs` — reroute `apply_subtitles`; delete the dead `SubFormat`/`SubtitlesSource` usage.
- `apps/desktop/native/src/napi_backend.rs` — register `restyle_caption_track` dispatch.
- `apps/desktop/native/src/lib.rs` (or `main` module file) — add `mod subtitles;`.
- `apps/desktop/src/renderer/ipc/index.ts` — widen `TextView`/`ResolvedTextView` deps; remove `SubtitlesView` from the union; add `restyleCaptionTrack`.
- `apps/desktop/src/renderer/render/resolveView.ts` — widen `resolveTextView`.
- `apps/desktop/src/renderer/render/sprite/TextSprite.ts` — apply weight/italic/align/outline/shadow/anchor.
- `apps/desktop/src/renderer/render/Compositor.ts` — DELETE subtitle path; load bundled fonts in preview.
- `apps/desktop/src/renderer/render/worker/exportWorker.ts` — load fonts before `app.init()`.
- `apps/desktop/src/renderer/render/worker/runExport.ts` — thread font bytes into the request.
- `apps/desktop/src/renderer/render/worker/protocol.ts` — add `fonts` to `ExportRequest`.
- `apps/desktop/src/renderer/panels/RightPanel.tsx` — mount `<CaptionsPanel/>`.
- `apps/desktop/src/renderer/i18n/locales/en-US.ts` + `zh-CN.ts` — `captions.*` keys.
- `apps/desktop/src/main/index.ts` — `font:resolve` IPC handler.
- `apps/desktop/src/preload/index.ts` + `apps/desktop/src/shared/ipc.ts` — `api.font.resolve`.
- `apps/desktop/package.json` — remove `jassub`.

**Deleted files:**
- `apps/desktop/src/renderer/render/subtitles/Jassub.ts`
- `apps/desktop/src/renderer/render/sprite/SubtitlesSprite.ts`
- `apps/desktop/src/renderer/render/subtitles/assBody.ts` (+ its `assBody.test.ts`)

---

## Phase 1 — Font infrastructure (risk-first spike → real infra)

**Why first:** the entire "burn-in is free" premise rests on PixiJS `Text` rendering CJK in the export Worker. Today it tofus (no font-loading path in the OffscreenCanvas Worker). This phase proves and builds the bundled-font pipeline before any subtitle work depends on it.

### Task 1.1: Bundle fonts + a renderer-side font registry

**Files:**
- Create: `apps/desktop/assets/fonts/NotoSansSC-VF.ttf`, `apps/desktop/assets/fonts/LiberationSans-Regular.woff2`
- Create: `apps/desktop/src/renderer/render/fonts/registry.ts`
- Test: `apps/desktop/src/renderer/render/fonts/registry.test.ts`

**Interfaces:**
- Produces: `BUNDLED_FONT_FAMILIES: readonly string[]` (`["Liberation Sans", "Noto Sans SC"]`), `DEFAULT_CAPTION_FONT_FAMILY = "Liberation Sans, Noto Sans SC"`, `async loadBundledFontBytes(): Promise<Record<string, ArrayBuffer>>` (family → bytes).

- [ ] **Step 1: Add the font binaries.** Download Noto Sans SC Regular (`.otf`; a `pyftsubset` GB2312+Latin subset is acceptable to keep size down — document the subset command in a sibling `README.md`) into `apps/desktop/assets/fonts/`. Copy `node_modules/jassub/dist/default.woff2` to `apps/desktop/assets/fonts/LiberationSans-Regular.woff2` (we now own it; JASSUB is being deleted). Verify they exist:

Run: `ls -la apps/desktop/assets/fonts/`
Expected: both files present, CJK file > 1MB.

- [ ] **Step 2: Write the failing test.**

```typescript
// apps/desktop/src/renderer/render/fonts/registry.test.ts
import { describe, expect, it } from "vitest";
import {
  BUNDLED_FONT_FAMILIES,
  DEFAULT_CAPTION_FONT_FAMILY,
} from "./registry";

describe("font registry", () => {
  it("advertises Liberation Sans + Noto CJK and a fallback-chain default", () => {
    expect(BUNDLED_FONT_FAMILIES).toContain("Liberation Sans");
    expect(BUNDLED_FONT_FAMILIES).toContain("Noto Sans SC");
    expect(DEFAULT_CAPTION_FONT_FAMILY).toBe("Liberation Sans, Noto Sans SC");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails.**

Run: `npm --workspace apps/desktop test -- registry`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 4: Implement the registry.**

```typescript
// apps/desktop/src/renderer/render/fonts/registry.ts
// Bundled fonts are loaded into BOTH the preview Compositor (main thread,
// document.fonts) and the export Worker (self.fonts) so burned-in captions
// render identically — this carries the cross-OS determinism guarantee.
// Vite `?url` resolves each asset to a same-origin URL at build time.
import notoCjkUrl from "../../../../assets/fonts/NotoSansSC-VF.ttf?url";
import liberationUrl from "../../../../assets/fonts/LiberationSans-Regular.woff2?url";

export const BUNDLED_FONT_FAMILIES = ["Liberation Sans", "Noto Sans SC"] as const;

/// Default caption font: Latin glyphs from Liberation Sans, CJK from Noto.
/// PixiJS passes this comma list straight to the canvas font shorthand, so
/// the browser falls through to Noto for any glyph Liberation lacks.
export const DEFAULT_CAPTION_FONT_FAMILY = "Liberation Sans, Noto Sans SC";

const FONT_URLS: Record<string, string> = {
  "Liberation Sans": liberationUrl,
  "Noto Sans SC": notoCjkUrl,
};

/// Fetch every bundled font's bytes. Used to FontFace-register them into a
/// face set (document.fonts for preview, self.fonts for the export Worker).
export async function loadBundledFontBytes(): Promise<Record<string, ArrayBuffer>> {
  const out: Record<string, ArrayBuffer> = {};
  for (const family of BUNDLED_FONT_FAMILIES) {
    const res = await fetch(FONT_URLS[family]);
    out[family] = await res.arrayBuffer();
  }
  return out;
}
```

- [ ] **Step 5: Run the test to confirm it passes.**

Run: `npm --workspace apps/desktop test -- registry`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/assets/fonts apps/desktop/src/renderer/render/fonts/registry.ts apps/desktop/src/renderer/render/fonts/registry.test.ts
git commit -m "feat(fonts): bundle Noto CJK + Liberation Sans with a renderer font registry"
```

### Task 1.2: A shared FontFace loader

**Files:**
- Create: `apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.ts`
- Test: `apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `async loadFontsIntoFaceSet(faceSet: FontFaceSet, fonts: Record<string, ArrayBuffer>): Promise<void>`.

- [ ] **Step 1: Write the failing test** (jsdom provides a `FontFace`/`document.fonts` stub via the polyfill we add in step 4's note; assert it calls `add` per family).

```typescript
// @vitest-environment jsdom
// apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.test.ts
import { describe, expect, it, vi } from "vitest";
import { loadFontsIntoFaceSet } from "./loadFontsIntoFaceSet";

describe("loadFontsIntoFaceSet", () => {
  it("constructs and adds one FontFace per family", async () => {
    const added: string[] = [];
    const fakeSet = { add: (f: { family: string }) => added.push(f.family) } as unknown as FontFaceSet;
    // jsdom lacks FontFace; stub a minimal one that resolves load().
    (globalThis as Record<string, unknown>).FontFace = class {
      family: string;
      constructor(family: string) { this.family = family; }
      load() { return Promise.resolve(this); }
    };
    await loadFontsIntoFaceSet(fakeSet, {
      "Liberation Sans": new ArrayBuffer(4),
      "Noto Sans SC": new ArrayBuffer(4),
    });
    expect(added.sort()).toEqual(["Liberation Sans", "Noto Sans SC"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm --workspace apps/desktop test -- loadFontsIntoFaceSet`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement the loader.**

```typescript
// apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.ts
// Register raw font bytes into a FontFaceSet so canvas/OffscreenCanvas text
// rasterization can use them. Works on both the main thread (document.fonts)
// and inside a Worker (self.fonts) — FontFace + FontFaceSet.add are available
// in both. MUST be awaited before any PixiJS Text is rasterized, or the first
// frames fall back to a system font (the bundled-font lazy-load gotcha).
export async function loadFontsIntoFaceSet(
  faceSet: FontFaceSet,
  fonts: Record<string, ArrayBuffer>,
): Promise<void> {
  await Promise.all(
    Object.entries(fonts).map(async ([family, bytes]) => {
      const face = new FontFace(family, bytes);
      await face.load();
      faceSet.add(face);
    }),
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm --workspace apps/desktop test -- loadFontsIntoFaceSet`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.ts apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.test.ts
git commit -m "feat(fonts): shared FontFace→FontFaceSet loader for worker + preview"
```

### Task 1.3: Load bundled fonts into the export Worker

**Files:**
- Modify: `apps/desktop/src/renderer/render/worker/protocol.ts` (the `ExportRequest` `start` variant)
- Modify: `apps/desktop/src/renderer/render/worker/exportWorker.ts:113` (before `app.init()`)
- Modify: `apps/desktop/src/renderer/render/worker/runExport.ts:175-188` (build request) and `:221-224` (transfer list)

**Interfaces:**
- Consumes: `loadBundledFontBytes()` (Task 1.1), `loadFontsIntoFaceSet()` (Task 1.2).
- Produces: `ExportRequest` `start` variant gains `fonts: Record<string, ArrayBuffer>`.

- [ ] **Step 1: Add `fonts` to the protocol.** In `protocol.ts`, add to the `start` request type:

```typescript
  /// Bundled font bytes (family → ArrayBuffer), FontFace-loaded into the
  /// Worker's `self.fonts` before renderer init so burned-in Text/captions
  /// don't tofu. Transferred, not copied.
  fonts: Record<string, ArrayBuffer>;
```

- [ ] **Step 2: Load fonts in the Worker before `app.init()`.** In `exportWorker.ts`, immediately before the `const app = new Application()` block (line ~113), insert:

```typescript
  // Register bundled fonts into the Worker's font set BEFORE the renderer
  // initializes. OffscreenCanvas has no system-font fallback chain, so
  // unregistered families (e.g. CJK) would rasterize as blank boxes.
  await loadFontsIntoFaceSet(self.fonts, req.fonts);
```

And add the import near the top of `exportWorker.ts`:

```typescript
import { loadFontsIntoFaceSet } from "../fonts/loadFontsIntoFaceSet";
```

- [ ] **Step 3: Build + transfer the bytes from the main thread.** In `runExport.ts`, before constructing `startReq`, load the bytes:

```typescript
  const fontBytes = await loadBundledFontBytes();
```

Add `fonts: fontBytes,` to the `startReq` object literal (alongside `canvas`, `motifFrames`, …). Then add the font ArrayBuffers to the transfer list at the `worker.postMessage(startReq, [...])` call:

```typescript
      worker.postMessage(startReq, [offscreen, ...bitmapTransfers, ...Object.values(fontBytes)]);
```

Add the import:

```typescript
import { loadBundledFontBytes } from "../fonts/registry";
```

- [ ] **Step 4: Typecheck (the spike's compile gate).**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS — no type errors across protocol/worker/runExport.

- [ ] **Step 5: The spike proof — manual export of a CJK Text layer.** Build and run the app, create a Text layer with content `中文字幕测试`, export a short clip, and confirm the characters render (not boxes) in the output file. This is the load-bearing manual verification of the whole premise.

Run: `npm --workspace apps/desktop run dev`
Then: import any short video, add a Text layer (content `中文字幕测试`), export, open the output.
Expected: Chinese glyphs visible in the exported video (not □□□).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/renderer/render/worker/protocol.ts apps/desktop/src/renderer/render/worker/exportWorker.ts apps/desktop/src/renderer/render/worker/runExport.ts
git commit -m "feat(export): FontFace-load bundled fonts into the worker (CJK burn-in)"
```

### Task 1.4: Load bundled fonts into the preview Compositor

**Files:**
- Modify: `apps/desktop/src/renderer/render/Compositor.ts` (preview-mode init, near the `audioHost` setup at `:439`)

**Interfaces:**
- Consumes: `loadBundledFontBytes()`, `loadFontsIntoFaceSet()`.

- [ ] **Step 1: Load fonts when the preview Compositor initializes.** In `Compositor.ts`, in the `mode === "preview"` init branch (around `:439`), after `document` is confirmed present, add a fire-and-forget load (preview can tolerate a one-frame fallback, but we await on the next frame via the existing dirty-redraw):

```typescript
    if (this.mode === "preview" && typeof document !== "undefined") {
      // Bundled fonts: same set as the export Worker, so preview matches the
      // burned-in output. Awaited off the constructor; the first post-load
      // redraw picks them up.
      void loadBundledFontBytes().then((b) =>
        loadFontsIntoFaceSet(document.fonts, b),
      );
      // ...existing audioHost setup...
```

Add the imports near the top of `Compositor.ts`:

```typescript
import { loadBundledFontBytes } from "./fonts/registry";
import { loadFontsIntoFaceSet } from "./fonts/loadFontsIntoFaceSet";
```

- [ ] **Step 2: Typecheck.**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual parity check.** In `dev`, the CJK Text layer from Task 1.3 now renders in the *preview* with the bundled font too (not a system fallback). Confirm visually.

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/renderer/render/Compositor.ts
git commit -m "feat(preview): load bundled fonts so preview matches burned-in export"
```

---

## Phase 2 — Widen the Text view to carry full style

**Why:** the default caption style needs outline + shadow + bottom-center anchoring, but today's `TextView` flattens those away (see the `TextSprite.ts` header comment: "additional `align`, `shadow`, `outline` fields that aren't in the view today"). Captions can't look right until the view carries them. This also improves plain Text layers.

### Task 2.1: Emit the full Text style from the Rust view builder

**Files:**
- Modify: `apps/desktop/native/src/state/layer.rs` (the function that builds the `Text` view / `LayerSummary` params — search for where `TextParams` is serialized into the summary view; likely a `to_view`/`summary` impl in `layer.rs` or a `commands/query.rs` summary builder)
- Test: add to the existing `layer.rs` `#[cfg(test)]` module

**Interfaces:**
- Produces: the Text view JSON now includes `weight: u16`, `italic: bool`, `align: "Left"|"Center"|"Right"`, `anchor_x: f64`, `anchor_y: f64`, `shadow: { color, offset_x, offset_y, blur } | null`, `outline: { color, width } | null`. `font_family`, `font_size_px`, `color`, `x`, `y`, `opacity` stay.

- [ ] **Step 1: Locate the Text view builder.**

Run: `grep -rn "font_family" apps/desktop/native/src`
Expected: find the function mapping `TextParams` → the view struct (the TS `TextView` mirror). Read it.

- [ ] **Step 2: Write the failing test** asserting a styled Text layer's view carries outline/shadow/align/weight/anchor. Add to `layer.rs` tests:

```rust
#[test]
fn text_view_carries_outline_shadow_align_anchor() {
    let p = TextParams {
        content: "hi".into(),
        font: FontSpec { family: "Liberation Sans".into(), size_px: 54.0, weight: 700, italic: true },
        color: Animated::Static(Rgba::WHITE),
        align: TextAlign::Center,
        transform: Transform { anchor: (0.5, 1.0), ..Default::default() },
        opacity: Animated::Static(1.0),
        shadow: Some(Shadow { color: Rgba::BLACK, offset_x: 2.0, offset_y: 2.0, blur: 2.0 }),
        outline: Some(Outline { color: Rgba::BLACK, width: 3.0 }),
        intro: None, outro: None,
        backend_hint: TextBackend::DrawText,
    };
    let v = text_view(&p, 0); // the builder under test; pass t_in_layer_us = 0
    assert_eq!(v.weight, 700);
    assert!(v.italic);
    assert_eq!(v.anchor_y, 1.0);
    assert!(v.outline.is_some());
    assert!(v.shadow.is_some());
}
```

(If the builder name differs, rename the call to match what Step 1 found and adjust the assert struct accordingly.)

- [ ] **Step 3: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml text_view_carries`
Expected: FAIL — fields don't exist / builder doesn't emit them.

- [ ] **Step 4: Widen the view struct + builder** to emit `weight`, `italic`, `align`, `anchor_x`, `anchor_y`, `shadow`, `outline`. Map `TextAlign` to its serde string; flatten `transform.anchor` to `anchor_x/anchor_y`; pass `Shadow`/`Outline` through as nested optional structs (they already derive `Serialize`).

- [ ] **Step 5: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml text_view_carries`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/native/src/state/layer.rs
git commit -m "feat(state): Text view carries weight/italic/align/anchor/shadow/outline"
```

### Task 2.2: Widen the TS `TextView` + `resolveTextView`

**Files:**
- Modify: `apps/desktop/src/renderer/ipc/index.ts:150-158` (`TextView`)
- Modify: `apps/desktop/src/renderer/render/resolveView.ts` (`ResolvedTextView`, `resolveTextView`)
- Test: `apps/desktop/src/renderer/render/resolveView.test.ts` (create if absent)

**Interfaces:**
- Consumes: the widened Rust view (Task 2.1).
- Produces: `TextView` + `ResolvedTextView` gain `weight`, `italic`, `align`, `anchor_x`, `anchor_y`, `shadow`, `outline`.

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, expect, it } from "vitest";
import { resolveTextView } from "./resolveView";

describe("resolveTextView", () => {
  it("passes weight/italic/align/anchor/outline/shadow through", () => {
    const v = resolveTextView(
      {
        kind: "Text",
        content: "x",
        font_family: "Liberation Sans",
        font_size_px: 54,
        weight: 700,
        italic: true,
        align: "Center",
        anchor_x: 0.5,
        anchor_y: 1.0,
        color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
        x: { mode: "Static", value: 100 },
        y: { mode: "Static", value: 200 },
        opacity: { mode: "Static", value: 1 },
        outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
        shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
      } as never,
      0,
    );
    expect(v.weight).toBe(700);
    expect(v.italic).toBe(true);
    expect(v.anchor_y).toBe(1.0);
    expect(v.outline?.width).toBe(3);
    expect(v.shadow?.blur).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm --workspace apps/desktop test -- resolveView`
Expected: FAIL — properties missing on the type / undefined at runtime.

- [ ] **Step 3: Widen `TextView`** in `ipc/index.ts`:

```typescript
export interface TextView {
  content: string;
  font_family: string;
  font_size_px: number;
  weight: number;
  italic: boolean;
  align: "Left" | "Center" | "Right";
  anchor_x: number;
  anchor_y: number;
  color: AnimTrack<Rgba>;
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  opacity: AnimTrack<number>;
  outline: { color: Rgba; width: number } | null;
  shadow: { color: Rgba; offset_x: number; offset_y: number; blur: number } | null;
}
```

And widen `ResolvedTextView` + `resolveTextView` to copy the new scalar fields through (they aren't animated, so just spread them; only `color/x/y/opacity` resolve).

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm --workspace apps/desktop test -- resolveView`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/ipc/index.ts apps/desktop/src/renderer/render/resolveView.ts apps/desktop/src/renderer/render/resolveView.test.ts
git commit -m "feat(render): widen TextView/ResolvedTextView with full style fields"
```

### Task 2.3: Render weight/italic/align/outline/shadow/anchor in TextSprite

**Files:**
- Modify: `apps/desktop/src/renderer/render/sprite/TextSprite.ts`
- Test: `apps/desktop/src/renderer/render/sprite/TextSprite.test.ts` (create)

**Interfaces:**
- Consumes: `ResolvedTextView` (Task 2.2).

- [ ] **Step 1: Write the failing test** (jsdom; assert the built `TextStyle` reflects weight/stroke/dropShadow and the sprite anchor is set).

```typescript
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TextSprite } from "./TextSprite";

const base = {
  kind: "Text" as const, content: "x", font_family: "Liberation Sans", font_size_px: 54,
  weight: 700, italic: true, align: "Center" as const, anchor_x: 0.5, anchor_y: 1.0,
  color: { r: 255, g: 255, b: 255, a: 255 }, x: 0, y: 0, opacity: 1,
  outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
  shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
};

describe("TextSprite", () => {
  it("applies weight, italic, stroke, dropShadow and anchor", () => {
    const s = new TextSprite({ layerId: "L" });
    s.update(base);
    expect(s.text.style.fontWeight).toBe("700");
    expect(s.text.style.fontStyle).toBe("italic");
    expect(s.text.style.stroke).toBeTruthy();
    expect(s.text.style.dropShadow).toBeTruthy();
    expect(s.text.anchor.y).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm --workspace apps/desktop test -- TextSprite`
Expected: FAIL — fields not applied.

- [ ] **Step 3: Extend `TextSprite.update`.** Fold the new fields into the cached signature and the `TextStyle`, and set the pixi anchor:

```typescript
  update(view: ResolvedTextView): void {
    const o = view.outline, sh = view.shadow;
    const sig =
      `${view.content}|${view.font_family}|${view.font_size_px}|${view.weight}|${view.italic}|${view.align}|` +
      `${view.color.r},${view.color.g},${view.color.b},${view.color.a}|` +
      `${o ? `${o.width}:${o.color.r},${o.color.g},${o.color.b}` : "-"}|` +
      `${sh ? `${sh.offset_x},${sh.offset_y},${sh.blur}:${sh.color.r},${sh.color.g},${sh.color.b}` : "-"}`;

    if (sig !== this.appliedSig) {
      this.appliedSig = sig;
      const fill = (view.color.r << 16) | (view.color.g << 8) | view.color.b;
      const align = view.align.toLowerCase() as "left" | "center" | "right";
      this.text.text = view.content;
      this.text.style = new TextStyle({
        fontFamily: view.font_family || "Liberation Sans, Noto Sans SC",
        fontSize: view.font_size_px,
        fontWeight: String(view.weight || 400) as TextStyleFontWeight,
        fontStyle: view.italic ? "italic" : "normal",
        align,
        fill,
        ...(o ? { stroke: { color: (o.color.r << 16) | (o.color.g << 8) | o.color.b, width: o.width } } : {}),
        ...(sh
          ? {
              dropShadow: {
                color: (sh.color.r << 16) | (sh.color.g << 8) | sh.color.b,
                blur: sh.blur,
                distance: Math.hypot(sh.offset_x, sh.offset_y),
                angle: Math.atan2(sh.offset_y, sh.offset_x),
                alpha: sh.color.a / 255,
              },
            }
          : {}),
      });
    }
    this.text.anchor.set(view.anchor_x, view.anchor_y);
    this.text.position.set(view.x, view.y);
    this.text.alpha = view.opacity * (view.color.a / 255);
  }
```

Add the `TextStyleFontWeight` type import: `import { Text, TextStyle, type TextStyleFontWeight } from "pixi.js";`.

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm --workspace apps/desktop test -- TextSprite`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/render/sprite/TextSprite.ts apps/desktop/src/renderer/render/sprite/TextSprite.test.ts
git commit -m "feat(render): TextSprite renders weight/italic/align/outline/shadow/anchor"
```

---

## Phase 3 — Rust subtitle parser + cue model + caption mutation

### Task 3.1: Add `TrackRole::Caption`

**Files:**
- Modify: `apps/desktop/native/src/state/track.rs:93-119`
- Test: `track.rs` tests.

**Interfaces:**
- Produces: `TrackRole::Caption`; `TrackRole::is_caption(self) -> bool`.

- [ ] **Step 1: Write the failing test.**

```rust
#[test]
fn caption_role_is_not_video_and_reports_caption() {
    assert!(TrackRole::Caption.is_caption());
    assert!(!TrackRole::Caption.is_video());
    assert!(!TrackRole::ARoll.is_caption());
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml caption_role_is_not_video`
Expected: FAIL — `Caption` variant / `is_caption` missing.

- [ ] **Step 3: Add the variant + helper.** Add `Caption,` to `TrackRole`, add `pub fn is_caption(self) -> bool { matches!(self, TrackRole::Caption) }`, and in `paired()` map `Caption => Caption` (captions have no audio pair). Fix any exhaustive `match TrackRole` sites the compiler flags.

Run: `cargo build --manifest-path apps/desktop/native/Cargo.toml`
Expected: compiler lists non-exhaustive matches; add `TrackRole::Caption => …` arms (treat like a non-video, non-AB role — hidden from AB filtering).

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml caption_role_is_not_video`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/state/track.rs
git commit -m "feat(state): add TrackRole::Caption"
```

### Task 3.2: Cue model + SRT parser

**Files:**
- Create: `apps/desktop/native/src/subtitles/mod.rs`, `apps/desktop/native/src/subtitles/srt.rs`
- Modify: `apps/desktop/native/src/lib.rs` (add `mod subtitles;`)
- Test: in `srt.rs`.

**Interfaces:**
- Produces: `Cue { start_us: i64, end_us: i64, text: String, style: CueStyle }`, `CueStyle` (all `Option`/bool fields, `Default`), `ParsedSubtitles { cues: Vec<Cue>, simplified: bool }`, `SubFormat { Srt, Vtt, Ass }`, `srt::parse(body: &str) -> Vec<Cue>`.

- [ ] **Step 1: Define the module + types in `mod.rs`.**

```rust
// apps/desktop/native/src/subtitles/mod.rs
// The single chokepoint that turns imported subtitle text (SRT/VTT/ASS) into
// Cues. File import, the MCP apply_subtitles tool, and the transcribe workflow
// all flow through `parse`. Cues are then laid out into Text layers by `layout`.
use crate::state::color::Rgba;

pub mod ass;
pub mod layout;
pub mod srt;
pub mod vtt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubFormat { Srt, Vtt, Ass }

/// One subtitle cue. `text` preserves explicit line breaks as '\n'.
#[derive(Clone, Debug, PartialEq)]
pub struct Cue {
    pub start_us: i64,
    pub end_us: i64,
    pub text: String,
    pub style: CueStyle,
}

/// Per-cue style hints extracted from ASS (all None for SRT/VTT → default
/// caption style applies in `layout`). `align` is the ASS 9-grid (`\an` 1..9);
/// `pos` is an absolute `\pos(x,y)` override.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CueStyle {
    pub font_family: Option<String>,
    pub size_px: Option<f32>,
    pub primary: Option<Rgba>,
    pub bold: bool,
    pub italic: bool,
    pub outline_px: Option<f32>,
    pub outline_color: Option<Rgba>,
    pub shadow_px: Option<f32>,
    pub align: Option<u8>,
    pub pos: Option<(f64, f64)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedSubtitles {
    pub cues: Vec<Cue>,
    pub simplified: bool,
}

/// Sniff format from a body when the caller doesn't know it.
pub fn sniff(body: &str) -> SubFormat {
    let t = body.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with("WEBVTT") { SubFormat::Vtt }
    else if t.starts_with('[') { SubFormat::Ass }
    else { SubFormat::Srt }
}

pub fn parse(body: &str, format: SubFormat) -> ParsedSubtitles {
    match format {
        SubFormat::Srt => ParsedSubtitles { cues: srt::parse(body), simplified: false },
        SubFormat::Vtt => ParsedSubtitles { cues: vtt::parse(body), simplified: false },
        SubFormat::Ass => ass::parse(body),
    }
}
```

- [ ] **Step 2: Write the failing SRT test** in `srt.rs`.

```rust
// apps/desktop/native/src/subtitles/srt.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_two_cues_with_preserved_line_breaks() {
        let body = "1\n00:00:01,000 --> 00:00:02,500\nHello\nworld\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_us, 1_000_000);
        assert_eq!(cues[0].end_us, 2_500_000);
        assert_eq!(cues[0].text, "Hello\nworld");
        assert_eq!(cues[1].start_us, 3_000_000);
        assert_eq!(cues[1].text, "Bye");
    }
}
```

- [ ] **Step 3: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml parses_two_cues_with_preserved`
Expected: FAIL — `srt::parse` not implemented (or module not wired).

- [ ] **Step 4: Implement the SRT parser** (above the test module in `srt.rs`).

```rust
use super::{Cue, CueStyle};

/// Parse an SRT body into cues. Blocks are separated by blank lines; each
/// block is `index / "HH:MM:SS,mmm --> HH:MM:SS,mmm" / text…`. Malformed
/// blocks are skipped. Line breaks inside a cue are preserved as '\n'.
pub fn parse(body: &str) -> Vec<Cue> {
    let mut cues = Vec::new();
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    for block in normalized.split("\n\n") {
        let mut lines = block.lines().filter(|l| !l.trim().is_empty());
        // Optional numeric index line; skip if present.
        let first = match lines.next() { Some(l) => l, None => continue };
        let time_line = if first.contains("-->") { first } else {
            match lines.next() { Some(l) => l, None => continue }
        };
        let (start_us, end_us) = match parse_time_range(time_line) { Some(t) => t, None => continue };
        let text = lines.collect::<Vec<_>>().join("\n");
        if text.is_empty() { continue; }
        cues.push(Cue { start_us, end_us, text, style: CueStyle::default() });
    }
    cues
}

fn parse_time_range(line: &str) -> Option<(i64, i64)> {
    let (lhs, rhs) = line.split_once("-->")?;
    let a = parse_ts(lhs.trim())?;
    // The RHS may carry SRT position overrides after the timestamp; take token 0.
    let rhs0 = rhs.trim().split_whitespace().next()?;
    let b = parse_ts(rhs0)?;
    Some((a, b))
}

/// `HH:MM:SS,mmm` (also accepts '.' as the decimal separator).
fn parse_ts(s: &str) -> Option<i64> {
    let (hms, ms) = s.split_once(',').or_else(|| s.split_once('.'))?;
    let mut p = hms.split(':');
    let h: i64 = p.next()?.parse().ok()?;
    let m: i64 = p.next()?.parse().ok()?;
    let sec: i64 = p.next()?.parse().ok()?;
    if p.next().is_some() { return None; }
    let ms: i64 = ms.parse().ok()?;
    if !(0..1000).contains(&ms) || !(0..60).contains(&sec) || !(0..60).contains(&m) || h < 0 { return None; }
    Some(((h * 3600 + m * 60 + sec) * 1000 + ms) * 1000)
}
```

Add `pub mod subtitles;` to `apps/desktop/native/src/lib.rs` (next to the other `pub mod` declarations).

- [ ] **Step 5: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml parses_two_cues_with_preserved`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/native/src/subtitles/mod.rs apps/desktop/native/src/subtitles/srt.rs apps/desktop/native/src/lib.rs
git commit -m "feat(subtitles): cue model + SRT parser"
```

### Task 3.3: VTT parser (text + timing)

**Files:**
- Create: `apps/desktop/native/src/subtitles/vtt.rs`
- Test: in `vtt.rs`.

**Interfaces:**
- Produces: `vtt::parse(body: &str) -> Vec<Cue>`.

- [ ] **Step 1: Write the failing test.**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_vtt_dropping_header_and_cue_settings() {
        let body = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90%\nHello\n\n00:00:03.000 --> 00:00:04.000\nBye\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_us, 1_000_000);
        assert_eq!(cues[0].text, "Hello");
    }
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml parses_vtt_dropping_header`
Expected: FAIL.

- [ ] **Step 3: Implement.** VTT timestamps use `.` and `HH:MM:SS.mmm` (hours optional). Reuse logic but accept missing hours; drop the `WEBVTT` header block and any trailing cue-setting tokens on the time line.

```rust
use super::{Cue, CueStyle};

/// Parse a WebVTT body to cues — text + timing only. Cue settings (line/
/// position/align/region) are dropped (v1: VTT renders at SRT level).
pub fn parse(body: &str) -> Vec<Cue> {
    let mut cues = Vec::new();
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    for block in normalized.split("\n\n") {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.is_empty() || lines[0].trim_start().starts_with("WEBVTT") { continue; }
        // An optional cue identifier line precedes the time line.
        let (time_idx, time_line) = lines.iter().enumerate().find(|(_, l)| l.contains("-->"))
            .map(|(i, l)| (i, *l)).unwrap_or((0, ""));
        let (start_us, end_us) = match parse_time_range(time_line) { Some(t) => t, None => continue };
        let text = lines[time_idx + 1..].join("\n");
        if text.is_empty() { continue; }
        cues.push(Cue { start_us, end_us, text, style: CueStyle::default() });
    }
    cues
}

fn parse_time_range(line: &str) -> Option<(i64, i64)> {
    let (lhs, rhs) = line.split_once("-->")?;
    let a = parse_ts(lhs.trim())?;
    let rhs0 = rhs.trim().split_whitespace().next()?;
    let b = parse_ts(rhs0)?;
    Some((a, b))
}

/// `[HH:]MM:SS.mmm`.
fn parse_ts(s: &str) -> Option<i64> {
    let (hms, ms) = s.split_once('.')?;
    let parts: Vec<&str> = hms.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [m, s] => (0i64, m.parse().ok()?, s.parse().ok()?),
        [h, m, s] => (h.parse().ok()?, m.parse().ok()?, s.parse().ok()?),
        _ => return None,
    };
    let ms: i64 = ms.parse().ok()?;
    if !(0..1000).contains(&ms) { return None; }
    Some(((h * 3600 + m * 60 + sec) * 1000 + ms) * 1000)
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml parses_vtt_dropping_header`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/subtitles/vtt.rs
git commit -m "feat(subtitles): VTT parser (text + timing)"
```

### Task 3.4: ASS Tier-3 parser

**Files:**
- Create: `apps/desktop/native/src/subtitles/ass.rs`
- Test: in `ass.rs`.

**Interfaces:**
- Produces: `ass::parse(body: &str) -> ParsedSubtitles`.

- [ ] **Step 1: Write the failing tests** (Style-table mapping, inline override mapping, and the `simplified` flag on dropped tags).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::color::Rgba;

    const DOC: &str = "[Script Info]\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Outline, Shadow, Alignment\nStyle: Default,Arial,60,&H00FFFFFF,-1,0,2,1,2\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,{\\an8}Top line\nDialogue: 0,0:00:03.00,0:00:04.00,Default,{\\k50}Karaoke gone\n";

    #[test]
    fn maps_style_table_and_an_override() {
        let p = parse(DOC);
        assert_eq!(p.cues.len(), 2);
        assert_eq!(p.cues[0].style.font_family.as_deref(), Some("Arial"));
        assert_eq!(p.cues[0].style.size_px, Some(60.0));
        assert_eq!(p.cues[0].style.primary, Some(Rgba::WHITE));
        assert!(p.cues[0].style.bold);
        assert_eq!(p.cues[0].style.align, Some(8)); // \an8 overrides the style's 2
        assert_eq!(p.cues[0].text, "Top line");
    }

    #[test]
    fn karaoke_is_dropped_and_flags_simplified() {
        let p = parse(DOC);
        assert_eq!(p.cues[1].text, "Karaoke gone"); // \k tag stripped, text kept
        assert!(p.simplified);
    }
}
```

- [ ] **Step 2: Run them to confirm they fail.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib subtitles::ass`
Expected: FAIL.

- [ ] **Step 3: Implement the Tier-3 ASS parser.** Parse `[V4+ Styles]` into a `name → StyleRow` map keyed by the `Format:` columns, parse `[Events]` `Dialogue:` rows (split into the `Format:` count − 1 fields so commas in `Text` survive), then for each dialogue apply the named style and the supported inline overrides; strip every other `{...}` tag and set `simplified` when a dropped tag is seen.

```rust
use super::{Cue, CueStyle, ParsedSubtitles};
use crate::state::color::Rgba;
use std::collections::HashMap;

pub fn parse(body: &str) -> ParsedSubtitles {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut styles: HashMap<String, CueStyle> = HashMap::new();
    let mut style_fmt: Vec<String> = Vec::new();
    let mut event_fmt: Vec<String> = Vec::new();
    let mut cues = Vec::new();
    let mut simplified = false;
    let mut section = "";

    for line in normalized.lines() {
        let l = line.trim();
        if l.starts_with('[') { section = if l.eq_ignore_ascii_case("[v4+ styles]") { "styles" }
            else if l.eq_ignore_ascii_case("[events]") { "events" } else { "other" }; continue; }
        if let Some(rest) = l.strip_prefix("Format:") {
            let cols: Vec<String> = rest.split(',').map(|s| s.trim().to_ascii_lowercase()).collect();
            if section == "styles" { style_fmt = cols; } else if section == "events" { event_fmt = cols; }
            continue;
        }
        if section == "styles" {
            if let Some(rest) = l.strip_prefix("Style:") {
                let (name, st) = parse_style_row(rest, &style_fmt);
                styles.insert(name, st);
            }
        } else if section == "events" {
            if let Some(rest) = l.strip_prefix("Dialogue:") {
                if let Some(cue) = parse_dialogue(rest, &event_fmt, &styles, &mut simplified) {
                    cues.push(cue);
                }
            }
        }
    }
    ParsedSubtitles { cues, simplified }
}

fn parse_style_row(rest: &str, fmt: &[String]) -> (String, CueStyle) {
    let vals: Vec<&str> = rest.splitn(fmt.len(), ',').map(|s| s.trim()).collect();
    let get = |key: &str| fmt.iter().position(|c| c == key).and_then(|i| vals.get(i)).copied();
    let mut st = CueStyle::default();
    let name = get("name").unwrap_or("Default").to_string();
    st.font_family = get("fontname").map(|s| s.to_string());
    st.size_px = get("fontsize").and_then(|s| s.parse().ok());
    st.primary = get("primarycolour").and_then(parse_ass_color);
    st.bold = get("bold").map(|s| s == "-1" || s == "1").unwrap_or(false);
    st.italic = get("italic").map(|s| s == "-1" || s == "1").unwrap_or(false);
    st.outline_px = get("outline").and_then(|s| s.parse().ok());
    st.shadow_px = get("shadow").and_then(|s| s.parse().ok());
    st.align = get("alignment").and_then(|s| s.parse().ok());
    (name, st)
}

fn parse_dialogue(rest: &str, fmt: &[String], styles: &HashMap<String, CueStyle>, simplified: &mut bool) -> Option<Cue> {
    let n = fmt.len().max(1);
    let vals: Vec<&str> = rest.splitn(n, ',').map(|s| s.trim()).collect();
    let col = |key: &str| fmt.iter().position(|c| c == key).and_then(|i| vals.get(i)).copied();
    let start_us = parse_ass_ts(col("start")?)?;
    let end_us = parse_ass_ts(col("end")?)?;
    let mut style = col("style").and_then(|n| styles.get(n)).cloned().unwrap_or_default();
    let raw = col("text")?;
    let text = apply_overrides(raw, &mut style, simplified);
    if text.is_empty() { return None; }
    Some(Cue { start_us, end_us, text, style })
}

/// Strip `{...}` override blocks. Map the supported overrides into `style`;
/// any other tag sets `simplified`. Convert `\N`/`\n` to real newlines.
fn apply_overrides(raw: &str, style: &mut CueStyle, simplified: &mut bool) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = match after.find('}') { Some(c) => c, None => break };
        let block = &after[..close];
        for tag in block.split('\\').filter(|t| !t.is_empty()) {
            let t = tag.trim();
            if let Some(v) = t.strip_prefix("an") { style.align = v.parse().ok(); }
            else if let Some(v) = t.strip_prefix("pos(") { style.pos = parse_pos(v.trim_end_matches(')')); }
            else if t.starts_with("c&") || t.starts_with("1c&") {
                style.primary = parse_ass_color(t.trim_start_matches("1c").trim_start_matches('c'));
            }
            else if t == "b1" { style.bold = true; }
            else if t == "b0" { style.bold = false; }
            else if t == "i1" { style.italic = true; }
            else if t == "i0" { style.italic = false; }
            else if let Some(v) = t.strip_prefix("fs") { style.size_px = v.parse().ok().or(style.size_px); }
            else if let Some(v) = t.strip_prefix("fn") { style.font_family = Some(v.to_string()); }
            else if t.starts_with("fad") { /* fade → handled as intro/outro in layout; not a drop */ }
            else { *simplified = true; } // \k \p \clip \t \move \frx \blur …
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out.replace("\\N", "\n").replace("\\n", "\n").trim().to_string()
}

fn parse_pos(s: &str) -> Option<(f64, f64)> {
    let (x, y) = s.split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

/// ASS colour `&HAABBGGRR` (alpha optional) → Rgba.
fn parse_ass_color(s: &str) -> Option<Rgba> {
    let hex = s.trim().trim_start_matches("&H").trim_start_matches("&h").trim_end_matches('&');
    let v = u32::from_str_radix(hex, 16).ok()?;
    Some(Rgba { r: (v & 0xFF) as u8, g: ((v >> 8) & 0xFF) as u8, b: ((v >> 16) & 0xFF) as u8, a: 255 })
}

/// ASS time `H:MM:SS.cs` (centiseconds).
fn parse_ass_ts(s: &str) -> Option<i64> {
    let (hms, cs) = s.split_once('.')?;
    let mut p = hms.split(':');
    let h: i64 = p.next()?.parse().ok()?;
    let m: i64 = p.next()?.parse().ok()?;
    let sec: i64 = p.next()?.parse().ok()?;
    let cs: i64 = cs.parse().ok()?;
    Some(((h * 3600 + m * 60 + sec) * 100 + cs) * 10_000)
}
```

- [ ] **Step 4: Run the tests to confirm they pass.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib subtitles::ass`
Expected: PASS (both tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/subtitles/ass.rs
git commit -m "feat(subtitles): Tier-3 ASS parser (style table + inline overrides)"
```

### Task 3.5: `cue_to_text_params` layout

**Files:**
- Create: `apps/desktop/native/src/subtitles/layout.rs`
- Test: in `layout.rs`.

**Interfaces:**
- Consumes: `Cue`, `CueStyle`, `TextParams` & friends.
- Produces: `layout::cue_to_text_params(cue: &Cue, comp_w: u32, comp_h: u32) -> TextParams`.

- [ ] **Step 1: Write the failing tests** — default style for a styleless cue; an8 anchoring.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::subtitles::{Cue, CueStyle};

    fn cue(style: CueStyle) -> Cue { Cue { start_us: 0, end_us: 1, text: "hi".into(), style } }

    #[test]
    fn styleless_cue_gets_bottom_center_default() {
        let p = cue_to_text_params(&cue(CueStyle::default()), 1920, 1080);
        assert_eq!(p.font.family, "Liberation Sans, Noto Sans SC");
        assert_eq!(p.font.size_px, 54.0); // round(1080 * 0.05)
        assert!(p.outline.is_some());
        assert!(p.shadow.is_some());
        // an2: bottom-center → anchor (0.5, 1.0), x = w/2, y = h - 8%
        assert_eq!(p.transform.anchor, (0.5, 1.0));
        match (&p.transform.x, &p.transform.y) {
            (Animated::Static(x), Animated::Static(y)) => {
                assert_eq!(*x, 960.0);
                assert!((*y - (1080.0 - 1080.0 * 0.08)).abs() < 0.5);
            }
            _ => panic!("static xy expected"),
        }
    }

    #[test]
    fn an8_top_center_anchors_top() {
        let mut s = CueStyle::default();
        s.align = Some(8);
        let p = cue_to_text_params(&cue(s), 1920, 1080);
        assert_eq!(p.transform.anchor, (0.5, 0.0));
    }
}
```

- [ ] **Step 2: Run them to confirm they fail.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib subtitles::layout`
Expected: FAIL.

- [ ] **Step 3: Implement layout.**

```rust
use super::{Cue, CueStyle};
use crate::state::animated::Animated;
use crate::state::color::Rgba;
use crate::state::layer::{FontSpec, Outline, Shadow, TextAlign, TextBackend, TextParams};
use crate::state::transform::Transform;

pub const DEFAULT_CAPTION_FONT: &str = "Liberation Sans, Noto Sans SC";

/// Lay out one cue as a Text layer. Styleless cues (SRT/VTT) get the default
/// caption look: white fill, black outline + soft shadow, size 5% of comp
/// height, bottom-centre with an 8% safe-area margin. The ASS 9-grid `align`
/// (or `\pos`) is converted here to an absolute anchor + position — the render
/// model stays plain x/y/anchor (no caption-specific render code).
pub fn cue_to_text_params(cue: &Cue, comp_w: u32, comp_h: u32) -> TextParams {
    let s = &cue.style;
    let size = s.size_px.unwrap_or((comp_h as f32 * 0.05).round());
    let primary = s.primary.unwrap_or(Rgba::WHITE);
    let outline_w = s.outline_px.unwrap_or(size * 0.06).max(1.0);
    let shadow_off = s.shadow_px.unwrap_or(2.0).max(1.0);

    let an = s.align.unwrap_or(2);
    let (anchor, base_x, base_y) = anchor_for(an, comp_w as f64, comp_h as f64);
    let (x, y) = s.pos.unwrap_or((base_x, base_y));

    TextParams {
        content: cue.text.clone(),
        font: FontSpec {
            family: s.font_family.clone().unwrap_or_else(|| DEFAULT_CAPTION_FONT.to_string()),
            size_px: size,
            weight: if s.bold { 700 } else { 400 },
            italic: s.italic,
        },
        color: Animated::Static(primary),
        align: align_for(an),
        transform: Transform { x: Animated::Static(x), y: Animated::Static(y), anchor, ..Default::default() },
        opacity: Animated::Static(1.0),
        shadow: Some(Shadow { color: Rgba::BLACK, offset_x: shadow_off, offset_y: shadow_off, blur: shadow_off }),
        outline: Some(Outline { color: s.outline_color.unwrap_or(Rgba::BLACK), width: outline_w }),
        intro: None,
        outro: None,
        backend_hint: TextBackend::DrawText,
    }
}

/// ASS 9-grid → (anchor, x, y). 1-3 bottom, 4-6 middle, 7-9 top; 1/4/7 left,
/// 2/5/8 centre, 3/6/9 right. 8% horizontal + vertical safe-area margins.
fn anchor_for(an: u8, w: f64, h: f64) -> ((f64, f64), f64, f64) {
    let mx = w * 0.08;
    let my = h * 0.08;
    let (ax, x) = match an { 1 | 4 | 7 => (0.0, mx), 3 | 6 | 9 => (1.0, w - mx), _ => (0.5, w / 2.0) };
    let (ay, y) = match an { 7 | 8 | 9 => (0.0, my), 4 | 5 | 6 => (0.5, h / 2.0), _ => (1.0, h - my) };
    ((ax, ay), x, y)
}

fn align_for(an: u8) -> TextAlign {
    match an { 1 | 4 | 7 => TextAlign::Left, 3 | 6 | 9 => TextAlign::Right, _ => TextAlign::Center }
}
```

- [ ] **Step 4: Run the tests to confirm they pass.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib subtitles::layout`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/subtitles/layout.rs
git commit -m "feat(subtitles): cue→TextParams layout (default style + 9-grid anchoring)"
```

### Task 3.6: Atomic `add_caption_track_from_cues` mutation

**Files:**
- Modify: `apps/desktop/native/src/state/actor.rs` (add `apply_add_caption_track` + a `ProjectHandle::add_caption_track` method following `add_layer`'s actor-command pattern) OR, simpler, add a `ProjectHandle` method that issues the existing add-track + add-layer commands inside one history commit. Implement as a new actor command for single-undo atomicity.
- Modify: `apps/desktop/native/src/commands/mutations.rs` (the `import_subtitles` orchestrator)
- Test: `apps/desktop/native/src/state/actor/tests.rs`

**Interfaces:**
- Consumes: `Cue` (Task 3.2), `cue_to_text_params` (Task 3.5), `TrackRole::Caption` (Task 3.1).
- Produces: `ProjectHandle::add_caption_track(actor, cues: Vec<Cue>, comp_w, comp_h, label) -> Result<TrackId, CommandError>` — ONE commit creating a `role: Caption` track + one Text layer per cue.

- [ ] **Step 1: Write the failing test.**

```rust
#[tokio::test]
async fn add_caption_track_creates_role_track_with_one_layer_per_cue() {
    use crate::subtitles::Cue;
    use crate::subtitles::CueStyle;
    let h = spawn(Project::new_blank("test"));
    let cues = vec![
        Cue { start_us: 0, end_us: 1_000_000, text: "a".into(), style: CueStyle::default() },
        Cue { start_us: 1_000_000, end_us: 2_000_000, text: "b".into(), style: CueStyle::default() },
    ];
    let track_id = h.add_caption_track(Actor::User, cues, 1920, 1080, Some("Captions".into()))
        .await.expect("add_caption_track");
    let snap = h.snapshot().await;
    let track = snap.tracks.iter().find(|t| t.id == track_id).expect("track");
    assert_eq!(track.role, Some(crate::state::track::TrackRole::Caption));
    assert_eq!(track.layers.len(), 2);
    assert!(matches!(track.layers[0].params, crate::state::layer::LayerParams::Text(_)));

    // ONE undo removes the whole caption track.
    h.undo(Actor::User).await.expect("undo");
    let snap = h.snapshot().await;
    assert!(snap.tracks.iter().all(|t| t.id != track_id));
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml add_caption_track_creates_role`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement the actor command.** Mirror `do_add_layer`: clone the current `Project`, push a new `Track` (`role: Some(TrackRole::Caption)`, `removable: true`, `transient: false`, label), then for each cue push a `Layer { params: Text(cue_to_text_params(...)), t_start_us, t_end_us, .. }` onto that track's `layers`, then ONE `commit(...)` with `DiffHint::Project` (or a track hint) and affected refs. Add the `Command::AddCaptionTrack` inbox variant + the async `ProjectHandle::add_caption_track` wrapper following the `add_layer` pattern (oneshot reply).

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml add_caption_track_creates_role`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/state/actor.rs apps/desktop/native/src/state/actor/tests.rs
git commit -m "feat(state): atomic add_caption_track_from_cues (single-undo caption import)"
```

### Task 3.7: `import_subtitles` chokepoint orchestrator

**Files:**
- Modify: `apps/desktop/native/src/commands/mutations.rs`
- Test: in `mutations.rs` `#[cfg(test)]` (or actor tests).

**Interfaces:**
- Consumes: `subtitles::parse`, `subtitles::sniff`, `ProjectHandle::add_caption_track`.
- Produces: `pub async fn import_subtitles(backend: &Backend, body: String, format: Option<SubFormat>, label: Option<String>) -> Result<(String, bool), String>` — returns `(track_id, simplified)`.

- [ ] **Step 1: Write the failing test.**

```rust
#[tokio::test]
async fn import_subtitles_builds_caption_track_from_srt() {
    let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
    b.init().await.unwrap();
    let srt = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
    let (track_id, simplified) = import_subtitles(&b, srt.into(), None, Some("Captions".into()))
        .await.expect("import_subtitles");
    assert!(!simplified);
    let snap = b.project().unwrap().snapshot().await;
    let track = snap.tracks.iter().find(|t| t.id.to_string() == track_id).expect("track");
    assert_eq!(track.layers.len(), 1);
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml import_subtitles_builds_caption`
Expected: FAIL.

- [ ] **Step 3: Implement.**

```rust
use crate::subtitles::{self, SubFormat};

/// THE chokepoint: parse a subtitle body and build a caption track. Shared by
/// file import (commands::media), MCP apply_subtitles, and transcribe. Returns
/// the new track id and whether any ASS styling was simplified (lossy).
pub async fn import_subtitles(
    backend: &Backend,
    body: String,
    format: Option<SubFormat>,
    label: Option<String>,
) -> Result<(String, bool), String> {
    if body.trim().is_empty() { return Err("subtitle body is empty".into()); }
    let fmt = format.unwrap_or_else(|| subtitles::sniff(&body));
    let parsed = subtitles::parse(&body, fmt);
    if parsed.cues.is_empty() { return Err("no cues parsed from subtitle body".into()); }
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let (w, h) = (snap.composition.width, snap.composition.height); // adjust to actual comp field names
    let track_id = handle
        .add_caption_track(Actor::User, parsed.cues, w, h, label)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok((track_id.to_string(), parsed.simplified))
}
```

(Confirm the composition width/height accessor names against `snap` in step 1's grep; adjust `snap.composition.width` if the field path differs.)

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml import_subtitles_builds_caption`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/commands/mutations.rs
git commit -m "feat(subtitles): import_subtitles chokepoint orchestrator"
```

---

## Phase 4 — Wire the three ingestion paths + delete the old chain

### Task 4.1: File-import routing (consume at import)

**Files:**
- Modify: `apps/desktop/native/src/commands/media.rs:14` (`import_media`)
- Test: `apps/desktop/native/src/napi_backend.rs` tests (mirror `import_media_adds_to_pool_and_returns_id`).

**Interfaces:**
- Consumes: `import_subtitles` (Task 3.7).

- [ ] **Step 1: Write the failing test.**

```rust
#[cfg(feature = "jobs")]
#[tokio::test]
async fn import_srt_makes_caption_track_not_pool_item() {
    let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
    b.init().await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let srt = dir.path().join("c.srt");
    std::fs::write(&srt, "1\n00:00:01,000 --> 00:00:02,000\nHi\n").unwrap();
    let args = serde_json::json!({ "path": srt.to_string_lossy() }).to_string();
    let _ = b.dispatch("import_media", &args).await.unwrap();
    let snap = b.project().unwrap().snapshot().await;
    assert!(snap.media_pool.is_empty(), "subtitle must NOT enter the media pool");
    assert!(snap.tracks.iter().any(|t| t.role == Some(crate::state::track::TrackRole::Caption)));
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs import_srt_makes_caption`
Expected: FAIL — SRT currently pools as `MediaKind::Subtitle`.

- [ ] **Step 3: Branch at the top of `import_media`.** Before the `spawn_blocking` probe, intercept subtitle extensions:

```rust
pub async fn import_media(backend: &Backend, path: String) -> Result<String, String> {
    let handle = backend.project()?;
    let source_buf = PathBuf::from(&path);

    // Subtitles are CONSUMED at import: parsed into a caption track of Text
    // layers, never pooled as media. (Q13 — MediaKind::Subtitle is no longer a
    // pool kind; the extension is only a routing signal here.)
    if is_subtitle_ext(&source_buf) {
        let body = std::fs::read_to_string(&source_buf).map_err(|e| format!("read subtitle: {e}"))?;
        let label = source_buf.file_name().map(|n| n.to_string_lossy().to_string());
        let (track_id, _simplified) =
            crate::commands::mutations::import_subtitles(backend, body, None, label).await?;
        // _simplified is surfaced to the UI via the apply path; file import just
        // returns the track id (the renderer refreshes off project:changed).
        return Ok(track_id);
    }
    let cache = backend.cache.clone();
    // …existing probe + MediaItem flow unchanged…
}

fn is_subtitle_ext(p: &std::path::Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("srt") | Some("ass") | Some("vtt")
    )
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs import_srt_makes_caption`
Expected: PASS. Also re-run `import_media_adds_to_pool_and_returns_id` to confirm the PNG path is untouched.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/commands/media.rs apps/desktop/native/src/napi_backend.rs
git commit -m "feat(import): consume subtitle files into caption tracks (no pooling)"
```

### Task 4.2: Reroute MCP `apply_subtitles`

**Files:**
- Modify: `apps/desktop/native/src/mcp/tools.rs:450-513` (`ApplySubtitlesArgs`, `apply_subtitles`)
- Modify: `apps/desktop/native/src/mcp/catalog.rs:68-73` (tool description)
- Test: `apps/desktop/native/src/mcp/tools.rs` tests + `catalog.rs` smoke test.

**Interfaces:**
- Consumes: `import_subtitles`.
- Produces: `apply_subtitles` returns the caption track id; `simplified` reported in the text result.

- [ ] **Step 1: Write the failing smoke test** (dispatch end-to-end).

```rust
#[tokio::test]
async fn apply_subtitles_builds_caption_track() {
    let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
    b.init().await.unwrap();
    let args = serde_json::json!({
        "body": "1\n00:00:01,000 --> 00:00:02,000\nHi\n", "t_end_us": 2_000_000
    }).to_string();
    let r = crate::mcp::catalog::dispatch_tool(&b, "apply_subtitles", &args).await.unwrap();
    let v = serde_json::to_value(&r).unwrap();
    let track_id = v["content"][0]["text"].as_str().unwrap();
    let snap = b.project().unwrap().snapshot().await;
    assert!(snap.tracks.iter().any(|t| t.id.to_string() == track_id
        && t.role == Some(crate::state::track::TrackRole::Caption)));
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features mcp apply_subtitles_builds_caption`
Expected: FAIL — current `apply_subtitles` makes a `Subtitles` layer (and that variant is about to be deleted).

- [ ] **Step 3: Reroute the tool.** Replace the body of `apply_subtitles` to call `import_subtitles`. The args keep their shape (`body`, optional `format`, optional `track_id` is now ignored/deprecated — a caption import always makes its own track; `t_start_us`/`t_end_us` are ignored because cue times are absolute in the body — document this). Map `format` strings to `SubFormat`.

```rust
pub(super) async fn apply_subtitles(b: &Backend, args: ApplySubtitlesArgs) -> Result<ToolResult, McpToolError> {
    if args.body.trim().is_empty() {
        return Err(McpToolError::invalid_params("subtitles body is empty", None));
    }
    let format = match args.format.as_deref() {
        Some("srt") | Some("SRT") => Some(crate::subtitles::SubFormat::Srt),
        Some("ass") | Some("ASS") => Some(crate::subtitles::SubFormat::Ass),
        Some("vtt") | Some("VTT") => Some(crate::subtitles::SubFormat::Vtt),
        None => None,
        Some(other) => return Err(McpToolError::invalid_params(
            format!("unknown subtitle format '{other}' — expected 'srt', 'ass', or 'vtt'"), None)),
    };
    let (track_id, simplified) =
        crate::commands::mutations::import_subtitles(b, args.body, format, Some("Captions".into()))
            .await
            .map_err(|e| McpToolError::internal_error(e, None))?;
    let msg = if simplified {
        format!("{track_id} (some ASS styling was simplified)")
    } else { track_id };
    Ok(ToolResult::text(msg))
}
```

Update the `catalog.rs` description to: "Import a subtitle document (SRT/VTT/ASS) as a caption track of editable Text layers. Cue timings come from the body. `format` is sniffed when omitted. Advanced ASS styling (karaoke, drawings) is simplified. Returns the new caption track id." Keep the `ApplySubtitlesArgs` struct but mark `track_id`/`t_start_us`/`t_end_us` as deprecated/ignored in their doc comments (do not remove — avoids breaking the wire schema mid-flight).

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features mcp apply_subtitles_builds_caption`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/mcp/tools.rs apps/desktop/native/src/mcp/catalog.rs
git commit -m "feat(mcp): apply_subtitles builds an editable caption track"
```

### Task 4.3: Transcribe → apply regression

**Files:**
- Test only: `apps/desktop/native/src/mcp/tools.rs` (cloud feature).

**Interfaces:**
- Consumes: `shift_srt` (unchanged), `apply_subtitles` (Task 4.2).

- [ ] **Step 1: Write a regression test** proving shifted Whisper SRT → caption track at the right timeline offset.

```rust
#[cfg(feature = "cloud")]
#[tokio::test]
async fn shifted_srt_applies_as_caption_track() {
    let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
    b.init().await.unwrap();
    let slice_relative = "1\n00:00:00,000 --> 00:00:01,000\nHi\n";
    let shifted = crate::cloud::srt::shift_srt(slice_relative, 5_000_000); // +5s
    let args = serde_json::json!({ "body": shifted, "t_end_us": 1 }).to_string();
    let _ = crate::mcp::catalog::dispatch_tool(&b, "apply_subtitles", &args).await.unwrap();
    let snap = b.project().unwrap().snapshot().await;
    let track = snap.tracks.iter().find(|t| t.role == Some(crate::state::track::TrackRole::Caption)).unwrap();
    assert_eq!(track.layers[0].t_start_us, 5_000_000);
}
```

- [ ] **Step 2: Run it to confirm it passes (or reveals a wiring gap).**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features cloud,mcp shifted_srt_applies_as_caption`
Expected: PASS (the transcribe end is unchanged; this guards the contract).

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/native/src/mcp/tools.rs
git commit -m "test(mcp): guard transcribe→shift_srt→apply caption-track contract"
```

### Task 4.4: Delete the JASSUB render chain

**Files:**
- Delete: `apps/desktop/src/renderer/render/subtitles/Jassub.ts`, `apps/desktop/src/renderer/render/sprite/SubtitlesSprite.ts`, `apps/desktop/src/renderer/render/subtitles/assBody.ts`, `apps/desktop/src/renderer/render/subtitles/assBody.test.ts`
- Modify: `apps/desktop/src/renderer/render/Compositor.ts` (remove `ensureSubtitles` `:1776-1801`, `updateSubtitles` `:1803-1813`, the `compositeFrame` Subtitles branch `:783-790`, the `subtitles` map field + its setProject cleanup + disposal, and the `SubtitlesSprite` import `:34`)
- Modify: `apps/desktop/src/renderer/ipc/index.ts` (remove `SubtitlesView` + its union arm `:102`)
- Modify: `apps/desktop/package.json` (remove `"jassub": "^2.5.1"`)

**Interfaces:** none produced — pure deletion.

- [ ] **Step 1: Delete the three files + test.**

```bash
git rm apps/desktop/src/renderer/render/subtitles/Jassub.ts \
       apps/desktop/src/renderer/render/sprite/SubtitlesSprite.ts \
       apps/desktop/src/renderer/render/subtitles/assBody.ts \
       apps/desktop/src/renderer/render/subtitles/assBody.test.ts
```

- [ ] **Step 2: Strip the subtitle code from `Compositor.ts`.** Remove the `SubtitlesSprite` import, the `subtitles` map declaration, the `ensureSubtitles`/`updateSubtitles` methods, the `compositeFrame` `else if (kind === "Subtitles")` branch, and the subtitle entries in `setProject` cleanup + disposal.

- [ ] **Step 3: Remove `SubtitlesView`** and its `({ kind: "Subtitles" } & SubtitlesView)` arm from the `LayerParamsView` union in `ipc/index.ts`.

- [ ] **Step 4: Remove the jassub dependency.** Delete the `"jassub": "^2.5.1"` line from `apps/desktop/package.json` and reinstall:

Run: `npm --workspace apps/desktop install`
Expected: lockfile updates, `node_modules/jassub` gone.

- [ ] **Step 5: Confirm no dangling references.**

Run: `grep -rn "jassub\|Jassub\|SubtitlesSprite\|assBody\|SubtitlesView" apps/desktop/src`
Expected: zero matches.

- [ ] **Step 6: Typecheck + test.**

Run: `npm --workspace apps/desktop run typecheck && npm --workspace apps/desktop test`
Expected: PASS (the `"Subtitles"` kind no longer exists; the union compiles).

- [ ] **Step 7: Commit.**

```bash
git add -A apps/desktop/src/renderer apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "refactor(render): delete JASSUB subtitle chain (single Text render path)"
```

### Task 4.5: Delete the `Subtitles` layer variant + bump format version

**Files:**
- Modify: `apps/desktop/native/src/state/layer.rs` (delete `SubtitlesParams` `:213-216`, `SubtitlesSource` `:226-235`, the `Subtitles` arm of `LayerParams` `:62`)
- Modify: `apps/desktop/native/src/commands/mutations.rs` (delete `add_subtitles_layer` `:374-409`; drop `SubtitlesParams`/`SubtitlesSource` imports)
- Modify: `apps/desktop/native/src/mcp/tools.rs` (delete `SubFormat`/`sniff_subtitle_format` if now unused; drop `SubtitlesSource`/`SubtitlesParams` imports)
- Modify: wherever the project format version constant lives (grep `PROXY_FORMAT_VERSION`-style or a `.vproj` schema version) — bump it.
- Modify: `napi_backend.rs` dispatch — remove the `add_subtitles_layer` arm.

**Interfaces:** none — deletion + version bump (hard break).

- [ ] **Step 1: Delete the Rust types + mutation + dispatch arm.** Remove `SubtitlesParams`, `SubtitlesSource`, the `LayerParams::Subtitles` variant, `add_subtitles_layer`, its dispatch arm, and any now-unused MCP helpers (`SubFormat`, `sniff_subtitle_format` — confirm with grep first).

- [ ] **Step 2: Build to find every exhaustive match.**

Run: `cargo build --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud,motifs`
Expected: compiler errors at each `match LayerParams` site that handled `Subtitles`. Remove those arms (render/view builders, validators, summary). Rebuild until clean.

- [ ] **Step 3: Bump the project format version.**

Run: `grep -rn "format_version\|FORMAT_VERSION\|schema_version" apps/desktop/native/src`
Expected: locate the `.vproj` version constant; increment it. Add a one-line landmine comment: `// Bumped for the captions-as-Text-layers cut: pre-bump projects with Subtitles layers are unsupported (hard break).`

- [ ] **Step 4: Run the full native test suite.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud,motifs`
Expected: PASS (the parser, layout, mutation, import, and MCP tests all green; no `Subtitles` references remain).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src
git commit -m "refactor(state): delete Subtitles layer variant; bump vproj format (hard break)"
```

---

## Phase 5 — Captions panel UI

### Task 5.1: Captions list panel (navigate + inline text edit)

**Files:**
- Create: `apps/desktop/src/renderer/panels/CaptionsPanel.tsx`, `apps/desktop/src/renderer/panels/CaptionsPanel.test.tsx`
- Modify: `apps/desktop/src/renderer/panels/RightPanel.tsx` (mount it), `apps/desktop/src/renderer/i18n/locales/en-US.ts` + `zh-CN.ts`

**Interfaces:**
- Consumes: `useProjectSummary`, `transportSeek`, `updateLayerParams` (existing); caption tracks = tracks with `role === "Caption"`.

- [ ] **Step 1: Add i18n keys** to both locale files (parity-checked by the `Resources` type):

```typescript
  captions: {
    title: "Captions",
    empty: "Import a subtitle file or auto-caption to create captions.",
    style_heading: "Caption style",
  },
```

zh-CN:

```typescript
  captions: {
    title: "字幕",
    empty: "导入字幕文件或自动字幕以创建字幕。",
    style_heading: "字幕样式",
  },
```

- [ ] **Step 2: Write the failing component test** (jsdom + testing-library; init i18n).

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "../i18n";
import { CaptionsPanel } from "./CaptionsPanel";
import { useProjectStore } from "../state/projectStore";

vi.mock("../state/playbackStore", () => ({ transportSeek: vi.fn() }));
import { transportSeek } from "../state/playbackStore";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function seed() {
  const summary = {
    composition: { width: 1920, height: 1080 },
    tracks: [{
      id: "t1", role: "Caption", layers: [
        { id: "L1", t_start_us: 1_000_000, t_end_us: 2_000_000, kind: "Text",
          params: { kind: "Text", content: "Hello", font_family: "Liberation Sans", font_size_px: 54,
            weight: 400, italic: false, align: "Center", anchor_x: 0.5, anchor_y: 1,
            color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
            x: { mode: "Static", value: 960 }, y: { mode: "Static", value: 990 },
            opacity: { mode: "Static", value: 1 }, outline: null, shadow: null } },
      ],
    }],
  };
  useProjectStore.getState().apply(summary as never);
}

describe("CaptionsPanel", () => {
  it("lists caption cues and seeks on row click", () => {
    seed();
    render(<CaptionsPanel onMutated={async () => {}} />);
    expect(screen.getByText("Hello")).toBeTruthy();
    fireEvent.click(screen.getByText("Hello"));
    expect(transportSeek).toHaveBeenCalledWith(1_000_000);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails.**

Run: `npm --workspace apps/desktop test -- CaptionsPanel`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `CaptionsPanel.tsx`** (follow the `MixerPanel` template; atomic selector; inline edit commits on blur).

```tsx
import { useTranslation } from "react-i18next";
import { useProjectSummary } from "../state/projectStore";
import { transportSeek } from "../state/playbackStore";
import { updateLayerParams, type LayerSummary } from "../ipc";

export function CaptionsPanel({ onMutated }: { onMutated: () => Promise<void> }) {
  const { t } = useTranslation();
  const summary = useProjectSummary();
  // A subtitle import is one caption-role track; flatten its Text layers in
  // time order. (Identity derives from the track role — Q4.)
  const cues: LayerSummary[] = (summary?.tracks ?? [])
    .filter((tr) => (tr as { role?: string }).role === "Caption")
    .flatMap((tr) => tr.layers)
    .filter((l) => l.params.kind === "Text")
    .sort((a, b) => a.t_start_us - b.t_start_us);

  const commitText = (layerId: string, content: string) =>
    updateLayerParams(layerId, { kind: "Text", content })
      .then(onMutated)
      .catch((e) => console.warn("update caption text failed:", e));

  return (
    <section className="captions-panel" aria-label={t("captions.title")}>
      <h3>{t("captions.title")}</h3>
      {cues.length === 0 ? (
        <p className="placeholder">{t("captions.empty")}</p>
      ) : (
        <ul className="captions-list">
          {cues.map((c) => (
            <li key={c.id} className="caption-row">
              <button
                type="button"
                className="caption-seek"
                onClick={() => transportSeek(c.t_start_us)}
                aria-label={`seek ${c.t_start_us}`}
              >
                {fmtTc(c.t_start_us)}
              </button>
              <input
                className="app-input caption-text"
                defaultValue={c.params.kind === "Text" ? c.params.content : ""}
                onBlur={(e) => commitText(c.id, e.target.value)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function fmtTc(us: number): string {
  const s = Math.floor(us / 1_000_000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
```

(Note: the inline `<input>` shows `c.params.content` — `defaultValue` not `value` so typing isn't fought by re-renders; commit on blur, matching the `StringPropField` blur-commit convention.)

- [ ] **Step 5: Mount in `RightPanel.tsx`** — add a `<section className="right-panel-captions"><CaptionsPanel onMutated={onMutated} /></section>` above the inspector section, and import it.

- [ ] **Step 6: Run the test + typecheck.**

Run: `npm --workspace apps/desktop test -- CaptionsPanel && npm --workspace apps/desktop run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/renderer/panels/CaptionsPanel.tsx apps/desktop/src/renderer/panels/CaptionsPanel.test.tsx apps/desktop/src/renderer/panels/RightPanel.tsx apps/desktop/src/renderer/i18n/locales/en-US.ts apps/desktop/src/renderer/i18n/locales/zh-CN.ts
git commit -m "feat(ui): captions panel — list cues, seek on click, inline text edit"
```

### Task 5.2: Track-level batch restyle

**Files:**
- Modify: `apps/desktop/native/src/commands/mutations.rs` (`restyle_caption_track`), `apps/desktop/native/src/napi_backend.rs` (dispatch), `apps/desktop/native/src/state/actor.rs` (one-commit fan-out)
- Modify: `apps/desktop/src/renderer/ipc/index.ts` (`restyleCaptionTrack`), `apps/desktop/src/renderer/panels/CaptionsPanel.tsx` (style controls)
- Test: actor test + a panel test.

**Interfaces:**
- Produces: `ProjectHandle::restyle_caption_track(actor, track_id, patch: CaptionStylePatch)` — one commit patching font/size/color/outline across every Text layer on the track; TS `restyleCaptionTrack(trackId, patch)`.

- [ ] **Step 1: Write the failing actor test.**

```rust
#[tokio::test]
async fn restyle_caption_track_patches_all_layers_in_one_undo() {
    use crate::subtitles::{Cue, CueStyle};
    let h = spawn(Project::new_blank("test"));
    let cues = vec![
        Cue { start_us: 0, end_us: 1_000_000, text: "a".into(), style: CueStyle::default() },
        Cue { start_us: 1_000_000, end_us: 2_000_000, text: "b".into(), style: CueStyle::default() },
    ];
    let tid = h.add_caption_track(Actor::User, cues, 1920, 1080, None).await.unwrap();
    h.restyle_caption_track(Actor::User, tid, CaptionStylePatch { font_size_px: Some(120.0), ..Default::default() })
        .await.unwrap();
    let snap = h.snapshot().await;
    let tr = snap.tracks.iter().find(|t| t.id == tid).unwrap();
    for l in &tr.layers {
        if let crate::state::layer::LayerParams::Text(tp) = &l.params { assert_eq!(tp.font.size_px, 120.0); }
    }
    h.undo(Actor::User).await.unwrap(); // ONE undo reverts all
    let snap = h.snapshot().await;
    let tr = snap.tracks.iter().find(|t| t.id == tid).unwrap();
    if let crate::state::layer::LayerParams::Text(tp) = &tr.layers[0].params { assert_eq!(tp.font.size_px, 54.0); }
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml restyle_caption_track_patches`
Expected: FAIL.

- [ ] **Step 3: Implement `CaptionStylePatch` + the actor command.** Define `#[derive(Default, Deserialize, JsonSchema)] struct CaptionStylePatch { font_family: Option<String>, font_size_px: Option<f32>, color: Option<Rgba>, outline_width: Option<f32> }`. The command clones the project, walks the named track's layers, applies the patch to each `Text` param, and `commit`s once. Add the `ProjectHandle::restyle_caption_track` wrapper + `Command` variant. Register `restyle_caption_track` in the napi dispatch table.

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml restyle_caption_track_patches`
Expected: PASS.

- [ ] **Step 5: Add TS bridge + panel controls.** In `ipc/index.ts`: `export async function restyleCaptionTrack(trackId: string, patch: { font_family?: string; font_size_px?: number; color?: Rgba; outline_width?: number }): Promise<void> { return invoke("restyle_caption_track", { trackId, patch }); }`. In `CaptionsPanel.tsx`, add a `captions.style_heading` section with a font-size `AppNumberField` and a color control that call `restyleCaptionTrack(trackId, …).then(onMutated)`. Track id = the first caption-role track (v1 single set; multi-set selection is a follow-up).

- [ ] **Step 6: Typecheck + test.**

Run: `npm --workspace apps/desktop run typecheck && cargo test --manifest-path apps/desktop/native/Cargo.toml restyle_caption_track`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/native/src apps/desktop/src/renderer/ipc/index.ts apps/desktop/src/renderer/panels/CaptionsPanel.tsx
git commit -m "feat(captions): track-level batch restyle (one-undo fan-out)"
```

---

## Phase 6 — (B2) Best-effort user-font resolution

**Note:** This phase is the most platform-specific and is a natural candidate to split into its own follow-up plan. It is INDEPENDENT of Phases 1–5 (the bundled-font path already works without it). The fallback rule guarantees no tofu even if resolution is imperfect.

### Task 6.1: `font:resolve` IPC handler (Electron main)

**Files:**
- Create: `apps/desktop/src/main/fonts/resolveSystemFont.ts`
- Modify: `apps/desktop/src/main/index.ts` (register handler)
- Test: `apps/desktop/src/main/fonts/resolveSystemFont.test.ts`

**Interfaces:**
- Produces: `async resolveSystemFont(family: string): Promise<Buffer | null>` (null when not found → renderer applies the fallback rule). IPC channel `font:resolve` returns `Uint8Array | null`.

- [ ] **Step 1: Write the failing test** (the name-table parser is the unit under test; feed it a known bundled font file and assert it reads a family name).

```typescript
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFamilyName } from "./resolveSystemFont";
import fs from "node:fs";
import path from "node:path";

describe("readFamilyName", () => {
  it("reads the family from a TTF/OTF name table", () => {
    const bytes = fs.readFileSync(
      path.resolve(__dirname, "../../../assets/fonts/LiberationSans-Regular.woff2"),
    );
    // woff2 is compressed; for the unit test point at the raw OTF instead:
    const otf = fs.readFileSync(
      path.resolve(__dirname, "../../../assets/fonts/NotoSansSC-VF.ttf"),
    );
    const name = readFamilyName(otf);
    expect(name?.toLowerCase()).toContain("noto");
  });
});
```

(The OTF is uncompressed sfnt; the name-table parser targets sfnt. WOFF2 needs decompression — out of scope; the directory scan reads `.ttf`/`.otf`/`.ttc` only.)

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm --workspace apps/desktop test -- resolveSystemFont`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement directory scan + sfnt `name`-table parser** (no new deps).

```typescript
// apps/desktop/src/main/fonts/resolveSystemFont.ts
// Best-effort family-name → font-file resolver for the burn-in path. Scans the
// platform font directories, builds a family→path map by reading each font's
// sfnt `name` table (no native deps). Returns null when not found — the
// renderer then applies the bundled-font fallback (never tofu). NOT part of the
// cross-OS determinism contract (Q8): different machines, different files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FONT_DIRS: Record<string, string[]> = {
  win32: [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"),
          path.join(os.homedir(), "AppData", "Local", "Microsoft", "Windows", "Fonts")],
  darwin: ["/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library/Fonts")],
  linux: ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"),
          path.join(os.homedir(), ".local/share/fonts")],
};

let familyMap: Map<string, string> | null = null;

export async function resolveSystemFont(family: string): Promise<Buffer | null> {
  if (!familyMap) familyMap = buildFamilyMap();
  const hit = familyMap.get(family.toLowerCase());
  if (!hit) return null;
  try { return fs.readFileSync(hit); } catch { return null; }
}

function buildFamilyMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of FONT_DIRS[process.platform] ?? []) {
    for (const file of walk(dir)) {
      if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
      try {
        const name = readFamilyName(fs.readFileSync(file));
        if (name) map.set(name.toLowerCase(), file);
      } catch { /* skip unreadable / unparsable */ }
    }
  }
  return map;
}

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
}

/// Read the family name (nameID 1) from an sfnt `name` table. Handles the
/// single-font sfnt header; `.ttc` collections read the first font's offset.
export function readFamilyName(buf: Buffer): string | null {
  let base = 0;
  const tag = buf.toString("ascii", 0, 4);
  if (tag === "ttcf") base = buf.readUInt32BE(12); // first font in the collection
  const numTables = buf.readUInt16BE(base + 4);
  let nameOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (buf.toString("ascii", rec, rec + 4) === "name") { nameOff = buf.readUInt32BE(rec + 8); break; }
  }
  if (!nameOff) return null;
  const count = buf.readUInt16BE(nameOff + 2);
  const storage = nameOff + buf.readUInt16BE(nameOff + 4);
  let fallback: string | null = null;
  for (let i = 0; i < count; i++) {
    const rec = nameOff + 6 + i * 12;
    const platformId = buf.readUInt16BE(rec);
    const nameId = buf.readUInt16BE(rec + 6);
    const len = buf.readUInt16BE(rec + 8);
    const off = storage + buf.readUInt16BE(rec + 10);
    if (nameId !== 1) continue;
    // platform 3 (Windows) / 0 (Unicode) → UTF-16BE; platform 1 (Mac) → ascii.
    const val = platformId === 1 ? buf.toString("ascii", off, off + len)
                                 : buf.toString("utf16le", off, off + len).replace(//g, "");
    const cleaned = (platformId === 1 ? val : swap16(buf.subarray(off, off + len))).trim();
    if (cleaned) { if (platformId === 3) return cleaned; fallback ??= cleaned; }
  }
  return fallback;
}

function swap16(b: Buffer): string {
  const out = Buffer.from(b);
  for (let i = 0; i + 1 < out.length; i += 2) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; }
  return out.toString("utf16le").replace(//g, "");
}
```

- [ ] **Step 4: Register the IPC handler** in `main/index.ts` (mirror `fs:readFile`):

```typescript
ipcMain.handle('font:resolve', async (_e, { family }: { family: string }) => {
  const buf = await resolveSystemFont(family)
  return buf ?? null
})
```

Add `import { resolveSystemFont } from './fonts/resolveSystemFont'`.

- [ ] **Step 5: Run the test + typecheck.**

Run: `npm --workspace apps/desktop test -- resolveSystemFont && npm --workspace apps/desktop run typecheck`
Expected: PASS (name read from the bundled OTF).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/main/fonts apps/desktop/src/main/index.ts
git commit -m "feat(fonts): best-effort OS font resolution in main (font:resolve IPC)"
```

### Task 6.2: Preload bridge for `font:resolve`

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/shared/ipc.ts`

**Interfaces:**
- Produces: `window.api.font.resolve(family: string): Promise<Uint8Array | null>`.

- [ ] **Step 1: Add the method to the `WeftcutApi` type** in `shared/ipc.ts`:

```typescript
  font: {
    resolve(family: string): Promise<Uint8Array | null>
  }
```

- [ ] **Step 2: Expose it in the preload** `api` object:

```typescript
  font: {
    resolve: (family: string): Promise<Uint8Array | null> =>
      ipcRenderer.invoke('font:resolve', { family }) as Promise<Uint8Array | null>,
  },
```

- [ ] **Step 3: Typecheck.**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/shared/ipc.ts
git commit -m "feat(fonts): preload bridge for font:resolve"
```

### Task 6.3: Resolve + inject user fonts (with fallback)

**Files:**
- Modify: `apps/desktop/src/renderer/render/fonts/registry.ts` (add `resolveUserFontBytes`)
- Modify: `apps/desktop/src/renderer/render/worker/runExport.ts` (resolve fonts used by caption/Text layers, merge into the request `fonts`)
- Test: `apps/desktop/src/renderer/render/fonts/registry.test.ts`

**Interfaces:**
- Consumes: `window.api.font.resolve` (Task 6.2).
- Produces: `async resolveFontsForFamilies(families: string[]): Promise<Record<string, ArrayBuffer>>` — bundled families skipped (already loaded); unresolved families omitted (fallback rule).

- [ ] **Step 1: Write the failing test** (mock `window.api.font.resolve`).

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { resolveFontsForFamilies } from "./registry";

describe("resolveFontsForFamilies", () => {
  it("resolves non-bundled families and skips misses", async () => {
    (globalThis as Record<string, unknown>).window = {
      api: { font: { resolve: vi.fn(async (f: string) => (f === "Impact" ? new Uint8Array([1, 2]) : null)) } },
    };
    const out = await resolveFontsForFamilies(["Impact", "Liberation Sans", "Nonexistent"]);
    expect(Object.keys(out)).toEqual(["Impact"]); // bundled skipped, miss omitted
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm --workspace apps/desktop test -- registry`
Expected: FAIL — `resolveFontsForFamilies` missing.

- [ ] **Step 3: Implement.**

```typescript
// append to registry.ts
/// Resolve OS fonts for non-bundled families used in a project (best-effort).
/// Bundled families are skipped (already loaded). Unresolved families are
/// omitted so the renderer falls back to the bundled default chain (no tofu).
export async function resolveFontsForFamilies(families: string[]): Promise<Record<string, ArrayBuffer>> {
  const bundled = new Set(BUNDLED_FONT_FAMILIES as readonly string[]);
  const out: Record<string, ArrayBuffer> = {};
  const seen = new Set<string>();
  for (const family of families) {
    // A family field may be a comma fallback chain; resolve each leaf.
    for (const leaf of family.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (bundled.has(leaf) || seen.has(leaf)) continue;
      seen.add(leaf);
      const bytes = await window.api.font.resolve(leaf);
      if (bytes && bytes.byteLength > 0) {
        out[leaf] = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Merge resolved user fonts into the export request.** In `runExport.ts`, collect the distinct `font_family` values from the project summary's Text layers, resolve them, and merge into `fontBytes` before building `startReq`:

```typescript
  const userFamilies = collectTextFontFamilies(summary); // walk tracks→Text layers→font_family
  const userBytes = await resolveFontsForFamilies(userFamilies);
  const fontBytes = { ...(await loadBundledFontBytes()), ...userBytes };
```

(`collectTextFontFamilies` is a small local helper — flatMap tracks→layers, filter `kind==="Text"`, map `params.font_family`, dedupe.)

- [ ] **Step 5: Run the test + typecheck + a manual user-font export.**

Run: `npm --workspace apps/desktop test -- registry && npm --workspace apps/desktop run typecheck`
Expected: PASS. Then in `dev`: set a Text layer to a system font you have (e.g. "Impact"), export, confirm it renders (and that an unknown font falls back to the bundled chain, not tofu).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/renderer/render/fonts/registry.ts apps/desktop/src/renderer/render/worker/runExport.ts
git commit -m "feat(fonts): resolve + inject user fonts into export, fallback to bundled"
```

---

## Phase 7 — Documentation

### Task 7.1: ADR + evergreen docs sync

**Files:**
- Create: `docs/adr/0026-captions-as-text-layers.md`
- Modify: `docs/data-model.md` (subtitle row → captions), `docs/render.md` (drop the Subtitles/JASSUB section; note bundled fonts), `docs/roadmap.md` (remove the "subtitles omitted from export" item)

- [ ] **Step 1: Write ADR 0026** following the project's ADR convention (status: accepted). Capture: full-replacement of JASSUB with Text-layer captions; the single Rust parser chokepoint; track-role caption identity; Tier-3 ASS; bundled-font determinism + best-effort user fonts (B2); v1 burn-in only; hard-break migration.

- [ ] **Step 2: Sync `data-model.md` + `render.md` + `roadmap.md`** — evergreen voice (no dates/phase numbers/commit hashes). Replace the "Subtitle | Preview-only (JASSUB); not burned into exports" row with the caption-track model; delete the JASSUB render section; drop the roadmap export-gap bullet.

- [ ] **Step 3: Commit.**

```bash
git add docs/adr/0026-captions-as-text-layers.md docs/data-model.md docs/render.md docs/roadmap.md
git commit -m "docs: ADR 0026 + sync data-model/render/roadmap to caption-text-layers"
```

---

## Self-Review

**Spec coverage (design decisions Q1–Q13):**
- Q1 full replacement → Tasks 4.4, 4.5 (delete JASSUB + Subtitles variant). ✓
- Q2 cue = independent Text layer on a dedicated track + batch fan-out → Tasks 3.6, 5.2. ✓
- Q3 v1 burn-in only → whole plan (no soft-sub task); text-only export explicitly deferred. ✓
- Q4 track-role caption identity → Task 3.1 + used in 3.6, 4.1, 4.2, 5.1. ✓
- Q5 Rust parser, atomic mutation, single chokepoint → Phase 3 + Task 3.7. ✓
- Q6 Tier-3 ASS → Task 3.4 (drop tags + `simplified`). ✓
- Q7 bundled fonts incl. CJK into worker → Tasks 1.1–1.4. ✓
- Q8 B2 user-font resolution + fallback rule → Phase 6. ✓
- Q9 default style + 9-grid→absolute (anchor) + no auto-wrap → Task 3.5. ✓
- Q10 hard break → Task 4.5 (format bump, no shim). ✓
- Q11 apply_subtitles reroute + reuse Text/keyframe tools + shift_srt → Tasks 4.2, 4.3. ✓
- Q12 captions panel → Phase 5. ✓
- Q13 consume at import, no pooling → Task 4.1. ✓
- Caught-during-planning gap: the Text view flattened away outline/shadow/align/anchor (needed for the default caption look) → Phase 2 added. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Two explicit verification-against-codebase steps remain (Task 2.1 Step 1 locates the exact view builder name; Task 3.7 confirms the composition width/height field path) — these are grep-confirm steps, not placeholders, because the surrounding code is fully specified.

**Type consistency:** `Cue`/`CueStyle`/`ParsedSubtitles`/`SubFormat` defined in Task 3.2 and used verbatim in 3.4–3.7, 4.x, 5.2. `cue_to_text_params` (3.5) consumed by `add_caption_track` (3.6). `import_subtitles` (3.7) consumed by 4.1, 4.2. `TrackRole::Caption` (3.1) used as the `"Caption"` string on the TS side (5.1). `loadBundledFontBytes`/`loadFontsIntoFaceSet` (1.1/1.2) used in 1.3/1.4 and `resolveFontsForFamilies` (6.3). `font:resolve` channel name consistent across 6.1/6.2/6.3. The widened `TextView` fields (2.2) match what `TextSprite` reads (2.3) and what the CaptionsPanel seeds in its test (5.1).

---

## Execution Handoff

**Risk-ordering note:** Phase 1 is deliberately first — it is the spike that proves the whole "burn-in is free" premise (CJK in the export Worker). If Task 1.3 Step 5 fails to render CJK, stop and reassess before building Phases 3–5 on top of it. Phase 6 (B2) is independent and splittable into its own plan.
