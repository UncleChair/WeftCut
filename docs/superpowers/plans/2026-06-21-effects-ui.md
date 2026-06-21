# Effects UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inspector UI to add / remove / enable / reorder / edit (incl. keyframe) per-layer effects, reusing the existing keyframe machinery.

**Architecture:** Rust already owns effect instances + 4 undoable actor commands + MCP tools, and the renderer owns the catalog + render path; only the *command bridge to the renderer* and the *UI* are missing. We add 4 renderer-callable commands, 4 TS IPC wrappers, catalog enumeration, a new `EffectsSection` inspector module (driven entirely by the registry), and reuse `KeyframeField` for params (whose nested `effects[<id>].params[<key>]` writes go through the existing `update_layer_param_track`, taught to lazily create an absent effect-param slot).

**Tech Stack:** Rust (napi-rs actor backend), React + TypeScript renderer, Base UI widgets, i18next, vitest + @testing-library/react, Playwright `_electron`.

## Global Constraints

- Node 22.20.0 via fnm; run all `npm` commands from `apps/desktop`.
- Rust unit tests: from `apps/desktop/native`, `cargo test --lib --features motifs <filter>` (the full `napi:build` set `jobs,export,mcp,cloud,motifs` is also valid; cfg'd-out arms just disappear).
- TS unit tests: from `apps/desktop`, `npm test -- <path>` (the `pretest` hook builds the eval wasm first). Typecheck: `npm run typecheck`.
- Electron e2e: ALWAYS rebuild before running — `VITE_WEFTCUT_E2E=1 npm run build && npm run napi:build`, then `npm run e2e:electron -- <spec>`. A stale `out/` bundle silently mimics a code bug (known landmine).
- Every user-facing string lands in BOTH `src/renderer/i18n/locales/en-US.ts` and `zh-CN.ts`.
- Renderer command Args structs use `#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")]`; the TS `invoke(...)` passes camelCase top-level keys.
- v1: scalar `Animated<f64>` params only; `blur` is the only catalog entry; effects render on visual kinds only (Text / VideoClip / ImageOverlay / Color / Motif), never Audio.
- Comments follow `docs/comment-style.md` (evergreen; summary / why / landmine — no changelog comments).
- Commit messages: `feat(effects): …` / `test(effects): …`; end each commit body with the repo's `Co-Authored-By` trailer.
- Stage by explicit path in every commit (a parallel session may be editing this checkout).

---

## File Structure

- `apps/desktop/native/src/state/actor/mutations.rs` — MODIFY `apply_update_layer_param_track` (lazy effect-param slot).
- `apps/desktop/native/src/commands/mod.rs` — ADD 4 Args structs.
- `apps/desktop/native/src/commands/mutations.rs` — ADD 4 command wrappers.
- `apps/desktop/native/src/napi_backend.rs` — ADD 4 dispatch arms + dispatch tests.
- `apps/desktop/src/renderer/ipc/index.ts` — ADD `EffectPatch` type + 4 IPC wrappers.
- `apps/desktop/src/renderer/ipc/effects.test.ts` — NEW (IPC wrapper tests).
- `apps/desktop/src/renderer/render/effects/effectRegistry.ts` — ADD `listEffects` + `step` + rename `nameI18nKey`.
- `apps/desktop/src/renderer/render/effects/effectRegistry.test.ts` — EXTEND.
- `apps/desktop/src/renderer/properties/EffectsSection.tsx` — NEW (chain UI + add/remove/enable/reorder).
- `apps/desktop/src/renderer/properties/EffectsSection.test.tsx` — NEW.
- `apps/desktop/src/renderer/properties/EffectParamField.tsx` — NEW (keyframe-capable param rows).
- `apps/desktop/src/renderer/properties/EffectParamField.test.tsx` — NEW.
- `apps/desktop/src/renderer/properties/PropertyPanel.tsx` — MODIFY (render section for visual kinds; export `isVisualKind`).
- `apps/desktop/src/renderer/properties/visualKind.test.ts` — NEW (gate unit test).
- `apps/desktop/src/renderer/i18n/locales/{en-US,zh-CN}.ts` — ADD `effects` namespace.
- `apps/desktop/e2e/electron/effects-smoke.spec.ts` — ADD a UI-driven test.

---

### Task 1: Backend — lazy effect-param slot creation

A freshly-added effect has empty `params`; `apply_update_layer_param_track` must create the slot on the first write to `effects[<id>].params[<key>]` instead of rejecting with `UnknownKeyframeParam`.

**Files:**
- Modify: `apps/desktop/native/src/state/actor/mutations.rs:457-483` (`apply_update_layer_param_track`)
- Test: `apps/desktop/native/src/state/actor/tests.rs` (effects test region, near line 5234)

**Interfaces:**
- Consumes: `crate::state::layer::{resolve_animated_f64_mut_on_layer, parse_effect_param_key}` (both `pub(crate)`), `Animated::Static`, helpers `project_with_video_track()`, `apply_add_layer`, `color_layer(Rgba::WHITE)` (existing in tests.rs).
- Produces: no signature change; new behavior — first track write to an existing effect's absent param key inserts it.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/native/src/state/actor/tests.rs`, inside the same `mod` that holds `add_then_move_then_remove_effect`, add:

```rust
    #[test]
    fn update_param_track_lazily_creates_absent_effect_param_slot() {
        use crate::state::actor::mutations::{
            apply_add_effect, apply_add_layer, apply_update_layer_param_track,
        };
        use crate::state::effect::Effect;

        let (mut project, track_id) = project_with_video_track();
        let layer_id =
            apply_add_layer(&mut project, track_id, color_layer(Rgba::WHITE), 0, 1_000_000).unwrap();
        // Effect with EMPTY params — exactly what add_effect creates.
        let effect_id = apply_add_effect(
            &mut project,
            layer_id,
            Effect { id: new_id(), kind: "blur".into(), enabled: true, params: Default::default() },
        )
        .unwrap();

        let key = format!("effects[{effect_id}].params[strength]");
        // First write to the not-yet-present slot must succeed (lazy-insert).
        apply_update_layer_param_track(&mut project, layer_id, &key, Animated::Static(20.0)).unwrap();

        let e = project
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .unwrap()
            .effects
            .iter()
            .find(|e| e.id == effect_id)
            .unwrap();
        assert!(matches!(e.params.get("strength"), Some(Animated::Static(v)) if *v == 20.0));
    }

    #[test]
    fn update_param_track_still_rejects_non_effect_unknown_key() {
        use crate::state::actor::mutations::{apply_add_layer, apply_update_layer_param_track};

        let (mut project, track_id) = project_with_video_track();
        let layer_id =
            apply_add_layer(&mut project, track_id, color_layer(Rgba::WHITE), 0, 1_000_000).unwrap();
        let err = apply_update_layer_param_track(&mut project, layer_id, "bogus", Animated::Static(1.0));
        assert!(matches!(err, Err(CommandError::UnknownKeyframeParam { .. })));
    }
```

- [ ] **Step 2: Run the tests to verify the first fails**

Run: `cargo test --lib --features motifs update_param_track_lazily_creates_absent_effect_param_slot` (from `apps/desktop/native`)
Expected: FAIL — the write returns `Err(UnknownKeyframeParam)` (slot absent), so the final `assert!` is never reached because `.unwrap()` panics on the write.

- [ ] **Step 3: Implement the lazy-insert**

In `apps/desktop/native/src/state/actor/mutations.rs`, replace the slot-resolution block in `apply_update_layer_param_track` (currently):

```rust
    let slot = crate::state::layer::resolve_animated_f64_mut_on_layer(
        &mut project.tracks[ti].layers[li],
        param_key,
    )
    .ok_or_else(|| CommandError::UnknownKeyframeParam { layer: id, param_key: param_key.to_string() })?;
    *slot = track;
```

with:

```rust
    let layer = &mut project.tracks[ti].layers[li];
    // Effect params are created lazily: a freshly-added effect has an empty
    // params map, so the first track write to a known effect-param path inserts
    // the slot rather than rejecting (the placeholder is overwritten just below).
    // Non-effect unknown keys (e.g. "bogus") still reject.
    if crate::state::layer::resolve_animated_f64_mut_on_layer(layer, param_key).is_none() {
        if let Some((effect_id, param)) = crate::state::layer::parse_effect_param_key(param_key) {
            if let Some(e) = layer.effects.iter_mut().find(|e| e.id == effect_id) {
                e.params.entry(param).or_insert(Animated::Static(0.0));
            }
        }
    }
    let slot = crate::state::layer::resolve_animated_f64_mut_on_layer(layer, param_key)
        .ok_or_else(|| CommandError::UnknownKeyframeParam { layer: id, param_key: param_key.to_string() })?;
    *slot = track;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib --features motifs update_param_track_ -- --exact` is not needed; use `cargo test --lib --features motifs update_param_track`
Expected: PASS (both new tests). Also run `cargo test --lib --features motifs apply_update_layer_param_track` to confirm no regression in the existing param-track tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/state/actor/mutations.rs apps/desktop/native/src/state/actor/tests.rs
git commit -m "feat(effects): lazily create absent effect-param slot on first track write"
```

---

### Task 2: Backend — renderer command bridge for the 4 effect commands

**Files:**
- Modify: `apps/desktop/native/src/commands/mod.rs` (Args structs, near the other `*Args` ~line 720)
- Modify: `apps/desktop/native/src/commands/mutations.rs` (wrappers, after `update_layer_param_tracks` ~line 421)
- Modify: `apps/desktop/native/src/napi_backend.rs` (dispatch arms near `update_layer_params` ~line 413; tests in the `#[cfg(test)] mod`)

**Interfaces:**
- Consumes: actor methods `add_effect/update_effect/move_effect/remove_effect` (actor.rs:1275-1331), `crate::state::effect::{Effect, EffectPatch}`, `crate::state::ids::new_id`, `Actor::User`, `Backend::project()`.
- Produces (renderer-callable commands): `add_effect{layerId,kind}->String(id)`, `update_effect{layerId,effectId,patch}`, `move_effect{layerId,effectId,newIndex}`, `remove_effect{layerId,effectId}`.

- [ ] **Step 1: Write the failing dispatch tests**

In `apps/desktop/native/src/napi_backend.rs`, inside the `#[cfg(test)] mod tests`, add:

```rust
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_effect_command_appends_blur_to_layer() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        // Create a layer via an existing demo command, then read its id from the summary.
        b.dispatch("add_demo_color_layer", "{}").await.unwrap();
        let summary = b.dispatch("project_summary", "{}").await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&summary).unwrap();
        let layer_id = v["tracks"]
            .as_array().unwrap().iter()
            .flat_map(|t| t["layers"].as_array().unwrap().clone())
            .next().expect("a layer")["id"].as_str().unwrap().to_string();

        let args = format!(r#"{{"layerId":"{layer_id}","kind":"blur"}}"#);
        let effect_id = b.dispatch("add_effect", &args).await.unwrap();
        assert!(effect_id.contains('-'), "expected a uuid string, got {effect_id}");

        let after = b.dispatch("project_summary", "{}").await.unwrap();
        assert!(after.contains("\"kind\":\"blur\"") || after.contains("\"kind\": \"blur\""));
    }

    #[tokio::test]
    async fn add_effect_command_rejects_bad_layer_id() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let err = b.dispatch("add_effect", r#"{"layerId":"not-a-uuid","kind":"blur"}"#).await;
        assert!(err.is_err());
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --lib --features motifs add_effect_command`
Expected: FAIL — `dispatch("add_effect", …)` returns `Err("unknown command: add_effect")` (no arm yet).

- [ ] **Step 3: Add the Args structs**

In `apps/desktop/native/src/commands/mod.rs`, near the other mutation Args (~line 720), add:

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddEffectArgs {
    pub layer_id: String,
    pub kind: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEffectArgs {
    pub layer_id: String,
    pub effect_id: String,
    pub patch: crate::state::effect::EffectPatch,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveEffectArgs {
    pub layer_id: String,
    pub effect_id: String,
    pub new_index: usize,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveEffectArgs {
    pub layer_id: String,
    pub effect_id: String,
}
```

- [ ] **Step 4: Add the command wrappers**

In `apps/desktop/native/src/commands/mutations.rs`, after `update_layer_param_tracks` (~line 421), add (the `Backend`, `Actor`, `Uuid`, `CommandError` imports are already in scope in this file — they back `update_layer_params`):

```rust
/// Append an effect (catalog `kind`) to a layer's chain. The effect starts with
/// empty params; the renderer seeds defaults lazily on first param edit
/// (apply_update_layer_param_track). Returns the new effect id. Mirrors the
/// `add_effect` MCP tool but for the renderer's invoke() path.
pub async fn add_effect(backend: &Backend, layer_id: String, kind: String) -> Result<String, String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let effect = crate::state::effect::Effect {
        id: crate::state::ids::new_id(),
        kind,
        enabled: true,
        params: std::collections::BTreeMap::new(),
    };
    handle
        .add_effect(Actor::User, id, effect)
        .await
        .map(|eid| eid.to_string())
        .map_err(|e: CommandError| e.to_string())
}

/// Patch an effect (`{ enabled?, params? }`). The UI uses only `enabled`; param
/// edits go through update_layer_param_track.
pub async fn update_effect(
    backend: &Backend,
    layer_id: String,
    effect_id: String,
    patch: crate::state::effect::EffectPatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let eid = Uuid::parse_str(&effect_id).map_err(|e| format!("effect_id: {e}"))?;
    handle
        .update_effect(Actor::User, lid, eid, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Reorder an effect within its layer's chain (0 = applied first).
pub async fn move_effect(
    backend: &Backend,
    layer_id: String,
    effect_id: String,
    new_index: usize,
) -> Result<(), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let eid = Uuid::parse_str(&effect_id).map_err(|e| format!("effect_id: {e}"))?;
    handle
        .move_effect(Actor::User, lid, eid, new_index)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Remove an effect from a layer's chain by id.
pub async fn remove_effect(backend: &Backend, layer_id: String, effect_id: String) -> Result<(), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let eid = Uuid::parse_str(&effect_id).map_err(|e| format!("effect_id: {e}"))?;
    handle
        .remove_effect(Actor::User, lid, eid)
        .await
        .map_err(|e: CommandError| e.to_string())
}
```

- [ ] **Step 5: Add the napi dispatch arms**

In `apps/desktop/native/src/napi_backend.rs`, alongside the `update_layer_params` arm (~line 413), add:

```rust
            "add_effect" => {
                let a: crate::commands::AddEffectArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::add_effect(self, a.layer_id, a.kind).await)
            }
            "update_effect" => {
                let a: crate::commands::UpdateEffectArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::update_effect(self, a.layer_id, a.effect_id, a.patch).await)
            }
            "move_effect" => {
                let a: crate::commands::MoveEffectArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::move_effect(self, a.layer_id, a.effect_id, a.new_index).await)
            }
            "remove_effect" => {
                let a: crate::commands::RemoveEffectArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::remove_effect(self, a.layer_id, a.effect_id).await)
            }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --lib --features motifs add_effect_command`
Expected: PASS (both).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/native/src/commands/mod.rs apps/desktop/native/src/commands/mutations.rs apps/desktop/native/src/napi_backend.rs
git commit -m "feat(effects): renderer-callable add/update/move/remove_effect commands"
```

---

### Task 3: TS IPC wrappers + `EffectPatch` type

**Files:**
- Modify: `apps/desktop/src/renderer/ipc/index.ts` (add `EffectPatch` near `EffectView` ~line 82; add wrappers near `updateLayerParams` ~line 856)
- Test: `apps/desktop/src/renderer/ipc/effects.test.ts` (NEW)

**Interfaces:**
- Consumes: `invoke` from `@/bridge/ipc`, `AnimTrack<number>`.
- Produces: `addEffect(layerId,kind):Promise<string>`, `updateEffect(layerId,effectId,patch:EffectPatch):Promise<void>`, `moveEffect(layerId,effectId,newIndex):Promise<void>`, `removeEffect(layerId,effectId):Promise<void>`, `interface EffectPatch { enabled?: boolean; params?: Record<string, AnimTrack<number>> }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/renderer/ipc/effects.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/bridge/ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/bridge/events", () => ({ listen: vi.fn() }));

import { addEffect, updateEffect, moveEffect, removeEffect } from "./index";

describe("effect IPC wrappers", () => {
  it("addEffect sends camelCase layerId + kind and returns the id", async () => {
    invoke.mockResolvedValue("e1");
    const id = await addEffect("L1", "blur");
    expect(invoke).toHaveBeenCalledWith("add_effect", { layerId: "L1", kind: "blur" });
    expect(id).toBe("e1");
  });
  it("updateEffect sends layerId, effectId, patch", async () => {
    invoke.mockResolvedValue(undefined);
    await updateEffect("L1", "E1", { enabled: false });
    expect(invoke).toHaveBeenCalledWith("update_effect", {
      layerId: "L1",
      effectId: "E1",
      patch: { enabled: false },
    });
  });
  it("moveEffect sends a 0-based newIndex", async () => {
    invoke.mockResolvedValue(undefined);
    await moveEffect("L1", "E1", 0);
    expect(invoke).toHaveBeenCalledWith("move_effect", { layerId: "L1", effectId: "E1", newIndex: 0 });
  });
  it("removeEffect sends layerId + effectId", async () => {
    invoke.mockResolvedValue(undefined);
    await removeEffect("L1", "E1");
    expect(invoke).toHaveBeenCalledWith("remove_effect", { layerId: "L1", effectId: "E1" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- src/renderer/ipc/effects.test.ts`
Expected: FAIL — `addEffect` (etc.) is not exported from `./index`.

- [ ] **Step 3: Add the type + wrappers**

In `apps/desktop/src/renderer/ipc/index.ts`, after the `EffectView` interface (~line 82) add:

```ts
/// Partial update for an effect — mirrors Rust `EffectPatch`. The UI uses only
/// `enabled` through this path; param edits (incl. keyframes) go through
/// `updateLayerParamTrack` with key `effects[<id>].params[<key>]`.
export interface EffectPatch {
  enabled?: boolean;
  params?: Record<string, AnimTrack<number>>;
}
```

Then, near `updateLayerParams` (~line 856), add:

```ts
/// Append a catalog effect (`kind`) to a layer's chain; returns the new effect id.
export async function addEffect(layerId: string, kind: string): Promise<string> {
  return invoke<string>("add_effect", { layerId, kind });
}

/// Patch an effect (enabled flag and/or scalar params).
export async function updateEffect(
  layerId: string,
  effectId: string,
  patch: EffectPatch,
): Promise<void> {
  return invoke<void>("update_effect", { layerId, effectId, patch });
}

/// Reorder an effect within its layer's chain (0 = applied first).
export async function moveEffect(layerId: string, effectId: string, newIndex: number): Promise<void> {
  return invoke<void>("move_effect", { layerId, effectId, newIndex });
}

/// Remove an effect from a layer's chain by id.
export async function removeEffect(layerId: string, effectId: string): Promise<void> {
  return invoke<void>("remove_effect", { layerId, effectId });
}
```

- [ ] **Step 4: Run to verify they pass + typecheck**

Run: `npm test -- src/renderer/ipc/effects.test.ts` → Expected: PASS (4 tests).
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/ipc/index.ts apps/desktop/src/renderer/ipc/effects.test.ts
git commit -m "feat(effects): TS IPC wrappers for the effect commands"
```

---

### Task 4: Catalog enumeration — `listEffects()` + `step` + `nameI18nKey`

**Files:**
- Modify: `apps/desktop/src/renderer/render/effects/effectRegistry.ts`
- Test: `apps/desktop/src/renderer/render/effects/effectRegistry.test.ts`

**Interfaces:**
- Produces: `listEffects(): EffectDescriptor[]`; `EffectParamSpec.step?: number`; the blur descriptor's `nameI18nKey` becomes `"effects.blur.name"` and its `strength` spec gains `step: 1`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/renderer/render/effects/effectRegistry.test.ts`:

```ts
import { listEffects } from "./effectRegistry";

describe("listEffects", () => {
  it("returns the catalog including blur", () => {
    expect(listEffects().map((d) => d.kind)).toContain("blur");
  });
  it("blur strength carries a step and a [0,100] range", () => {
    const blur = listEffects().find((d) => d.kind === "blur")!;
    expect(blur.params.strength.step).toBe(1);
    expect(blur.params.strength.range).toEqual([0, 100]);
  });
  it("blur name i18n key is a nested leaf (effects.blur.name)", () => {
    const blur = listEffects().find((d) => d.kind === "blur")!;
    expect(blur.nameI18nKey).toBe("effects.blur.name");
  });
});
```

(The existing `effectRegistry.test.ts` already imports from `vitest` and `./effectRegistry`; reuse that `describe`/`it`/`expect` import — do not duplicate it.)

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- src/renderer/render/effects/effectRegistry.test.ts`
Expected: FAIL — `listEffects` not exported; `step` undefined; `nameI18nKey` is `"effects.blur"`.

- [ ] **Step 3: Implement**

In `apps/desktop/src/renderer/render/effects/effectRegistry.ts`:

Add `step?: number` to the param spec:

```ts
export interface EffectParamSpec {
  default: number;
  range?: [number, number];
  /// Number-field / slider step. Absent ⇒ the UI derives one from the range
  /// width (≤10 → 0.1, else 1).
  step?: number;
  apply(filter: Filter, value: number): void;
}
```

Change the blur descriptor's `nameI18nKey` and add `step: 1`:

```ts
  blur: {
    kind: "blur",
    nameI18nKey: "effects.blur.name",
    create: () => new BlurFilter({ strength: 8 }),
    params: {
      strength: {
        default: 8,
        range: [0, 100],
        step: 1,
        apply: (f, v) => {
          (f as BlurFilter).strength = v;
        },
      },
    },
    fidelity: "f16-verified",
    colorspace: "display-gamma",
  },
```

Add, after `getDescriptor`:

```ts
/// All catalog entries, for the add-effect picker and the param-row generator.
/// The UI is fully data-driven off this — a new filter is one REGISTRY entry,
/// zero UI change.
export function listEffects(): EffectDescriptor[] {
  return Object.values(REGISTRY);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- src/renderer/render/effects/effectRegistry.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/effects/effectRegistry.ts apps/desktop/src/renderer/render/effects/effectRegistry.test.ts
git commit -m "feat(effects): enumerate the effect catalog (listEffects) + param step"
```

---

### Task 5: `EffectsSection` structural UI + i18n

The chain list + add picker + per-effect enable / reorder / remove. No param rows yet (Task 6 adds them).

**Files:**
- Create: `apps/desktop/src/renderer/properties/EffectsSection.tsx`
- Create: `apps/desktop/src/renderer/properties/EffectsSection.test.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/en-US.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: `addEffect/updateEffect/moveEffect/removeEffect`, `EffectView`, `LayerSummary` (from `../ipc`); `listEffects` (from `../render/effects/effectRegistry`); `AppSelect`, `AppSwitch`, `Button`.
- Produces: `export function EffectsSection({ layer, tInLayerUs, playheadInSpan, onMutated })`.

- [ ] **Step 1: Write the failing component tests**

Create `apps/desktop/src/renderer/properties/EffectsSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const addEffect = vi.fn(async () => "new-id");
const updateEffect = vi.fn(async () => {});
const moveEffect = vi.fn(async () => {});
const removeEffect = vi.fn(async () => {});
vi.mock("../ipc", () => ({ addEffect, updateEffect, moveEffect, removeEffect }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));

import { EffectsSection } from "./EffectsSection";
import type { EffectView, LayerSummary } from "../ipc";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function layerWith(effects: EffectView[]): LayerSummary {
  return { id: "L1", effects } as unknown as LayerSummary;
}
const blur = (id: string, enabled = true): EffectView => ({
  id,
  kind: "blur",
  enabled,
  params: { strength: { mode: "Static", value: 8 } },
});
const onMutated = vi.fn(async () => {});

describe("EffectsSection", () => {
  it("renders one row per effect, named from the catalog", () => {
    render(<EffectsSection layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    // effects.blur.name has no translation in the mock → falls back to defaultValue "blur".
    expect(screen.getByText("blur")).toBeTruthy();
  });

  it("clicking Add calls addEffect with the selected (default) kind", async () => {
    render(<EffectsSection layer={layerWith([])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-add"));
    expect(addEffect).toHaveBeenCalledWith("L1", "blur");
  });

  it("toggling enable calls updateEffect with the negated flag", async () => {
    render(<EffectsSection layer={layerWith([blur("E1", true)])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-enable-0"));
    expect(updateEffect).toHaveBeenCalledWith("L1", "E1", { enabled: false });
  });

  it("remove calls removeEffect", async () => {
    render(<EffectsSection layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-remove-0"));
    expect(removeEffect).toHaveBeenCalledWith("L1", "E1");
  });

  it("up is disabled at index 0; down moves to index+1", async () => {
    render(
      <EffectsSection layer={layerWith([blur("E1"), blur("E2")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    expect((screen.getByTestId("effect-up-0") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("effect-down-0"));
    expect(moveEffect).toHaveBeenCalledWith("L1", "E1", 1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- src/renderer/properties/EffectsSection.test.tsx`
Expected: FAIL — `./EffectsSection` does not exist.

- [ ] **Step 3: Implement `EffectsSection.tsx`**

Create `apps/desktop/src/renderer/properties/EffectsSection.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AppSelect } from "../components/AppSelect";
import { AppSwitch } from "../components/AppSwitch";
import { Button } from "@/components/ui/button";
import { addEffect, updateEffect, moveEffect, removeEffect, type EffectView, type LayerSummary } from "../ipc";
import { listEffects } from "../render/effects/effectRegistry";

interface Props {
  layer: LayerSummary;
  /// Playhead relative to the layer's t_start; forwarded to the keyframe rows.
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}

/// Per-layer effect chain editor. Data-driven off the effect catalog
/// (`listEffects`): the add picker, the row names, and (Task 6) the param rows
/// all come from the registry, so a new filter is zero UI change. Rendered by
/// PropertyPanel for visual layer kinds only.
export function EffectsSection({ layer, tInLayerUs, playheadInSpan, onMutated }: Props) {
  const { t } = useTranslation();
  const catalog = listEffects();
  const [pendingKind, setPendingKind] = useState(catalog[0]?.kind ?? "");
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    setErr(null);
    addEffect(layer.id, pendingKind).then(onMutated).catch((e) => setErr(String(e)));
  };

  return (
    <section className="prop-section">
      <h3>{t("effects.heading")}</h3>
      {layer.effects.map((eff, i) => (
        <EffectRow
          key={eff.id}
          layer={layer}
          effect={eff}
          index={i}
          count={layer.effects.length}
          tInLayerUs={tInLayerUs}
          playheadInSpan={playheadInSpan}
          onMutated={onMutated}
        />
      ))}
      <div className="prop-effect-add">
        <AppSelect
          value={pendingKind}
          ariaLabel={t("effects.add")}
          onValueChange={setPendingKind}
          options={catalog.map((d) => ({ value: d.kind, label: t(d.nameI18nKey, { defaultValue: d.kind }) }))}
        />
        <Button size="sm" data-testid="effect-add" disabled={!pendingKind} onClick={add}>
          {t("effects.add")}
        </Button>
      </div>
      {err && <p className="settings-error">{err}</p>}
    </section>
  );
}

function EffectRow({
  layer,
  effect,
  index,
  count,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  index: number;
  count: number;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  const name = t(`effects.${effect.kind}.name`, { defaultValue: effect.kind });
  // tInLayerUs / playheadInSpan are threaded through for Task 6's param rows.
  void tInLayerUs;
  void playheadInSpan;

  const run = (fn: () => Promise<unknown>) => () => {
    setErr(null);
    fn().then(onMutated).catch((e) => setErr(String(e)));
  };

  return (
    <div className="prop-effect-row" data-testid={`effect-row-${index}`}>
      <div className="prop-effect-head">
        <span className="prop-effect-name">{name}</span>
        <AppSwitch
          checked={effect.enabled}
          data-testid={`effect-enable-${index}`}
          ariaLabel={t("effects.enable", { name })}
          onCheckedChange={(next) => run(() => updateEffect(layer.id, effect.id, { enabled: next }))()}
        />
        <Button
          size="sm"
          data-testid={`effect-up-${index}`}
          ariaLabel={t("effects.move_up")}
          disabled={index === 0}
          onClick={run(() => moveEffect(layer.id, effect.id, index - 1))}
        >
          ↑
        </Button>
        <Button
          size="sm"
          data-testid={`effect-down-${index}`}
          ariaLabel={t("effects.move_down")}
          disabled={index === count - 1}
          onClick={run(() => moveEffect(layer.id, effect.id, index + 1))}
        >
          ↓
        </Button>
        <Button
          size="sm"
          data-testid={`effect-remove-${index}`}
          ariaLabel={t("effects.remove", { name })}
          onClick={run(() => removeEffect(layer.id, effect.id))}
        >
          ✕
        </Button>
      </div>
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}
```

> Note: if `AppSwitch` / `Button` do not forward `data-testid`, switch those test queries to `getByRole`/`getByLabelText` using the aria-labels — but verify forwarding first, since the e2e (Task 8) relies on these testids. If a primitive drops unknown props, wrap the control in a `<span data-testid=…>`.

- [ ] **Step 4: Add i18n keys**

In `apps/desktop/src/renderer/i18n/locales/en-US.ts`, add an `effects` entry to the translation object (mirror the nesting style of the existing `property_panel` entry):

```ts
  effects: {
    heading: "Effects",
    add: "Add effect",
    enable: "Toggle {{name}}",
    move_up: "Move up",
    move_down: "Move down",
    remove: "Remove {{name}}",
    blur: {
      name: "Blur",
      params: { strength: "Strength" },
    },
  },
```

In `zh-CN.ts`, the same shape with Chinese values:

```ts
  effects: {
    heading: "效果",
    add: "添加效果",
    enable: "切换 {{name}}",
    move_up: "上移",
    move_down: "下移",
    remove: "移除 {{name}}",
    blur: {
      name: "模糊",
      params: { strength: "强度" },
    },
  },
```

- [ ] **Step 5: Run to verify they pass + typecheck**

Run: `npm test -- src/renderer/properties/EffectsSection.test.tsx` → Expected: PASS (5).
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/properties/EffectsSection.tsx apps/desktop/src/renderer/properties/EffectsSection.test.tsx apps/desktop/src/renderer/i18n/locales/en-US.ts apps/desktop/src/renderer/i18n/locales/zh-CN.ts
git commit -m "feat(effects): EffectsSection chain UI (add/enable/reorder/remove) + i18n"
```

---

### Task 6: `EffectParamField` — keyframe-capable param rows

Adds the per-param rows under each effect row, reusing the shared `KeyframeField` (so params keyframe exactly like transform/opacity).

**Files:**
- Create: `apps/desktop/src/renderer/properties/EffectParamField.tsx`
- Create: `apps/desktop/src/renderer/properties/EffectParamField.test.tsx`
- Modify: `apps/desktop/src/renderer/properties/EffectsSection.tsx` (render `<EffectParamFields>` in `EffectRow`)
- Modify: `apps/desktop/src/renderer/properties/EffectsSection.test.tsx` (mock the param module to keep the structural test isolated)

**Interfaces:**
- Consumes: `KeyframeField` (`../components/KeyframeField`), `updateLayerParamTrack`, `AnimTrack`, `EffectView`, `LayerSummary` (from `../ipc`), `getDescriptor`, `EffectParamSpec` (from `../render/effects/effectRegistry`).
- Produces: `export function EffectParamFields({ layer, effect, tInLayerUs, playheadInSpan, onMutated })`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/properties/EffectParamField.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const updateLayerParamTrack = vi.fn(async () => {});
vi.mock("../ipc", () => ({ updateLayerParamTrack }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));
// Isolate from KeyframeField internals: a stub that surfaces the wired props
// and lets the test fire onCommitTrack.
vi.mock("../components/KeyframeField", () => ({
  KeyframeField: (props: {
    paramKey: string;
    label: string;
    track: { mode: string; value: number };
    onCommitTrack: (k: string, t: { mode: "Static"; value: number }) => void;
  }) => (
    <button
      data-testid={`kf-${props.paramKey}`}
      onClick={() => props.onCommitTrack(props.paramKey, { mode: "Static", value: 42 })}
    >
      {props.label}:{props.track.mode === "Static" ? props.track.value : "kf"}
    </button>
  ),
}));

import { EffectParamFields } from "./EffectParamField";
import type { EffectView, LayerSummary } from "../ipc";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const layer = { id: "L1" } as unknown as LayerSummary;
const onMutated = vi.fn(async () => {});

describe("EffectParamFields", () => {
  it("renders a row per registry param, reading the effect's current value", () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: { strength: { mode: "Static", value: 8 } } };
    render(<EffectParamFields layer={layer} effect={effect} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    // label "strength" (defaultValue) : value 8
    expect(screen.getByText("strength:8")).toBeTruthy();
  });

  it("falls back to the registry default when the param slot is absent", () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: {} };
    render(<EffectParamFields layer={layer} effect={effect} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    expect(screen.getByText("strength:8")).toBeTruthy(); // blur default
  });

  it("commits to the nested effects[id].params[key] track key", async () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: {} };
    render(<EffectParamFields layer={layer} effect={effect} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("kf-effects[E1].params[strength]"));
    expect(updateLayerParamTrack).toHaveBeenCalledWith("L1", "effects[E1].params[strength]", { mode: "Static", value: 42 });
  });

  it("renders nothing for an unknown kind", () => {
    const effect: EffectView = { id: "E1", kind: "mystery", enabled: true, params: {} };
    const { container } = render(
      <EffectParamFields layer={layer} effect={effect} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    expect(container.querySelector("[data-testid^='kf-']")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/renderer/properties/EffectParamField.test.tsx`
Expected: FAIL — `./EffectParamField` does not exist.

- [ ] **Step 3: Implement `EffectParamField.tsx`**

Create `apps/desktop/src/renderer/properties/EffectParamField.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { KeyframeField } from "../components/KeyframeField";
import { updateLayerParamTrack, type AnimTrack, type EffectView, type LayerSummary } from "../ipc";
import { getDescriptor, type EffectParamSpec } from "../render/effects/effectRegistry";

/// One keyframe-capable row per registry param of `effect`, reusing the shared
/// KeyframeField (stopwatch + auto-key) exactly like the transform/opacity rows.
/// The wire key is `effects[<id>].params[<key>]`, which `update_layer_param_track`
/// resolves and lazily creates on first write. Unknown kinds (absent from the
/// catalog) render no params.
export function EffectParamFields({
  layer,
  effect,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const desc = getDescriptor(effect.kind);
  if (!desc) return null;
  return (
    <>
      {Object.entries(desc.params).map(([key, spec]) => (
        <EffectParamField
          key={key}
          layer={layer}
          effect={effect}
          paramName={key}
          spec={spec}
          tInLayerUs={tInLayerUs}
          playheadInSpan={playheadInSpan}
          onMutated={onMutated}
        />
      ))}
    </>
  );
}

function EffectParamField({
  layer,
  effect,
  paramName,
  spec,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  paramName: string;
  spec: EffectParamSpec;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const paramKey = `effects[${effect.id}].params[${paramName}]`;
  // Absent slot ⇒ show the registry default; the first commit lazily creates it.
  const track: AnimTrack<number> = effect.params[paramName] ?? { mode: "Static", value: spec.default };
  const label = t(`effects.${effect.kind}.params.${paramName}`, { defaultValue: paramName });
  const step = spec.step ?? (spec.range && spec.range[1] - spec.range[0] <= 10 ? 0.1 : 1);
  // Wrapper carries a stable testid (effect id + param) so the e2e can target
  // this exact field; KeyframeField/AppNumberField don't take a testid prop.
  return (
    <div className="prop-effect-param" data-testid={`effect-param-${effect.id}-${paramName}`}>
      <KeyframeField
        layerId={layer.id}
        paramKey={paramKey}
        label={label}
        track={track}
        fallback={spec.default}
        tInLayerUs={tInLayerUs}
        playheadInSpan={playheadInSpan}
        onCommitTrack={(k, next) => updateLayerParamTrack(layer.id, k, next).then(onMutated).catch((e) => console.warn(e))}
        onMutated={onMutated}
        widgets={["number"]}
        step={step}
        {...(spec.range ? { min: spec.range[0], max: spec.range[1] } : {})}
      />
    </div>
  );
}
```

- [ ] **Step 4: Wire into `EffectRow` and isolate the structural test**

In `EffectsSection.tsx`, import the param fields:

```tsx
import { EffectParamFields } from "./EffectParamField";
```

In `EffectRow`, remove the two `void tInLayerUs; void playheadInSpan;` lines and render the param fields after the `.prop-effect-head` div, before the error `<p>`:

```tsx
      <EffectParamFields
        layer={layer}
        effect={effect}
        tInLayerUs={tInLayerUs}
        playheadInSpan={playheadInSpan}
        onMutated={onMutated}
      />
```

In `EffectsSection.test.tsx`, add this mock near the other `vi.mock` calls so the structural test stays isolated from KeyframeField:

```tsx
vi.mock("./EffectParamField", () => ({ EffectParamFields: () => null }));
```

- [ ] **Step 5: Run to verify everything passes + typecheck**

Run: `npm test -- src/renderer/properties/EffectParamField.test.tsx` → Expected: PASS (4).
Run: `npm test -- src/renderer/properties/EffectsSection.test.tsx` → Expected: PASS (still 5, now with the param mock).
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/properties/EffectParamField.tsx apps/desktop/src/renderer/properties/EffectParamField.test.tsx apps/desktop/src/renderer/properties/EffectsSection.tsx apps/desktop/src/renderer/properties/EffectsSection.test.tsx
git commit -m "feat(effects): keyframe-capable effect param rows (EffectParamField)"
```

---

### Task 7: Wire `EffectsSection` into `PropertyPanel` for visual kinds

**Files:**
- Modify: `apps/desktop/src/renderer/properties/PropertyPanel.tsx` (KindFields; remove the stale line-45 comment; export `isVisualKind`)
- Test: `apps/desktop/src/renderer/properties/visualKind.test.ts` (NEW)

**Interfaces:**
- Consumes: `EffectsSection` (from `./EffectsSection`).
- Produces: `export function isVisualKind(kind: string): boolean`; `KindFields` renders `<EffectsSection>` after the kind body for visual kinds.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/properties/visualKind.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isVisualKind } from "./PropertyPanel";

describe("isVisualKind", () => {
  it("is true for the five visual kinds", () => {
    for (const k of ["Text", "VideoClip", "ImageOverlay", "Color", "Motif"]) {
      expect(isVisualKind(k)).toBe(true);
    }
  });
  it("is false for Audio and anything else", () => {
    expect(isVisualKind("Audio")).toBe(false);
    expect(isVisualKind("Whatever")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/renderer/properties/visualKind.test.ts`
Expected: FAIL — `isVisualKind` not exported.

- [ ] **Step 3: Implement**

In `apps/desktop/src/renderer/properties/PropertyPanel.tsx`:

Add the import near the other imports:

```tsx
import { EffectsSection } from "./EffectsSection";
```

Remove the stale comment at line 45 (`// No EffectsSection here — effect editing isn't part of this panel.`).

Add the exported gate (e.g. just above `KindFields`):

```tsx
/// Effects render on visual sprite kinds only (not Audio), so the EffectsSection
/// shows for exactly these. An allowlist (not `!== "Audio"`) keeps a future
/// non-visual kind from wrongly getting effects.
export function isVisualKind(kind: string): boolean {
  return (
    kind === "Text" ||
    kind === "VideoClip" ||
    kind === "ImageOverlay" ||
    kind === "Color" ||
    kind === "Motif"
  );
}
```

Refactor `KindFields` so the kind body is computed, then the effects section is appended for visual kinds. Replace the `switch (layer.params.kind) { … }` return with:

```tsx
  const body = ((): React.ReactNode => {
    switch (layer.params.kind) {
      case "Text":
        return <TextFields layer={layer} v={layer.params} commit={commit} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />;
      case "VideoClip":
        return <VideoClipFields layer={layer} v={layer.params} commit={commit} fpsNum={fpsNum} fpsDen={fpsDen} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />;
      case "ImageOverlay":
        return <ImageOverlayFields layer={layer} v={layer.params} commit={commit} fpsNum={fpsNum} fpsDen={fpsDen} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />;
      case "Color":
        return <ColorFields v={layer.params} commit={commit} />;
      case "Audio":
        return <AudioFields layer={layer} v={layer.params} commit={commit} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />;
      case "Motif":
        return <MotifFields layer={layer} v={layer.params} commit={commit} onMutated={onMutated} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} />;
    }
  })();

  return (
    <>
      {body}
      {isVisualKind(layer.params.kind) && (
        <EffectsSection layer={layer} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      )}
    </>
  );
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npm test -- src/renderer/properties/visualKind.test.ts` → Expected: PASS (2).
Run: `npm run typecheck` → Expected: no errors.
Run the existing inspector tests to confirm no regression: `npm test -- src/renderer/properties/`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/properties/PropertyPanel.tsx apps/desktop/src/renderer/properties/visualKind.test.ts
git commit -m "feat(effects): show EffectsSection in the inspector for visual kinds"
```

---

### Task 8: Electron e2e — UI-driven effects

Drives the actual panel (not MCP): select a layer, add a blur via the panel button, edit strength, reorder, toggle, remove — asserting through the project summary, plus a composite sample to confirm the blur renders.

**Files:**
- Modify: `apps/desktop/e2e/electron/effects-smoke.spec.ts` (add one test; reuse the file's `connectMcp`-free helpers `launchApp/newProject/invokeCmd/summary` + the `sampleAt` helper + `effectsOf`)

**Interfaces:**
- Consumes: `window.__weftcutTest.revealLayer({ layerId })` (selects the layer so the inspector shows it), the Task 5/6 testids (`effect-add`, `effect-enable-<i>`, `effect-up-<i>`, `effect-down-<i>`, `effect-remove-<i>`, `kf-effects[<id>].params[strength]`).

- [ ] **Step 1: Add the UI-driven test**

Append to `apps/desktop/e2e/electron/effects-smoke.spec.ts` (the imports `launchApp,newProject,invokeCmd,summary` and helpers `effectsOf`,`sampleAt` already exist at the top of the file):

```ts
test('effects UI: add/edit/reorder/remove a blur from the inspector panel', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-effects-ui-'))
  await newProject(page, {
    parentFolder: parent,
    name: 'effects-ui',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  const trackId = await invokeCmd<string>(page, 'add_track', {})
  const layerId = await invokeCmd<string>(page, 'add_text_layer', {
    trackId,
    content: 'BLUR UI TEST',
    tStartUs: 0,
    durationUs: 2_000_000,
  })

  // Warm the sharp baseline (text composited, no effect yet).
  let sharp: Sample | null = null
  {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const s0 = await sampleAt(page, 500_000, 320, 180)
      if (s0.nonTransparent > 100) { sharp = s0; break }
      await page.waitForTimeout(400)
    }
  }
  if (!sharp) throw new Error('text never composited (warmup failed)')

  // Select the layer so the inspector renders its EffectsSection.
  await page.evaluate((id) => (window as any).__weftcutTest.revealLayer({ layerId: id }), layerId)

  // Add a blur via the panel button.
  await page.getByTestId('effect-add').click()
  await expect.poll(async () => (effectsOf((await summary(page)) as any, layerId) as Array<{ kind: string }>).length).toBe(1)
  let fx = effectsOf((await summary(page)) as any, layerId) as Array<{ kind: string; id: string; enabled: boolean; params: any }>
  expect(fx[0]!.kind).toBe('blur')
  const effectId = fx[0]!.id

  // Edit strength through the param field (commits on blur/Enter → nested track key).
  const strength = page.getByTestId(`effect-param-${effectId}-strength`).locator('input')
  await strength.fill('30')
  await strength.press('Enter')
  await expect.poll(async () => {
    const f = effectsOf((await summary(page)) as any, layerId) as Array<{ params: any }>
    return f[0]?.params?.strength?.value ?? null
  }).toBe(30)

  // The blur measurably changes the composite vs the sharp baseline.
  await page.waitForTimeout(800)
  let blur = await sampleAt(page, 500_000, 320, 180)
  {
    const deadline = Date.now() + 6_000
    while (blur.nonTransparent === sharp.nonTransparent && Date.now() < deadline) {
      await page.waitForTimeout(400)
      blur = await sampleAt(page, 500_000, 320, 180)
    }
  }
  expect(blur.nonTransparent).not.toBe(sharp.nonTransparent)

  // Disable via the toggle → enabled:false in state.
  await page.getByTestId('effect-enable-0').click()
  await expect.poll(async () => {
    const f = effectsOf((await summary(page)) as any, layerId) as Array<{ enabled: boolean }>
    return f[0]?.enabled
  }).toBe(false)

  // Remove via the panel → chain empties.
  await page.getByTestId('effect-remove-0').click()
  await expect.poll(async () => (effectsOf((await summary(page)) as any, layerId) as unknown[]).length).toBe(0)

  await app.close()
})
```

> The `effect-enable-0` toggle is a Base UI Switch; if `.click()` on the testid element doesn't flip it, target the inner control (`page.getByTestId('effect-enable-0').locator('button, [role=switch]')`). The strength input selector assumes `AppNumberField` renders a single `<input>` inside the KeyframeField — confirm against the running app and adjust the `.locator('input')` if the structure differs.

- [ ] **Step 2: Build, then run the e2e**

Run (from `apps/desktop`):
```bash
VITE_WEFTCUT_E2E=1 npm run build && npm run napi:build
npm run e2e:electron -- effects-smoke.spec.ts
```
Expected: PASS — the new UI test plus the two existing MCP-driven tests. (If a testid selector misses, fix per the notes above; a stale bundle is the most common false failure — rebuild.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/electron/effects-smoke.spec.ts
git commit -m "test(effects): UI-driven e2e — add/edit/reorder/remove from the inspector"
```

---

## Final verification

- [ ] `cargo test --lib --features motifs` (from `apps/desktop/native`) — all Rust unit tests pass.
- [ ] `npm test` (from `apps/desktop`) — all vitest suites pass.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run e2e:electron -- effects-smoke.spec.ts` (after the e2e build) — green.
- [ ] Manual smoke (optional): launch the built app, select a layer, add Blur, drag strength, keyframe it via the stopwatch, reorder/remove, undo — confirm the preview updates each step.
