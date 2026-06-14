# Add Color & Text Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore UI entry points to add a Color (solid) layer and a Text layer to a composition, placed at the playhead with a smart Overlay-track reuse rule and auto-selected for immediate editing.

**Architecture:** The full Color/Text stack (data model, renderer, Property Panel editor) already exists; only creation was removed in the A/B-roll redesign. We add two thin Tauri commands over the existing actor (`add_color_layer`; relax the existing `add_text_layer`), both delegating track choice to a shared pure helper `pick_free_overlay_track` + async `resolve_overlay_track`. The React `Insert` menu gains two items that call these at the current playhead and reuse the existing Motif "pending reveal" selection mechanism.

**Tech Stack:** Rust (Tauri 2 command + tokio actor, `imbl` persistent collections), TypeScript/React (Base UI menu, i18next), existing WebView2 e2e harness.

**Spec:** `docs/superpowers/specs/2026-06-14-add-color-text-layers-design.md`

**Working directory:** worktree `videtor-wt1`, branch `feat/add-color-text-layers`.

---

## File Structure

- `apps/desktop/src-tauri/src/commands.rs` — add `DEFAULT_LAYER_DURATION_US`, `pick_free_overlay_track` (pure), `resolve_overlay_track` (async), `add_color_layer_impl` + `#[tauri::command] add_color_layer`; replace the existing `add_text_layer` with an optional-params version + `add_text_layer_impl`. Tests in the existing `#[cfg(test)] mod tests`.
- `apps/desktop/src-tauri/src/lib.rs` — register `commands::add_color_layer` in the `invoke_handler`.
- `apps/desktop/src/ipc/index.ts` — add `addColorLayer`; migrate `addTextLayer` to an options object.
- `apps/desktop/src/i18n/locales/en-US.ts`, `zh-CN.ts` — re-label `actions.add_color_layer` / `actions.add_text_layer` (drop the demo duration suffix).
- `apps/desktop/src/App.tsx` — two `Insert` menu items + handlers; import the two wrappers.

---

## Task 1: Pure track-pick helper `pick_free_overlay_track`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (imports near line 19-28; new fn after `add_demo_text_layer`, ~line 1009; tests in `mod tests`, ~line 2685)

- [ ] **Step 1: Extend the `use crate::state::{...}` block** (commands.rs:19-28)

Add `Track` to the top-level list and `TrackId` to the `ids` import. Replace:

```rust
use crate::state::{
    self, Actor, ColorParams, CommandError, LayerParams, MediaItem, MediaKind, ProjectHandle,
    MotifParams, ProjectSettings, ProjectSettingsPatch, Rgba, SubtitlesParams, SubtitlesSource,
    TrackFlagsPatch, Transform,
    actor::{CompositionPatch, LayerParamsPatch, LayerPatch},
    animated::Animated,
    ids::new_id,
    time::{Rational, TimeUs},
    track::TrackRole,
};
```

with:

```rust
use crate::state::{
    self, Actor, ColorParams, CommandError, LayerParams, MediaItem, MediaKind, ProjectHandle,
    MotifParams, ProjectSettings, ProjectSettingsPatch, Rgba, SubtitlesParams, SubtitlesSource,
    Track, TrackFlagsPatch, Transform,
    actor::{CompositionPatch, LayerParamsPatch, LayerPatch},
    animated::Animated,
    ids::{new_id, TrackId},
    time::{Rational, TimeUs},
    track::TrackRole,
};
```

- [ ] **Step 2: Write the failing unit tests** — add to `mod tests` (after the last existing test, before the closing `}` of the module)

```rust
    // --- add color/text layer: placement ---

    fn test_track(id: u128, role: Option<TrackRole>, ranges: &[(TimeUs, TimeUs)]) -> Track {
        let mut tr = Track::new();
        tr.id = Uuid::from_u128(id);
        tr.role = role;
        tr.layers = ranges
            .iter()
            .map(|&(s, e)| crate::state::layer::Layer {
                id: Uuid::now_v7(),
                label: None,
                t_start_us: s,
                t_end_us: e,
                enabled: true,
                locked: false,
                metadata: imbl::HashMap::new(),
                params: LayerParams::Color(ColorParams {
                    color: Animated::Static(Rgba::BLACK),
                    width: 16,
                    height: 16,
                }),
            })
            .collect();
        tr
    }

    #[test]
    fn pick_returns_none_when_no_nonreserved_track() {
        let tracks: imbl::Vector<Track> = imbl::vector![
            test_track(1, Some(TrackRole::ARoll), &[]),
            test_track(2, Some(TrackRole::BRoll), &[]),
        ];
        assert_eq!(pick_free_overlay_track(&tracks, 0, 1_000_000), None);
    }

    #[test]
    fn pick_reuses_free_nonreserved_track() {
        let tracks: imbl::Vector<Track> = imbl::vector![
            test_track(1, Some(TrackRole::ARoll), &[]),
            test_track(7, None, &[(0, 2_000_000)]),
        ];
        // [2s,3s) does not overlap [0,2s) (half-open) → reuse track 7.
        assert_eq!(
            pick_free_overlay_track(&tracks, 2_000_000, 3_000_000),
            Some(Uuid::from_u128(7))
        );
    }

    #[test]
    fn pick_returns_none_when_only_candidate_is_occupied() {
        let tracks: imbl::Vector<Track> = imbl::vector![test_track(7, None, &[(0, 2_000_000)])];
        // [1s,3s) overlaps [0,2s) → no free candidate → caller must create one.
        assert_eq!(pick_free_overlay_track(&tracks, 1_000_000, 3_000_000), None);
    }

    #[test]
    fn pick_treats_adjacent_ranges_as_free() {
        let tracks: imbl::Vector<Track> = imbl::vector![test_track(7, None, &[(0, 2_000_000)])];
        // Edge-touching at 2_000_000 is NOT an overlap (half-open interval).
        assert_eq!(
            pick_free_overlay_track(&tracks, 2_000_000, 4_000_000),
            Some(Uuid::from_u128(7))
        );
    }

    #[test]
    fn pick_prefers_top_of_zstack() {
        // Both free; index 0 = bottom, last = top. Scan is top→bottom, so the
        // last (id 9) wins.
        let tracks: imbl::Vector<Track> = imbl::vector![
            test_track(8, None, &[]),
            test_track(9, None, &[]),
        ];
        assert_eq!(
            pick_free_overlay_track(&tracks, 0, 1_000_000),
            Some(Uuid::from_u128(9))
        );
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test --lib pick_ 2>&1 | tail -20`
Expected: FAIL — compile error `cannot find function pick_free_overlay_track in this scope`.

- [ ] **Step 4: Implement `pick_free_overlay_track`** — add after `add_demo_text_layer` (after commands.rs:1009)

```rust
/// Default span for a UI-inserted generator layer (color / text) when the
/// caller doesn't specify one. `add_layer` re-snaps both edges to the frame
/// grid, so this is a pre-snap nominal length.
const DEFAULT_LAYER_DURATION_US: TimeUs = 5_000_000; // 5s

/// Pure: choose a non-reserved ("Overlay"/general, `role == None`) track that is
/// free for `[t_start_us, t_end_us)`, scanning top of z-stack → bottom. Returns
/// `None` when no candidate is free, signalling the caller to spawn a new track.
/// Uses the same half-open overlap semantic as `Layer::overlaps`.
fn pick_free_overlay_track(
    tracks: &imbl::Vector<Track>,
    t_start_us: TimeUs,
    t_end_us: TimeUs,
) -> Option<TrackId> {
    tracks
        .iter()
        .rev()
        .filter(|t| t.role.is_none())
        .find(|t| {
            t.layers
                .iter()
                .all(|l| !(t_start_us < l.t_end_us && l.t_start_us < t_end_us))
        })
        .map(|t| t.id)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib pick_ 2>&1 | tail -20`
Expected: PASS — `test result: ok. 5 passed`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(layers): pure pick_free_overlay_track placement helper"
```

---

## Task 2: Async `resolve_overlay_track`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (new fn after `pick_free_overlay_track`; tests in `mod tests`)

- [ ] **Step 1: Write the failing integration tests** — add to `mod tests`

```rust
    #[tokio::test]
    async fn resolve_creates_overlay_track_on_fresh_project() {
        // new_blank has only the reserved A/B pair (role = Some), so there is
        // no candidate → resolve must create a new role-null Overlay track.
        let h = crate::state::actor::spawn(crate::state::Project::new_blank("test"));
        let before = h.snapshot().await.tracks.len();
        let tid = resolve_overlay_track(&h, 0, 1_000_000).await.unwrap();
        let snap = h.snapshot().await;
        assert_eq!(snap.tracks.len(), before + 1);
        let tr = snap.tracks.iter().find(|t| t.id == tid).unwrap();
        assert!(tr.role.is_none());
    }

    #[tokio::test]
    async fn resolve_reuses_free_overlay_track() {
        let h = crate::state::actor::spawn(crate::state::Project::new_blank("test"));
        let overlay = h
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .unwrap();
        h.add_layer(
            Actor::User,
            overlay,
            LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::BLACK),
                width: 16,
                height: 16,
            }),
            0,
            2_000_000,
        )
        .await
        .unwrap();
        // Non-overlapping range → reuse the same overlay track, no new track.
        let before = h.snapshot().await.tracks.len();
        let got = resolve_overlay_track(&h, 2_500_000, 3_500_000).await.unwrap();
        assert_eq!(got, overlay);
        assert_eq!(h.snapshot().await.tracks.len(), before);
    }

    #[tokio::test]
    async fn resolve_creates_new_track_on_overlap() {
        let h = crate::state::actor::spawn(crate::state::Project::new_blank("test"));
        let overlay = h
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .unwrap();
        h.add_layer(
            Actor::User,
            overlay,
            LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::BLACK),
                width: 16,
                height: 16,
            }),
            0,
            2_000_000,
        )
        .await
        .unwrap();
        let before = h.snapshot().await.tracks.len();
        // Overlapping range → can't reuse → new track.
        let got = resolve_overlay_track(&h, 1_000_000, 3_000_000).await.unwrap();
        assert_ne!(got, overlay);
        assert_eq!(h.snapshot().await.tracks.len(), before + 1);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test --lib resolve_ 2>&1 | tail -20`
Expected: FAIL — `cannot find function resolve_overlay_track in this scope`.

- [ ] **Step 3: Implement `resolve_overlay_track`** — add directly after `pick_free_overlay_track`

```rust
/// Resolve the track a UI-inserted color/text layer should land on: reuse the
/// first free non-reserved track for `[t_start_us, t_end_us)`, else create a new
/// "Overlay" track (appended on top of the z-stack, same as `add_motif`).
async fn resolve_overlay_track(
    handle: &ProjectHandle,
    t_start_us: TimeUs,
    t_end_us: TimeUs,
) -> Result<TrackId, String> {
    let snap = handle.snapshot().await;
    if let Some(id) = pick_free_overlay_track(&snap.tracks, t_start_us, t_end_us) {
        return Ok(id);
    }
    handle
        .add_track(Actor::User, Some("Overlay".into()))
        .await
        .map_err(|e: CommandError| e.to_string())
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib resolve_ 2>&1 | tail -20`
Expected: PASS — `test result: ok. 3 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(layers): resolve_overlay_track reuse-or-create placement"
```

---

## Task 3: `add_color_layer` command + registration

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (impl + command after `resolve_overlay_track`; test in `mod tests`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (invoke_handler, near line 131)

- [ ] **Step 1: Write the failing integration test** — add to `mod tests`

```rust
    #[tokio::test]
    async fn add_color_layer_defaults_full_frame_black_at_playhead() {
        let h = crate::state::actor::spawn(crate::state::Project::new_blank("test"));
        let comp = h.snapshot().await.composition.clone();
        let id = add_color_layer_impl(&h, None, None, None, None, 1_000_000, None)
            .await
            .unwrap();
        let snap = h.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id.to_string() == id)
            .expect("inserted color layer");
        match &layer.params {
            LayerParams::Color(c) => {
                assert_eq!(c.width, comp.width);
                assert_eq!(c.height, comp.height);
                match &c.color {
                    Animated::Static(rgba) => {
                        assert_eq!((rgba.r, rgba.g, rgba.b, rgba.a), (0, 0, 0, 255));
                    }
                    _ => panic!("expected static color"),
                }
            }
            _ => panic!("expected Color layer"),
        }
        assert!(layer.t_start_us <= 1_000_000);
        assert!(layer.t_end_us - layer.t_start_us >= 4_900_000); // ~5s default
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test --lib add_color_layer_defaults 2>&1 | tail -20`
Expected: FAIL — `cannot find function add_color_layer_impl in this scope`.

- [ ] **Step 3: Implement the impl + command** — add directly after `resolve_overlay_track`

```rust
async fn add_color_layer_impl(
    handle: &ProjectHandle,
    track_id: Option<String>,
    color: Option<Rgba>,
    width: Option<u32>,
    height: Option<u32>,
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,
) -> Result<String, String> {
    let span = duration_us.unwrap_or(DEFAULT_LAYER_DURATION_US).max(100_000);
    let t_end = t_start_us + span;
    let snap = handle.snapshot().await;
    let track = match track_id {
        Some(s) => Uuid::parse_str(&s).map_err(|e| format!("track_id: {e}"))?,
        None => resolve_overlay_track(handle, t_start_us, t_end).await?,
    };
    let params = LayerParams::Color(ColorParams {
        color: Animated::Static(color.unwrap_or(Rgba::BLACK)),
        width: width.unwrap_or(snap.composition.width),
        height: height.unwrap_or(snap.composition.height),
    });
    handle
        .add_layer(Actor::User, track, params, t_start_us, t_end)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

/// UI: insert a solid Color layer. `track_id` omitted → smart Overlay placement
/// (`resolve_overlay_track`); defaults to a full-frame black matte for the
/// default duration. Returns the new layer id (the UI selects it for editing).
#[tauri::command]
pub async fn add_color_layer(
    handle: State<'_, ProjectHandle>,
    track_id: Option<String>,
    color: Option<Rgba>,
    width: Option<u32>,
    height: Option<u32>,
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,
) -> Result<String, String> {
    add_color_layer_impl(&handle, track_id, color, width, height, t_start_us, duration_us).await
}
```

- [ ] **Step 4: Register the command** — `apps/desktop/src-tauri/src/lib.rs`. Find the line `commands::add_demo_color_layer,` (≈131) and add a line after it:

```rust
            commands::add_demo_color_layer,
            commands::add_color_layer,
```

- [ ] **Step 5: Run the test (+ build) to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test --lib add_color_layer_defaults 2>&1 | tail -20`
Expected: PASS — `test result: ok. 1 passed`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(layers): add_color_layer command with smart placement"
```

---

## Task 4: Relax `add_text_layer` to optional params + smart placement

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (replace existing `add_text_layer` at ~930-962; add impl; tests in `mod tests`)

- [ ] **Step 1: Write the failing integration tests** — add to `mod tests`

```rust
    #[tokio::test]
    async fn add_text_layer_defaults_content_and_duration() {
        let h = crate::state::actor::spawn(crate::state::Project::new_blank("test"));
        let id = add_text_layer_impl(&h, None, None, 0, None).await.unwrap();
        let snap = h.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id.to_string() == id)
            .expect("inserted text layer");
        match &layer.params {
            LayerParams::Text(tp) => assert_eq!(tp.content, "Text"),
            _ => panic!("expected Text layer"),
        }
        assert!(layer.t_end_us - layer.t_start_us >= 4_900_000); // ~5s default
    }

    #[tokio::test]
    async fn add_text_layer_honors_explicit_track_and_content() {
        let h = crate::state::actor::spawn(crate::state::Project::new_blank("test"));
        let overlay = h
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .unwrap();
        let _ = add_text_layer_impl(
            &h,
            Some(overlay.to_string()),
            Some("Hi".to_string()),
            0,
            Some(1_000_000),
        )
        .await
        .unwrap();
        let snap = h.snapshot().await;
        let tr = snap.tracks.iter().find(|t| t.id == overlay).unwrap();
        assert_eq!(tr.layers.len(), 1);
        match &tr.layers[0].params {
            LayerParams::Text(tp) => assert_eq!(tp.content, "Hi"),
            _ => panic!("expected Text layer"),
        }
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test --lib add_text_layer 2>&1 | tail -20`
Expected: FAIL — `cannot find function add_text_layer_impl in this scope`.

- [ ] **Step 3: Replace the existing `add_text_layer`** — delete the current command (commands.rs ~930-962) and put this in its place:

```rust
async fn add_text_layer_impl(
    handle: &ProjectHandle,
    track_id: Option<String>,
    content: Option<String>,
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,
) -> Result<String, String> {
    let span = duration_us.unwrap_or(DEFAULT_LAYER_DURATION_US).max(100_000);
    let t_end = t_start_us + span;
    let track = match track_id {
        Some(s) => Uuid::parse_str(&s).map_err(|e| format!("track_id: {e}"))?,
        None => resolve_overlay_track(handle, t_start_us, t_end).await?,
    };
    let params = LayerParams::Text(state::layer::TextParams {
        content: content.unwrap_or_else(|| "Text".to_string()),
        font: state::layer::FontSpec {
            family: "Arial".to_string(),
            size_px: 72.0,
            weight: 400,
            italic: false,
        },
        color: Animated::Static(Rgba::WHITE),
        align: state::layer::TextAlign::Center,
        transform: Default::default(),
        opacity: Animated::Static(1.0),
        shadow: None,
        outline: None,
        intro: None,
        outro: None,
        backend_hint: state::layer::TextBackend::DrawText,
    });
    handle
        .add_layer(Actor::User, track, params, t_start_us, t_end)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

/// UI: insert a Text layer. `track_id` omitted → smart Overlay placement;
/// `content` omitted → "Text"; `duration_us` omitted → default duration.
/// Returns the new layer id (the UI selects it for editing).
#[tauri::command]
pub async fn add_text_layer(
    handle: State<'_, ProjectHandle>,
    track_id: Option<String>,
    content: Option<String>,
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,
) -> Result<String, String> {
    add_text_layer_impl(&handle, track_id, content, t_start_us, duration_us).await
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib add_text_layer 2>&1 | tail -20`
Expected: PASS — `test result: ok. 2 passed` (plus the `honors_explicit_track` case).

- [ ] **Step 5: Verify the whole crate still builds and all tests pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib 2>&1 | tail -15`
Expected: PASS — no compile errors, `test result: ok`. (`add_text_layer` already registered in `lib.rs`, no registration change needed.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(layers): relax add_text_layer to optional params + smart placement"
```

---

## Task 5: TypeScript IPC wrappers

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts` (replace `addTextLayer` at 429-441; add `addColorLayer` next to it)

- [ ] **Step 1: Replace the `addTextLayer` wrapper and add `addColorLayer`** (ipc/index.ts:429-441)

Replace the existing positional `addTextLayer` with these two options-object wrappers (`Rgba` is already declared in this module and used by `LayerParamsView`):

```ts
export async function addColorLayer(opts: {
  tStartUs: number;
  durationUs?: number;
  trackId?: string;
  color?: Rgba;
  width?: number;
  height?: number;
}): Promise<string> {
  return invoke<string>("add_color_layer", {
    trackId: opts.trackId,
    color: opts.color,
    width: opts.width,
    height: opts.height,
    tStartUs: opts.tStartUs,
    durationUs: opts.durationUs,
  });
}

export async function addTextLayer(opts: {
  tStartUs: number;
  durationUs?: number;
  trackId?: string;
  content?: string;
}): Promise<string> {
  return invoke<string>("add_text_layer", {
    trackId: opts.trackId,
    content: opts.content,
    tStartUs: opts.tStartUs,
    durationUs: opts.durationUs,
  });
}
```

(`undefined` fields are dropped by `invoke`'s JSON serialization → the Rust `Option<_>` params receive `None`, the same pattern the Motif picker uses for `trackId: undefined`.)

- [ ] **Step 2: Typecheck**

Run: `cd ../../.. && npm run typecheck` (from repo root) — or `npm --workspace apps/desktop run typecheck`.
Expected: clean (`tsc -b`, no errors). If it reports an unused-export or a stale positional caller of `addTextLayer`, that caller is migrated in Task 7 (App.tsx) — there are no other callers (verified: only the wrapper definition existed).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/ipc/index.ts
git commit -m "feat(layers): addColorLayer + options-object addTextLayer wrappers"
```

---

## Task 6: i18n labels

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` (line 92-93)
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts` (line 96-97)

- [ ] **Step 1: Re-label en-US** — in `en-US.ts`, replace:

```ts
    add_color_layer: "+ Color layer (2s)",
    add_text_layer: "+ Text (3s)",
```

with:

```ts
    add_color_layer: "Color layer",
    add_text_layer: "Text",
```

- [ ] **Step 2: Re-label zh-CN** — in `zh-CN.ts`, replace:

```ts
    add_color_layer: "+ 颜色层（2秒）",
    add_text_layer: "+ 文本（3秒）",
```

with:

```ts
    add_color_layer: "颜色层",
    add_text_layer: "文本",
```

- [ ] **Step 3: Typecheck**

Run: `npm --workspace apps/desktop run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(layers): re-enable color/text layer menu labels"
```

---

## Task 7: App.tsx Insert menu entries + handlers

**Files:**
- Modify: `apps/desktop/src/App.tsx` (ipc import block; Insert menu at 1780-1791)

- [ ] **Step 1: Import the wrappers** — add `addColorLayer` and `addTextLayer` to the existing `import { ... } from "./ipc";` block in `App.tsx`. (Search for `} from "./ipc";` and add both names to the brace list.)

- [ ] **Step 2: Add two menu items** — in the `Insert` menu (App.tsx:1780-1791), insert two `MenuItem`s before the existing Motifs item so the menu reads:

```tsx
            <Menu label={t("menu.insert")}>
              <MenuItem
                label={t("actions.add_color_layer")}
                onSelect={async () => {
                  const layerId = await addColorLayer({ tStartUs: currentTimeUs });
                  setPendingRevealLayerId(layerId);
                  await refresh();
                }}
              />
              <MenuItem
                label={t("actions.add_text_layer")}
                onSelect={async () => {
                  const layerId = await addTextLayer({ tStartUs: currentTimeUs });
                  setPendingRevealLayerId(layerId);
                  await refresh();
                }}
              />
              <MenuItem
                label={t("actions.motifs")}
                hint={t("actions.motifs_hint")}
                onSelect={() => setMotifPickerOpen(true)}
              />
            </Menu>
```

(`currentTimeUs`, `setPendingRevealLayerId`, and `refresh` are already in scope. The `pendingRevealLayerId` effect at App.tsx:313-322 selects + reveals the new layer once the refreshed summary contains it — the same path the Motif "New Motif" insert uses, required because the layer lands on a role-null Overlay track the A/B view hides.)

- [ ] **Step 3: Typecheck**

Run: `npm --workspace apps/desktop run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(layers): Insert-menu entries for color and text layers"
```

---

## Task 8: Manual verification in the running app

Automated coverage of the only non-trivial logic (placement) is complete in Tasks 1-4 (5 pure + 6 integration tests). Final acceptance is a manual run, because the WebView2 e2e harness needs a live `tauri-driver` + a `msedgedriver` matched to the installed WebView2 (heavy; see `feedback_wdio_spec_filter_windows`). An automated spec can be added later mirroring `apps/desktop/e2e/specs/image_support.e2e.js`.

- [ ] **Step 1: Launch the app**

Run: `npm --workspace apps/desktop run tauri:dev`
Expected: app builds and opens; create or open a project.

- [ ] **Step 2: Verify Color layer**
  - Move the playhead to a non-zero time.
  - Insert → **Color layer**.
  - Confirm: a new layer appears at the playhead; it is auto-selected; the Property Panel shows Color fields (color / width / height); changing the color updates the preview; the solid renders full-frame.

- [ ] **Step 3: Verify Text layer**
  - Insert → **Text**.
  - Confirm: new layer at the playhead, auto-selected; Property Panel shows Text fields; editing content/font/size/color/position updates the preview.

- [ ] **Step 4: Verify placement rule**
  - Add a second Text layer at a *non-overlapping* time → it lands on the *same* Overlay track.
  - Add another at an *overlapping* time → it lands on a *new* Overlay track.

- [ ] **Step 5: Verify export**
  - Export a short range covering a color and a text layer.
  - Confirm both appear in the output file.

- [ ] **Step 6: Final full check**

Run: `cd apps/desktop/src-tauri && cargo test --lib 2>&1 | tail -5` and `npm --workspace apps/desktop run typecheck`
Expected: all Rust tests pass; typecheck clean.

---

## Self-Review

- **Spec coverage:** UI entry (Task 7) ✓; smart Overlay placement (Tasks 1-2) ✓; `add_color_layer` + relaxed `add_text_layer` with defaults 5s/black-full-frame/"Text" (Tasks 3-4) ✓; demo commands untouched ✓; TS wrappers (Task 5) ✓; i18n re-label (Task 6) ✓; auto-select via pending-reveal (Task 7) ✓; z-order matte behavior accepted (no code, documented) ✓; testing — pure + integration automated, e2e → manual gate with rationale (Task 8, a deliberate deviation from the spec's e2e line) ✓.
- **Placeholder scan:** none — every code/edit step shows full content; commands and exact run lines given.
- **Type consistency:** `pick_free_overlay_track(&imbl::Vector<Track>, TimeUs, TimeUs) -> Option<TrackId>`, `resolve_overlay_track(&ProjectHandle, TimeUs, TimeUs) -> Result<TrackId, String>`, `add_color_layer_impl` / `add_text_layer_impl` signatures match their callers and tests; TS `addColorLayer` / `addTextLayer` option keys map to the Rust `Option<_>` params; `Rgba` fields `(r,g,b,a)` consistent across Rust tests and the BLACK default.
