"""Tiny MCP probe for WeftCut (Streamable HTTP transport).

Lives outside the Cargo / Vite trees so it doesn't get picked up by any
build script. Run against a live dev app as:

    python scripts/mcp_probe.py tools/list
    python scripts/mcp_probe.py tools/call begin_agent_session '{"reason":"smoke"}'

Reads `<userData>/mcp_auth.json` for the bearer token + port (so it stays in
sync with the running app's persisted credentials).

Transport: the app serves MCP over the SDK's Streamable HTTP transport — a
single `POST /mcp` endpoint. The flow per session is:
  1. POST `initialize`            -> server assigns an `mcp-session-id` header
  2. POST `notifications/initialized` (carrying that session id)
  3. POST the real request        (carrying that session id)
The server replies to a request POST with an SSE body (`enableJsonResponse`
is off), so each response arrives as one `event: message` / `data: {json}`
frame which we parse out below.
"""

import json
import os
import sys
import urllib.error
import urllib.request

CONFIG_PATH = os.path.expandvars(
    r"%APPDATA%\dev.weftcut.desktop\mcp_auth.json"
)

# Proposed at initialize; the server echoes back a version it supports, which
# we then send as the MCP-Protocol-Version header on every later request.
PROTOCOL_VERSION = "2024-11-05"


def read_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def _parse_sse(text):
    """Pull JSON-RPC payloads out of a text/event-stream body."""
    msgs = []
    event_type = None
    data_lines = []

    def flush():
        if data_lines and event_type in (None, "message"):
            data = "\n".join(data_lines)
            try:
                msgs.append(json.loads(data))
            except Exception as e:  # noqa: BLE001 — surface, don't crash the probe
                msgs.append({"_parse_error": str(e), "_raw": data})

    for raw in text.split("\n"):
        line = raw.rstrip("\r")
        if line == "":
            flush()
            event_type = None
            data_lines = []
            continue
        if line.startswith(":"):
            continue  # SSE comment / keep-alive
        if line.startswith("event:"):
            event_type = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].lstrip())
    flush()  # body may end without a trailing blank line
    return msgs


def _parse_body(content_type, body):
    text = body.decode("utf-8", errors="replace")
    if "text/event-stream" in content_type:
        return _parse_sse(text)
    text = text.strip()
    if not text:
        return []  # e.g. 202 Accepted for a notification
    obj = json.loads(text)
    return obj if isinstance(obj, list) else [obj]


def _post(url, token, payload, *, session_id=None, protocol_version=None, timeout=8):
    """POST one JSON-RPC message; return (status, headers, [messages])."""
    headers = {
        "Content-Type": "application/json",
        # The transport requires BOTH for a request POST, else it 406s.
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    if protocol_version:
        headers["MCP-Protocol-Version"] = protocol_version
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ct = resp.headers.get("Content-Type", "")
            return resp.status, resp.headers, _parse_body(ct, resp.read())
    except urllib.error.HTTPError as e:
        # Surface the error body (401/400 carry a JSON-RPC error) instead of raising.
        ct = e.headers.get("Content-Type", "") if e.headers else ""
        return e.code, e.headers, _parse_body(ct, e.read())


def _find(msgs, request_id):
    for m in msgs:
        if isinstance(m, dict) and m.get("id") == request_id:
            return m
    return None


def _handshake(url, token, *, timeout=8):
    """initialize + initialized; returns (session_id, negotiated_version, init_result)."""
    status, resp_headers, msgs = _post(
        url,
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "mcp_probe.py", "version": "0.0.2"},
            },
        },
        timeout=timeout,
    )
    session_id = resp_headers.get("mcp-session-id") if resp_headers else None
    init_result = _find(msgs, 1)
    if init_result is None:
        raise SystemExit(
            f"initialize failed (HTTP {status}): {json.dumps(msgs, ensure_ascii=False)}"
        )
    negotiated = (
        init_result.get("result", {}).get("protocolVersion") or PROTOCOL_VERSION
    )
    if session_id:
        _post(
            url,
            token,
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
            session_id=session_id,
            protocol_version=negotiated,
            timeout=timeout,
        )
    return session_id, negotiated, init_result


def call(method, params, *, port, token, request_id=2, timeout=8):
    """Run the full session: handshake, then send `method`."""
    url = f"http://127.0.0.1:{port}/mcp"
    session_id, negotiated, init_result = _handshake(url, token, timeout=timeout)
    if method == "initialize":
        return {"session_id": session_id, "response": init_result}
    status, _resp_headers, msgs = _post(
        url,
        token,
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
        session_id=session_id,
        protocol_version=negotiated,
        timeout=timeout,
    )
    response = _find(msgs, request_id)
    if response is None:
        raise SystemExit(
            f"no response to id={request_id} (HTTP {status}): "
            f"{json.dumps(msgs, ensure_ascii=False)}"
        )
    return {"session_id": session_id, "response": response}


def main(argv):
    cfg = read_config()
    port = cfg["port"]
    token = cfg["token"]
    if len(argv) < 2:
        print("usage: mcp_probe.py <method> [params-json or tool-name [args-json]]")
        sys.exit(2)
    method = argv[1]
    if method == "tools/list":
        out = call(method, {}, port=port, token=token)
    elif method == "tools/call":
        if len(argv) < 3:
            print("usage: mcp_probe.py tools/call <tool> [args-json]")
            sys.exit(2)
        tool = argv[2]
        args_json = argv[3] if len(argv) > 3 else "{}"
        out = call(
            method,
            {"name": tool, "arguments": json.loads(args_json)},
            port=port,
            token=token,
        )
    elif method == "initialize":
        out = call(method, {}, port=port, token=token)
    else:
        params = json.loads(argv[2]) if len(argv) > 2 else {}
        out = call(method, params, port=port, token=token)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    # Force UTF-8 on the Windows console — `print(json.dumps(...))` would
    # otherwise crash on any non-cp1252 character in a tool's description.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    main(sys.argv)
