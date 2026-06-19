---
status: accepted
---
# 0024 — Desktop runtime: Electron + napi-rs

## Context
WeftCut must ship on Windows, macOS, and Linux. A system-webview runtime (per-OS: WebView2 / WKWebView / WebKitGTK) made browser behavior diverge per platform — codec, transport, and capture-determinism quirks that were a recurring tax and blocked cross-platform parity. The heavy runtime work (the PixiJS WebGPU compositor, WebCodecs decode, the frame ring) already lives in the webview, and the domain core is Rust; rewriting that core in Node was never desirable.

## Decision
The desktop shell is **Electron** — one bundled Chromium across all three OSes, so renderer behavior is identical everywhere. The Rust domain core stays **in-process as a napi-rs addon** (`@weftcut/core`, `apps/desktop/native/`), exposed to the Electron main process through a `Backend.invoke(cmd, argsJson)` dispatch plus a thread-safe event callback; the renderer reaches it via a contextBridge preload. The renderer keeps PixiJS + WebCodecs unchanged.

## Consequences
- **+** Deterministic cross-OS behavior: offscreen-CDP motif capture is byte-identical across Windows/Linux/macOS (verified on a 3-OS CI matrix), and a class of system-webview codec/transport quirks disappears on a pinned Chromium.
- **+** No Rust rewrite — the same native code runs in-process; control-plane latency is sub-millisecond.
- **−** Larger bundle and cold start; Chromium updates are self-maintained (no OS-provided runtime).
- Hot-path runtime performance is unchanged versus the prior shell (same Chromium engine, same native Rust), so the payoff is determinism and control, not speed.
