# MCP Server & Agent UX

Videtor exposes itself as an MCP server. External agents (Claude Desktop, Cursor, Cline, custom Python clients) connect over a localhost HTTP server and edit the project through a structured tool surface.

## Transport & deployment

- **Streamable HTTP** on `127.0.0.1:<auto-port>`. Not stdio — the app isn't a child process of the agent.
- Auto-port assigned at app start; user may pin in settings.
- One server per running Videtor instance. Multi-instance = multi-port; surfaced in the connection UI.
- For remote access (Tailscale, ngrok, codespace): out of scope for v1. Localhost only.

## Authentication

- Per-session random token (32 bytes hex), regenerated on every app launch unless user pins.
- Token required as `Authorization: Bearer <token>` header on every request.
- No token visible in UI until user opens the **Connect agent** panel — defends against video tutorials accidentally leaking it on stream.
- "Reset token" button kicks all connected agents.

## Connection UX

The app's **Connect agent** panel:
- Shows server URL + token (revealable by click).
- One-click copy of:
  - Just the URL (for clients with their own auth UI).
  - A complete Claude Desktop config snippet.
  - A complete Cursor `mcp.json` snippet.
  - A `curl` line for sanity-checking.
- QR code for mobile/secondary-machine clients (when those become a thing).
- Live status: number of connected clients, which client (Claude Desktop / Cursor / unknown user-agent), last call timestamp.

Snippet example for Claude Desktop:
```json
{
  "mcpServers": {
    "videtor": {
      "url": "http://127.0.0.1:50831/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer 8f3a..." }
    }
  }
}
```

## Multi-agent semantics

Multiple agents may connect simultaneously. The single-writer actor (see [data-model.md](data-model.md)) serializes all mutations regardless of source.

Rules:
- Tool calls are atomic: each call either commits or rejects; no half-applied edits.
- Operations carry an `Actor` tag (`User` or `Agent { client_name }`) — surfaced in change events and history.
- The UI shows an "agent activity" panel listing recent calls per client.
- Agents may subscribe to the SSE change feed to see edits from other agents and the user.
- No edit-locks, no per-agent state. If two agents step on each other, the second to commit may fail invariants — expected, agents should retry or back off.

## Tool surface

Around 25 tools. Don't expose 100; agents get confused.

### Read (resources, not tools)

| URI | Returns |
|---|---|
| `project://current` | full Project JSON (with `schema_version`) |
| `project://composition` | composition only |
| `project://media` | media pool listing |
| `project://tracks` | tracks + layer summaries |
| `project://layers/{id}` | one layer in detail |
| `project://layers/{id}/effects` | effects on that layer |
| `project://markers` | all markers |
| `project://history` | recent ops + checkpoints |
| `project://compiled` | current IR (JSON) for agents that want structural reasoning |
| `media://{id}/thumbnail` | poster frame as image |
| `media://{id}/frame/{time}` | extracted frame as image (multimodal-friendly) |
| `media://{id}/waveform` | audio peaks |
| `templates://list` | available templates with `props_schema` and previews |
| `templates://{id}/preview` | thumbnail PNG |

Returning images from `media://{id}/frame/{time}` is what makes this useful with multimodal agents — they can *see* the video and make spatial/temporal judgments before editing.

### Analysis tools (cheap, ffmpeg-backed, no AI needed locally)

- `detect_silences(media_id, threshold_db, min_duration_us)` → array of `{start, end}`
- `detect_scenes(media_id, threshold)` → array of `{t, score}`
- `extract_frames(media_id, times[])` → array of images (handed back as image content)
- `get_audio_levels(media_id, resolution_us)` → RMS array

### Edit tools (the core)

Each maps 1:1 to a project actor command (see [data-model.md](data-model.md) "Mutation surface"):

- `import_media`, `add_track`, `add_layer`, `update_layer`, `move_layer`, `split_layer`, `delete_layer`, `duplicate_layer`
- `add_effect`, `update_effect`, `move_effect`, `remove_effect`
- `add_keyframe`, `update_keyframe`, `remove_keyframe`
- `add_marker`, `update_marker`, `remove_marker`
- `set_composition`
- `add_template` — uses templated overlay; rasterization may be async, returns immediately with `state: "rasterizing"`
- `apply_subtitles(srt_or_ass)` — agent generates the SRT/ASS, pushes whole

### Workflow / safety

- `checkpoint(label)` — explicit named snapshot
- `list_checkpoints()` / `restore_checkpoint(id)`
- `undo()` / `redo()`
- `dry_run(operations[])` — applies the batch in a sandbox, returns the resulting compiled graph + validation diagnostics, **does not commit**
- `list_recent_operations(limit)` — for agents that want to see what just happened

### Render

- `render_preview(start_us, end_us)` — quick low-res render to disk; returns path
- `render_export(path, format, codec, preset)` — full-quality export; returns job id; progress via SSE
- `cancel_render(job_id)`

### Prompts (MCP "prompts")

User-invoked workflows discoverable in agent UIs (Claude Desktop slash menu, Cursor command palette):

- `/cut-silences` (params: threshold_db, min_duration_ms)
- `/auto-caption` (uses cloud transcription; see below)
- `/highlight-reel` (params: target_duration)
- `/jump-cut` (params: style)
- `/translate-subtitles` (params: target_language)

Prompts are huge for UX — they make the app's capabilities discoverable inside the agent's UI rather than hidden behind documentation.

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

Subscribed agents receive a stream of compact events:

```
event: change
data: {"op_id":"...","actor":{"User":null},"summary":"Moved 'intro' to 4.20s","affected":[{"Layer":"7f3a..."}],"ts":"..."}

event: render
data: {"job_id":"...","kind":"export","progress":0.42,"phase":"encoding"}

event: raster
data: {"template_layer_id":"...","progress":0.66}
```

Agents can fetch the full new state by reading `project://current` after a change event arrives. Don't bake the full state into every event — events are a notification, not a sync protocol.

## Cloud APIs (optional, user-supplied)

For things agents can't do well themselves:

- **Transcription** (`transcribe_clip(media_id) → SRT/ASS`) — calls Whisper API / Deepgram / AssemblyAI on the user's behalf using a key configured in app settings. If no key configured, tool returns `Unavailable` with a hint to configure one.
- **Image gen for thumbnails** (deferred; v2).

These are MCP tools like any other; the agent doesn't see "cloud vs local" — just "this tool exists or doesn't."

## Observability

The app shows an **MCP activity** panel listing every recent call:
- Timestamp
- Client name (from User-Agent / handshake)
- Tool name + args (truncated)
- Result (success / error class)
- Diff summary

User can clear, filter, and export the log. This is the difference between "useful" and "users disable it."

## Concurrency policy

- Inbound HTTP handler accepts concurrent requests; tool calls funnel into the project actor's bounded inbox.
- Backpressure: if inbox fills, return `429 Too Many Requests` with `Retry-After`.
- Long-running tools (`render_export`, big `add_template` rasterizations) return immediately with a job id; progress flows on the SSE feed; result is fetchable via `get_job(id)`.

## Security

- Localhost-only binding by default. Toggle to `0.0.0.0` requires confirmation dialog with stark warning.
- Token never logged in plaintext.
- File paths in tool calls are validated against an allow-list (project folder, configured media folders) — agents can't read `/etc/passwd` via `import_media`.
- All cloud-API keys live in OS keyring, not in project files.

## Implementation footprint

| Component | LoC est. |
|---|---|
| `rmcp` server setup, transport, auth | ~400 |
| Tool definitions (one per command, schema via `schemars`) | ~1500 |
| Resource handlers | ~500 |
| Prompt definitions | ~150 |
| SSE change feed | ~200 |
| Activity log + UI bridge | ~300 |
| Cloud API clients (Whisper, etc.) | ~400 (per provider) |
| Tests (server up, tool round-trip, error mapping) | ~800 |

**MVP MCP layer: ~3.5K LoC.**

## Build order

1. Server up, one read tool (`get_project_state`), token auth — verify Claude Desktop can connect.
2. Read resources (`project://current`, `media://...`).
3. Edit tools (in order: add_layer → split_layer → delete_layer → update_layer → move_layer → rest).
4. Workflow tools (checkpoint, undo, dry_run).
5. SSE change feed.
6. Activity log.
7. Prompts (cut-silences, auto-caption).
8. Cloud transcription tool.
