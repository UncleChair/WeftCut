# JoyAI-VL Frame Recognition POC

This branch validates that JoyAI-VL-Interaction can sit beside WeftCut as an
external frame-recognition subsystem without adding Python or model dependencies
to the Electron app.

## Shape

The POC adds one experimental MCP tool in the Electron main process:

```text
recognize_frame
```

The tool keeps WeftCut's existing boundary intact:

1. WeftCut extracts a JPEG through the existing MCP media resource:
   `media://{media_id}/frame/{t_us}`.
2. The Electron main process wraps the JPEG as a `data:image/jpeg;base64,...`
   `image_url`.
3. The tool posts an OpenAI-compatible `chat/completions` request to the JoyAI
   VLM backend shape used by `JoyAI-VL-Interaction`'s `VLMService`.
4. The result is returned as a JSON text content block to the MCP caller.

No timeline state is mutated. The Rust project actor, undo stack, renderer, and
project schema are untouched.

## Configuration

Defaults mirror JoyAI-VL-Interaction's WebUI defaults where possible:

```powershell
$env:JOYAI_VL_API_BASE = "http://127.0.0.1:8070/v1"
$env:JOYAI_VL_MODEL = "meta/llama-3.2-11b-vision-instruct"
$env:JOYAI_VL_API_KEY = "EMPTY"
```

Per-call overrides are also accepted:

```json
{
  "media_id": "<media uuid>",
  "t_us": 2500000,
  "prompt": "Describe the frame for editing decisions.",
  "api_base": "http://127.0.0.1:8070/v1",
  "model": "meta/llama-3.2-11b-vision-instruct"
}
```

Use `dry_run: true` to inspect the planned request without requiring ffmpeg,
Python, JoyAI, or a running model:

```json
{
  "media_id": "<media uuid>",
  "t_us": 2500000,
  "dry_run": true
}
```

## JoyAI Compatibility Note

`JoyAI-VL-Interaction` currently exposes its VLM logic primarily through WebRTC /
RTSP frame processing in the WebUI. The reusable contract inside that project is
`VLMService`, which sends an OpenAI-compatible request containing:

- `messages[].content[]` text plus `image_url`
- `max_tokens`
- `temperature`
- `x-streaming-session`
- `frame_time_range` as a JoyAI-compatible extra body field

This POC targets that contract directly. If JoyAI later adds a dedicated
single-frame HTTP endpoint, only the small adapter in
`apps/desktop/src/main/mcp/frameRecognition.ts` should need to change.

## Why MCP Main Process

The implementation lives in the main-process MCP host because it is a subsystem
probe, not an editor feature yet:

- it can reuse the existing `media://.../frame/...` resource reader;
- it avoids new renderer UI and project-schema changes;
- it does not place API keys in renderer memory;
- it keeps failed or slow model calls outside the undo/history model.

## Next Steps After POC

If the direction is accepted, promote the adapter into a small provider
interface and add one of these product surfaces:

- MCP-only batch recognition over multiple timestamps;
- a renderer panel that stores recognition notes as markers or text layers;
- a JoyAI sidecar lifecycle manager for starting/stopping the Python WebUI;
- an explicit JoyAI single-frame endpoint to avoid duplicating
  OpenAI-compatible request construction in WeftCut.
