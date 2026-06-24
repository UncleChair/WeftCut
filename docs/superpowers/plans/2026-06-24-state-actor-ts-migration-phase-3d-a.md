# Phase 3d-a — MCP adapter foundation + mechanical tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the ~31 mechanical category-A MCP tools onto the TS state actor as a DORMANT, differential-gated adapter (no live routing; the `server.ts` flip + un-pause is Phase 3d-d).

**Architecture:** A new `ActorHandle.mcpCall(name, argsJson) → McpCallResult` entrypoint (a third surface alongside `dispatch()`/`command()`, implemented inside `createActor` so it can reach the gated `commit`/closures) reuses `dispatch()` for most tools and has dedicated arms for the explicit-param tools (`add_color_layer`/`add_video_layer`/`add_marker`/`split_layer`). Pure arg-parsing, ToolResult-shaping, and `mapCommandError` live in a new `src/main/state/mcp-commands.ts`. A new Rust `mcp_driver` bin drives the REAL `dispatch_tool` under deterministic ids to produce byte-identical oracles in a new corpus dimension (`sequences-mcp/` + `oracle-mcp/`); a `mcp.differential.test.ts` replays each sequence through `mcpCall` and asserts equality.

**Tech Stack:** TypeScript (Electron main, vitest/esbuild), Rust (napi-rs addon + `bin` drivers, `serde_json`), the existing `fixtures/state-corpus` differential harness.

## Global Constraints

- DORMANT slice: **NO change to `src/main/index.ts`, `src/main/mcp/server.ts`, or `src/main/mcp/mutationTools.ts`.** The MCP mutation pause stays as-is; nothing goes live. Verified by diff in Task 6.
- Corpus changes are **ADDITIVE**: existing oracle dirs (`oracle/`, `oracle-summary/`, `oracle-prod/`) stay byte-identical — `git diff --diff-filter=M fixtures/state-corpus` over those dirs must be empty after regen.
- `dispatch()` (the replay vehicle) stays **byte-untouched** — `mcpCall` is a new sibling, it does not edit `dispatch()`.
- Error gating = **`code` + structured `data` byte-identical + state byte-identical** (state pins ok/no-op). The prose `message` is generated reasonably but NOT asserted byte-equal, EXCEPT `InvalidArgument` whose `"{field}: {detail}"` message IS reproduced exactly. (Refines the spec; matches the prod gate's variant-only error comparison; no Display-string twin.)
- Structured ToolResult JSON (`add_video_layer` pair, `split_layer`) must serialize with **alpha-sorted keys** to match Rust `serde_json` (preserve_order OFF → BTreeMap). Use `canonicalize` + `JSON.stringify`.
- The MCP agent actor is `Actor::Agent{client:"mcp"}` — corpus uses det ids so actor attribution doesn't affect serialized state, but keep the actor consistent.
- Regen toolchain env (Windows): `FFMPEG_DIR=<…Gyan.FFmpeg.Shared…/ffmpeg-8.1.1-full_build-shared>`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH=$FFMPEG_DIR/bin:$PATH`; build `--features replay,jobs,export,mcp,cloud,motifs`.
- Branch: `phase-3d-a-mcp-port` (already created; spec committed at `12d97afa`).

## File Structure

- Create `apps/desktop/native/src/bin/mcp_driver.rs` — det-id oracle driving `dispatch_tool` via `reply`.
- Modify `apps/desktop/native/src/mcp/mod.rs` — `#[cfg(feature="replay")] pub use` of `dispatch_tool` + `reply`.
- Modify `apps/desktop/native/src/lib.rs` — crate-root `#[cfg(all(feature="replay",feature="mcp"))] pub use mcp::{dispatch_tool, reply}`.
- Create `apps/desktop/src/main/state/mcp-commands.ts` — pure: envelope/result types, `parseUuid`, `McpArgError`, `toolText/toolEmpty/toolJson`, `mapCommandError`, `MCP_ARG_PARSERS`, `MCP_RESULT_SHAPERS`, `MCP_TOOLS` set.
- Modify `apps/desktop/src/main/state/actor.ts` — add `mcpCall` to `ActorHandle` + `createActor`.
- Modify `apps/desktop/src/main/state/replay.ts` — add `replayMcpSequence` + `mcpSequenceIsSupported`.
- Create `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts` — the gate.
- Modify `apps/desktop/scripts/gen-state-oracle.mjs` — add the `sequences-mcp/`→`oracle-mcp/` loop.
- Create `apps/desktop/fixtures/state-corpus/sequences-mcp/*.json` + generated `oracle-mcp/*.json`.
- Modify `apps/desktop/fixtures/state-corpus/README.md` — document the mcp dimension (Task 6).

---

### Task 1: Rust `mcp_driver` + re-exports + corpus harness (de-risk)

**Files:**
- Create: `apps/desktop/native/src/bin/mcp_driver.rs`
- Modify: `apps/desktop/native/src/mcp/mod.rs` (the `pub(crate) use catalog::{…}` block, ~lines 29-31)
- Modify: `apps/desktop/native/src/lib.rs` (after the `#[cfg(feature="replay")] pub use napi_backend::Backend;` re-export, ~line 27)
- Modify: `apps/desktop/scripts/gen-state-oracle.mjs`
- Create: `apps/desktop/fixtures/state-corpus/sequences-mcp/add-track.json`

**Interfaces:**
- Produces: the `mcp_driver` bin (CLI: `mcp_driver <sequence.json>` → stdout `{name, steps:[{op, ok, env, state}]}`); `weftcut_lib::dispatch_tool`, `weftcut_lib::reply` (replay-gated); `oracle-mcp/add-track.json`.

- [ ] **Step 1: Add the replay-gated re-exports.**

In `apps/desktop/native/src/mcp/mod.rs`, after the existing `pub(crate) use catalog::{…};` block, add:

```rust
#[cfg(feature = "replay")]
pub use catalog::dispatch_tool;
#[cfg(feature = "replay")]
pub use wire::reply;
```

In `apps/desktop/native/src/lib.rs`, after `#[cfg(feature = "replay")] pub use napi_backend::Backend;`, add:

```rust
// pub: dispatch_tool + reply consumed by the mcp_driver differential-harness bin
#[cfg(all(feature = "replay", feature = "mcp"))]
pub use mcp::{dispatch_tool, reply};
```

- [ ] **Step 2: Write `mcp_driver.rs`** (clone of `prod_driver.rs`; reuse its `resolve_value`, `build_wire_args` renamed `build_args`, `canonical_state`, `media_item`).

```rust
//! MCP-channel differential oracle. Drives the REAL `dispatch_tool` (the napi
//! MCP entrypoint's inner call) with deterministic ids, capturing the exact
//! `reply()` envelope per step. Build/run with
//! `--features replay,jobs,export,mcp,cloud,motifs`. NOT in the production addon.
use std::collections::HashMap;
use serde_json::{json, Value};
use weftcut_lib::{dispatch_tool, reply, Backend, NullEventSink, state};

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: mcp_driver <sequence.json>");
    let seq: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let name = seq["name"].as_str().unwrap_or("unnamed").to_string();

    state::ids::det::reset();
    state::ids::det::enable();
    let tmp = std::env::temp_dir().join(format!("weftcut-mcp-{}", std::process::id()));
    let backend = Backend::new_for_replay(
        std::sync::Arc::new(NullEventSink),
        tmp.join("config").to_string_lossy().to_string(),
        tmp.join("cache").to_string_lossy().to_string(),
    );
    let h = backend.init_for_replay().await; // mints A(#1) B(#2) project(#3)
    let mut refs: HashMap<String, String> = HashMap::new();
    refs.insert("A".into(), h.snapshot().await.tracks[0].id.to_string());
    refs.insert("B".into(), h.snapshot().await.tracks[1].id.to_string());

    let mut steps = Vec::new();
    for cmd in seq["commands"].as_array().unwrap() {
        let op = cmd["op"].as_str().unwrap().to_string();
        let (ok, env, ret) = if op == "add_media" {
            // Pool seed (MCP import_media is jobs/3d-d). Apply via handle.
            match h.add_media_item(state::Actor::User, media_item(cmd)).await {
                Ok(id) => (true, json!({ "ok": true, "result": { "content": [] } }), Some(id.to_string())),
                Err(e) => (false, json!({ "ok": false, "error": { "code": "internal", "message": format!("{e:?}") } }), None),
            }
        } else {
            let args = build_args(cmd, &refs);
            let env_str = reply(dispatch_tool(&backend, &op, &serde_json::to_string(&args).unwrap()).await);
            let env: Value = serde_json::from_str(&env_str).unwrap();
            let ok = env["ok"].as_bool().unwrap();
            let ret = if ok { extract_ref_id(&op, &env["result"]) } else { None };
            (ok, env, ret)
        };
        if let (true, Some(id)) = (ok, &ret) {
            if let Some(rf) = cmd["ref"].as_str() { refs.insert(rf.to_string(), id.clone()); }
        }
        let snap = h.snapshot().await;
        steps.push(json!({ "op": op, "ok": ok, "env": env, "state": canonical_state(&*snap) }));
    }
    state::ids::det::disable();
    println!("{}", serde_json::to_string_pretty(&json!({ "name": name, "steps": steps })).unwrap());
}

/// Build the wire-args object: copy every key of cmd except op/ref, resolving
/// @ref-token string values to resolved UUID strings. (= prod_driver build_wire_args.)
fn build_args(cmd: &Value, refs: &HashMap<String, String>) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(map) = cmd.as_object() {
        for (k, v) in map {
            if k == "op" || k == "ref" { continue; }
            obj.insert(k.clone(), resolve_value(v, refs));
        }
    }
    Value::Object(obj)
}

fn resolve_value(v: &Value, refs: &HashMap<String, String>) -> Value {
    match v {
        Value::String(s) => s.strip_prefix('@').and_then(|k| refs.get(k))
            .map(|id| Value::String(id.clone())).unwrap_or_else(|| v.clone()),
        Value::Array(arr) => Value::Array(arr.iter().map(|x| resolve_value(x, refs)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, val)| (k.clone(), resolve_value(val, refs))).collect()),
        other => other.clone(),
    }
}

/// Extract the @ref id from an MCP result envelope's `result` value, by tool.
/// id tools → result.content[0].text is the raw UUID. add_video_layer → the
/// inner JSON's "video_layer_id". Others → None.
fn extract_ref_id(op: &str, result: &Value) -> Option<String> {
    let text = result.get("content")?.get(0)?.get("text")?.as_str()?;
    match op {
        "add_track" | "add_color_layer" | "duplicate_layer" | "groups_create"
        | "add_effect" | "add_marker" => Some(text.to_string()),
        "add_video_layer" => {
            // Either a raw uuid (no pair) or JSON {audio_layer_id, group_id, video_layer_id}.
            serde_json::from_str::<Value>(text).ok()
                .and_then(|v| v.get("video_layer_id").and_then(Value::as_str).map(str::to_string))
                .or_else(|| Some(text.to_string()))
        }
        _ => None,
    }
}

fn canonical_state(p: &state::Project) -> Value {
    let mut v = serde_json::to_value(p).unwrap();
    if let Some(m) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        m.insert("created_at".into(), json!("<TS>"));
        m.insert("modified_at".into(), json!("<TS>"));
    }
    v
}

/// Byte-identical twin of prod_driver::media_item (see that file).
fn media_item(cmd: &Value) -> state::media::MediaItem {
    use state::media::{MediaItem, MediaKind, MediaMetadata};
    let kind = match cmd["kind"].as_str().unwrap() {
        "Video" => MediaKind::Video, "Audio" => MediaKind::Audio, "Image" => MediaKind::Image,
        other => panic!("bad media kind {other}"),
    };
    MediaItem {
        id: uuid::Uuid::parse_str(cmd["id"].as_str().unwrap()).unwrap(),
        label: None, path_abs: "media/clip.bin".into(), path_rel: None, kind,
        metadata: MediaMetadata {
            duration_us: cmd["duration_us"].as_i64(),
            video: None,
            audio: if cmd["with_audio"].as_bool().unwrap_or(false) {
                Some(state::media::AudioStreamMeta { sample_rate: 0, channels: 0, codec: "".into() })
            } else { None },
            container_format: None,
        },
        proxy_path: None, proxy_format_version: 0, quick_proxy_path: None,
        proxy_bypassed: false, export_uses_original: false, waveform_path: None,
        conform_path: None, thumbnails_dir: None,
        file_hash_blake3: "0".into(), file_size: 0, file_mtime: 0,
        imported_at: "2026-01-01T00:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap(),
    }
}
```

- [ ] **Step 3: Write the first MCP sequence.** `apps/desktop/fixtures/state-corpus/sequences-mcp/add-track.json`:

```json
{ "name": "add-track", "commands": [
  { "op": "add_track", "label": "T", "ref": "T1" },
  { "op": "add_color_layer", "track_id": "@T1", "t_start_us": 0, "t_end_us": 1000000, "color": { "r": 10, "g": 20, "b": 30, "a": 255 } }
] }
```

- [ ] **Step 4: Extend `gen-state-oracle.mjs`** — after the `prod_driver` loop (before `process.exit`), add:

```javascript
// MCP-channel oracles: real dispatch_tool under det ids, captured via reply().
const SEQ_MCP = 'fixtures/state-corpus/sequences-mcp'
const OUT_MCP = 'fixtures/state-corpus/oracle-mcp'
mkdirSync(OUT_MCP, { recursive: true })
const runMcp = (file) => execFileSync('cargo', [
  'run', '--quiet', '--manifest-path', 'native/Cargo.toml',
  '--bin', 'mcp_driver', '--features', 'replay,jobs,export,mcp,cloud,motifs', '--', join(SEQ_MCP, file),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
for (const file of readdirSync(SEQ_MCP).filter((f) => f.endsWith('.json'))) {
  const a = runMcp(file), b = runMcp(file)
  if (a !== b) { console.error(`NONDETERMINISTIC (mcp): ${file}`); fail++; continue }
  writeFileSync(join(OUT_MCP, file), a)
  console.log(`ok  mcp/${file}`)
}
```

- [ ] **Step 5: Regenerate and verify additivity.**

Run (from `apps/desktop`, with the toolchain env exported):
```bash
node scripts/gen-state-oracle.mjs
```
Expected: prints `ok  mcp/add-track.json`; creates `fixtures/state-corpus/oracle-mcp/add-track.json`. Then:
```bash
git -C ../.. status --short apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod
```
Expected: **empty** (no modified pre-existing oracles — additive only).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/native/src/bin/mcp_driver.rs apps/desktop/native/src/mcp/mod.rs apps/desktop/native/src/lib.rs apps/desktop/scripts/gen-state-oracle.mjs apps/desktop/fixtures/state-corpus/sequences-mcp/add-track.json apps/desktop/fixtures/state-corpus/oracle-mcp/add-track.json
git commit -m "feat(state-migration): mcp_driver det-id oracle + sequences-mcp dimension (Phase 3d-a)"
```

---

### Task 2: TS adapter skeleton + `mcpCall` + `replayMcpSequence` + the gate

**Files:**
- Create: `apps/desktop/src/main/state/mcp-commands.ts`
- Modify: `apps/desktop/src/main/state/actor.ts` (`ActorHandle` interface ~lines 48-58; add `mcpCall` impl after `command()`)
- Modify: `apps/desktop/src/main/state/replay.ts` (add exports)
- Create: `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts`
- Test: the gate above, run against `oracle-mcp/add-track.json`

**Interfaces:**
- Consumes: `dispatch()` (internal ops), `commit`/`applyAddLayer`/`applyAddMarker` closures (for arms in later tasks), `canonicalize`, `serializeProject`, `blankProject`, `seededGen`, `createActor`.
- Produces: `ActorHandle.mcpCall(name: string, argsJson: string): McpCallResult`; types `McpCallResult`/`ToolResultJson`/`McpToolErrorJson`; `replayMcpSequence(seq): Trace`; `mcpSequenceIsSupported(seq): boolean`; `MCP_TOOLS: ReadonlySet<string>`.

- [ ] **Step 1: Write `mcp-commands.ts` core** (types, helpers, error map, and the parser/shaper tables with ONLY `add_track` populated; later tasks fill the rest).

```typescript
// apps/desktop/src/main/state/mcp-commands.ts
// Pure MCP-tool adapter helpers: arg parsing (snake_case MCP vocab → internal
// dispatch vocab), ToolResult shaping, and CommandError → MCP error mapping.
// The byte-exact mcp.differential gate (vs Rust dispatch_tool) is the backstop.
// Mirrors native/src/mcp/{tools.rs,wire.rs}. DORMANT until Phase 3d-d.
import type { CommandError } from './errors'
import { canonicalize } from './canonical'

export type McpErrorCode = 'invalid_params' | 'invalid_request' | 'not_found' | 'internal'
export type McpToolErrorJson = { code: McpErrorCode; message: string; data?: unknown }
export type ToolResultJson = { content: Array<{ type: 'text'; text: string }> } // isError omitted when false
export type McpCallResult = { ok: true; result: ToolResultJson } | { ok: false; error: McpToolErrorJson }

/** Thrown by arg parsers on bad input (e.g. malformed UUID) → invalid_params. */
export class McpArgError extends Error {
  constructor(public readonly mcpMessage: string) { super(mcpMessage); this.name = 'McpArgError' }
  toJson(): McpToolErrorJson { return { code: 'invalid_params', message: this.mcpMessage } }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Mirrors tools.rs parse_uuid: validates + errors "<field> not a UUID: …". */
export function parseUuid(s: unknown, field: string): string {
  if (typeof s !== 'string' || !UUID_RE.test(s)) throw new McpArgError(`${field} not a UUID: ${String(s)}`)
  return s
}

// ── ToolResult shapers (wire.rs:81-93) ──
export function toolText(s: string): ToolResultJson { return { content: [{ type: 'text', text: s }] } }
export function toolEmpty(): ToolResultJson { return { content: [] } }
/** json results travel as a text block whose text is the SERIALIZED JSON with
 *  alpha-sorted keys (Rust serde_json preserve_order OFF → BTreeMap). */
export function toolJson(v: unknown): ToolResultJson { return { content: [{ type: 'text', text: JSON.stringify(canonicalize(v)) }] } }

/** map_command_error (tools.rs:61-118): CommandError → MCP error JSON. Only the
 *  structured `data` (LayerOverlap/MediaInUse) + InvalidArgument message are
 *  gated byte-exact; other prose messages are reasonable-but-ungated. */
export function mapCommandError(e: CommandError): McpToolErrorJson {
  if (e.error === 'InvalidArgument') return { code: 'invalid_params', message: `${e.field}: ${e.detail}` }
  if (e.error === 'Backend') return { code: 'internal', message: e.detail }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'LayerOverlap') {
    const d = e.detail
    return { code: 'invalid_params', message: 'layer overlap', data: {
      error: 'LayerOverlap', track: d.track, blocking_layer: d.a,
      blocking_range_us: [d.a_start, d.a_end], requested_range_us: [d.b_start, d.b_end],
      options: [
        { action: 'create_new_track', kind: 'Video' },
        { action: 'trim_existing', layer_id: d.a, new_t_end_us: d.b_start },
        { action: 'split_at_t', layer_id: d.a, at_t_us: d.b_start },
      ],
    } }
  }
  if (e.error === 'MediaInUse') {
    return { code: 'invalid_params', message: 'media in use', data: {
      error: 'MediaInUse', media: e.media, referenced_by: e.referenced_by,
      options: [
        { action: 'force_remove', note: 'calls remove_media with force=true; cascades layer deletions' },
        { action: 'delete_layers_first', layer_ids: e.referenced_by },
      ],
    } }
  }
  return { code: 'invalid_params', message: e.error }
}

/** MCP tool → internal dispatch op + renamed args. Throws McpArgError on bad
 *  UUIDs. Explicit-param tools (add_color_layer/add_video_layer/add_marker/
 *  split_layer) are NOT here — they have dedicated arms in actor.mcpCall. */
export const MCP_ARG_PARSERS: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> = {
  add_track: (a) => ({ op: 'add_track', args: { label: (a.label as string | undefined) ?? null } }),
}

/** MCP tool → ToolResult from the dispatch value. Tools absent here → toolEmpty. */
export const MCP_RESULT_SHAPERS: Record<string, (value: unknown) => ToolResultJson> = {
  add_track: (v) => toolText(v as string),
}

/** All MCP tools this adapter handles (parsers + the dedicated arms). Grows per task. */
export const MCP_TOOLS: ReadonlySet<string> = new Set<string>(['add_track', 'add_color_layer'])
```

- [ ] **Step 2: Add `mcpCall` to the `ActorHandle` interface** (`actor.ts`). Add this line inside `export interface ActorHandle { … }`:

```typescript
  mcpCall(name: string, argsJson: string): McpCallResult
```

And add the import at the top of `actor.ts`:
```typescript
import { mapCommandError, MCP_ARG_PARSERS, MCP_RESULT_SHAPERS, toolText, toolEmpty, toolJson, parseUuid, McpArgError, type McpCallResult } from './mcp-commands'
```

- [ ] **Step 3: Implement `mcpCall` inside `createActor`** (after the `command()` function; it reaches `dispatch`/`commit`/`applyAddLayer`/`applyAddMarker`). Add `mcpCall` to the returned object too.

```typescript
  function mcpCall(name: string, argsJson: string): McpCallResult {
    let a: Record<string, unknown>
    try { a = JSON.parse(argsJson) as Record<string, unknown> }
    catch (e) { return { ok: false, error: { code: 'invalid_params', message: `invalid args for ${name}: ${String(e)}` } } }
    try {
      // Dedicated arms for explicit-param tools land in Tasks 4. Until then, the
      // table path handles the mechanical tools.
      const parse = MCP_ARG_PARSERS[name]
      if (!parse) return { ok: false, error: { code: 'not_found', message: `unknown tool '${name}'` } }
      const { op, args } = parse(a)
      const r = dispatch(op, args)
      if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
      const shape = MCP_RESULT_SHAPERS[name] ?? (() => toolEmpty())
      return { ok: true, result: shape(r.value) }
    } catch (e) {
      if (e instanceof McpArgError) return { ok: false, error: e.toJson() }
      throw e
    }
  }
```

In the `return { … }` object at the end of `createActor`, add `mcpCall,`.

- [ ] **Step 4: Add `replayMcpSequence` + `mcpSequenceIsSupported` to `replay.ts`** (mirror `replayProductionSequence`, lines 187-205). Import `MCP_TOOLS` from `./mcp-commands`.

```typescript
export function mcpSequenceIsSupported(seq: Sequence): boolean {
  return seq.commands.every((c) => c.op === 'add_media' || MCP_TOOLS.has(c.op))
}

/** Drives the MCP adapter (actor.mcpCall) over an MCP-channel sequence, capturing
 *  the reply-envelope + canonical state per step. `add_media` is a pool seed via
 *  the existing dispatch path (MCP import_media is jobs/3d-d). */
export function replayMcpSequence(seq: Sequence): Trace {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  const aRoll = initial.tracks[0].id, bRoll = initial.tracks[1].id
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const refs = new Map<string, string>([['A', aRoll], ['B', bRoll]])
  const steps: TraceStep[] = []
  for (const cmd of seq.commands) {
    let env: unknown, ok: boolean, ret: string | null = null
    if (cmd.op === 'add_media') {
      const r = actor.dispatch('add_media', { id: cmd.id, kind: cmd.kind, duration_us: cmd.duration_us ?? null, with_audio: cmd.with_audio ?? false })
      ok = r.ok
      env = ok ? { ok: true, result: { content: [] } } : { ok: false, error: { code: 'internal', message: 'add_media failed' } }
      if (ok && typeof r.value === 'string') ret = r.value
    } else {
      const wire = resolveWire(cmd, refs)
      const r = actor.mcpCall(cmd.op, JSON.stringify(wire))
      ok = r.ok
      env = r
      if (r.ok) ret = mcpRefId(cmd.op, r.result)
    }
    if (ok && cmd.ref && ret) refs.set(cmd.ref, ret)
    steps.push({ op: cmd.op, ok, env, state: canonicalize(serializeProject(actor.snapshot())) } as TraceStep)
  }
  return { name: seq.name, steps }
}

/** @ref extraction mirroring mcp_driver::extract_ref_id. */
function mcpRefId(op: string, result: { content: Array<{ type: 'text'; text: string }> }): string | null {
  const text = result.content[0]?.text
  if (text == null) return null
  if (['add_track', 'add_color_layer', 'duplicate_layer', 'groups_create', 'add_effect', 'add_marker'].includes(op)) return text
  if (op === 'add_video_layer') {
    try { const v = JSON.parse(text) as { video_layer_id?: string }; return v.video_layer_id ?? text } catch { return text }
  }
  return null
}
```

Note: `TraceStep` currently is `{op, ok, error, state}` — extend the interface in `replay.ts` to add an optional `env?: unknown` field (the prod gate ignores it). Concretely change the interface to:
```typescript
export interface TraceStep { op: string; ok: boolean; error?: string | null; env?: unknown; state: unknown }
```
(`error` becomes optional; `replayProductionSequence` still sets it — leave that function untouched.)

- [ ] **Step 5: Write the gate** `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { replayMcpSequence, mcpSequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences-mcp')
const ORACLE = join(ROOT, 'oracle-mcp')

/** Compare an MCP error envelope by code + structured data only (prose message
 *  is non-asserted per the plan's error-gating decision; the underlying
 *  CommandError variant is gated by the state/prod differentials). */
function errKey(env: any): unknown {
  if (env?.ok !== false) return null
  return { code: env.error.code, data: env.error.data ?? null }
}

describe('Phase 3d-a differential: TS mcpCall adapter === Rust dispatch_tool oracle', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  const skipped = files.filter((f) => !mcpSequenceIsSupported(JSON.parse(readFileSync(join(SEQ, f), 'utf8'))))

  it('every mcp corpus sequence is in-vocabulary (no silent skips)', () => {
    expect(skipped.sort(), `unexpectedly skipped: ${skipped.join(', ')}`).toEqual([])
  })

  for (const f of files) {
    it(`matches the mcp oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing oracle-mcp ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replayMcpSequence(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts: any = trace.steps[i], or: any = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.state), `state ${where}`).toBe(JSON.stringify(canonicalize(or.state)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (ts.ok) expect(JSON.stringify(ts.env.result), `result ${where}`).toBe(JSON.stringify(or.env.result))
        else expect(errKey(ts.env), `error ${where}`).toEqual(errKey(or.env))
      }
    })
  }
})
```

- [ ] **Step 6: Run the gate (expect FAIL on `add_color_layer`).**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.differential.test.ts`
Expected: the `add-track` sequence's step 0 (`add_track`) PASSES, step 1 (`add_color_layer`) FAILS (not yet in `MCP_ARG_PARSERS` and no arm → `not_found` ⇒ state/result mismatch). This confirms the harness wiring before the tool is implemented.

- [ ] **Step 7: Temporarily prove green** by trimming `add-track.json` to only the `add_track` command (remove the `add_color_layer` command), re-run gen + gate; expect PASS. Then restore the `add_color_layer` command (it is implemented in Task 4). Leave the gate failing on `add_color_layer` until Task 4 — OR move the `add_color_layer` step into a Task-4 sequence and keep `add-track.json` single-command. **Choose the latter:** edit `add-track.json` to the single `add_track` command, regen, gate PASS.

`add-track.json` final:
```json
{ "name": "add-track", "commands": [ { "op": "add_track", "label": "T", "ref": "T1" } ] }
```

- [ ] **Step 8: Run full state suite + typecheck.**

Run: `cd apps/desktop && npx vitest run src/main/state && npx tsc -b`
Expected: all green (existing gates unaffected; `mcp.differential` passes for `add-track`).

- [ ] **Step 9: Commit.**

```bash
git add apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/__tests__/mcp.differential.test.ts apps/desktop/fixtures/state-corpus/sequences-mcp/add-track.json apps/desktop/fixtures/state-corpus/oracle-mcp/add-track.json
git commit -m "feat(state-migration): TS mcpCall adapter + mcp.differential gate (add_track) (Phase 3d-a)"
```

---

### Task 3: `mapCommandError` error-path coverage

**Files:**
- Modify: `apps/desktop/fixtures/state-corpus/sequences-mcp/` (add error sequences)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` only if a fix is needed (mapCommandError already written in Task 2)
- Test: `mcp.differential.test.ts`

**Interfaces:**
- Consumes: `mapCommandError` (Task 2), `dispatch` error surfacing.
- Produces: gated error envelopes for `LayerOverlap`, `MediaInUse`, bad-UUID `InvalidArgument`.

- [ ] **Step 1: Add an `InvalidArgument` (bad UUID) sequence.** `sequences-mcp/err-bad-uuid.json`:

```json
{ "name": "err-bad-uuid", "commands": [
  { "op": "remove_track", "track_id": "not-a-uuid" }
] }
```
(`remove_track` lands in Task 5's parser; for Task 3 add a minimal `remove_track` parser entry to `MCP_ARG_PARSERS` now: `remove_track: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: (a.force as boolean) ?? false } })` and add `'remove_track'` to `MCP_TOOLS`. The bad UUID throws `McpArgError` BEFORE dispatch.)

- [ ] **Step 2: Add a `LayerOverlap` sequence.** `sequences-mcp/err-layer-overlap.json`:

```json
{ "name": "err-layer-overlap", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 0, "t_end_us": 2000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 }, "ref": "L1" },
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 1000000, "t_end_us": 3000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 } }
] }
```
(Depends on `add_color_layer` from Task 4 — sequence the tasks so Task 4 lands first, OR add this sequence in Task 4. **Move `err-layer-overlap.json` to Task 4** since it needs `add_color_layer`. Task 3 ships only `err-bad-uuid` + `err-media-in-use`.)

- [ ] **Step 3: Add a `MediaInUse` sequence.** `sequences-mcp/err-media-in-use.json`:

```json
{ "name": "err-media-in-use", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 0, "t_end_us": 5000000, "src_in_us": 0, "src_out_us": 5000000, "ref": "VL" },
  { "op": "remove_media", "media_id": "@M1" }
] }
```
(Depends on `add_video_layer` + `remove_media` — **move `err-media-in-use.json` to Task 4/5** after those land. Task 3 ships only `err-bad-uuid.json`, which depends solely on the Task-3 `remove_track` parser entry.)

> Net for Task 3: ship `err-bad-uuid.json` + the `remove_track` parser entry. The `LayerOverlap`/`MediaInUse` data-shape coverage is added in Task 4/5 alongside the tools they need. This keeps each task independently green.

- [ ] **Step 4: Regen + gate.**

Run: `cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts`
Expected: `err-bad-uuid` passes — Rust returns `{ok:false,error:{code:"invalid_params",message:"track_id not a UUID: …"}}`; TS `McpArgError` yields the same `code` (message non-asserted, but for `InvalidArgument`-shaped it matches; here it is a parser-level McpArgError with identical `code`). `errKey` compares `code:"invalid_params", data:null` on both sides → equal.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/main/state/mcp-commands.ts apps/desktop/fixtures/state-corpus/sequences-mcp/err-bad-uuid.json apps/desktop/fixtures/state-corpus/oracle-mcp/err-bad-uuid.json
git commit -m "feat(state-migration): MCP bad-arg error envelope gated (Phase 3d-a)"
```

---

### Task 4: Layer-creation family (explicit-param arms)

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (`mcpCall` — add dedicated arms)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (`MCP_TOOLS` additions; helper `mcpColorParams`)
- Create sequences: `add-color-layer.json`, `add-video-layer-no-pair.json`, `add-video-layer-auto-pair.json`, `split-layer.json`, `duplicate-layer.json`, `err-layer-overlap.json`, `err-media-in-use.json`
- Test: `mcp.differential.test.ts`

**Interfaces:**
- Consumes: `commit`, `applyAddLayer`, `applyGroupsCreate`, `colorParams`, `videoClipParams`, `audioParams` (from `mutations/`), `dispatch('split_layer'|'duplicate_layer')`, `snapshot()`.
- Produces: `mcpCall` arms for `add_color_layer`/`add_video_layer`/`split_layer` (+ `duplicate_layer` via table).

- [ ] **Step 1: Add dedicated arms in `mcpCall`** (BEFORE the `MCP_ARG_PARSERS` lookup — a `switch (name)` for the explicit-param tools). Insert in `mcpCall`'s `try` block:

```typescript
      switch (name) {
        case 'add_color_layer': {
          const track = parseUuid(a.track_id, 'track_id')
          const params = colorParams(a.color as Rgba, (a.width as number | undefined) ?? 1920, (a.height as number | undefined) ?? 1080)
          const id = commit('Added layer', [], { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, track, params, a.t_start_us as number, a.t_end_us as number))
          return { ok: true, result: toolText(id) }
        }
        case 'add_video_layer': {
          const track = parseUuid(a.track_id, 'track_id')
          const media = parseUuid(a.media_id, 'media_id')
          const snap = current()
          const item = snap.media_pool[media]
          const vParams = videoClipParams(media, a.src_in_us as number, a.src_out_us as number)
          const videoId = commit('Added layer', [], { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, track, vParams, a.t_start_us as number, a.t_end_us as number))
          const shouldPair = (snap.settings.auto_pair_audio_on_import === true) && (item?.metadata.audio != null)
          if (shouldPair) {
            // ensure_audio_track (tools.rs:123-132): topmost track, or a new "Voiceover".
            const tracks = current().tracks
            const audioTrack = tracks.length ? tracks[tracks.length - 1].id
              : commit('Added track', [], { kind: 'Coarse' }, (d) => applyAddTrack(d, idGen, 'Voiceover'))
            const aParams = { ...audioParams(media, a.src_in_us as number, a.src_out_us as number), role: 'dialogue' as const }
            const audioId = commit('Added layer', [], { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, audioTrack, aParams, a.t_start_us as number, a.t_end_us as number))
            const groupId = commit('Created group', [], { kind: 'Coarse' }, (d) => applyGroupsCreate(d, idGen, [videoId, audioId], null, false))
            return { ok: true, result: toolJson({ video_layer_id: videoId, audio_layer_id: audioId, group_id: groupId }) }
          }
          return { ok: true, result: toolText(videoId) }
        }
        case 'add_marker': {
          const id = commit('Added marker', [], { kind: 'Coarse' }, (d) => applyAddMarker(d, idGen, a.t_us as number, (a.end_t_us as number | undefined) ?? null, a.label as string, a.color as Rgba))
          return { ok: true, result: toolText(id) }
        }
        case 'split_layer': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const r = dispatch('split_layer', { layer, at_t_us: a.at_t_us, escape_group: (a.escape_group as boolean) ?? false })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          // SplitLayerResult{left,right}: confirm against Rust do_split_layer which
          // id is the original (left) vs the new (right). The gate pins it; adjust
          // if the oracle disagrees. Initial mapping: left=input layer, right=new id.
          return { ok: true, result: toolJson({ left: layer, right: r.value as string }) }
        }
      }
```

(`applyAddTrack`, `colorParams`, `videoClipParams`, `audioParams`, `applyGroupsCreate`, `applyAddMarker`, `Rgba` must be imported in `actor.ts` — most already are; add `colorParams` from `./mutations/add` and `Rgba` from `./model` if missing.)

- [ ] **Step 2: Add the table entries** for `duplicate_layer` in `mcp-commands.ts`:

```typescript
  duplicate_layer: (a) => ({ op: 'duplicate_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), t_offset_us: a.t_offset_us } }),
```
in `MCP_ARG_PARSERS`, and:
```typescript
  duplicate_layer: (v) => toolText(v as string),
```
in `MCP_RESULT_SHAPERS`. Extend `MCP_TOOLS` to include `'add_video_layer','add_marker','split_layer','duplicate_layer'` (and `'add_color_layer'` already there).

- [ ] **Step 3: Write the sequences.**

`sequences-mcp/add-color-layer.json`:
```json
{ "name": "add-color-layer", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 0, "t_end_us": 1000000, "color": { "r": 10, "g": 20, "b": 30, "a": 255 }, "ref": "L1" }
] }
```

`sequences-mcp/add-video-layer-no-pair.json`:
```json
{ "name": "add-video-layer-no-pair", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000a1", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 0, "t_end_us": 5000000, "src_in_us": 0, "src_out_us": 5000000, "ref": "VL" }
] }
```

`sequences-mcp/add-video-layer-auto-pair.json`:
```json
{ "name": "add-video-layer-auto-pair", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000a2", "kind": "Video", "duration_us": 5000000, "with_audio": true, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 0, "t_end_us": 5000000, "src_in_us": 0, "src_out_us": 5000000, "ref": "VL" }
] }
```

`sequences-mcp/split-layer.json`:
```json
{ "name": "split-layer", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 0, "t_end_us": 4000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 }, "ref": "L1" },
  { "op": "split_layer", "layer_id": "@L1", "at_t_us": 2000000 }
] }
```

`sequences-mcp/duplicate-layer.json`:
```json
{ "name": "duplicate-layer", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 0, "t_end_us": 1000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 }, "ref": "L1" },
  { "op": "duplicate_layer", "layer_id": "@L1", "t_offset_us": 2000000 }
] }
```

Plus the two error sequences moved from Task 3: `err-layer-overlap.json` and `err-media-in-use.json` (bodies in Task 3 Steps 2-3).

- [ ] **Step 4: Regen + gate.**

Run: `cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts`
Expected: all pass. **If `split-layer` fails on the `{left,right}` mapping**, swap to `{ left: r.value, right: layer }` (or read the oracle's `result.content[0].text` to see Rust's ordering) and re-run — the oracle is the source of truth.
**If `add-video-layer-auto-pair` fails**, compare the per-step state: the Rust handler does video-add → audio-add → groups_create as THREE separate operations; verify the TS arm issues three `commit`s in that order (so ids allocate identically), and that the paired Audio role serializes as `"dialogue"` (kebab wire form) and the audio track is the topmost (B-roll, id #2) not a new track.

- [ ] **Step 5: Full suite + typecheck + commit.**

```bash
cd apps/desktop && npx vitest run src/main/state && npx tsc -b
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mcp-commands.ts apps/desktop/fixtures/state-corpus/sequences-mcp/ apps/desktop/fixtures/state-corpus/oracle-mcp/
git commit -m "feat(state-migration): MCP layer-creation tools + auto-pair, gated (Phase 3d-a)"
```

---

### Task 5: Mechanical batch (the remaining ~22 tools)

**Files:**
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (`MCP_ARG_PARSERS`, `MCP_RESULT_SHAPERS`, `MCP_TOOLS`)
- Create sequences: one per tool family
- Test: `mcp.differential.test.ts`

**Interfaces:**
- Consumes: `dispatch()` ops (`delete_track`/`move_track`/`update_layer`/`update_layer_params`/`move_layer`/`trim_layer`/`delete_layer`/`groups_*`/`add_effect`/`update_effect`/`move_effect`/`remove_effect`/`set_composition`/`fit_composition_to_layers`/`update_marker`/`remove_marker`/`remove_media`/`undo`/`redo`/`set_role_gain`/`update_role_flags`), `lockHistory`/`unlockHistory` (ActorHandle).
- Produces: full `MCP_ARG_PARSERS`/`MCP_RESULT_SHAPERS`/`MCP_TOOLS`.

- [ ] **Step 1: Fill `MCP_ARG_PARSERS`** with the complete table (append to the existing entries):

```typescript
  remove_track: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: (a.force as boolean) ?? false } }),
  move_track: (a) => ({ op: 'move_track', args: { track: parseUuid(a.track_id, 'track_id'), new_position: a.new_position } }),
  update_layer: (a) => ({ op: 'update_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: a.patch } }),
  update_layer_params: (a) => ({ op: 'update_layer_params', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: a.patch } }),
  move_layer: (a) => ({ op: 'move_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), to_track: parseUuid(a.new_track_id, 'new_track_id'), t_start_us: a.new_t_start_us, escape_group: (a.escape_group as boolean) ?? false } }),
  trim_layer: (a) => ({ op: 'trim_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), edge: a.edge, new_t_us: a.new_t_us, escape_group: (a.escape_group as boolean) ?? false } }),
  delete_layer: (a) => ({ op: 'delete_layer', args: { layer: parseUuid(a.layer_id, 'layer_id') } }),
  groups_create: (a) => ({ op: 'groups_create', args: { layers: (a.layer_ids as string[]).map((s) => parseUuid(s, 'layer_ids')), label: (a.label as string | undefined) ?? null, reassign: (a.reassign as boolean) ?? false } }),
  groups_dissolve: (a) => ({ op: 'groups_dissolve', args: { group: parseUuid(a.group_id, 'group_id') } }),
  groups_add_members: (a) => ({ op: 'groups_add_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: (a.layer_ids as string[]).map((s) => parseUuid(s, 'layer_ids')), reassign: (a.reassign as boolean) ?? false } }),
  groups_remove_members: (a) => ({ op: 'groups_remove_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: (a.layer_ids as string[]).map((s) => parseUuid(s, 'layer_ids')) } }),
  groups_rename: (a) => ({ op: 'groups_rename', args: { group: parseUuid(a.group_id, 'group_id'), label: (a.label as string | undefined) ?? null } }),
  add_effect: (a) => ({ op: 'add_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), kind: a.kind } }),
  update_effect: (a) => ({ op: 'update_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), patch: a.patch } }),
  move_effect: (a) => ({ op: 'move_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), new_index: a.new_index } }),
  remove_effect: (a) => ({ op: 'remove_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id') } }),
  set_composition: (a) => ({ op: 'set_composition', args: a.patch as Record<string, unknown> }),
  fit_composition_to_layers: () => ({ op: 'fit_composition_to_layers', args: {} }),
  update_marker: (a) => ({ op: 'update_marker', args: { marker: parseUuid(a.marker_id, 'marker_id'), patch: a.patch } }),
  remove_marker: (a) => ({ op: 'remove_marker', args: { marker: parseUuid(a.marker_id, 'marker_id') } }),
  remove_media: (a) => ({ op: 'remove_media', args: { media: parseUuid(a.media_id, 'media_id'), force: (a.force as boolean) ?? false } }),
  undo: () => ({ op: 'undo', args: {} }),
  redo: () => ({ op: 'redo', args: {} }),
  set_role_gain: (a) => ({ op: 'set_role_gain', args: { role: a.role, gain_db: a.gain_db } }),
  set_role_flags: (a) => ({ op: 'update_role_flags', args: { role: a.role, patch: { muted: a.muted ?? null, solo: a.solo ?? null } } }),
```

- [ ] **Step 2: Fill `MCP_RESULT_SHAPERS`** — only id-returning tools need an entry; everything else defaults to `toolEmpty`. Add:

```typescript
  add_effect: (v) => toolText(v as string),
```
(All other tools in this batch return `ToolResult::empty()` per the Rust handlers — leave them out so the `?? toolEmpty()` default applies.)

- [ ] **Step 3: Handle `lock_history`/`unlock_history`** — these are not `dispatch()` ops (they are `ActorHandle.lockHistory`/`unlockHistory`). Add dedicated arms in `mcpCall`'s `switch (name)` block:

```typescript
        case 'lock_history': lockHistory(a.reason as string); return { ok: true, result: toolEmpty() }
        case 'unlock_history': unlockHistory(); return { ok: true, result: toolEmpty() }
```
(They reference the in-actor `lockHistory`/`unlockHistory` closures — confirm those names; they are exposed on `ActorHandle` so the closures exist.)

- [ ] **Step 4: Extend `MCP_TOOLS`** to the full set:

```typescript
export const MCP_TOOLS: ReadonlySet<string> = new Set<string>([
  'add_track', 'remove_track', 'move_track',
  'add_color_layer', 'add_video_layer', 'update_layer', 'update_layer_params',
  'move_layer', 'split_layer', 'delete_layer', 'trim_layer', 'duplicate_layer',
  'groups_create', 'groups_dissolve', 'groups_add_members', 'groups_remove_members', 'groups_rename',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'set_composition', 'fit_composition_to_layers',
  'add_marker', 'update_marker', 'remove_marker',
  'remove_media', 'undo', 'redo', 'lock_history', 'unlock_history',
  'set_role_gain', 'set_role_flags',
])
```

- [ ] **Step 5: Write one sequence per family.** Create (mirror the JSON shapes from Tasks 1/4; resolve ids via `@ref`):
  - `tracks.json` — add_track(ref T1) → move_track(@T1 via track_id, new_position 0) → remove_track(@T1).
  - `layer-edits.json` — add_color_layer(ref L1) → update_layer(@L1, patch:{label:"x"}) → update_layer_params(@L1, patch:{kind:"Color",width:640}) → move_layer(@L1, new_track_id:@B, new_t_start_us:0) → trim_layer(@L1, edge:"out", new_t_us:500000) → delete_layer(@L1).
  - `groups.json` — two color layers (ref L1,L2) → groups_create(layer_ids:[@L1,@L2], ref G1) → groups_rename(@G1, label:"g") → groups_add_members / groups_remove_members / groups_dissolve as applicable.
  - `effects.json` — add_color_layer(ref L1) → add_effect(@L1, kind:"blur", ref E1) → update_effect(@L1,@E1, patch:{enabled:false}) → move_effect(@L1,@E1, new_index:0) → remove_effect(@L1,@E1).
  - `composition.json` — set_composition(patch:{width:1280,height:720}) → fit_composition_to_layers.
  - `markers.json` — add_marker(t_us:0, label:"m", color:{r:0,g:128,b:255,a:255}, ref MK) → update_marker(@MK, patch:{t_us:1000000}) → remove_marker(@MK).
  - `history.json` — add_color_layer → undo → redo; plus a fresh sequence `undo-empty.json` with a single `undo` (asserts `NothingToUndo` error).
  - `roles.json` — set_role_gain(role:"music", gain_db:-6) → set_role_flags(role:"music", muted:true).
  - `lock.json` — lock_history(reason:"batch") → unlock_history.
  - `err-media-in-use.json` (from Task 3 Step 3, now that add_video_layer + remove_media exist).

For each, write the exact `{name, commands:[…]}` JSON following the field names in the parser table above (MCP snake_case: `track_id`, `layer_id`, `new_track_id`, `new_t_start_us`, `new_t_us`, `effect_id`, `group_id`, `layer_ids`, `marker_id`, `media_id`).

- [ ] **Step 6: Regen + gate.**

Run: `cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts`
Expected: all sequences pass. Common fix points: `set_role_flags` patch shape (`update_role_flags` expects `{patch:{muted,solo}}` — confirm field names vs `RoleFlagsPatch`); `undo-empty` error (Rust `NothingToUndo` → MCP `invalid_params`, no data; TS `dispatch('undo')` surfaces `{error:'NothingToUndo'}` → `mapCommandError` → `{code:'invalid_params'}`; `errKey` compares `code`+`data:null` → equal).

- [ ] **Step 7: Full suite + typecheck + commit.**

```bash
cd apps/desktop && npx vitest run src/main/state && npx tsc -b
git add apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/actor.ts apps/desktop/fixtures/state-corpus/sequences-mcp/ apps/desktop/fixtures/state-corpus/oracle-mcp/
git commit -m "feat(state-migration): MCP mechanical-tool batch, full surface gated (Phase 3d-a)"
```

---

### Task 6: Audit, README, dormancy + additivity verification

**Files:**
- Modify: `apps/desktop/fixtures/state-corpus/README.md`
- (No source change unless the audit finds a gap.)

**Interfaces:** none (verification task).

- [ ] **Step 1: Tool-coverage audit.** Confirm every 3d-a tool (the 31 in the spec table) appears in at least one `sequences-mcp/*.json`. List each tool → sequence file. If any is missing a sequence, add one (regen + gate) before proceeding.

- [ ] **Step 2: Dormancy verification.**

Run: `git -C ../.. diff --name-only main..phase-3d-a-mcp-port -- apps/desktop/src/main/index.ts apps/desktop/src/main/mcp/server.ts apps/desktop/src/main/mcp/mutationTools.ts`
Expected: **empty** (no live-wiring files touched).

- [ ] **Step 3: Corpus additivity verification.**

Run: `git -C ../.. diff --diff-filter=M --name-only main..phase-3d-a-mcp-port -- apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod`
Expected: **empty** (only NEW `oracle-mcp/` + `sequences-mcp/` files; pre-existing oracles unmodified).

- [ ] **Step 4: Full gates.**

Run:
```bash
cd apps/desktop && npx vitest run && npx tsc -b
cargo test --manifest-path native/Cargo.toml --lib --features replay,jobs,export,mcp,cloud,motifs
```
Expected: full vitest suite green (all differential gates `skipped===[]`); `tsc -b` clean; Rust lib tests pass.

- [ ] **Step 5: Update the corpus README.** Add a `### sequences-mcp / oracle-mcp` section to `apps/desktop/fixtures/state-corpus/README.md` documenting: the dimension drives the real `dispatch_tool` via `mcp_driver` under det ids; the oracle captures `{op, ok, env, state}`; the gate asserts state + result byte-identical and error `code`+`data` (prose message non-asserted); the 31 tools covered; DORMANT (no live routing — 3d-d).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/fixtures/state-corpus/README.md
git commit -m "docs(state-migration): corpus README — sequences-mcp dimension + 3d-a audit (Phase 3d-a)"
```

---

## Self-Review (filled by the plan author)

**Spec coverage:** ✓ 31 mechanical tools (Tasks 4-5); ✓ mcp-commands.ts adapter (T2); ✓ mcp_driver + corpus dimension (T1); ✓ envelope contract incl. sorted-key JSON (T2 `toolJson`); ✓ map_command_error code+data (T2/T3); ✓ add_video_layer MCP auto-pair (T4); ✓ dormant — no server.ts/mutationTools.ts (Global Constraints + T6); ✓ additive corpus (T1/T6). Deferred-to-later-slices items (keyframes/dry_run/checkpoints/agent-session/hybrids/reads/un-pause) are explicitly out of scope per the spec.

**Placeholder scan:** the only deliberate "verify at gate" points are the `split_layer` left/right ordering (T4 Step 4, with the concrete fallback) and a few patch-field-name confirmations (T5/T6) — each gives the concrete check + fix, backed by the byte-exact oracle. No bare TODOs.

**Type consistency:** `McpCallResult`/`ToolResultJson`/`McpToolErrorJson` defined once in `mcp-commands.ts`, consumed by `actor.ts`/`replay.ts`/the gate. `MCP_ARG_PARSERS`/`MCP_RESULT_SHAPERS`/`MCP_TOOLS` names consistent across tasks. `mcpCall` signature identical in the interface and impl.
