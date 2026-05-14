"""Tiny MCP-over-SSE probe for WeftCut.

Lives outside the Cargo / Vite trees so it doesn't get picked up by any
build script. Run as:

    python scripts/mcp_probe.py tools/list
    python scripts/mcp_probe.py tools/call begin_agent_session '{"reason":"smoke"}'

Reads `<app_config_dir>/mcp_auth.json` for the bearer + port (so it
stays in sync with the running app's persisted credentials).
"""

import json
import os
import queue
import sys
import threading
import time
import urllib.request

CONFIG_PATH = os.path.expandvars(
    r"%APPDATA%\dev.weftcut.desktop\mcp_auth.json"
)


def read_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def open_sse(url, token, responses, ready):
    """Open the SSE stream and pump events into `responses`. Sets
    `ready` once the server has handed us the message endpoint."""
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "text/event-stream",
        },
    )
    with urllib.request.urlopen(req) as resp:
        event_type = None
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                event_type = None
                continue
            if line.startswith("event:"):
                event_type = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data = line.split(":", 1)[1].lstrip()
                if event_type == "endpoint":
                    ready.put(data)
                elif event_type == "message":
                    try:
                        responses.put(json.loads(data))
                    except Exception as e:
                        responses.put({"_parse_error": str(e), "_raw": data})


def _post(message_url, token, payload):
    req = urllib.request.Request(
        message_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req) as r:
        return r.read().decode("utf-8", errors="replace")


def _wait_for(responses, request_id, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            msg = responses.get(timeout=0.5)
        except queue.Empty:
            continue
        if msg.get("id") == request_id:
            return msg
    raise SystemExit(f"timed out waiting for response to id={request_id}")


def call(method, params, *, port, token, request_id=2, timeout=8, skip_init=False):
    """Open SSE, do the MCP initialize handshake, then send `method`.

    MCP requires the client to send `initialize`, await the server's
    response, then send the `notifications/initialized` notification
    before any other request will be answered. We do that in one
    SSE session so the server's sessionId-bound state stays
    consistent.
    """
    base = f"http://127.0.0.1:{port}"
    responses: "queue.Queue[dict]" = queue.Queue()
    ready: "queue.Queue[str]" = queue.Queue()
    t = threading.Thread(
        target=open_sse,
        args=(f"{base}/sse", token, responses, ready),
        daemon=True,
    )
    t.start()
    message_path = ready.get(timeout=5)
    message_url = f"{base}{message_path}"

    if not skip_init:
        init_id = request_id - 1 if request_id > 0 else 0
        _post(
            message_url,
            token,
            {
                "jsonrpc": "2.0",
                "id": init_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "mcp_probe.py",
                        "version": "0.0.1",
                    },
                },
            },
        )
        _wait_for(responses, init_id, timeout=timeout)
        _post(
            message_url,
            token,
            {
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {},
            },
        )

    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }
    ack = _post(message_url, token, payload)
    response = _wait_for(responses, request_id, timeout)
    return {"ack": ack, "response": response}


def main(argv):
    cfg = read_config()
    port = cfg["port"]
    token = cfg["bearer_token"]
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
        out = call(
            method,
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "mcp_probe.py", "version": "0.0.1"},
            },
            port=port,
            token=token,
            request_id=1,
            skip_init=True,
        )
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
