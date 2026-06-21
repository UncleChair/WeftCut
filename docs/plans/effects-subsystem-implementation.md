# Per-layer Effects Subsystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Working plan (ephemeral; delete on consolidation per the docs convention).
> Branch: `feat/effects-subsystem` (worktree `videtor-wt2`).
> Design rationale: `docs/plans/effects-subsystem.md`. Validation PoC: branch `poc/f16-filter-pool`.

**Goal:** Ship a v1 per-layer effects subsystem — a single Blur filter, addable/orderable/removable per layer, keyframeable, visible in preview AND in 10-bit export at full `rgba16float` precision, driven from MCP and undoable.

**Architecture:** Rust owns effect *instances* (an ordered `Vec<Effect>` on `Layer`, each param a keyframeable `Animated<f64>`); the TS renderer owns the *catalog* (`effectRegistry.ts` mapping a `kind` string to a stock Pixi `Filter` factory + param glue). The two join on `kind`. The 10-bit path reuses the unmodified Pixi filter ecosystem by bumping the export Worker realm's global `TexturePool` format to `rgba16float` at init.

**Tech Stack:** Rust (napi-rs core, `imbl`, `serde`, `schemars`, `tokio`), TypeScript renderer (PixiJS v8.18.1, vitest), Playwright `_electron` (GL-parity e2e).

## Global Constraints

- **v1 param type is `Animated<f64>` only** (scalar). `Effect.params: BTreeMap<String, Animated<f64>>`. The broader `ParamValue` sum type (color/bool/enum) is deferred until a filter needs it. Verbatim from the spec: "v1 param types: `Animated<f64>` scalars".
- **v1 catalog is a single filter: `"blur"`** (Pixi `BlurFilter`). Catalog grows filter-by-filter afterward, gated by the GL-parity gate.
- **Working space = output space = gamma-encoded BT.709.** No color management. Filters operate in gamma space.
- **Export-realm pool format is set ONCE at renderer init, before any filtering. NEVER call `TexturePool.clear(true)` on a live `FilterSystem`** (destroys pooled textures the persistent `_globalFilterBindGroup` references → null-resources crash). Landmine proven on branch `poc/f16-filter-pool`.
- **Preview realm stays default 8-bit** (preview is SDR/8-bit per ADR 0022; filters there run 8-bit, WYSIWYG to the limit of what preview can display).
- **`Speed` is out of scope** — time-remapping, not a filter; never in `layer.effects`.
- **Cross-language engine-twin rule:** any new `Animated<T>::value_at` interpolator needs both a Rust and a TS side. v1 reuses the existing `Animated<f64>` path, so **no new twin is introduced.**
- **Rust is permissive about `kind`:** it stores arbitrary `kind` strings and does not validate them; an unknown `kind` is a renderer-side skip + status-log warning. `kind` validity is checked at the TS/MCP boundary.

## File Structure

**Rust (`apps/desktop/native/src/`):**
- `state/effect.rs` — **new.** `Effect` struct, `EffectId`, `EffectPatch`.
- `state/ids.rs` — add `pub type EffectId = Uuid;`.
- `state/layer.rs` — add `effects: Vec<Effect>` to `Layer`; extend `resolve_animated_f64` + add a mutable resolver for `effects[<id>].params[<key>]` paths.
- `state/mutations.rs` — `apply_add_effect`, `apply_update_effect`, `apply_move_effect`, `apply_remove_effect`.
- `state/actor.rs` — 4 `Command` variants, 4 match arms, 4 `do_*` handlers, 4 public async methods.
- `state/actor/tests.rs` — actor-level effect tests.
- `commands/mod.rs` — add `effects` to the layer→view conversion (the place that builds `VideoClipView`, ~line 470).
- `mcp/effects.rs` — **new.** 4 MCP arg structs.
- `mcp/tools.rs` — 4 thin handler fns.
- `mcp/catalog.rs` — register 4 tools in `tool_table!`.

**TypeScript (`apps/desktop/src/renderer/`):**
- `ipc/index.ts` — `EffectView` type; add `effects: EffectView[]` to `LayerSummary`.
- `render/effects/effectRegistry.ts` — **new.** `EffectDescriptor`, the Blur descriptor, `getDescriptor(kind)`.
- `render/effects/EffectChain.ts` — **new.** per-layer filter-instance cache + per-frame param application.
- `render/effects/resolveEffects.ts` — **new.** view `EffectView[]` → resolved-param filter list.
- `render/Compositor.ts` — attach `sprite.filters` in `updateClip`/`updateImage`/`updateColor`/`updateText`; preview-LOD gate.
- `render/worker/exportWorker.ts` — `TexturePool` format bump at init.

**Docs / e2e:**
- `docs/mcp.md` — Effects tool subsection.
- `apps/desktop/e2e/` — `effects_f16_parity.e2e.js` GL-parity gate.

---

## Phase A — Rust backend (data + API)

### Task 1: Effect data model

**Files:**
- Create: `apps/desktop/native/src/state/effect.rs`
- Modify: `apps/desktop/native/src/state/ids.rs` (add `EffectId`)
- Modify: `apps/desktop/native/src/state/layer.rs:17-40` (add `effects` field), and the module's `mod`/`pub use` wiring (`state/mod.rs`)
- Test: in `effect.rs` (`#[cfg(test)]` serde roundtrip)

**Interfaces:**
- Produces: `pub type EffectId = Uuid;`; `pub struct Effect { pub id: EffectId, pub kind: String, pub enabled: bool, pub params: BTreeMap<String, Animated<f64>> }`; `pub struct EffectPatch { pub enabled: Option<bool>, pub params: Option<BTreeMap<String, Animated<f64>>> }`; `Layer.effects: Vec<Effect>`.

- [ ] **Step 1: Write the failing test** — in `state/effect.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::animated::Animated;

    #[test]
    fn effect_serde_roundtrip_static_param() {
        let mut params = std::collections::BTreeMap::new();
        params.insert("strength".to_string(), Animated::Static(8.0));
        let e = Effect { id: crate::state::ids::new_id(), kind: "blur".into(), enabled: true, params };
        let json = serde_json::to_string(&e).unwrap();
        let back: Effect = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, "blur");
        assert!(back.enabled);
        assert!(matches!(back.params.get("strength"), Some(Animated::Static(v)) if *v == 8.0));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml effect_serde_roundtrip`
Expected: FAIL — `effect.rs` / `Effect` does not exist.

- [ ] **Step 3: Write minimal implementation**

`state/ids.rs` — add beside the other `pub type ... = Uuid;` lines:

```rust
pub type EffectId = Uuid;
```

`state/effect.rs` (new):

```rust
//! Per-layer effect instances. Rust stores the ordered instances + animatable
//! params; the TS renderer (effectRegistry.ts) owns the catalog of which filters
//! exist and how to build them. The two join on `kind`. See
//! docs/plans/effects-subsystem.md.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::state::animated::Animated;
use crate::state::ids::EffectId;

/// One effect in a layer's chain. `kind` is the TS-catalog join key; Rust does
/// not validate it. v1 params are scalar `Animated<f64>` only.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Effect {
    pub id: EffectId,
    pub kind: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub params: BTreeMap<String, Animated<f64>>,
}

fn default_true() -> bool {
    true
}

/// Partial update for `update_effect`. Absent fields are left unchanged.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct EffectPatch {
    pub enabled: Option<bool>,
    pub params: Option<BTreeMap<String, Animated<f64>>>,
}
```

`state/mod.rs` — add `mod effect;` and `pub use effect::{Effect, EffectPatch};` (follow the existing `mod`/`pub use` lines).

`state/layer.rs` — add to the `Layer` struct (after `params: LayerParams`):

```rust
    #[serde(default)]
    pub effects: Vec<Effect>,
```

and `use crate::state::effect::Effect;` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml effect_serde_roundtrip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/state/effect.rs apps/desktop/native/src/state/ids.rs apps/desktop/native/src/state/layer.rs apps/desktop/native/src/state/mod.rs
git commit -m "feat(effects): Effect data model + effects field on Layer"
```

---

### Task 2: Mutation helpers

**Files:**
- Modify: `apps/desktop/native/src/state/mutations.rs`
- Test: same file (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `Effect`, `EffectPatch`, `EffectId`, `Layer.effects` (Task 1).
- Produces: `pub fn apply_add_effect(p: &mut Project, layer_id: LayerId, effect: Effect) -> Result<EffectId, CommandError>`; `apply_update_effect(p, layer_id, effect_id, patch) -> Result<(), CommandError>`; `apply_move_effect(p, layer_id, effect_id, new_index: usize) -> Result<(), CommandError>`; `apply_remove_effect(p, layer_id, effect_id) -> Result<(), CommandError>`.

- [ ] **Step 1: Write the failing test** — in `mutations.rs` tests:

```rust
#[test]
fn add_then_move_then_remove_effect() {
    let mut p = test_project_with_one_layer(); // existing helper in this test mod; if absent, build via Project::new_blank + add a color layer
    let layer_id = first_layer_id(&p);

    let e1 = blur_effect(4.0);
    let id1 = apply_add_effect(&mut p, layer_id, e1).unwrap();
    let id2 = apply_add_effect(&mut p, layer_id, blur_effect(8.0)).unwrap();
    assert_eq!(layer_effects(&p, layer_id).len(), 2);
    assert_eq!(layer_effects(&p, layer_id)[0].id, id1);

    apply_move_effect(&mut p, layer_id, id2, 0).unwrap();
    assert_eq!(layer_effects(&p, layer_id)[0].id, id2);

    apply_remove_effect(&mut p, layer_id, id1).unwrap();
    assert_eq!(layer_effects(&p, layer_id).len(), 1);
    assert_eq!(layer_effects(&p, layer_id)[0].id, id2);
}

fn blur_effect(strength: f64) -> Effect {
    let mut params = std::collections::BTreeMap::new();
    params.insert("strength".to_string(), Animated::Static(strength));
    Effect { id: crate::state::ids::new_id(), kind: "blur".into(), enabled: true, params }
}
fn layer_effects(p: &Project, id: LayerId) -> &[Effect] {
    &p.layer(id).unwrap().effects
}
```

(If `test_project_with_one_layer`, `first_layer_id`, or `Project::layer(id)` accessors do not already exist in this module, add small local helpers mirroring the existing test helpers in `mutations.rs`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml add_then_move_then_remove_effect`
Expected: FAIL — `apply_add_effect` not found.

- [ ] **Step 3: Write minimal implementation** — in `mutations.rs`:

```rust
use crate::state::effect::{Effect, EffectPatch};
use crate::state::ids::EffectId;

fn layer_mut<'a>(p: &'a mut Project, layer_id: LayerId) -> Result<&'a mut Layer, CommandError> {
    p.layer_mut(layer_id)
        .ok_or(CommandError::NotFound(format!("layer {layer_id}")))
}

pub fn apply_add_effect(
    p: &mut Project,
    layer_id: LayerId,
    effect: Effect,
) -> Result<EffectId, CommandError> {
    let id = effect.id;
    layer_mut(p, layer_id)?.effects.push(effect);
    Ok(id)
}

pub fn apply_update_effect(
    p: &mut Project,
    layer_id: LayerId,
    effect_id: EffectId,
    patch: EffectPatch,
) -> Result<(), CommandError> {
    let layer = layer_mut(p, layer_id)?;
    let e = layer
        .effects
        .iter_mut()
        .find(|e| e.id == effect_id)
        .ok_or(CommandError::NotFound(format!("effect {effect_id}")))?;
    if let Some(enabled) = patch.enabled {
        e.enabled = enabled;
    }
    if let Some(params) = patch.params {
        for (k, v) in params {
            e.params.insert(k, v);
        }
    }
    Ok(())
}

pub fn apply_move_effect(
    p: &mut Project,
    layer_id: LayerId,
    effect_id: EffectId,
    new_index: usize,
) -> Result<(), CommandError> {
    let layer = layer_mut(p, layer_id)?;
    let from = layer
        .effects
        .iter()
        .position(|e| e.id == effect_id)
        .ok_or(CommandError::NotFound(format!("effect {effect_id}")))?;
    if new_index >= layer.effects.len() {
        return Err(CommandError::Invalid(format!(
            "effect index {new_index} out of range ({})",
            layer.effects.len()
        )));
    }
    let e = layer.effects.remove(from);
    layer.effects.insert(new_index, e);
    Ok(())
}

pub fn apply_remove_effect(
    p: &mut Project,
    layer_id: LayerId,
    effect_id: EffectId,
) -> Result<(), CommandError> {
    let layer = layer_mut(p, layer_id)?;
    let before = layer.effects.len();
    layer.effects.retain(|e| e.id != effect_id);
    if layer.effects.len() == before {
        return Err(CommandError::NotFound(format!("effect {effect_id}")));
    }
    Ok(())
}
```

(Use whatever `CommandError` variants this codebase actually exposes — mirror the variants used by neighboring `apply_*` helpers; `NotFound`/`Invalid` are placeholders for the real variant names found in `actor.rs`/`error.rs`. If `Project::layer_mut` does not exist, add it next to the existing `Project::layer` accessor.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml add_then_move_then_remove_effect`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/state/mutations.rs apps/desktop/native/src/state/layer.rs
git commit -m "feat(effects): add/update/move/remove mutation helpers"
```

---

### Task 3: Actor commands + public API

**Files:**
- Modify: `apps/desktop/native/src/state/actor.rs` (Command enum ~line 520+; match arms ~line 1805+; `do_*` handlers ~line 2403+; public API ~line 1148+)
- Test: `apps/desktop/native/src/state/actor/tests.rs`

**Interfaces:**
- Consumes: `apply_*` (Task 2).
- Produces: `ProjectHandle::add_effect(actor, layer_id, effect) -> Result<EffectId, CommandError>`; `update_effect(actor, layer_id, effect_id, patch) -> Result<(), CommandError>`; `move_effect(actor, layer_id, effect_id, new_index) -> Result<(), CommandError>`; `remove_effect(actor, layer_id, effect_id) -> Result<(), CommandError>`.

- [ ] **Step 1: Write the failing test** — in `actor/tests.rs`:

```rust
#[tokio::test]
async fn effect_lifecycle_through_actor_records_undo() {
    let h = spawn(Project::new_blank("test"));
    let track_id = h.add_track(Actor::User, Some("overlay".into())).await.unwrap();
    let layer_id = h
        .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
        .await
        .unwrap();

    let mut params = std::collections::BTreeMap::new();
    params.insert("strength".to_string(), crate::state::animated::Animated::Static(6.0));
    let effect = crate::state::effect::Effect {
        id: crate::state::ids::new_id(), kind: "blur".into(), enabled: true, params,
    };
    let effect_id = h.add_effect(Actor::User, layer_id, effect).await.unwrap();

    let snap = h.snapshot().await;
    assert_eq!(snap.layer(layer_id).unwrap().effects.len(), 1);

    // undo removes the effect
    h.undo(Actor::User).await.unwrap();
    let snap = h.snapshot().await;
    assert_eq!(snap.layer(layer_id).unwrap().effects.len(), 0);
    let _ = effect_id;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml effect_lifecycle_through_actor`
Expected: FAIL — `add_effect` not found on handle.

- [ ] **Step 3: Write minimal implementation** — in `actor.rs`, replacing the "No set-effects command" comment (~line 662) with the four variants:

```rust
AddEffect {
    layer_id: LayerId,
    effect: Effect,
    actor: Actor,
    reply: oneshot::Sender<Result<EffectId, CommandError>>,
},
UpdateEffect {
    layer_id: LayerId,
    effect_id: EffectId,
    patch: EffectPatch,
    actor: Actor,
    reply: oneshot::Sender<Result<(), CommandError>>,
},
MoveEffect {
    layer_id: LayerId,
    effect_id: EffectId,
    new_index: usize,
    actor: Actor,
    reply: oneshot::Sender<Result<(), CommandError>>,
},
RemoveEffect {
    layer_id: LayerId,
    effect_id: EffectId,
    actor: Actor,
    reply: oneshot::Sender<Result<(), CommandError>>,
},
```

Match arms (in the command dispatch match, alongside `Command::MoveLayer { .. }`):

```rust
Command::AddEffect { layer_id, effect, actor, reply } => {
    let _ = reply.send(self.do_add_effect(layer_id, effect, actor));
}
Command::UpdateEffect { layer_id, effect_id, patch, actor, reply } => {
    let _ = reply.send(self.do_update_effect(layer_id, effect_id, patch, actor));
}
Command::MoveEffect { layer_id, effect_id, new_index, actor, reply } => {
    let _ = reply.send(self.do_move_effect(layer_id, effect_id, new_index, actor));
}
Command::RemoveEffect { layer_id, effect_id, actor, reply } => {
    let _ = reply.send(self.do_remove_effect(layer_id, effect_id, actor));
}
```

`do_*` handlers (mirror `do_move_layer` at ~line 2403):

```rust
fn do_add_effect(&mut self, layer_id: LayerId, effect: Effect, actor: Actor) -> Result<EffectId, CommandError> {
    let mut next: Project = (*self.history.current()).clone();
    let id = apply_add_effect(&mut next, layer_id, effect)?;
    self.commit(next, actor, format!("Added effect to layer {layer_id}"),
        vec![EntityRef::Layer(layer_id)], DiffHint::Coarse)?;
    Ok(id)
}
fn do_update_effect(&mut self, layer_id: LayerId, effect_id: EffectId, patch: EffectPatch, actor: Actor) -> Result<(), CommandError> {
    let mut next: Project = (*self.history.current()).clone();
    apply_update_effect(&mut next, layer_id, effect_id, patch)?;
    self.commit(next, actor, format!("Updated effect {effect_id}"),
        vec![EntityRef::Layer(layer_id)], DiffHint::Coarse)?;
    Ok(())
}
fn do_move_effect(&mut self, layer_id: LayerId, effect_id: EffectId, new_index: usize, actor: Actor) -> Result<(), CommandError> {
    let mut next: Project = (*self.history.current()).clone();
    apply_move_effect(&mut next, layer_id, effect_id, new_index)?;
    self.commit(next, actor, format!("Reordered effect {effect_id}"),
        vec![EntityRef::Layer(layer_id)], DiffHint::Coarse)?;
    Ok(())
}
fn do_remove_effect(&mut self, layer_id: LayerId, effect_id: EffectId, actor: Actor) -> Result<(), CommandError> {
    let mut next: Project = (*self.history.current()).clone();
    apply_remove_effect(&mut next, layer_id, effect_id)?;
    self.commit(next, actor, format!("Removed effect {effect_id}"),
        vec![EntityRef::Layer(layer_id)], DiffHint::Coarse)?;
    Ok(())
}
```

Public async API (mirror `move_layer` at ~line 1148):

```rust
pub async fn add_effect(&self, actor: Actor, layer_id: LayerId, effect: Effect) -> Result<EffectId, CommandError> {
    let (reply, rx) = oneshot::channel();
    self.tx.send(Command::AddEffect { layer_id, effect, actor, reply }).await.expect("project actor terminated");
    rx.await.expect("project actor terminated")
}
pub async fn update_effect(&self, actor: Actor, layer_id: LayerId, effect_id: EffectId, patch: EffectPatch) -> Result<(), CommandError> {
    let (reply, rx) = oneshot::channel();
    self.tx.send(Command::UpdateEffect { layer_id, effect_id, patch, actor, reply }).await.expect("project actor terminated");
    rx.await.expect("project actor terminated")
}
pub async fn move_effect(&self, actor: Actor, layer_id: LayerId, effect_id: EffectId, new_index: usize) -> Result<(), CommandError> {
    let (reply, rx) = oneshot::channel();
    self.tx.send(Command::MoveEffect { layer_id, effect_id, new_index, actor, reply }).await.expect("project actor terminated");
    rx.await.expect("project actor terminated")
}
pub async fn remove_effect(&self, actor: Actor, layer_id: LayerId, effect_id: EffectId) -> Result<(), CommandError> {
    let (reply, rx) = oneshot::channel();
    self.tx.send(Command::RemoveEffect { layer_id, effect_id, actor, reply }).await.expect("project actor terminated");
    rx.await.expect("project actor terminated")
}
```

Add `use crate::state::effect::{Effect, EffectPatch}; use crate::state::ids::EffectId;` to `actor.rs` imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml effect_lifecycle_through_actor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/state/actor.rs apps/desktop/native/src/state/actor/tests.rs
git commit -m "feat(effects): actor commands + public API for effect lifecycle"
```

---

### Task 4: MCP tools + docs

**Files:**
- Create: `apps/desktop/native/src/mcp/effects.rs`
- Modify: `apps/desktop/native/src/mcp/tools.rs`, `apps/desktop/native/src/mcp/catalog.rs`, `apps/desktop/native/src/mcp/mod.rs` (add `mod effects;`)
- Modify: `docs/mcp.md`
- Test: `apps/desktop/native/src/mcp/catalog.rs` (`#[cfg(test)]` smoke tests)

**Interfaces:**
- Consumes: `ProjectHandle::add_effect/...` (Task 3).
- Produces: MCP tools `add_effect`, `update_effect`, `move_effect`, `remove_effect`.

- [ ] **Step 1: Write the failing test** — in `catalog.rs` tests (mirror `ping_dispatches_to_pong`):

```rust
#[tokio::test]
async fn add_effect_tool_creates_effect() {
    use std::sync::Arc;
    let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
    b.init().await.unwrap();
    // create a layer first via existing tooling; reuse whatever the other catalog
    // tests use to seed a layer (e.g. a helper that adds a track + color layer and
    // returns the layer id).
    let layer_id = seed_layer(&b).await;
    let args = format!(r#"{{"layer_id":"{layer_id}","kind":"blur"}}"#);
    let r = dispatch_tool(&b, "add_effect", &args).await.unwrap();
    let v = serde_json::to_value(&r).unwrap();
    assert!(v["content"][0]["text"].as_str().unwrap().len() > 0); // returns the new effect id
}
```

(`seed_layer` follows the project-seeding helper the existing MCP tests use; if none exists, build the layer through `b.project()?` directly with `add_track` + `add_layer`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml add_effect_tool_creates_effect`
Expected: FAIL — tool `add_effect` not found in dispatch.

- [ ] **Step 3: Write minimal implementation**

`mcp/effects.rs` (new):

```rust
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AddEffectArgs {
    pub layer_id: String,
    pub kind: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct UpdateEffectArgs {
    pub layer_id: String,
    pub effect_id: String,
    pub patch: serde_json::Value, // deserialized to EffectPatch downstream
}
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct MoveEffectArgs {
    pub layer_id: String,
    pub effect_id: String,
    pub new_index: usize,
}
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RemoveEffectArgs {
    pub layer_id: String,
    pub effect_id: String,
}
```

`mcp/mod.rs` — add `mod effects;`.

`mcp/tools.rs` — 4 handlers (mirror `set_keyframe` at ~line 975; `parse_uuid`, `agent_actor`, `map_command_error`/`ToolResult` are the existing helpers):

```rust
pub(super) async fn add_effect(b: &Backend, args: super::effects::AddEffectArgs) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let effect = crate::state::effect::Effect {
        id: crate::state::ids::new_id(),
        kind: args.kind,
        enabled: true,
        params: std::collections::BTreeMap::new(),
    };
    let id = b.project()?.add_effect(agent_actor(), layer_id, effect).await.map_err(map_command_error)?;
    Ok(ToolResult::text(id.to_string()))
}
pub(super) async fn update_effect(b: &Backend, args: super::effects::UpdateEffectArgs) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let effect_id = parse_uuid(&args.effect_id, "effect_id")?;
    let patch: crate::state::effect::EffectPatch = serde_json::from_value(args.patch)
        .map_err(|e| McpToolError::invalid_params(format!("invalid patch: {e}"), None))?;
    b.project()?.update_effect(agent_actor(), layer_id, effect_id, patch).await.map_err(map_command_error)?;
    Ok(ToolResult::empty())
}
pub(super) async fn move_effect(b: &Backend, args: super::effects::MoveEffectArgs) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let effect_id = parse_uuid(&args.effect_id, "effect_id")?;
    b.project()?.move_effect(agent_actor(), layer_id, effect_id, args.new_index).await.map_err(map_command_error)?;
    Ok(ToolResult::empty())
}
pub(super) async fn remove_effect(b: &Backend, args: super::effects::RemoveEffectArgs) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let effect_id = parse_uuid(&args.effect_id, "effect_id")?;
    b.project()?.remove_effect(agent_actor(), layer_id, effect_id).await.map_err(map_command_error)?;
    Ok(ToolResult::empty())
}
```

(If the existing handlers use a different error mapper than `map_command_error`, use the one neighboring tools use.)

`mcp/catalog.rs` — add inside `tool_table!`:

```rust
"add_effect" => ("Add an effect to a layer's chain (top of the stack). `kind` is the catalog key (v1: \"blur\"). Returns the new effect id. Set params afterward with update_effect / set_keyframe.", super::effects::AddEffectArgs, tools::add_effect),
"update_effect" => ("Update an effect: { enabled?, params? } where params is { paramKey: { mode:\"Static\", value:<number> } } (v1 params are scalar). For keyframed params use set_keyframe with param_key \"effects[<effect_id>].params[<key>]\".", super::effects::UpdateEffectArgs, tools::update_effect),
"move_effect" => ("Reorder an effect within its layer's chain. new_index is 0-based; 0 = first applied. Must be < effect count.", super::effects::MoveEffectArgs, tools::move_effect),
"remove_effect" => ("Remove an effect from a layer by id.", super::effects::RemoveEffectArgs, tools::remove_effect),
```

`docs/mcp.md` — under "Edit tools", add:

```markdown
Effects (per-layer Pixi filter chains; v1 catalog: `blur`):
- `add_effect { layer_id, kind }` → `EffectId`. Append an effect (top of stack).
- `update_effect { layer_id, effect_id, patch }` — patch is `{ enabled?, params? }`; v1 params are scalar `{ mode:"Static", value }`.
- `move_effect { layer_id, effect_id, new_index }` — reorder (0 = first applied).
- `remove_effect { layer_id, effect_id }` — delete.
- Keyframe an effect param via `set_keyframe { layer_id, param_key:"effects[<effect_id>].params[<key>]", t_us, value, interp? }`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml add_effect_tool_creates_effect`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/mcp/ docs/mcp.md
git commit -m "feat(effects): MCP tools add/update/move/remove_effect + docs"
```

---

### Task 5: Effect-param keyframe addressing

**Files:**
- Modify: `apps/desktop/native/src/state/layer.rs:307-341` (`resolve_animated_f64` + add mutable variant)
- Test: `apps/desktop/native/src/mcp/keyframes.rs` tests (or `layer.rs` tests)

**Interfaces:**
- Consumes: `Layer.effects`, the existing `resolve_animated_f64` + `update_layer_param_track` path.
- Produces: param-key grammar `effects[<effect_id>].params[<key>]` resolves to the effect param's `Animated<f64>` for both read (`get_param_track`) and write (`set_keyframe`).

- [ ] **Step 1: Write the failing test** — in `mcp/keyframes.rs` tests (mirror `set_get_remove_roundtrip...`):

```rust
#[tokio::test]
async fn keyframe_on_effect_param_addresses_nested_path() {
    let (handle, layer_id) = motif_project().await;
    // add a blur effect, capture its id
    let mut params = std::collections::BTreeMap::new();
    params.insert("strength".to_string(), crate::state::animated::Animated::Static(0.0));
    let eff = crate::state::effect::Effect { id: crate::state::ids::new_id(), kind: "blur".into(), enabled: true, params };
    let effect_id = handle.add_effect(Actor::User, layer_id, eff).await.unwrap();

    let key = format!("effects[{effect_id}].params[strength]");
    set_keyframe(&handle, Actor::User, layer_id, &key, 1_000_000, 10.0, None).await.unwrap();
    let v = get_param_track(&handle, layer_id, &key).await.unwrap();
    assert_eq!(v["mode"], "Keyframed");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml keyframe_on_effect_param`
Expected: FAIL — the path `effects[...]...` does not resolve.

- [ ] **Step 3: Write minimal implementation** — in `layer.rs`, add a path parser used by both the read resolver and the write path:

```rust
/// Parse an effect-param key `effects[<uuid>].params[<key>]` → (effect_id, param_key).
pub(crate) fn parse_effect_param_key(key: &str) -> Option<(crate::state::ids::EffectId, String)> {
    let rest = key.strip_prefix("effects[")?;
    let (id_str, rest) = rest.split_once("].params[")?;
    let param = rest.strip_suffix(']')?;
    let id = id_str.parse().ok()?;
    Some((id, param.to_string()))
}
```

Extend `resolve_animated_f64` to handle effect paths (this fn takes `params: &LayerParams`; the effect path needs the whole `Layer`, so add a sibling `resolve_animated_f64_on_layer(layer: &Layer, key) -> Option<&Animated<f64>>` that first tries `parse_effect_param_key`, else falls back to `resolve_animated_f64(&layer.params, key)`):

```rust
pub(crate) fn resolve_animated_f64_on_layer<'a>(layer: &'a Layer, key: &str) -> Option<&'a Animated<f64>> {
    if let Some((effect_id, param)) = parse_effect_param_key(key) {
        return layer.effects.iter().find(|e| e.id == effect_id)?.params.get(&param);
    }
    resolve_animated_f64(&layer.params, key)
}
```

Add the mutable twin used by the write path (mirror whatever `update_layer_param_track` uses to locate the field):

```rust
pub(crate) fn resolve_animated_f64_mut<'a>(layer: &'a mut Layer, key: &str) -> Option<&'a mut Animated<f64>> {
    if let Some((effect_id, param)) = parse_effect_param_key(key) {
        return layer.effects.iter_mut().find(|e| e.id == effect_id)?.params.get_mut(&param);
    }
    resolve_animated_f64_mut_params(&mut layer.params, key) // existing params-level mut resolver
}
```

Then point the read (`read_track` in `mcp/keyframes.rs`) and write (`update_layer_param_track` in `actor.rs`) at the `*_on_layer` / `*_mut` layer-level resolvers instead of the params-only ones. (Locate the current call sites — `mcp/keyframes.rs::read_track` and the `update_layer_param_track` handler — and swap the resolver.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml keyframe_on_effect_param`
Expected: PASS. Then run the full keyframe suite to confirm no regression: `cargo test --manifest-path apps/desktop/native/Cargo.toml keyframe`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/state/layer.rs apps/desktop/native/src/state/actor.rs apps/desktop/native/src/mcp/keyframes.rs
git commit -m "feat(effects): keyframe addressing for effects[id].params[key]"
```

---

## Phase B — IPC + renderer (preview)

### Task 6: IPC view — emit effects to the renderer

**Files:**
- Modify: `apps/desktop/native/src/commands/mod.rs` (layer→view conversion, ~line 470, the place that builds `VideoClipView` and drops `blend_mode`)
- Modify: `apps/desktop/src/renderer/ipc/index.ts:72-94` (`LayerSummary`) + add `EffectView`
- Test: `apps/desktop/src/renderer/...` — a type-level + a small serialization-shape assertion (vitest)

**Interfaces:**
- Consumes: `Layer.effects` (Task 1), `AnimTrack<number>` (existing, `ipc/index.ts:277`).
- Produces: `LayerSummary.effects: EffectView[]`; `EffectView = { id: string; kind: string; enabled: boolean; params: Record<string, AnimTrack<number>> }`.

- [ ] **Step 1: Write the failing test** — `apps/desktop/src/renderer/ipc/effectView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EffectView, LayerSummary } from "./index";

describe("EffectView", () => {
  it("LayerSummary carries an effects array of EffectView", () => {
    const e: EffectView = { id: "x", kind: "blur", enabled: true, params: { strength: { mode: "Static", value: 8 } } };
    const layer: Pick<LayerSummary, "effects"> = { effects: [e] };
    expect(layer.effects[0]!.params.strength).toEqual({ mode: "Static", value: 8 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- effectView`
Expected: FAIL — `EffectView` / `LayerSummary.effects` not defined.

- [ ] **Step 3: Write minimal implementation**

`ipc/index.ts` — add near `LayerSummary`:

```ts
export interface EffectView {
  id: string;
  kind: string;
  enabled: boolean;
  params: Record<string, AnimTrack<number>>;
}
```

and add to `LayerSummary`:

```ts
  effects: EffectView[];
```

`native/src/commands/mod.rs` — in the layer→summary conversion, populate the new field by serializing `layer.effects` (each `Effect` → `{ id, kind, enabled, params }`, where `params` is the already-serde-compatible `BTreeMap<String, Animated<f64>>` → `Record<string, AnimTrack<number>>`). Add `effects: layer.effects.iter().map(effect_to_view).collect()` to the summary builder, with a small `effect_to_view(&Effect) -> EffectViewDto` (or, if the summary builder serializes via serde derive on a DTO struct, add an `effects` field to that DTO mirroring `Effect`). Match the existing conversion style at this site.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- effectView` → PASS. Then `npm run typecheck` clean, and `cargo test --manifest-path apps/desktop/native/Cargo.toml` green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/commands/mod.rs apps/desktop/src/renderer/ipc/index.ts apps/desktop/src/renderer/ipc/effectView.test.ts
git commit -m "feat(effects): emit layer.effects in the IPC view"
```

---

### Task 7: Effect registry (catalog) with Blur

**Files:**
- Create: `apps/desktop/src/renderer/render/effects/effectRegistry.ts`
- Test: `apps/desktop/src/renderer/render/effects/effectRegistry.test.ts`

**Interfaces:**
- Consumes: PixiJS `BlurFilter`, `Filter`.
- Produces: `interface EffectDescriptor { kind: string; nameI18nKey: string; create(): Filter; params: Record<string, { default: number; range?: [number, number]; apply(f: Filter, v: number): void }>; fidelity: "f16-verified" | "precision-reduced"; colorspace: "display-gamma" }`; `getDescriptor(kind: string): EffectDescriptor | null`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import { getDescriptor } from "./effectRegistry";

describe("effectRegistry", () => {
  it("blur descriptor builds a BlurFilter and applies strength", () => {
    const d = getDescriptor("blur")!;
    expect(d.fidelity).toBe("f16-verified");
    const f = d.create();
    expect(f).toBeInstanceOf(BlurFilter);
    d.params.strength!.apply(f, 12);
    expect((f as BlurFilter).strength).toBe(12);
  });
  it("unknown kind returns null", () => {
    expect(getDescriptor("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- effectRegistry`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { BlurFilter, type Filter } from "pixi.js";

export interface EffectParamSpec {
  default: number;
  range?: [number, number];
  apply(filter: Filter, value: number): void;
}
export interface EffectDescriptor {
  kind: string;
  nameI18nKey: string;
  create(): Filter;
  params: Record<string, EffectParamSpec>;
  fidelity: "f16-verified" | "precision-reduced";
  colorspace: "display-gamma";
}

const REGISTRY: Record<string, EffectDescriptor> = {
  blur: {
    kind: "blur",
    nameI18nKey: "effects.blur",
    create: () => new BlurFilter({ strength: 8 }),
    params: {
      strength: { default: 8, range: [0, 100], apply: (f, v) => { (f as BlurFilter).strength = v; } },
    },
    fidelity: "f16-verified",
    colorspace: "display-gamma",
  },
};

export function getDescriptor(kind: string): EffectDescriptor | null {
  return REGISTRY[kind] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- effectRegistry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/effects/effectRegistry.ts apps/desktop/src/renderer/render/effects/effectRegistry.test.ts
git commit -m "feat(effects): TS effect registry with Blur descriptor"
```

---

### Task 8: resolveEffects + EffectChain applier

**Files:**
- Create: `apps/desktop/src/renderer/render/effects/EffectChain.ts`
- Test: `apps/desktop/src/renderer/render/effects/EffectChain.test.ts`

**Interfaces:**
- Consumes: `EffectView` (Task 6), `getDescriptor` (Task 7), `resolveAnimated` (`render/animated.ts:100`).
- Produces: `class EffectChain { sync(views: EffectView[], tInLayerUs: number): Filter[] }` — returns the ordered, param-updated filter list for a layer; rebuilds instances only when the (kind, id) structure changes; skips unknown kinds (logs once).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import type { EffectView } from "../../ipc";
import { EffectChain } from "./EffectChain";

const blur = (id: string, strength: number): EffectView => ({
  id, kind: "blur", enabled: true, params: { strength: { mode: "Static", value: strength } },
});

describe("EffectChain", () => {
  it("builds one BlurFilter and applies the resolved strength", () => {
    const chain = new EffectChain();
    const filters = chain.sync([blur("a", 5)], 0);
    expect(filters).toHaveLength(1);
    expect((filters[0] as BlurFilter).strength).toBe(5);
  });
  it("reuses the same instance across syncs (no rebuild on param-only change)", () => {
    const chain = new EffectChain();
    const f1 = chain.sync([blur("a", 5)], 0)[0];
    const f2 = chain.sync([blur("a", 9)], 0)[0];
    expect(f2).toBe(f1);
    expect((f2 as BlurFilter).strength).toBe(9);
  });
  it("disabled effects are excluded; unknown kinds skipped", () => {
    const chain = new EffectChain();
    const disabled: EffectView = { ...blur("a", 5), enabled: false };
    const unknown: EffectView = { id: "u", kind: "nope", enabled: true, params: {} };
    expect(chain.sync([disabled, unknown], 0)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- EffectChain`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Filter } from "pixi.js";
import type { EffectView } from "../../ipc";
import { resolveAnimated } from "../animated";
import { getDescriptor } from "./effectRegistry";

interface Instance { id: string; kind: string; filter: Filter; }

export class EffectChain {
  private instances: Instance[] = [];
  private warned = new Set<string>();

  /** Returns the ordered, param-updated filter list for the current frame. */
  sync(views: EffectView[], tInLayerUs: number): Filter[] {
    const wanted = views.filter((v) => v.enabled && getDescriptor(v.kind) !== null);

    // Rebuild instance list only on a structural change (id+kind sequence).
    const sameStructure =
      wanted.length === this.instances.length &&
      wanted.every((v, i) => this.instances[i]!.id === v.id && this.instances[i]!.kind === v.kind);
    if (!sameStructure) {
      for (const inst of this.instances) inst.filter.destroy();
      this.instances = wanted.map((v) => ({ id: v.id, kind: v.kind, filter: getDescriptor(v.kind)!.create() }));
    }

    // Warn once per unknown kind (so authors learn the kind isn't in the catalog).
    for (const v of views) {
      if (v.enabled && getDescriptor(v.kind) === null && !this.warned.has(v.kind)) {
        this.warned.add(v.kind);
        console.warn(`[effects] unknown effect kind "${v.kind}" — skipped`);
      }
    }

    // Apply resolved params each frame.
    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i]!;
      const view = wanted[i]!;
      const spec = getDescriptor(inst.kind)!.params;
      for (const [key, paramSpec] of Object.entries(spec)) {
        const v = resolveAnimated(view.params[key], tInLayerUs, paramSpec.default);
        paramSpec.apply(inst.filter, v);
      }
    }
    return this.instances.map((i) => i.filter);
  }

  dispose(): void {
    for (const inst of this.instances) inst.filter.destroy();
    this.instances = [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- EffectChain`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/effects/EffectChain.ts apps/desktop/src/renderer/render/effects/EffectChain.test.ts
git commit -m "feat(effects): EffectChain applier (cache instances, resolve params per frame)"
```

---

### Task 9: Compositor — attach filters per frame

**Files:**
- Modify: `apps/desktop/src/renderer/render/Compositor.ts` (sprite caches ~264; `updateClip` ~1520-1581; the `ActiveClip`/`ActiveImage`/etc. interfaces ~162)
- Test: manual verify via the run skill + an existing compositor test if one covers `updateClip`; otherwise a small unit test on a helper

**Interfaces:**
- Consumes: `EffectChain` (Task 8), `LayerSummary.effects` (Task 6).
- Produces: filtered sprites in preview. Each `Active*` gains an `effects: EffectChain` field; `update*` sets `sprite.filters`.

- [ ] **Step 1: Write the failing test** — add a focused helper + test so this is unit-checkable without a GPU. Add to `Compositor.ts` an exported pure helper:

```ts
// exported for test
export function effectsFor(chain: EffectChain, layer: LayerSummary, tInLayerUs: number): Filter[] {
  return chain.sync(layer.effects ?? [], tInLayerUs);
}
```

Test `apps/desktop/src/renderer/render/effectsFor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import { EffectChain } from "./effects/EffectChain";
import { effectsFor } from "./Compositor";

describe("effectsFor", () => {
  it("returns a BlurFilter for a layer with a blur effect", () => {
    const chain = new EffectChain();
    const layer = { id: "l", effects: [{ id: "a", kind: "blur", enabled: true, params: { strength: { mode: "Static", value: 4 } } }] } as any;
    const filters = effectsFor(chain, layer, 0);
    expect(filters[0]).toBeInstanceOf(BlurFilter);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- effectsFor`
Expected: FAIL — `effectsFor` not exported.

- [ ] **Step 3: Write minimal implementation**

In `Compositor.ts`: (a) add `effects: EffectChain` to each `Active*` interface and initialize it in the corresponding `ensure*`; (b) export `effectsFor` (above); (c) in `updateClip` (after the transform/opacity block at ~1579, before `clip.sprite.sprite.zIndex = z`):

```ts
const layerLocalUs = tUs - layer.t_start_us;
clip.sprite.sprite.filters = effectsFor(clip.effects, layer, layerLocalUs);
clip.sprite.sprite.zIndex = z;
```

Repeat the `filters =` assignment in `updateImage`, `updateColor`, `updateText` (each `Active*` has its own `EffectChain`). Dispose each chain in the matching disposal path (where sprites are removed/disposed).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- effectsFor` → PASS. Then a real visual check (Task is GPU-bound): use the run skill to launch the app, add a blur via MCP, confirm the layer blurs in preview.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/Compositor.ts apps/desktop/src/renderer/render/effectsFor.test.ts
git commit -m "feat(effects): apply per-layer filter chains in the compositor"
```

---

## Phase C — export 10-bit + parity gate

### Task 10: Export-worker f16 TexturePool bump

**Files:**
- Modify: `apps/desktop/src/renderer/render/worker/exportWorker.ts` (~line 145, after the float16 capability check, before Compositor creation)
- Test: covered by the GL-parity gate (Task 11); add an inline comment-guard assertion

**Interfaces:**
- Consumes: PixiJS `TexturePool`; `tenBit` flag (`req.bitDepth === 10`, already computed at ~line 106).
- Produces: filter intermediates render at `rgba16float` in the 10-bit export realm.

- [ ] **Step 1: Write the failing test** — this is GPU/worker-bound; the executable assertion lives in Task 11's e2e gate. For this task, the "test" is the gate from Task 11 going from FAIL→PASS once this line lands. (Land Task 11's gate first if executing strictly TDD; otherwise implement here and let Task 11 verify.)

- [ ] **Step 2: (n/a — verified by Task 11 gate)**

- [ ] **Step 3: Write minimal implementation** — add the import and the init bump:

```ts
import { TexturePool } from "pixi.js";
// ...
if (tenBit) {
  // The Pixi FilterSystem allocates filter intermediates from this global
  // TexturePool; default format is 8-bit and would band the 10-bit signal at
  // the first filter. Set it to rgba16float ONCE here, before any filtering.
  // NEVER TexturePool.clear(true) on a live FilterSystem — it destroys pooled
  // textures the persistent filter bind group references (null-resources
  // crash). The pool is empty at this point, so no clear is needed.
  // Validated: branch poc/f16-filter-pool. See docs/plans/effects-subsystem.md.
  TexturePool.textureOptions = { ...TexturePool.textureOptions, format: "rgba16float" };
}
```

Place this immediately after the float16 capability check passes (~line 145) and before the Compositor is created.

- [ ] **Step 4: Verify** — run Task 11's gate (below).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/worker/exportWorker.ts
git commit -m "feat(effects): bump export-realm filter pool to rgba16float for 10-bit"
```

---

### Task 11: GL-parity gate for f16 filter precision

**Files:**
- Create: `apps/desktop/e2e/effects_f16_parity.e2e.js` (Playwright `_electron`, following the existing 10-bit GL-parity gate)
- Test: the gate itself

**Interfaces:**
- Consumes: the export-worker f16 pool bump (Task 10), the Blur descriptor (`fidelity: "f16-verified"`).
- Produces: an automated assertion that a `f16-verified` filter preserves precision (>256 distinct values) through the f16 pool, and bands (≈256) without it. Productizes the PoC.

- [ ] **Step 1: Write the failing test** — port the PoC (`poc/f16-filter-pool/index.html`) into an e2e that, inside the renderer/worker GL context: builds a 1024-step `rgba16float` gradient, runs it through `getDescriptor("blur").create()` under (a) default pool and (b) `format:"rgba16float"` pool, reads back float pixels, and asserts:

```js
// pseudocode of the in-page assertion
expect(distinctDefaultPool).toBeLessThanOrEqual(260);   // bands to ~256
expect(distinctF16Pool).toBeGreaterThan(900);            // preserves ~1024
```

Mirror the harness in branch `poc/f16-filter-pool` (`index.html` readRed + halfToFloat + the two-run structure). Run it through the project's Playwright `_electron` setup used by the existing 10-bit gate (requires a `VITE_WEFTCUT_E2E=1` build; see the media-conformance e2e for the launch pattern).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx playwright test effects_f16_parity`
Expected: FAIL before Task 10's bump (f16-pool distinct ≈ 256), or harness-not-wired.

- [ ] **Step 3: Write minimal implementation** — wire the gate harness page + the Playwright spec; ensure Task 10's bump is in place. Register the gate alongside the other local-only e2e gates (skipped in CI per the media-conformance convention).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx playwright test effects_f16_parity`
Expected: PASS — default pool ≤260 distinct, f16 pool >900.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/effects_f16_parity.e2e.js
git commit -m "test(effects): GL-parity gate — f16 pool preserves filter precision"
```

---

## Phase D — polish

### Task 12: preview-LOD skip toggle

**Files:**
- Modify: the settings struct (`ProjectSettings` or `AppSettings` — whichever holds preview prefs; set via the unrecorded `replace_settings_everywhere` path per the ProjectSettings convention) + its IPC view
- Modify: `apps/desktop/src/renderer/render/Compositor.ts` (`effectsFor` honors the flag while scrubbing)
- Test: unit test on the gate logic

**Interfaces:**
- Consumes: the settings flag `preview_effects_enabled: bool` (default true).
- Produces: when the flag is false (or while scrubbing if a scrub-only variant is chosen), preview skips filters; export is unaffected.

- [ ] **Step 1: Write the failing test** — `apps/desktop/src/renderer/render/effectsFor.test.ts` (extend):

```ts
it("returns no filters when preview effects are disabled", () => {
  const chain = new EffectChain();
  const layer = { id: "l", effects: [{ id: "a", kind: "blur", enabled: true, params: { strength: { mode: "Static", value: 4 } } }] } as any;
  expect(effectsFor(chain, layer, 0, { previewEffectsEnabled: false })).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- effectsFor`
Expected: FAIL — `effectsFor` has no options arg.

- [ ] **Step 3: Write minimal implementation** — extend `effectsFor`:

```ts
export function effectsFor(
  chain: EffectChain,
  layer: LayerSummary,
  tInLayerUs: number,
  opts?: { previewEffectsEnabled?: boolean },
): Filter[] {
  if (opts && opts.previewEffectsEnabled === false) return [];
  return chain.sync(layer.effects ?? [], tInLayerUs);
}
```

Thread the setting from the project/app settings view into the `update*` call sites in the compositor. (The export worker calls `chain.sync` directly and never passes this opt — export is always full quality.) Add the `preview_effects_enabled` field to the settings struct + IPC view, defaulting true.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- effectsFor` → PASS. Full suite: `npm test` and `cargo test --manifest-path apps/desktop/native/Cargo.toml` green; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/Compositor.ts apps/desktop/native/src/ docs/
git commit -m "feat(effects): preview-LOD toggle to skip filters while scrubbing"
```

---

## Self-Review

**Spec coverage** (against `docs/plans/effects-subsystem.md`):
- A (Rust instances / TS catalog split) → Tasks 1-3 (Rust) + 7 (TS catalog). ✓
- B (data model, `Animated<f64>` params, IPC, permissive kind) → Tasks 1, 6; permissive kind in Task 8 (skip+warn). ✓
- C (capability registry) → Task 7. ✓
- D (apply path, instance cache) → Task 8 + 9. ✓
- E (10-bit reconciliation, tiering = labeling) → Task 10; `fidelity` field in Task 7. ✓
- F (GL-parity gate) → Task 11. ✓
- G (preview-LOD) → Task 12. ✓
- H (actor + MCP + keyframes) → Tasks 3, 4, 5. ✓
- I (colorspace contract / HDR seam) → `colorspace: "display-gamma"` field in Task 7 descriptor. ✓
- J (v1 = single Blur, scalar params; ParamValue deferred) → Global Constraints + Task 1. ✓

**Placeholder scan:** Tasks 2, 5, 6 contain "mirror the existing variant / call site" pointers where the exact pre-existing helper names (`CommandError` variants, `Project::layer_mut`, the params-level mut resolver, the summary DTO builder) must be read from the codebase at execution time. These are explicit "read this exact site" references, not vague TODOs, but the executor must confirm the real names. Flagged here rather than hidden.

**Type consistency:** `EffectView` (TS, Task 6) mirrors `Effect` (Rust, Task 1): `{ id, kind, enabled, params }` with `params: Record<string, AnimTrack<number>>` ↔ `BTreeMap<String, Animated<f64>>`. `EffectChain.sync(views, t)` (Task 8) is consumed by `effectsFor` (Task 9) and extended in Task 12. `getDescriptor` (Task 7) used by Tasks 8, 11. Names consistent across tasks.

## Open risks for the executor

- **The Rust layer→view summary builder** (`commands/mod.rs`) shape is referenced from a prior investigation (~line 470, "drops blend_mode"); confirm the exact builder and whether it serializes via a DTO struct or hand-maps fields before writing Task 6.
- **`update_layer_param_track` write resolver** (Task 5): confirm whether it currently resolves on `&mut LayerParams` or `&mut Layer`; the effect path needs the whole layer. Adjust the swap accordingly.
- **`CommandError` variant names** (Task 2): use the real variants; `NotFound`/`Invalid` are stand-ins.
