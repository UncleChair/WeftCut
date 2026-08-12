# MCP Server & Agent UX

WeftCut exposes itself as an MCP server. External agents (Claude Desktop, Cursor, Cline, custom Python clients) connect over a localhost server and edit the project through a structured tool surface. Clients connect one of two ways: through the **`weftcut-mcp` stdio shim** (recommended — the config survives app restarts, port changes, and token rotations, and keeps working while the app is closed) or **HTTP-direct** to the in-app endpoint (for clients that cannot spawn stdio servers).

## Transport & deployment

- **Streamable-HTTP on `127.0.0.1:<auto-port>/mcp`**, hosted in the Electron
  main process: an `express` app fronts the `@modelcontextprotocol/sdk`
  `StreamableHTTPServerTransport`. The app isn't a child process of
  the agent. Each `initialize` request mints a session (UUID in the
  `Mcp-Session-Id` header); subsequent requests on that session route back to
  the same transport. In-protocol notifications (the change feed below) ride the
  same connection, so there is no separate event endpoint.
- **The stdio shim (`weftcut-mcp`)** wraps that endpoint for clients: a single
  self-contained bundle (`src/cli/`, built by `scripts/build-cli.mjs`) that
  runs under `ELECTRON_RUN_AS_NODE` — the WeftCut binary doubles as its Node
  runtime, so user machines need no Node install. It ships as an extraResource
  and the app copies it to `<userData>/cli/weftcut-mcp.cjs` at every startup;
  client configs reference THAT copy, the only path stable across upgrades on
  all three OSes (an AppImage mounts at a random point per run). `<userData>`
  is `<appData>/WeftCut` — Electron names it from package.json's `productName`,
  which is why that key must stay set: electron-builder's own `productName` is
  never written into the packaged package.json, and without it both dev and
  packaged builds fall back to the scoped package name. The shim
  re-reads `mcp_auth.json` on every bridge (re)connect, so port re-picks and
  token rotations self-heal, and the config fragment carries no URL and no
  token.
- **Shim catalog = synthetic ∪ (app reachable ? real catalog : ∅).** Two
  synthetic tools are always present: `weftcut_status` (endpoint state + next
  steps) and `launch_weftcut` (detached GUI spawn, then waits for the endpoint,
  bounded). `tools/list_changed` fires on every bridge transition, so one agent
  session upgrades to the full catalog the moment the app comes up — including
  when `launch_weftcut` itself brought it up — and degrades back to the
  synthetic surface when the app closes. Down-state calls fail with the remedy
  in the error **message** (see the error model below). While bridged, the
  change feed is forwarded verbatim, so a shim-connected agent sees exactly
  what an HTTP-direct one does.
- **Shim subcommands** (the terminal-facing connection helpers): `info`
  (endpoint, token, reachability; exit 3 when the app is down), `print-config`
  (the machine-specific `mcpServers` fragment), `list-tools` (dump the running
  app's advertised catalog), `help`.
- The Rust core is **transport-free**: it provides the tool catalog, resource
  readers, prompts, and wire types, and the main process bridges to it over
  dedicated napi methods (`mcpCatalog`, `mcpCallTool`, `mcpReadResource`,
  `mcpListPrompts`, `mcpGetPrompt`). The Rust wire types serialize to exactly
  the JSON shapes the SDK's low-level `Server` expects, so the main process
  forwards Rust output verbatim.
- Bearer token + auto-picked port are persisted to `<userData>/mcp_auth.json`
  on first launch and reused on every subsequent start so the Claude Desktop /
  Cursor snippet stays valid across restarts. If the saved port is occupied at
  bind time, the server falls back to a fresh OS-picked port and rewrites the
  file.
- One server per running WeftCut instance. Multi-instance = multi-port;
  surfaced in the connection UI.
- For remote access (Tailscale, ngrok, codespace): out of scope. Localhost only.

## Authentication

- Random 32-byte hex token generated on first launch, stored in
  `<userData>/mcp_auth.json` alongside the auto-picked port.
- The token is **enforced** on every `/mcp` request: the main process owns the
  express middleware, so each request must carry `Authorization: Bearer <token>`
  or it's rejected with `401`. The compare is constant-time (`timingSafeEqual`)
  — not a meaningful attack surface for a 256-bit localhost token, but the
  correct form.
- **DNS-rebinding protection** is on: the transport rejects requests whose
  `Host` header isn't the loopback bind (`allowedHosts` = `127.0.0.1:<port>` /
  `localhost:<port>`), so a malicious web page the user visits can't POST to the
  loopback port and drive the editor. The bearer is the primary gate; `Origin`
  is left unrestricted so non-browser MCP clients still work.
- No token visible in UI until the user opens the **Connect agent** panel —
  defends against video tutorials accidentally leaking it on stream.
- A **Refresh** button in the Connect-agent panel rotates the bearer in place:
  the server stays bound on the same port and `mcp_auth.json` is rewritten with
  the new token.

## Connection UX

The app's **Connect agent** panel (Settings → Agent):
- **Primary: the stdio shim config**, one copyable snippet per client
  (Codex TOML / Claude / Cursor / generic JSON) plus a self-configuration
  prompt the user can paste into any MCP-capable agent. No token rides in
  these — the shim resolves it at connect time.
- **Advanced (collapsed): HTTP-direct** — the server URL
  (`http://127.0.0.1:<port>/mcp`), the bearer token (masked until revealed,
  rotatable in place), and the same per-client snippets in URL + header form.
  For clients that cannot spawn stdio servers; breaks whenever the app is
  closed and goes stale when the port or token changes.
- Renders "starting…" while the server is still binding its port; polls
  `get_mcp_info` until the bind completes. Until the shim bundle exists (dev
  before `build:cli`), the HTTP path renders as primary.

Shim snippet example (paths are machine-specific, generated at runtime from
`process.execPath` and `app.getPath("userData")`):
```json
{
  "mcpServers": {
    "weftcut": {
      "command": "C:\\Users\\u\\AppData\\Local\\Programs\\WeftCut\\WeftCut.exe",
      "args": ["C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut-mcp.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "WEFTCUT_USERDATA": "C:\\Users\\u\\AppData\\Roaming\\WeftCut" }
    }
  }
}
```

HTTP-direct snippet example (the advanced path; Cursor has the same shape):
```json
{
  "mcpServers": {
    "weftcut": {
      "url": "http://127.0.0.1:50831/mcp",
      "headers": { "Authorization": "Bearer 8f3a..." }
    }
  }
}
```

## Multi-agent semantics

Multiple agents may connect simultaneously. The single-writer actor (see [data-model.md](data-model.md)) serializes all mutations regardless of source.

Rules:
- Tool calls are atomic: each call either commits or rejects; no half-applied edits.
- Operations carry an `Actor` tag (`User` or `Agent { client }`) — surfaced in change events and the status-log console.
- Connected agents receive change notifications in-protocol (see the change feed below) to see edits from other agents and the user.
- No edit-locks, no per-agent state. If two agents step on each other, the second to commit may fail invariants — expected, agents should retry or back off.
- `lock_history(reason)` is the explicit cooperative pen: one client holds the undo pen during a batch, and every REVERT path (`undo`, `redo`, `jump_to`, `restore_checkpoint`) — from the UI or another agent — fails with `HistoryLocked` until the lock releases. It gates reverting only: edits still commit, and the lock never affects what records (`docs/features.md#undo-stack-scope` is authoritative).

## Tool surface

The MCP tool surface is the same set of actor commands the UI calls.
Two declarative tables single-source the advertised schemas and the
name→handler dispatch, so a tool can never appear in one without the
other: `MCP_TOOL_DEFS` in the TS actor host for every mutation tool, and
the `tool_table!` macro in the Rust core for the native compute tools.
Every advertised schema property carries an explicit `type` — MCP
clients coerce untyped fields to `type: string`, which forces agents to
send nested payloads as JSON-encoded strings (a catalog-wide test gates
this). Don't expose 100 tools; agents get confused. The current set is
around 40, organised below.

### Read (resources, not tools)

| URI | Returns |
|---|---|
| `project://current` | full Project JSON (with `schema_version`) |
| `project://composition` | composition only |
| `project://media` | media pool listing |
| `project://tracks` | tracks + layer envelopes |
| `project://layers/{id}` | one layer in detail |
| `project://markers` | all markers |
| `project://history` | recent ops + checkpoints (snapshot-free). Each op carries `summary` (English prose), `label_key` + optional `label_args` (its i18n key and interpolation values — `history.*`, see `main/state/history-labels.ts`), `affected` (Track/Layer/Marker refs) and `entity_labels` (names for `affected`, same length and order, resolved against whichever stored snapshot still **holds** each ref — the op's own for an add/update/move, its predecessor's for a delete — so a deleted entity still has a name). An `entity_labels` element is `{"text": "…"}` for a resolved name or `{"kind_key": "kinds.color"}` when only the entity's kind is known (the key is translated by the UI). The envelope carries `window_start` and `evicted` — see below |
| `project://compiled` | compiled audio IRGraph (JSON) |
| `media://{id}/thumbnail` | middle thumbnail as JPG (base64) |
| `media://{id}/frame/{t_us}` | on-demand frame at the given microsecond, lazy-cached (multimodal-friendly) |
| `media://{id}/waveform` | audio peaks file (binary, base64) |
| `media://{id}/analysis` | deterministic shot report (`{ shots, cut_scores }`, source-absolute) for the default detection params, content-addressed per source; computed on demand on a miss (no `404`) and shared with `analyze_clip` |
| `media://{id}/description` | cached scene descriptions for the resolver's default backend + sampling (`{ covered_ranges, segments }`); `404` until `describe_clip` has populated it (unlike the always-computable resources above) |
| `motifs://current` | full motif catalog (built-ins, installed, drafts) — same payload as `list_motifs`; `html` stripped |

`media://*` reads return `404` with a hint pointing at the
`media:job_complete` event when derivatives haven't been generated
yet, so agents know to wait + retry rather than give up.

#### Reading `project://history` positions

`ops` is a **window** — the last N entries of the stack, currently N = 100 against
a cap of 200 — and `cursor` is an **absolute stack index**, not an offset into
`ops`. Two envelope fields place the window, and they answer different questions:

- **`window_start`** — the absolute stack index of `ops[0]`, i.e. `len -
  ops.length`. `ops[i]`'s absolute index is `window_start + i`, and that is the
  only index space `jump_to` accepts. On a 150-entry stack the resource returns
  ops 50..149 with `window_start: 50` and `cursor: 149`; reading `cursor` as an
  index into the 100-element array lands 50 entries off, or off the end entirely.
- **`evicted`** — how many entries `record()` has dropped off the FRONT of the
  stack at capacity. The eviction does not spare the `Initial` entry, and `len`
  (the live stack length) cannot tell you.

So `window_start === 0 && evicted === 0` is the **only** combination meaning
"`ops[0]` is the start of the project". `window_start > 0` means the window is
narrower than the stack (re-read for more); `evicted > 0` means the stack itself
is narrower than the project, and those states are gone — nothing can jump back
to them.

### Analysis tools

- `detect_silences { layer_id, threshold_amp?, min_silence_us? }` → `[{ t_start_us, t_end_us }, ...]`. Reads pre-computed peaks; defaults `threshold_amp=0.02` (≈ -34 dBFS) and `min_silence_us=500000`.
- `analyze_clip { layer_id, sensitivity?, min_shot_us?, passes? }` → `{ shots: [{ index, t_start_us, t_end_us, keyframe_t_us, brightness, motion, sharpness, flags: [...] }], cut_scores: [{ t_us, score }] }`. Deterministic shot boundaries + per-shot brightness / motion / sharpness (0..1, sharpness = variance-of-Laplacian) and `black` / `freeze` / `fade` flags for a VideoClip layer. Runs over the source (preferring the 720p proxy); source-absolute times clipped to the layer's source window. `cut_scores` is the raw cut signal, `shots` the cleaned segmentation. Defaults `sensitivity=0.4`, `min_shot_us=500000`, `passes=["shots","stats","events"]` (drop `stats`/`events` for timing only). Per-shot stat values are advisory (proxy-decode-derived, not bit-identical across machines); the flags are the deterministic signal.
- `compare_frames { a: { layer_id, t_us }, b: { layer_id, t_us } }` → `{ phash_hamming, ssim, similar }`. Pairwise perceptual similarity of two video frames — dedup shots, match a cutaway. Each side names a VideoClip layer and a source-absolute `t_us` (same coordinate space as `media://{id}/frame/{t_us}` and `analyze_clip`'s `keyframe_t_us`); the two sides may be the same clip or different clips. `phash_hamming` is the 0..64 Hamming distance between the frames' DCT perceptual hashes (0 = identical, small = same frame re-encoded / rescaled); `ssim` is MSSIM in 0..1; `similar` is `phash_hamming <= 10 && ssim >= 0.5` (both must agree; the pHash is the strong signal and the loose SSIM floor keeps a source frame vs its lossy downscaled proxy similar while rejecting unrelated frames). Cross-aspect-ratio pairs are approximate (the MSSIM path squares both frames, so differing aspect ratios misalign) and lean on the aspect-independent pHash; same-clip dedup (one aspect ratio) is exact. Read-only, no cache; VideoClip layers only.
- `describe_clip { layer_id, t_start_us?, t_end_us?, fps?, focus?, backend? }` → `{ backend, model, segments: [{ t_start_us, t_end_us, text, tags: [...] }] }` — see "Video understanding" below.

### Edit tools

Each maps 1:1 to a project actor command (see
[data-model.md](data-model.md) "Mutation surface").

Media + tracks:
- `import_media { path }` → `{ media_id, … }`
- `remove_media { media_id, force? }`
- `add_track { label? }` → `TrackId` (tracks are kind-agnostic — any layer kind can be placed on any track)
- `remove_track { track_id, force? }`
- `move_track { track_id, new_position }`

Layers:
- `add_color_layer { track_id, t_start_us, t_end_us, color, width?, height? }` → `LayerId`
- `add_video_layer { track_id, media_id, t_start_us, t_end_us, src_in_us, src_out_us }` → `LayerId`, or `{ video_layer_id, audio_layer_id, group_id }` when the source carries audio and `auto_pair_audio_on_import` is on: the paired dialogue Audio layer lands on the SAME track's audio lane (a track holds one visual + one audio lane) and the two are grouped. The triple commits atomically — if the audio lane is occupied, the call rejects naming the blocking layer and nothing lands on the timeline.
- `add_motif { motif_id, t_start_us, t_end_us?, track_id?, props? }` → `LayerId` — `t_end_us` defaults to `default_duration_s`; `track_id` auto-creates an "Overlay" Video track when absent; `props` validates against the motif's `props_schema`. Frame capture is lazy at next render; the tool returns synchronously.
- `apply_subtitles { body, format?, track_id?, t_start_us?, t_end_us? }` — SRT/VTT/ASS body inline; format sniffed when omitted. Builds a new caption-role track of editable `Text` layers (one per cue). `track_id`, `t_start_us`, and `t_end_us` are accepted for wire stability but ignored — cue timings come from the body. Returns the new caption track id.
- `update_layer { layer_id, patch }` — envelope-only (label, time range, enabled, locked).
- `update_layer_params { layer_id, patch }` — kind-specific params. On a scale-linked layer, a patch that leaves `scale_x ≠ scale_y` auto-clears the link in the same commit; patch both axes to the same value to keep it.
- `set_scale_linked { layer_id, linked }` — toggle a layer's uniform-scale link (visual kinds only). `linked=true` snaps `scale_y` to a whole-track copy of `scale_x` (keyframes included, fresh key ids) in the same commit — one undo restores both. `linked=false` clears only the flag. While linked, the two scale tracks are structural twins and the human UI edits them as one collapsed "Scale"; any write that diverges them (single-axis `update_layer_params` / `set_keyframe` / `set_param_track`) auto-clears the flag in that write's commit.
- `move_layer { layer_id, new_track_id, new_t_start_us, escape_group? }`
- `split_layer { layer_id, at_t_us, escape_group? }` → `{ left, right }`
- `auto_split_by_shot { layer_id, min_shot_us?, drop_short? }` → `{ layer_ids }` — detect the VideoClip's shot cuts and split it at every in-window cut in ONE undoable step; returns the new segment layer ids in timeline order (or the single unchanged id when there is no interior cut). `min_shot_us` (default `500000`) is the detection minimum-shot length (closer cuts merge); `drop_short=true` also deletes any resulting segment shorter than `min_shot_us`. Pure convenience — reproducible with `analyze_clip` + `split_layer`, and it reuses the SAME cached shot report as `analyze_clip` (a prior `analyze_clip` at matching params is a cache hit). Group-aware: an auto-paired audio partner splits in lockstep. Caveat: with `drop_short=true`, only the short VIDEO segment is deleted — its group-paired audio sliver is left in place (v1 limitation).
- `trim_layer { layer_id, edge, new_t_us, escape_group? }` — `edge` ∈ `"in" | "out"`.
- `delete_layer { layer_id }`
- `duplicate_layer { layer_id, t_offset_us }` → `LayerId`

Effects (per-layer Pixi filter chains; v1 catalog: `blur`):
- In v1, effects render on all five visual layer kinds: VideoClip, ImageOverlay, Color, Text, and Motif.
- `add_effect { layer_id, kind }` → `EffectId`. Append an effect to the end of the chain (applied last). Creates the effect with no params set; use `update_effect` to set a static value or `set_keyframe` to keyframe a param.
- `update_effect { layer_id, effect_id, patch }` — patch is `{ enabled?, params? }`; v1 params are scalar `{ "mode": "Static", "value": <number> }`.
- `move_effect { layer_id, effect_id, new_index }` — reorder (0 = first applied).
- `remove_effect { layer_id, effect_id }` — delete.
- Keyframe an effect param via `set_keyframe { layer_id, param_key: "effects[<effect_id>].params[<key>]", t_us, value, interp? }`. **Ordering:** `add_effect` creates an effect with no params; set a static value first with `update_effect` (so the param key exists), then use `set_keyframe` to lift it to keyframed. Calling `set_keyframe` on a param key that has never been set returns `UnknownKeyframeParam`.

Keyframes (animate `Animated<f64>` params; times are timeline-absolute µs):
- `get_param_track { layer_id, param_key }` → `{ mode, value }` (Static) or `{ mode, keyframes: [{ id, t_us, t_local_us, value, interp, preset_id? }] }` (Keyframed). Read this to discover keyframe ids before editing. `preset_id` names the canonical easing preset whose params exactly match the key's `interp` (exact-float reverse lookup — presets bake to params, the name is recovered on read); a hand-tuned curve omits the field.
- `set_keyframe { layer_id, param_key, t_us, value, interp? }` — insert-or-update. Lifts a Static track; updates in place at the same frame; `interp` omitted inherits the preceding key's easing (or Linear). `interp` takes the raw kinds below (not the preset form — that is a `set_keyframe_easing` payload).
- `remove_keyframe { layer_id, param_key, keyframe_id }` — last key collapses to Static holding its value.
- `retime_keyframe { layer_id, param_key, keyframe_id, t_us }` — move a key; re-sorts.
- `set_keyframe_easing { layer_id, param_key, keyframe_id, interp }` — `interp` is one of:
  - `{ "preset": "<id>" }` — a named preset from the canonical easing table (`src/shared/easing.ts::EASING_PRESETS`, the single source of the id list: `linear`, `hold`, the CSS curves `ease`/`ease_in`/`ease_out`/`ease_in_out`, and the `ease_{in,out,in_out}_{sine,quad,cubic,quart,quint,expo,circ,back,elastic,bounce}` families). Bezier-family presets bake to their canonical params at write time; the name comes back as `preset_id` on `get_param_track`. An unknown id rejects with the full live list in the error message.
  - `{ "kind": "Hold" }` | `{ "kind": "Linear" }`
  - `{ "kind": "Bezier", "p1": [x, y], "p2": [x, y] }` — control-point x within `[0, 1]` (x is segment time and the solver is single-valued only there; y may overshoot).
  - `{ "kind": "Elastic", "dir": "In" | "Out" | "InOut", "amplitude"?, "period"? }` — `amplitude` ≥ 1 (default 1), `period` > 0 (default 0.3); omitted params take the defaults.
  - `{ "kind": "Bounce", "dir": "In" | "Out" | "InOut" }`
- `smooth_keyframes { layer_id, param_key, keyframe_id? }` — monotone auto-smooth one key, or the whole track when `keyframe_id` is omitted.
- `clear_keyframes { layer_id, param_key, value? }` — collapse to Static (defaults to the first keyframe's value).
- `set_param_track { layer_id, param_key, track }` — low-level: replace the whole `AnimTrack<f64>` (keyframe `t_us` timeline-absolute).

Valid `param_key`: VideoClip/ImageOverlay/Text/Motif → `x, y, scale_x, scale_y, rotation_deg, anchor_x, anchor_y, opacity`; Audio → `gain_db, pan`. Each write routes through the actor's `update_layer_param_track` (snap-to-frame, sort, dedupe, lock check). Unlike `update_layer_params`, these preserve/produce keyframes rather than wiping them. Keying only one scale axis of a scale-linked layer diverges the twin pair and auto-clears the link in the same commit (see `set_scale_linked`); write both axes identically to animate a linked layer's scale.

Groups (see [features.md §Groups](features.md#groups)):
- `groups_create { layer_ids, label?, reassign? }` → `GroupId`
- `groups_dissolve { group_id }`
- `groups_add_members { group_id, layer_ids, reassign? }` / `groups_remove_members { group_id, layer_ids }`
- `groups_rename { group_id, label? }`
- Reads: there is no `groups_list`/`groups_get` tool — group membership is carried on the `project://current` resource as `groups: [{ id, label, layer_ids }]`.

Markers + composition:
- `add_marker { t_us, label, color, end_t_us? }` → `MarkerId`
- `update_marker { marker_id, patch }` / `remove_marker { marker_id }`
- `set_composition { patch }` — nothing in this tool records onto the undo stack;
  the patch is applied to every history snapshot, so undo walks past it. `fps` is
  locked once the timeline holds a layer **or any history snapshot / checkpoint
  does** (`FpsLockedByContent`, carrying the current rate, the requested rate, the
  live layer count and `locked_by: "current" | "history"`). With `locked_by:
  "history"` the layer count is 0 and the timeline looks empty — the rate is still
  refused because undo could bring old-grid layers back. Set the rate on a project
  that has never held a layer; to clear a history-scoped lock, empty the timeline
  and reopen the project (opening resets history). Markers, a pinned duration and
  unplaced media never lock it. `sample_rate` is an export target, not a grid, and
  is never locked.

Catalog:
- `list_motifs()` → `[{ id, name, version, size: [w, h], default_duration_s, props_schema, status, content_hash, target_id? }, ...]`. `status` is `builtin | installed | draft`; drafts may carry `target_id` (the Motif they update). Inspect `props_schema` before calling `add_motif`. Drafts are placeable immediately for preview.

Motif authoring (see [motifs.md](motifs.md) "Agent surface"):
- `get_motif_source { id }` → `{ manifest, html }` — any built-in, installed, or draft.
- `write_motif_draft { manifest, html, from? }` → draft id. `from` records an existing Motif as the update target.
- `preview_motif_draft { id, t_sec, width?, height?, props? }` → base64 PNG of one frame; `props` defaults to the Motif's schema defaults.
- `install_motif { draft_id, mode: new | update }` — publish; update bumps version and rebinds placed layers.
- `delete_motif { id }` — remove a user Motif (built-ins rejected).

### Workflow / safety

- `checkpoint { label }` → `CheckpointId`
- `list_checkpoints()` / `restore_checkpoint { checkpoint_id }` — restore clears redo and replaces the current snapshot.
- `undo()` / `redo()`
- `lock_history { reason }` / `unlock_history()` — freeze undo while a tool batch runs; the UI shows the reason.
- `begin_agent_session { reason }` — flips the human's UI into a simplified preview / scrub / record-only layout. Auto-checkpoints. The human can also enter agent mode locally (View menu / command palette, client `local`); the human ends the session via the UI; the agent has no symmetric tool.
- `dry_run { operations }` — applies the batch against a clone, validates after each op (matching `commit()`), halts at the first error. Does not commit. Op variants: `add_color_layer`, `add_video_layer`, `update_layer`, `update_layer_params`, `move_layer`, `split_layer`, `delete_layer`. Returns `{ results: [{ index, status, output? | error? }, ...], halted_at: number | null }`. Other tools (motifs, caption import, media import, undo/redo) are not dry-runnable.

### Render

Export is UI-driven through backend commands + the `export:*` event stream
— there are intentionally no `render_export` / `cancel_render` MCP
tools. Agents that need a render either ask the user, or read
`project://compiled` to inspect what the audio export would produce.

### Prompts (MCP "prompts")

User-invoked workflows discoverable in agent UIs (Claude Desktop slash menu, Cursor command palette):

- `/auto-caption { layer_id, language? }` — walks the agent through `transcribe_clip` → inspect the `srt` field → `apply_subtitles`.
- `/cut-silences { layer_id, threshold_amp?, min_silence_us? }` — `detect_silences` → `split_layer` + `delete_layer` to tighten dead air.
- `/voiceover { script, voice, speed?, target_track_id? }` — `synthesize_speech` for an agent-supplied script. Prompts the agent to split long scripts at paragraph boundaries (tts-1 caps at 4096 chars).

Each prompt closes with the missing-key recovery hint (Settings → API
keys) so the agent has somewhere to send the user when no cloud
provider is configured.

## Tool description quality

**This matters more than tool count.** Agents pick tools from descriptions. Write them like API docs, not function signatures.

Bad:
```
set_clip_speed(clip_id, factor) — Sets clip speed.
```

Good:
```
set_clip_speed(clip_id, factor) — Speeds up or slows down a clip.
factor < 1 slows down (e.g. 0.5 = half speed); > 1 speeds up.
Affects audio pitch unless preserve_pitch=true. Audio length matches
new video length. Maximum factor is 8x; below 0.1 use a different
approach. Does not affect other clips on the timeline.
```

Every tool gets this treatment. Examples in the description for non-obvious parameters.

## Error model

Tool errors carry structured detail:

```json
{
  "error": "LayerOverlap",
  "message": "Cannot place clip from 5.0s to 10.0s on track 'V1' — clip 'intro' (id 7f3a...) occupies 4.2s to 8.0s.",
  "options": [
    { "action": "create_new_track", "kind": "Video" },
    { "action": "trim_existing", "layer_id": "7f3a...", "new_t_end_us": 5000000 },
    { "action": "split_at_t", "layer_id": "7f3a...", "at_t_us": 5000000 }
  ]
}
```

Give the agent something to act on, not a brick wall.

The prose `message` must itself name the cause and the options — several
MCP clients (Claude Code among them) surface only `code: message` to the
model and drop the structured `data`, so detail that lives only in
`data` is detail the agent never sees. `data` mirrors the same facts
machine-readably for clients that do forward it.

## Change feed

Connected agents receive change notifications **in-protocol**, over the same
streamable-HTTP connection — there is no separate event endpoint. The Rust core
emits an `mcp:change` event when the project mutates; the Electron main process
relays it to every live session as a `notifications/weftcut/change` MCP
notification whose params are the compact change summary:

```json
{
  "op_id": "...",
  "actor": { "kind": "User" },
  "summary": "Moved 'intro' to 4.20s",
  "affected": [{ "kind": "Layer", "id": "7f3a..." }],
  "timestamp": "...",
  "diff_hint": { "kind": "Layer", "id": "7f3a..." }
}
```

Agents can fetch the full new state by reading `project://current` after a
change notification arrives — the notification is a hint, not a sync protocol.

## Speech (optional, user-supplied)

For things agents can't do well themselves. Speech-to-text runs over
**pluggable backends** — OpenAI Whisper (cloud) plus local one-shot CLI
sidecars (whisper.cpp, FunASR via sherpa-onnx) — behind one entry point.
The API key (secret) lives in `safeStorage`; local engine paths live in a
TS-owned config store; Electron main merges both into the snapshot the
stateless Rust resolver reads. The resolver picks a transcriber by **user
preference then availability** (cloud = has key; local = binary + model
present), falls through a default order, and errors with an actionable
message naming every remedy when nothing is available.

**Capability surfaces:**

- **Transcription** (`Transcriber` trait) — `transcribe_clip { layer_id, t_start_us?, t_end_us?, language?, backend?, word_timestamps? }` returns a normalized transcript envelope `{ backend, segments: [{ t_start_us, t_end_us, text, words: [{ t_start_us, t_end_us, text }] }], language, word_timing, srt }`, all times timeline-absolute; `backend` names the engine that actually served the request. Slices the layer's source audio at the requested window (defaults: the whole layer), transcribes with the picked provider, normalizes the raw output to timestamped word segments, shifts every timestamp forward by the timeline offset, and includes a rendered `srt` field so the agent can inspect / edit and pass it to `apply_subtitles` (word-level data stays in `segments`). `word_timing` records the per-word timing provenance — `exact` from an engine's token offsets, `interpolated_from_cue` when derived by splitting an SRT cue span across its words (space-less CJK cues split per character, matching FunASR's granularity). `VideoClip` layers with `speed != 1.0` reject with a hint to `split_layer` off a speed-1 segment first. Backends: OpenAI Whisper (cloud, SRT → interpolated words); whisper.cpp + FunASR (local sidecars, exact word timing from JSON token offsets). The `backend` arg is a **strict** override: that engine serves the call or it errors naming the missing piece — it never substitutes another engine, so an explicit local choice can never fall back to a cloud upload. The user's Settings preference stays a soft hint (injected by the host, honored by availability). `word_timestamps` defaults to **true** — the chosen engine's best precision at no extra cost; pass `false` to force SRT-style interpolated output.
- **Text-to-speech** (`Synthesizer` trait) — `synthesize_speech { text, voice, speed?, target_track_id?, t_start_us? }` returns `{ layer_id, media_id, t_start_us, t_end_us, cached }`. Synthesizes audio for the supplied script, writes a content-addressed file under `<workspace>/Cache/voiceover/<hash>.mp3`, imports it as a `MediaItem`, and adds an `Audio` layer on the target Audio track (auto-creates one labeled "Voiceover" when absent). `t_start_us` defaults to the composition's current `duration_us` so voiceover appends at the end. `cached=true` means the request hit the cache and no API call billed. Provider today: OpenAI tts-1 (same key as Whisper).

**Config UI:** an OpenAI key activates BOTH `transcribe_clip` and
`synthesize_speech` (TTS is cloud-only today). Settings → **Transcription /
Speech** has an engine selector plus per-backend rows: cloud = API key,
local = binary / model (/ tokens) path pickers, each with a "Test" button
that reports `Available` or the exact missing piece. Engines that report
engine-exact per-word timestamps (whisper.cpp, FunASR) carry an
"exact word timing" badge on their row.

**Tool gating:** the `tool_table!` macro registers tools at compile
time, and the catalog has no per-session filter today, so unconfigured
speech tools are always listed and fail with a structured "no backend
available" error that names the Settings panel. Hiding unsupported speech
tools from the catalog entirely is a possible refinement.

These are MCP tools like any other; the agent doesn't see "cloud vs local" — just "this tool exists or doesn't."

## Video understanding (optional, user-supplied)

The architectural twin of Speech, for *what is in a shot* rather than *what was
said*. Scene description runs over the same **pluggable-backend** rails: a
`SceneDescriber` trait, a resolver by **preference then availability**, a
normalized `SceneDescription` output, and a per-backend parser — mirroring
ADR 0036. Backends: **Qwen3-VL** and **MiniCPM-V** (local one-shot
`llama-mtmd-cli` sidecars — a GGUF model + mmproj on disk), a **BYO** self-hosted
OpenAI-compatible endpoint, and a **cloud** VLM. All four ingest the SAME input
(frames we sample from the source + injected `<t s>` text-timestamp markers) and
diverge only in the output parser + availability probe.

**Capability surface:**

- **Scene description** (`SceneDescriber` trait) — `describe_clip { layer_id, t_start_us?, t_end_us?, fps?, focus?, backend? }` returns `{ backend, model, segments: [{ t_start_us, t_end_us, text, tags: [ ... ] }] }`, all times **source-absolute** microseconds; `backend`/`model` name the engine that served the request. Samples frames from the layer's source across the window (defaults: the whole layer) at `fps` (default 1.0), runs the model ONCE over all the frames, and normalizes the model's JSON array into timestamped segments — `text` is a free-text span description, `tags` are filterable visual keywords (subjects, setting, camera motion, shot type). `focus` (`"general"` | `"shot-type"`) selects the prompt template that populates `tags`. Results are **cached per source range**: a later call over an already-described window returns instantly with no model spawn (the cache is a `{ covered_ranges, segments }` value keyed by source hash + `{ backend, model, fps, focus, prompt-template version }`, a SEPARATE namespace from the shot layer so the cheap deterministic layer and this opt-in layer never block each other). `VideoClip` layers with `speed != 1.0` reject with a hint to `split_layer` first. The `backend` arg (`"qwen3_vl"` | `"minicpm_v"` | `"byo_endpoint"` | `"cloud"`) is a **strict** override: that engine serves the call or it errors naming the missing piece (binary / model / endpoint / key) — it never substitutes another engine. This is **privacy-strict**: frames are heavier and more sensitive than audio, so the default order is local-first and cloud-last, and an explicit local choice can never fall back to a cloud upload. The cached view is also readable as `media://{id}/description`.

**Config UI (planned):** same secrecy split as Speech — a cloud VLM key lives in
`safeStorage`; the local engines' binary/model/mmproj paths and a BYO endpoint
URL live in the TS-owned `vlm_config` store; Electron main merges both into the
config snapshot the stateless resolver reads.

## Observability

Tool calls flow through the `LogBus` and surface in the status-bar
console at the bottom of the editor — see [status-log.md](status-log.md).
Each MCP call records a `Started` + `Ok/Err` pair sharing one `op_id`,
with the truncated args / return / error in `details`. The console
filters by category (`Mcp`) and source (`Agent { client }`).

## Concurrency policy

- The express `/mcp` handler accepts concurrent requests across sessions; tool calls funnel into the project actor's single-writer inbox.
- `lock_history(reason)` / `unlock_history()` lets a long batch hold the history pen: while it is held, every revert path (`undo`, `redo`, `jump_to`, `restore_checkpoint`) rejects with `HistoryLocked`, so nobody unwinds the batch from under it. It does NOT collapse or suppress entries — each op in the batch still records its own (`docs/features.md#undo-stack-scope`).
- `dry_run` does not commit; it clones state and walks ops, halting at the first validation error.

## Security

- Localhost-only binding, bearer-enforced on every request, with DNS-rebinding protection on. Flipping the bind to `0.0.0.0` is gated behind a confirmation dialog.
- Shim configs carry no token — the shim reads it from `mcp_auth.json` at connect time, so the bearer never spreads into client config files.
- Token surfaced in the connect panel's advanced section; the HTTP connect snippet (which embeds the token) is printed to stdout only in unpackaged dev / e2e runs, never in a packaged build.
- Cloud-API keys live in the OS keyring, not in project files.
