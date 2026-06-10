# MCP Server & Agent UX

WeftCut exposes itself as an MCP server. External agents (Claude Desktop, Cursor, Cline, custom Python clients) connect over a localhost server and edit the project through a structured tool surface.

## Transport & deployment

- **SSE on `127.0.0.1:<auto-port>`** via rmcp 0.1.x's `SseServer`. Not stdio — the app isn't a child process of the agent. rmcp 1.x dropped SSE in favor of streamable-HTTP, but Claude Desktop is SSE-only for local servers, so 0.1.x is pinned deliberately.
- Bearer token + auto-picked port are persisted to `<app_config_dir>/mcp_auth.json` on first launch and reused on every subsequent start so the Claude Desktop / Cursor snippet stays valid across restarts. If the saved port is occupied at bind time, the server falls back to a fresh OS-picked port and rewrites the file.
- The change feed lives on a separate axum-backed `/events` SSE endpoint — rmcp 0.1.x has no per-session notification surface.
- One server per running WeftCut instance. Multi-instance = multi-port; surfaced in the connection UI.
- For remote access (Tailscale, ngrok, codespace): out of scope. Localhost only.

## Authentication

- Random 32-byte hex token generated on first launch, stored in `<app_config_dir>/mcp_auth.json` alongside the auto-picked port.
- Token is **surfaced but not enforced** on inbound requests. rmcp 0.1.x's `SseServer` exposes no middleware hook (only `serve` / `serve_with_config` / `with_service` / `cancel` / `next_transport`), so localhost-only binding is the real isolation. Enforcement could ship via an axum reverse-proxy in front of rmcp's SSE server, but is deferred until the threat model justifies it; flipping the bind to `0.0.0.0` needs enforcement first.
- No token visible in UI until the user opens the **Connect agent** panel — defends against video tutorials accidentally leaking it on stream.
- A **Refresh** button in the Connect-agent panel rotates the bearer in place: the server stays bound on the same port and `mcp_auth.json` is rewritten with the new token.

## Connection UX

The app's **Connect agent** panel:
- Shows SSE URL, change-feed `/events` URL, and bearer token (revealable by click).
- One-click copy of:
  - Just the SSE URL (for clients with their own auth UI).
  - A complete Claude Desktop `claude_desktop_config.json` snippet.
  - A complete Cursor `mcp.json` snippet.
  - A `curl -N` line for sanity-checking the SSE stream and the change feed.
- Renders "starting…" while the server is still binding its port; polls `get_mcp_info` until the bind completes.

Snippet example for Claude Desktop:
```json
{
  "mcpServers": {
    "weftcut": {
      "url": "http://127.0.0.1:50831/sse",
      "transport": "sse",
      "headers": { "Authorization": "Bearer 8f3a..." }
    }
  }
}
```

The Cursor snippet uses `"type": "sse"` in place of `"transport"`. A
`curl -N -H "Authorization: Bearer …" <sse_url>` line is also offered for
sanity-checking the connection.

## Multi-agent semantics

Multiple agents may connect simultaneously. The single-writer actor (see [data-model.md](data-model.md)) serializes all mutations regardless of source.

Rules:
- Tool calls are atomic: each call either commits or rejects; no half-applied edits.
- Operations carry an `Actor` tag (`User` or `Agent { client }`) — surfaced in change events and the status-log console.
- Agents may subscribe to the `/events` SSE change feed to see edits from other agents and the user.
- No edit-locks, no per-agent state. If two agents step on each other, the second to commit may fail invariants — expected, agents should retry or back off.
- `lock_history(reason)` is the explicit cooperative pen: one client holds the undo pen during a batch and any other client (UI or agent) that touches the actor sees a `HistoryLocked` error until the lock releases.

## Tool surface

The MCP tool surface is the same set of actor commands the UI calls,
exposed through rmcp's `#[tool]` macros. Don't expose 100 tools;
agents get confused. The current set is around 40, organised below.

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
`media:job_complete` Tauri event when derivatives haven't been generated
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
- `apply_subtitles { body, format?, track_id?, t_start_us?, t_end_us }` — SRT/ASS body inline; format sniffed from `[Script Info]` when omitted. Auto-finds or creates a Subtitle track. Body is materialized to a content-addressed cache file before render.
- `update_layer { layer_id, patch }` — envelope-only (label, time range, enabled, locked).
- `update_layer_params { layer_id, patch }` — kind-specific params.
- `move_layer { layer_id, new_track_id, new_t_start_us, escape_group? }`
- `split_layer { layer_id, at_t_us, escape_group? }` → `{ left, right }`
- `trim_layer { layer_id, edge, new_t_us, escape_group? }` — `edge` ∈ `"in" | "out"`.
- `delete_layer { layer_id }`
- `duplicate_layer { layer_id, t_offset_us }` → `LayerId`

Groups (see [groups.md](groups.md)):
- `groups_list` / `groups_get { group_id }`
- `groups_create { layer_ids, label?, reassign? }` → `GroupId`
- `groups_dissolve { group_id }`
- `groups_add_members { group_id, layer_ids, reassign? }` / `groups_remove_members { group_id, layer_ids }`
- `groups_rename { group_id, label? }`

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
- `dry_run { operations }` — applies the batch against a clone, validates after each op (matching `commit()`), halts at the first error. Does not commit. Op variants: `add_color_layer`, `add_video_layer`, `update_layer`, `update_layer_params`, `move_layer`, `split_layer`, `delete_layer`. Returns `{ results: [{ index, status, output? | error? }, ...], halted_at: number | null }`. Other tools (motifs, subtitles, media import, undo/redo) are not dry-runnable.

### Render

Export is UI-driven through Tauri commands + the `export:*` event stream
— there are intentionally no `render_export` / `cancel_render` MCP
tools. Agents that need a render either ask the user, or read
`project://compiled` to inspect what the audio export would produce.

### Prompts (MCP "prompts")

User-invoked workflows discoverable in agent UIs (Claude Desktop slash menu, Cursor command palette):

- `/auto-caption { layer_id, language? }` — walks the agent through `transcribe_clip` → inspect SRT → `apply_subtitles`.
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

## Change feed (SSE)

Subscribed agents receive a stream of compact events on the separate
`/events` endpoint:

```
event: change
data: {"op_id":"...","actor":{"kind":"User"},"summary":"Moved 'intro' to 4.20s","affected":[{"kind":"Layer","id":"7f3a..."}],"timestamp":"...","diff_hint":{"kind":"Layer","id":"7f3a..."}}
```

Only one event type (`change`) flows over `/events` today. The stream
sends a 15 s keep-alive and emits a `lagged` hint if the broadcast
channel falls behind a subscriber. Agents can fetch the full new state
by reading `project://current` after a change event arrives — events
are a notification, not a sync protocol.

## Cloud APIs (optional, user-supplied)

For things agents can't do well themselves. The cloud surface is
provider-agnostic: keys live in the OS keyring keyed by **API provider**
(`OpenAi`, future `Deepgram` / `ElevenLabs` / …), and each provider
declares which capabilities it supports. The default-provider picker
for each tool falls back to the first configured provider that can
serve the surface.

**Capability surfaces:**

- **Transcription** (`Transcriber` trait) — `transcribe_clip { layer_id, t_start_us?, t_end_us?, language? }` returns a timeline-absolute SRT body. Slices the layer's source audio at the requested window (defaults: the whole layer), posts to the picked provider, shifts SRT cues forward by the timeline offset, returns the SRT body so the agent can inspect / edit before passing it to `apply_subtitles`. `VideoClip` layers with `speed != 1.0` reject with a hint to `split_layer` off a speed-1 segment first. Provider today: OpenAI Whisper.
- **Text-to-speech** (`Synthesizer` trait) — `synthesize_speech { text, voice, speed?, target_track_id?, t_start_us? }` returns `{ layer_id, media_id, t_start_us, t_end_us, cached }`. Synthesizes audio for the supplied script, writes a content-addressed file under `<workspace>/Cache/voiceover/<hash>.mp3`, imports it as a `MediaItem`, and adds an `Audio` layer on the target Audio track (auto-creates one labeled "Voiceover" when absent). `t_start_us` defaults to the composition's current `duration_us` so voiceover appends at the end. `cached=true` means the request hit the cache and no API call billed. Provider today: OpenAI tts-1 (same key as Whisper).

**Single-key, multi-surface:** an OpenAI key activates BOTH
`transcribe_clip` and `synthesize_speech`. The Settings panel lists
providers (one row per `Provider` enum variant), not surfaces — so the
user thinks in terms of "configure OpenAI" once.

**Tool gating:** rmcp 0.1.x's `tool_box` macro registers tools at
compile time with no per-session filter hook, so unconfigured cloud
tools are always listed and fail with a structured `MissingKey` error
that names the Settings panel. Revisit when rmcp gains per-session
filtering.

These are MCP tools like any other; the agent doesn't see "cloud vs local" — just "this tool exists or doesn't."

## Observability

Tool calls flow through the `LogBus` and surface in the status-bar
console at the bottom of the editor — see [status-log.md](status-log.md).
Each MCP call records a `Started` + `Ok/Err` pair sharing one `op_id`,
with the truncated args / return / error in `details`. The console
filters by category (`Mcp`) and source (`Agent { client }`).

## Concurrency policy

- Inbound SSE handler accepts concurrent requests; tool calls funnel into the project actor's single-writer inbox.
- `lock_history(reason)` / `unlock_history()` lets a long batch hold the history pen so the UI doesn't show partial state as separate undo entries.
- `dry_run` does not commit; it clones state and walks ops, halting at the first validation error.

## Security

- Localhost-only binding. Flipping the bind to `0.0.0.0` is gated behind a confirmation dialog and needs token enforcement first.
- Token surfaced in the connect panel; never logged in plaintext.
- Cloud-API keys live in the OS keyring, not in project files.
