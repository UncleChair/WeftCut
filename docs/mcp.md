# MCP Server & Agent UX

WeftCut exposes itself as an MCP server. External agents (Claude Desktop, Cursor, Cline, custom Python clients) connect over a localhost server and edit the project through a structured tool surface.

## Transport & deployment

- **Streamable-HTTP on `127.0.0.1:<auto-port>/mcp`**, hosted in the Electron
  main process: an `express` app fronts the `@modelcontextprotocol/sdk`
  `StreamableHTTPServerTransport`. Not stdio — the app isn't a child process of
  the agent. Each `initialize` request mints a session (UUID in the
  `Mcp-Session-Id` header); subsequent requests on that session route back to
  the same transport. In-protocol notifications (the change feed below) ride the
  same connection, so there is no separate event endpoint.
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

The app's **Connect agent** panel:
- Shows the server URL (`http://127.0.0.1:<port>/mcp`) and bearer token
  (revealable by click).
- One-click copy of:
  - Just the URL (for clients with their own auth UI).
  - A complete Claude Desktop `claude_desktop_config.json` snippet.
  - A complete Cursor `mcp.json` snippet.
- Renders "starting…" while the server is still binding its port; polls
  `get_mcp_info` until the bind completes.

Snippet example for Claude Desktop:
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

The Cursor snippet has the same shape.

## Multi-agent semantics

Multiple agents may connect simultaneously. The single-writer actor (see [data-model.md](data-model.md)) serializes all mutations regardless of source.

Rules:
- Tool calls are atomic: each call either commits or rejects; no half-applied edits.
- Operations carry an `Actor` tag (`User` or `Agent { client }`) — surfaced in change events and the status-log console.
- Connected agents receive change notifications in-protocol (see the change feed below) to see edits from other agents and the user.
- No edit-locks, no per-agent state. If two agents step on each other, the second to commit may fail invariants — expected, agents should retry or back off.
- `lock_history(reason)` is the explicit cooperative pen: one client holds the undo pen during a batch and any other client (UI or agent) that touches the actor sees a `HistoryLocked` error until the lock releases.

## Tool surface

The MCP tool surface is the same set of actor commands the UI calls.
A single declarative `tool_table!` macro in the Rust core single-sources
both the advertised schemas and the name→handler dispatch, so a tool can
never appear in one without the other. Don't expose 100 tools; agents
get confused. The current set is around 40, organised below.

### Read (resources, not tools)

| URI | Returns |
|---|---|
| `project://current` | full Project JSON (with `schema_version`) |
| `project://composition` | composition only |
| `project://media` | media pool listing |
| `project://tracks` | tracks + layer envelopes |
| `project://layers/{id}` | one layer in detail |
| `project://markers` | all markers |
| `project://history` | recent ops + checkpoints (snapshot-free) |
| `project://compiled` | compiled audio IRGraph (JSON) |
| `media://{id}/thumbnail` | middle thumbnail as JPG (base64) |
| `media://{id}/frame/{t_us}` | on-demand frame at the given microsecond, lazy-cached (multimodal-friendly) |
| `media://{id}/waveform` | audio peaks file (binary, base64) |
| `motifs://current` | full motif catalog (built-ins, installed, drafts) — same payload as `list_motifs`; `html` stripped |

`media://*` reads return `404` with a hint pointing at the
`media:job_complete` event when derivatives haven't been generated
yet, so agents know to wait + retry rather than give up.

### Analysis tools

- `detect_silences { layer_id, threshold_amp?, min_silence_us? }` → `[{ t_start_us, t_end_us }, ...]`. Reads pre-computed peaks; defaults `threshold_amp=0.02` (≈ -34 dBFS) and `min_silence_us=500000`.

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
- `add_video_layer { track_id, media_id, t_start_us, t_end_us, src_in_us, src_out_us }` → `LayerId`
- `add_motif { motif_id, t_start_us, t_end_us?, track_id?, props? }` → `LayerId` — `t_end_us` defaults to `default_duration_s`; `track_id` auto-creates an "Overlay" Video track when absent; `props` validates against the motif's `props_schema`. Frame capture is lazy at next render; the tool returns synchronously.
- `apply_subtitles { body, format?, track_id?, t_start_us?, t_end_us? }` — SRT/VTT/ASS body inline; format sniffed when omitted. Builds a new caption-role track of editable `Text` layers (one per cue). `track_id`, `t_start_us`, and `t_end_us` are accepted for wire stability but ignored — cue timings come from the body. Returns the new caption track id.
- `update_layer { layer_id, patch }` — envelope-only (label, time range, enabled, locked).
- `update_layer_params { layer_id, patch }` — kind-specific params.
- `move_layer { layer_id, new_track_id, new_t_start_us, escape_group? }`
- `split_layer { layer_id, at_t_us, escape_group? }` → `{ left, right }`
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
- `get_param_track { layer_id, param_key }` → `{ mode, value }` (Static) or `{ mode, keyframes: [{ id, t_us, t_local_us, value, interp }] }` (Keyframed). Read this to discover keyframe ids before editing.
- `set_keyframe { layer_id, param_key, t_us, value, interp? }` — insert-or-update. Lifts a Static track; updates in place at the same frame; `interp` omitted inherits the preceding key's easing (or Linear).
- `remove_keyframe { layer_id, param_key, keyframe_id }` — last key collapses to Static holding its value.
- `retime_keyframe { layer_id, param_key, keyframe_id, t_us }` — move a key; re-sorts.
- `set_keyframe_easing { layer_id, param_key, keyframe_id, interp }` — `interp` ∈ `Hold | Linear | EaseIn | EaseOut | Bezier{p1,p2}`.
- `smooth_keyframes { layer_id, param_key, keyframe_id? }` — monotone auto-smooth one key, or the whole track when `keyframe_id` is omitted.
- `clear_keyframes { layer_id, param_key, value? }` — collapse to Static (defaults to the first keyframe's value).
- `set_param_track { layer_id, param_key, track }` — low-level: replace the whole `AnimTrack<f64>` (keyframe `t_us` timeline-absolute).

Valid `param_key`: VideoClip/Motif → `x, y, scale_x, scale_y, rotation_deg, opacity`; ImageOverlay/Text → `x, y, rotation_deg, opacity`; Audio → `gain_db, pan`. Each write routes through the actor's `update_layer_param_track` (snap-to-frame, sort, dedupe, lock check). Unlike `update_layer_params`, these preserve/produce keyframes rather than wiping them.

Groups (see [groups.md](groups.md)):
- `groups_create { layer_ids, label?, reassign? }` → `GroupId`
- `groups_dissolve { group_id }`
- `groups_add_members { group_id, layer_ids, reassign? }` / `groups_remove_members { group_id, layer_ids }`
- `groups_rename { group_id, label? }`
- Reads: there is no `groups_list`/`groups_get` tool — group membership is carried on the `project://current` resource as `groups: [{ id, label, layer_ids }]`.

Markers + composition:
- `add_marker { t_us, label, color, end_t_us? }` → `MarkerId`
- `update_marker { marker_id, patch }` / `remove_marker { marker_id }`
- `set_composition { patch }`

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
- `begin_agent_session { reason }` — flips the human's UI into a simplified preview / scrub / record-only layout. Auto-checkpoints. The human ends the session via the UI; the agent has no symmetric tool.
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

For things agents can't do well themselves. The cloud surface is
provider-agnostic: keys live in the OS keyring keyed by **API provider**
(`OpenAi`, future `Deepgram` / `ElevenLabs` / …), and each provider
declares which capabilities it supports. The default-provider picker
for each tool falls back to the first configured provider that can
serve the surface.

**Capability surfaces:**

- **Transcription** (`Transcriber` trait) — `transcribe_clip { layer_id, t_start_us?, t_end_us?, language? }` returns a normalized transcript envelope `{ segments: [{ t_start_us, t_end_us, text, words: [{ t_start_us, t_end_us, text }] }], language, word_timing, srt }`, all times timeline-absolute. Slices the layer's source audio at the requested window (defaults: the whole layer), transcribes with the picked provider, normalizes the raw output to timestamped word segments, shifts every timestamp forward by the timeline offset, and includes a rendered `srt` field so the agent can inspect / edit and pass it to `apply_subtitles` (word-level data stays in `segments`). `word_timing` records the per-word timing provenance — `exact` from an engine's token offsets, `interpolated_from_cue` when derived by splitting an SRT cue span across its words. `VideoClip` layers with `speed != 1.0` reject with a hint to `split_layer` off a speed-1 segment first. Provider today: OpenAI Whisper (SRT → interpolated words).
- **Text-to-speech** (`Synthesizer` trait) — `synthesize_speech { text, voice, speed?, target_track_id?, t_start_us? }` returns `{ layer_id, media_id, t_start_us, t_end_us, cached }`. Synthesizes audio for the supplied script, writes a content-addressed file under `<workspace>/Cache/voiceover/<hash>.mp3`, imports it as a `MediaItem`, and adds an `Audio` layer on the target Audio track (auto-creates one labeled "Voiceover" when absent). `t_start_us` defaults to the composition's current `duration_us` so voiceover appends at the end. `cached=true` means the request hit the cache and no API call billed. Provider today: OpenAI tts-1 (same key as Whisper).

**Single-key, multi-surface:** an OpenAI key activates BOTH
`transcribe_clip` and `synthesize_speech`. The Settings panel lists
providers (one row per `Provider` enum variant), not surfaces — so the
user thinks in terms of "configure OpenAI" once.

**Tool gating:** the `tool_table!` macro registers tools at compile
time, and the catalog has no per-session filter today, so unconfigured
cloud tools are always listed and fail with a structured `MissingKey`
error that names the Settings panel. Hiding unsupported cloud tools
from the catalog entirely is a possible refinement.

These are MCP tools like any other; the agent doesn't see "cloud vs local" — just "this tool exists or doesn't."

## Observability

Tool calls flow through the `LogBus` and surface in the status-bar
console at the bottom of the editor — see [status-log.md](status-log.md).
Each MCP call records a `Started` + `Ok/Err` pair sharing one `op_id`,
with the truncated args / return / error in `details`. The console
filters by category (`Mcp`) and source (`Agent { client }`).

## Concurrency policy

- The express `/mcp` handler accepts concurrent requests across sessions; tool calls funnel into the project actor's single-writer inbox.
- `lock_history(reason)` / `unlock_history()` lets a long batch hold the history pen so the UI doesn't show partial state as separate undo entries.
- `dry_run` does not commit; it clones state and walks ops, halting at the first validation error.

## Security

- Localhost-only binding, bearer-enforced on every request, with DNS-rebinding protection on. Flipping the bind to `0.0.0.0` is gated behind a confirmation dialog.
- Token surfaced in the connect panel; the connect snippet (which embeds the token) is printed to stdout only in unpackaged dev / e2e runs, never in a packaged build.
- Cloud-API keys live in the OS keyring, not in project files.
