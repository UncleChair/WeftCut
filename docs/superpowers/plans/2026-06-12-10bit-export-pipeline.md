# 10-bit Export Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 10-bit HEVC/AV1 export through a float16 WebGL2 Pixi composite and a localhost-WebSocket → ffmpeg rawvideo encode exit; the 8-bit pipeline stays byte-for-byte unchanged.

**Architecture:** When `bitDepth: 10` is selected, the export worker switches its Pixi renderer to WebGL2, composites into an `rgba16float` RenderTexture, GPU-packs each frame to `yuv420p10le` bytes (byte-packed RGBA8 targets + `readPixels`), and streams frames over a one-shot loopback WebSocket into a Rust sink that pipes ffmpeg (`-f rawvideo`, encoder from `hwencoder.rs`, 10-bit probed). 10-bit-capable sources (H.264 Hi10P) decode from ORIGINALS via a new CPU-plane lane (`copyTo` + immediate close) and ingest through an RG8→f16 conversion pass instead of the 8-bit canvas snapshot.

**Tech Stack:** Pixi 8.18 (WebGL2 backend), WebCodecs `VideoFrame.copyTo`, raw WebGL2 `readPixels`, tungstenite (sync WS server), ffmpeg-sidecar, existing wdio/tauri-driver e2e harness.

**Spec:** `docs/superpowers/specs/2026-06-12-10bit-export-pipeline-design.md`
**Probe evidence:** `docs/superpowers/specs/2026-06-12-float16-pipeline-exploration.md` (P1–P6 results) + `apps/desktop/e2e/tools/float16_probes.e2e.js`

---

## Conventions used by every task

- Unit tests: `cd apps/desktop && npm run test -- <file>` (vitest; test files live next to sources).
- Rust tests: `cd apps/desktop/src-tauri && cargo test <module>`.
- E2E (real WebView2, from `apps/desktop/e2e`; npx/npm silently DROP `--spec` on Windows — call the wdio binary via node directly and confirm the log says `Execution of 1 workers`):
  ```
  node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.mjs --spec ./tools/<name>.e2e.js
  ```
  `onPrepare` rebuilds the app (`tauri build --debug --no-bundle` with `VITE_WEFTCUT_E2E=1`) on every run — Rust changes are picked up automatically, but the build adds minutes.
- Long e2e tests: override mocha's cap with `function () { this.timeout(300000); ... }` (arrow functions can't).
- Commits: stage by EXPLICIT path only (другие sessions may share this checkout); message style `feat(export10): …` / `test(export10): …`.
- Color constants (BT.709 gamma-domain, 10-bit limited) — single source of truth, used by Tasks 2/5/6:
  - RGB→Y′: `Y = 0.2126R + 0.7152G + 0.0722B`; `Cb = (B−Y)/1.8556`; `Cr = (R−Y)/1.5748`
  - Quantize: `y10 = round(64 + 876·Y)`, `c10 = round(512 + 896·C)`, clamp [0,1023]
  - Inverse: `Y = (y10−64)/876`, `Cb = (u10−512)/896`, `Cr = (v10−512)/896`; `R = Y + 1.5748·Cr`; `G = Y − 0.46812·Cr − 0.18732·Cb`; `B = Y + 1.8556·Cb`

---

### Task 1: Rust video sink (discard + WS modes) + transport throughput spike

The spike IS the gate from the spec: if loopback WS sustains ≥ 190 MB/s the
transport question is closed; 60–190 MB/s means "offline-acceptable, note in
UI"; below 60 MB/s stop and re-plan transport before continuing.

**Files:**
- Create: `apps/desktop/src-tauri/src/export/videosink.rs`
- Modify: `apps/desktop/src-tauri/src/export/mod.rs` (add `pub mod videosink;` at top, near `pub mod hwencoder;` — check the existing module layout)
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `tungstenite = "0.24"` under `[dependencies]`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (manage state + register commands)
- Create: `apps/desktop/e2e/tools/iso_video_sink_throughput.e2e.js`

- [ ] **Step 1: Add the dependency**

In `apps/desktop/src-tauri/Cargo.toml` under `[dependencies]`:

```toml
tungstenite = "0.24"
```

- [ ] **Step 2: Write `videosink.rs` (discard + ws skeleton, no ffmpeg yet)**

```rust
//! Localhost video sink for the 10-bit export. The webview streams raw
//! yuv420p10le frames over a one-shot loopback WebSocket; this module pipes
//! them into an ffmpeg encode (Task 3). `mode: "discard"` byte-counts instead
//! — the transport spike and the throughput e2e use it. Token = first text
//! message on the socket; anything else closes the connection.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::net::TcpListener;
use std::process::{Child, ChildStdin};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::{info, warn};

#[derive(Default)]
pub struct VideoSinkState(pub Mutex<Option<ActiveSink>>);

/// Shared between the WS thread, the IPC-fallback write command, and cancel.
pub struct SinkShared {
    /// ffmpeg child (None in discard mode / after wait).
    pub child: Mutex<Option<Child>>,
    /// ffmpeg stdin. WS thread and the IPC write command both write here;
    /// taking it (drop) signals EOF.
    pub stdin: Mutex<Option<ChildStdin>>,
}

pub struct ActiveSink {
    pub join: Option<JoinHandle<Result<SinkStats, String>>>,
    pub shared: Arc<SinkShared>,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SinkStats {
    pub bytes: u64,
    pub frames: u64,
    pub elapsed_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSinkStartArgs {
    /// "ws" | "discard" (Task 3 adds full ffmpeg wiring behind both).
    pub mode: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// "hevc" | "av1" — unused until Task 3.
    pub codec: String,
    pub bitrate: u64,
    pub cbr: bool,
    pub gop: u64,
    pub software: bool,
    pub output_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSinkStartReply {
    pub port: u16,
    pub token: String,
}

fn make_token() -> String {
    let mut h = DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut h);
    std::process::id().hash(&mut h);
    let a = h.finish();
    a.hash(&mut h);
    format!("{:016x}{:016x}", a, h.finish())
}

/// Accept exactly one WS client, verify the token, then pump binary frames
/// into `shared.stdin` (None ⇒ discard). A non-Normal close kills ffmpeg
/// (abort); a Normal close drops stdin (EOF) and waits for ffmpeg to exit.
fn run_ws_sink(
    listener: TcpListener,
    token: String,
    shared: Arc<SinkShared>,
) -> Result<SinkStats, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("sink listener: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let stream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("sink: no client within 30s".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("sink accept: {e}")),
        }
    };
    stream
        .set_nonblocking(false)
        .map_err(|e| format!("sink stream: {e}"))?;
    let mut ws =
        tungstenite::accept(stream).map_err(|e| format!("ws handshake: {e}"))?;
    match ws.read() {
        Ok(tungstenite::Message::Text(t)) if t.as_str() == token => {}
        other => return Err(format!("sink: bad first message ({other:?})")),
    }
    let t0 = Instant::now();
    let mut bytes: u64 = 0;
    let mut frames: u64 = 0;
    let kill = |shared: &SinkShared| {
        if let Some(c) = shared.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    };
    loop {
        match ws.read() {
            Ok(tungstenite::Message::Binary(b)) => {
                bytes += b.len() as u64;
                frames += 1;
                let mut stdin = shared.stdin.lock().unwrap();
                if let Some(s) = stdin.as_mut() {
                    if let Err(e) = s.write_all(&b) {
                        kill(&shared);
                        return Err(format!("ffmpeg stdin: {e}"));
                    }
                }
            }
            Ok(tungstenite::Message::Close(frame)) => {
                let clean = frame
                    .as_ref()
                    .map(|f| u16::from(f.code) == 1000)
                    .unwrap_or(false);
                if !clean {
                    kill(&shared);
                    return Err("sink: client aborted".into());
                }
                break;
            }
            Ok(_) => {}
            Err(e) => {
                kill(&shared);
                return Err(format!("ws read: {e}"));
            }
        }
    }
    // EOF → ffmpeg finalizes; then reap it.
    drop(shared.stdin.lock().unwrap().take());
    let status = match shared.child.lock().unwrap().take() {
        Some(mut c) => Some(c.wait().map_err(|e| format!("ffmpeg wait: {e}"))?),
        None => None,
    };
    if let Some(st) = status {
        if !st.success() {
            return Err(format!("ffmpeg exited {st}"));
        }
    }
    Ok(SinkStats {
        bytes,
        frames,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn export_video_sink_start(
    state: State<'_, VideoSinkState>,
    args: VideoSinkStartArgs,
) -> Result<VideoSinkStartReply, String> {
    if state.0.lock().unwrap().is_some() {
        return Err("video sink already active".into());
    }
    if args.mode != "discard" && args.mode != "ws" {
        return Err(format!("unknown sink mode {}", args.mode));
    }
    // Task 3 spawns ffmpeg here for mode == "ws"; discard runs sinkless.
    let shared = Arc::new(SinkShared {
        child: Mutex::new(None),
        stdin: Mutex::new(None),
    });
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("sink bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = make_token();
    info!("video sink listening on 127.0.0.1:{port} mode={}", args.mode);
    let join = {
        let token = token.clone();
        let shared = shared.clone();
        std::thread::spawn(move || run_ws_sink(listener, token, shared))
    };
    *state.0.lock().unwrap() = Some(ActiveSink {
        join: Some(join),
        shared,
    });
    Ok(VideoSinkStartReply { port, token })
}

#[tauri::command]
pub async fn export_video_sink_finish(
    state: State<'_, VideoSinkState>,
) -> Result<SinkStats, String> {
    let join = {
        let mut guard = state.0.lock().unwrap();
        let sink = guard.as_mut().ok_or("no active video sink")?;
        sink.join.take().ok_or("sink already finished")?
    };
    let res = tauri::async_runtime::spawn_blocking(move || {
        join.join().unwrap_or_else(|_| Err("sink thread panicked".into()))
    })
    .await
    .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = None;
    res
}

#[tauri::command]
pub async fn export_video_sink_cancel(
    state: State<'_, VideoSinkState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(sink) = guard.take() {
        drop(sink.shared.stdin.lock().unwrap().take());
        if let Some(c) = sink.shared.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
        warn!("video sink cancelled");
    }
    Ok(())
}

/// IPC fallback: raw-invoke body straight into ffmpeg stdin. Used only when
/// the WS connect fails in the worker (the export still completes, slower).
#[tauri::command]
pub fn export_video_sink_write(
    request: tauri::ipc::Request<'_>,
    state: State<'_, VideoSinkState>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let guard = state.0.lock().unwrap();
    let sink = guard.as_ref().ok_or("no active video sink")?;
    let mut stdin = sink.shared.stdin.lock().unwrap();
    match stdin.as_mut() {
        Some(s) => s.write_all(bytes).map_err(|e| format!("ffmpeg stdin: {e}")),
        None => Ok(()), // discard mode
    }
}
```

- [ ] **Step 3: Register module, state, and commands**

In `export/mod.rs` add `pub mod videosink;` next to the existing `pub mod hwencoder;`. In `lib.rs`, find where `HwEncoderCache` is managed and the `invoke_handler` list; add:

```rust
.manage(crate::export::videosink::VideoSinkState::default())
```

and to `generate_handler![…]`:

```rust
crate::export::videosink::export_video_sink_start,
crate::export::videosink::export_video_sink_finish,
crate::export::videosink::export_video_sink_cancel,
crate::export::videosink::export_video_sink_write,
```

- [ ] **Step 4: Build check**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: clean (warnings about unused `args` fields are fine until Task 3).

- [ ] **Step 5: Write the spike e2e tool**

`apps/desktop/e2e/tools/iso_video_sink_throughput.e2e.js`:

```js
// TRANSPORT SPIKE (spec gate): loopback WebSocket throughput webview→Rust.
// Verdict thresholds: ≥190 MB/s = realtime-capable; ≥60 = offline-OK; below
// 60 = STOP, re-plan transport before continuing the 10-bit pipeline.
//   node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.mjs --spec ./tools/iso_video_sink_throughput.e2e.js
describe("export video sink loopback throughput (spike)", function () {
  it("pumps P010-sized frames over WS and reports MB/s", async function () {
    this.timeout(120000);
    const r = await browser.executeAsync((done) => {
      (async () => {
        const T = window.__TAURI__;
        const args = {
          mode: "discard", width: 1920, height: 1080,
          fpsNum: 30, fpsDen: 1, codec: "hevc",
          bitrate: 0, cbr: false, gop: 30, software: false, outputPath: "",
        };
        const { port, token } = await T.core.invoke("export_video_sink_start", { args });
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.binaryType = "arraybuffer";
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });
        ws.send(token);
        const FRAME = 1920 * 1080 * 3; // yuv420p10le bytes
        const N = 90;
        const payload = new Uint8Array(FRAME);
        for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff;
        const HIGH_WATER = 32 * 1024 * 1024;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          while (ws.bufferedAmount > HIGH_WATER) await new Promise((r2) => setTimeout(r2, 2));
          ws.send(payload);
        }
        while (ws.bufferedAmount > 0) await new Promise((r2) => setTimeout(r2, 2));
        const sendMs = performance.now() - t0;
        ws.close(1000);
        const stats = await T.core.invoke("export_video_sink_finish");
        done({ sendMs: Math.round(sendMs), clientMBps: Math.round((FRAME * N / 1048576) / (sendMs / 1000)), stats, frame: FRAME, n: N });
      })().catch((e) => done({ fatal: String((e && e.stack) || e) }));
    });
    console.log("\n[sinkSpike] result:", JSON.stringify(r));
    if (!r.fatal) {
      const v = r.clientMBps >= 190 ? "✅ ≥190 MB/s (realtime-capable)"
        : r.clientMBps >= 60 ? "🟡 ≥60 MB/s (offline-OK; UI should state reduced speed)"
        : "❌ <60 MB/s — STOP and re-plan transport";
      console.log(`[sinkSpike] ${r.clientMBps} MB/s -> ${v}`);
      expect(r.stats.bytes).toBe(r.frame * r.n);
    }
    expect(r.fatal).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run the spike**

Run from `apps/desktop/e2e`:
`node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.mjs --spec ./tools/iso_video_sink_throughput.e2e.js`
Expected: spec passes, `bytes` matches, and the MB/s verdict line prints. **Record the number in the spec doc's P3 row.** If ❌, stop the plan here and escalate.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/export/videosink.rs apps/desktop/src-tauri/src/export/mod.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/lib.rs apps/desktop/e2e/tools/iso_video_sink_throughput.e2e.js
git commit -m "feat(export10): loopback WS video sink (discard mode) + transport spike"
```

---

### Task 2: 10-bit YUV↔RGB reference math (`yuv10.ts`)

The single source of truth the GLSL shaders must match (Tasks 5–6 parity-test
against it).

**Files:**
- Create: `apps/desktop/src/render/tenbit/yuv10.ts`
- Test: `apps/desktop/src/render/tenbit/yuv10.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { rgbToYuv10, yuv10ToRgb, BT709 } from "./yuv10";

describe("yuv10 (BT.709 limited, gamma-domain)", () => {
  it("maps black/white/grey to canonical codes", () => {
    expect(rgbToYuv10(0, 0, 0, BT709)).toEqual([64, 512, 512]);
    expect(rgbToYuv10(1, 1, 1, BT709)).toEqual([940, 512, 512]);
    expect(rgbToYuv10(0.5, 0.5, 0.5, BT709)).toEqual([502, 512, 512]);
  });
  it("maps pure red per BT.709", () => {
    const [y, u, v] = rgbToYuv10(1, 0, 0, BT709);
    expect(y).toBe(250); // 64 + 876*0.2126 = 250.25 → 250
    expect(u).toBe(409); // 512 + 896*(-0.2126/1.8556)
    expect(v).toBe(960); // 512 + 896*(0.7874/1.5748) = 512+448
  });
  it("round-trips within one 10-bit step", () => {
    for (const [r, g, b] of [[0.1, 0.5, 0.9], [0.73, 0.21, 0.02], [1, 1, 0]]) {
      const [y, u, v] = rgbToYuv10(r, g, b, BT709);
      const [r2, g2, b2] = yuv10ToRgb(y, u, v, BT709);
      expect(Math.abs(r2 - r)).toBeLessThan(1.5 / 876);
      expect(Math.abs(g2 - g)).toBeLessThan(1.5 / 876);
      expect(Math.abs(b2 - b)).toBeLessThan(1.5 / 876);
    }
  });
  it("clamps out-of-range input", () => {
    expect(rgbToYuv10(2, 2, 2, BT709)[0]).toBe(940);
    expect(rgbToYuv10(-1, -1, -1, BT709)[0]).toBe(64);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/desktop && npm run test -- src/render/tenbit/yuv10.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// 10-bit limited-range YCbCr ⇄ gamma-encoded RGB, the reference the ingest
// and pack shaders are parity-tested against. Display-referred: NO transfer
// math here (ADR 0021 / design doc: working space = gamma 709).

export interface YuvCoef {
  /// Kr, Kb of the matrix (Kg = 1 − Kr − Kb).
  kr: number;
  kb: number;
}
export const BT709: YuvCoef = { kr: 0.2126, kb: 0.0722 };
export const BT601: YuvCoef = { kr: 0.299, kb: 0.114 };

const clamp10 = (x: number) => Math.min(1023, Math.max(0, Math.round(x)));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/// Derived shader coefficients [crR, cbG, crG, cbB] for yuv→rgb.
export function inverseCoef(c: YuvCoef): [number, number, number, number] {
  const kg = 1 - c.kr - c.kb;
  const crR = 2 * (1 - c.kr);
  const cbB = 2 * (1 - c.kb);
  return [crR, (c.kb * cbB) / kg, (c.kr * crR) / kg, cbB];
}

export function rgbToYuv10(
  r: number, g: number, b: number, c: YuvCoef,
): [number, number, number] {
  const kg = 1 - c.kr - c.kb;
  const y = c.kr * clamp01(r) + kg * clamp01(g) + c.kb * clamp01(b);
  const cb = (clamp01(b) - y) / (2 * (1 - c.kb));
  const cr = (clamp01(r) - y) / (2 * (1 - c.kr));
  return [clamp10(64 + 876 * y), clamp10(512 + 896 * cb), clamp10(512 + 896 * cr)];
}

export function yuv10ToRgb(
  y10: number, u10: number, v10: number, c: YuvCoef,
): [number, number, number] {
  const [crR, cbG, crG, cbB] = inverseCoef(c);
  const y = (y10 - 64) / 876;
  const cb = (u10 - 512) / 896;
  const cr = (v10 - 512) / 896;
  return [
    clamp01(y + crR * cr),
    clamp01(y - crG * cr - cbG * cb),
    clamp01(y + cbB * cb),
  ];
}

/// CPU reference of the pack shader's byte layout: two samples per RGBA8
/// texel, u16LE each. Used by the GL-parity e2e (Task 5).
export function packTwoSamples(a10: number, b10: number): [number, number, number, number] {
  return [a10 & 255, a10 >> 8, b10 & 255, b10 >> 8];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/desktop && npm run test -- src/render/tenbit/yuv10.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/tenbit/yuv10.ts apps/desktop/src/render/tenbit/yuv10.test.ts
git commit -m "feat(export10): 10-bit YUV/RGB reference math + golden vectors"
```

---

### Task 3: ffmpeg encode mode in the sink (10-bit encoder pick + args)

**Files:**
- Modify: `apps/desktop/src-tauri/src/export/hwencoder.rs` (10-bit probe + cache + `tenbit_encode_args`)
- Modify: `apps/desktop/src-tauri/src/export/videosink.rs` (spawn ffmpeg in `start` for mode "ws"/"ipc")

- [ ] **Step 1: Write failing Rust unit tests** (append to `hwencoder.rs` `mod tests`)

```rust
#[test]
fn tenbit_args_per_encoder() {
    let s = |v: &Vec<std::ffi::OsString>| -> Vec<String> {
        v.iter().map(|o| o.to_string_lossy().into_owned()).collect()
    };
    assert_eq!(s(&tenbit_encode_args("hevc_nvenc")), vec!["-pix_fmt", "p010le", "-profile:v", "main10"]);
    assert_eq!(s(&tenbit_encode_args("libx265")), vec!["-pix_fmt", "yuv420p10le", "-profile:v", "main10"]);
    assert_eq!(s(&tenbit_encode_args("libsvtav1")), vec!["-pix_fmt", "yuv420p10le"]);
}
```

Run: `cd apps/desktop/src-tauri && cargo test tenbit_args` → FAIL (missing fn).

- [ ] **Step 2: Implement in `hwencoder.rs`**

```rust
/// Output pixel-format + profile flags for a 10-bit encode through `encoder`.
/// NVENC/QSV/AMF HEVC take P010 input frames; software encoders take planar.
pub fn tenbit_encode_args(encoder: &str) -> Vec<std::ffi::OsString> {
    let mk = |xs: &[&str]| xs.iter().map(|s| s.into()).collect();
    match encoder {
        "hevc_nvenc" | "hevc_qsv" | "hevc_amf" => mk(&["-pix_fmt", "p010le", "-profile:v", "main10"]),
        "libx265" => mk(&["-pix_fmt", "yuv420p10le", "-profile:v", "main10"]),
        _ => mk(&["-pix_fmt", "yuv420p10le"]),
    }
}
```

Add a 10-bit-probed cache lane to `HwEncoderCache` (the 8-bit probe passes
for encoders whose 10-bit path fails, e.g. old NVENC):

```rust
// field next to `inner`:
inner10: Mutex<HashMap<TargetCodec, Arc<String>>>,
// (update ::new() accordingly)

pub async fn encoder_for_10bit(&self, codec: TargetCodec) -> Arc<String> {
    if let Some(cached) = self.inner10.lock().await.get(&codec) {
        return cached.clone();
    }
    let chosen = pick_encoder_10bit(codec).await;
    let arc = Arc::new(chosen);
    self.inner10.lock().await.insert(codec, arc.clone());
    arc
}

async fn pick_encoder_10bit(codec: TargetCodec) -> String {
    for &fam in platform_families() {
        if let Some(name) = fam.encoder_for(codec) {
            if probe_encoder_10bit(name).await {
                info!("10-bit hw encoder for {:?}: {}", codec, name);
                return name.to_string();
            }
        }
    }
    let sw = codec.software_encoder();
    info!("no usable 10-bit hw encoder for {:?}, using {}", codec, sw);
    sw.to_string()
}

/// Same shape as `probe_encoder`, but with a 10-bit source + the encoder's
/// 10-bit output flags, so a HW family that can't do Main10 fails here.
async fn probe_encoder_10bit(encoder_name: &str) -> bool {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=128x128:d=0.1:r=30,format=yuv420p10le",
        "-c:v", encoder_name,
    ]);
    cmd.args(tenbit_encode_args(encoder_name));
    cmd.args(["-frames:v", "1", "-f", "null", "-"]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    // …then byte-for-byte the same child/wait/timeout handling as
    // `probe_encoder` — extract that tail into
    // `async fn run_probe(cmd: Command, encoder_name: &str) -> bool`
    // and call it from BOTH probes (DRY).
    run_probe(cmd, encoder_name).await
}
```

Refactor: move `probe_encoder`'s spawn/wait/timeout body into
`async fn run_probe(mut cmd: Command, encoder_name: &str) -> bool` and have
both probes call it. No behavior change for the 8-bit path.

- [ ] **Step 3: Spawn ffmpeg in `export_video_sink_start`**

First, in `export/mod.rs`, widen the two arg-builders the sink reuses from
private to crate-visible (no other change):

```rust
pub(crate) fn video_encode_args(encoder: &str, bitrate: u64, cbr: bool, gop: u64) -> Vec<std::ffi::OsString> {
pub(crate) fn hvc1_tag_args(codec: TargetCodec, output: &Path) -> Vec<std::ffi::OsString> {
```

Then in `videosink.rs`, replace the `// Task 3 spawns ffmpeg…` comment. New import:
`use super::hwencoder::{tenbit_encode_args, HwEncoderCache, TargetCodec};` and
`use ffmpeg_sidecar::paths::ffmpeg_path;` and add the `hw: State<'_, HwEncoderCache>`
parameter to the command:

```rust
let mut child_opt = None;
let mut stdin_opt = None;
if args.mode != "discard" {
    let codec = TargetCodec::parse(&args.codec)
        .ok_or_else(|| format!("unknown codec {}", args.codec))?;
    let encoder: String = if args.software {
        codec.software_encoder().to_string()
    } else {
        hw.encoder_for_10bit(codec).await.as_ref().clone()
    };
    let mut cmd = std::process::Command::new(ffmpeg_path());
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"]);
    cmd.args(["-f", "rawvideo", "-pix_fmt", "yuv420p10le"]);
    cmd.arg("-video_size").arg(format!("{}x{}", args.width, args.height));
    cmd.arg("-framerate").arg(format!("{}/{}", args.fps_num, args.fps_den));
    cmd.args(["-i", "-"]);
    cmd.args(super::video_encode_args(&encoder, args.bitrate, args.cbr, args.gop));
    cmd.args(tenbit_encode_args(&encoder));
    cmd.args([
        "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-color_range", "tv",
    ]);
    cmd.args(super::hvc1_tag_args(codec, std::path::Path::new(&args.output_path)));
    cmd.arg(&args.output_path);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit());
    let mut child = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    stdin_opt = child.stdin.take();
    child_opt = Some(child);
}
let shared = Arc::new(SinkShared {
    child: Mutex::new(child_opt),
    stdin: Mutex::new(stdin_opt),
});
```

Mode `"ipc"`: skip the listener/thread — set `join: None` is NOT allowed by
`finish` (it takes the join); instead, for ipc mode spawn a trivial thread
that just waits for stdin to be taken… **simpler**: in ipc mode the WS thread
still runs but no client ever connects; its 30s accept timeout would kill the
export. So: in `run_ws_sink`, when the accept deadline passes, do NOT error —
return `Ok(SinkStats { bytes: 0, frames: 0, elapsed_ms: 0 })` **only if**
stdin has already been taken (the ipc path's `finish` takes it); otherwise
keep extending the deadline while `shared.stdin` still holds Some (ipc writes
in flight). Concretely replace the deadline error with:

```rust
if Instant::now() > deadline {
    // ipc fallback may be feeding via the write command instead;
    // wait until finish() drops stdin, then reap ffmpeg.
    if shared.stdin.lock().unwrap().is_none() {
        let status = match shared.child.lock().unwrap().take() {
            Some(mut c) => Some(c.wait().map_err(|e| e.to_string())?),
            None => None,
        };
        if let Some(st) = status {
            if !st.success() { return Err(format!("ffmpeg exited {st}")); }
        }
        return Ok(SinkStats { bytes: 0, frames: 0, elapsed_ms: 0 });
    }
    std::thread::sleep(Duration::from_millis(100));
    continue;
}
```

and in `export_video_sink_finish`, BEFORE joining, drop stdin so both paths
converge: `{ let g = state.0.lock().unwrap(); if let Some(s) = g.as_ref() { drop(s.shared.stdin.lock().unwrap().take()); } }`
(WS path: stdin is already None by the time the client closed; harmless.)

- [ ] **Step 4: Tests + build**

Run: `cd apps/desktop/src-tauri && cargo test && cargo check`
Expected: `tenbit_args_per_encoder` + existing tests PASS.

- [ ] **Step 5: Manual smoke (optional but cheap)**

With the dev app running, in devtools:
```js
const a = { mode:"ws", width:128, height:128, fpsNum:30, fpsDen:1, codec:"hevc", bitrate:1000000, cbr:false, gop:30, software:true, outputPath: "C:\\\\Users\\\\jonny\\\\AppData\\\\Local\\\\Temp\\\\sink_smoke.mp4" };
const {port, token} = await window.__TAURI__.core.invoke("export_video_sink_start", {args:a});
const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.onopen = () => {
  ws.send(token);
  const f = new Uint8Array(128*128*3); // one grey-ish frame
  for (let i=0;i<10;i++) ws.send(f);
  ws.close(1000);
};
// then: await window.__TAURI__.core.invoke("export_video_sink_finish")
```
Expected: finish resolves; `ffprobe sink_smoke.mp4` shows `hevc`, `yuv420p10le`/`p010le`, 10 frames.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/export/hwencoder.rs apps/desktop/src-tauri/src/export/videosink.rs
git commit -m "feat(export10): ffmpeg 10-bit encode exit in the video sink (probed Main10 encoders)"
```

---

### Task 4: CPU-plane lane in the export decoder (TenBitFrame)

**Files:**
- Create: `apps/desktop/src/render/decoder/tenBitFrame.ts`
- Modify: `apps/desktop/src/render/decoder/SourceDecoderPool.ts` (widen `DecodedFrame`, extend `SourceHandleInit`)
- Modify: `apps/desktop/src/render/decoder/ExportDecoderPool.ts` (lane + reorder margin + prefer-software)
- Modify: `apps/desktop/src/render/sprite/VideoClipSprite.ts` (defensive guard only — binding comes in Task 6)
- Test: `apps/desktop/src/render/decoder/ExportFrameStore.test.ts`, `apps/desktop/src/render/decoder/ExportSourceHandle.test.ts` (extend; read both first to reuse their fakes)

- [ ] **Step 1: `tenBitFrame.ts`**

```ts
// CPU-plane copy of a >8-bit decoder frame. Created in the decoder output
// callback (copyTo + frame.close() immediately — drains the WebCodecs pool
// outright, ADR 0004), stored in the export ring in place of the VideoFrame.

export interface TenBitFrame {
  readonly kind: "p10";
  readonly width: number;
  readonly height: number;
  /// Tightly packed I420P10 planes (u16LE): Y at yOffset (stride width*2),
  /// then U, V at half resolution (stride width).
  readonly data: Uint8Array;
  readonly yOffset: number;
  readonly uOffset: number;
  readonly vOffset: number;
  readonly colorSpace: VideoColorSpaceInit | null;
  readonly timestamp: number;
  readonly duration: number | null;
  /// Uniform-shape no-op so ring eviction code treats both frame kinds alike.
  close(): void;
}

export function isTenBitFrame(f: unknown): f is TenBitFrame {
  return !!f && typeof f === "object" && (f as { kind?: string }).kind === "p10";
}

/// True for decoder output formats this lane handles (I420P10 today; P12
/// would need 12→10 requantize — out of scope, returns false).
export function isTenBitDecoderFormat(format: string | null): boolean {
  return format === "I420P10";
}

export async function copyToTenBit(frame: VideoFrame): Promise<TenBitFrame> {
  const rect = frame.visibleRect ?? new DOMRectReadOnly(0, 0, frame.codedWidth, frame.codedHeight);
  const w = rect.width;
  const h = rect.height;
  const ySize = w * h * 2;
  const cSize = (w >> 1) * (h >> 1) * 2;
  const data = new Uint8Array(ySize + 2 * cSize);
  await frame.copyTo(data, {
    rect,
    layout: [
      { offset: 0, stride: w * 2 },
      { offset: ySize, stride: w },
      { offset: ySize + cSize, stride: w },
    ],
  });
  const cs = frame.colorSpace;
  return {
    kind: "p10",
    width: w,
    height: h,
    data,
    yOffset: 0,
    uOffset: ySize,
    vOffset: ySize + cSize,
    colorSpace: cs
      ? { matrix: cs.matrix ?? undefined, primaries: cs.primaries ?? undefined,
          transfer: cs.transfer ?? undefined, fullRange: cs.fullRange ?? undefined }
      : null,
    timestamp: frame.timestamp,
    duration: frame.duration,
    close() {},
  };
}
```

- [ ] **Step 2: Widen the shared types** (`SourceDecoderPool.ts`)

```ts
import type { TenBitFrame } from "./tenBitFrame";
// line ~70:
export type DecodedFrame = VideoFrame | ImageBitmap | TenBitFrame;
// SourceHandleInit gains:
  /// Export-only: copy >8-bit decoder output to CPU planes (TenBitFrame)
  /// instead of holding VideoFrames. Implies the 10-bit export lane.
  tenBitLane?: boolean;
  /// Export-only: configure the decoder prefer-software up front (Hi10P has
  /// no HW path; skipping the error-fallback round-trip).
  preferSoftware?: boolean;
```

In `VideoClipSprite.updateFrame`, guard the snapshot path (routing happens in
Task 6; this keeps a mis-route loud instead of a silent drawImage error):

```ts
if ((frame as { kind?: string }).kind === "p10") {
  throw new Error("VideoClipSprite.updateFrame got a TenBitFrame — use bindExternalTexture");
}
```

and in `decodedDims`, TenBitFrame never reaches it after the guard (no change).

- [ ] **Step 3: Failing unit tests**

`ExportFrameStore.test.ts` — add (mirror the file's existing fake-frame helper;
it fakes VideoFrames as `{ timestamp, duration, close }` objects):

```ts
it("stores and serves TenBitFrames like VideoFrames", async () => {
  const store = new ExportFrameStore();
  const tb = { kind: "p10", timestamp: 0, duration: 33333, close: vi.fn() };
  store.push(tb as never);
  expect(store.containsPts(10)).toBe(true);
  await store.waitForPts(10); // resolves synchronously
  store.evictBefore(40000);
  expect(store.size()).toBe(0);
});
```

`ExportSourceHandle.test.ts` — read the existing fake `packetSink`/decoder
harness first, then add two tests using the same fakes:

```ts
it("tenBitLane dispatches a reorder margin past the stop key", async () => {
  // fixture: packets at 0..19 frames of 33333us, key at 0 and at frame 10.
  // decodeRange(0, 150000) on a NON-lane handle stops right after the frame-10
  // key (existing behavior). The SAME range on a tenBitLane handle dispatches
  // TENBIT_REORDER_MARGIN (16) extra packets (or to EOS, whichever first).
  // Assert: dispatched count == nonLaneCount + min(16, remaining).
});
it("preferSoftware configures the decoder prefer-software", async () => {
  // build handle with preferSoftware: true; capture the config passed to the
  // fake decoder's configure(); assert hardwareAcceleration === "prefer-software".
});
```

(Adapt to the file's actual fake API — the harness already drives
`decodeRange` with scripted packets; these tests are additions, not new infra.)

Run: `cd apps/desktop && npm run test -- src/render/decoder` → new tests FAIL.

- [ ] **Step 4: Implement in `ExportDecoderPool.ts`**

1. `RingEntry.frame: VideoFrame | TenBitFrame`; `push(frame: VideoFrame | TenBitFrame)`;
   `frameAt` return type `VideoFrame | TenBitFrame | null` (satisfies the widened
   `FrameStore` since `DecodedFrame` now includes `TenBitFrame`).
2. Handle fields from init: `private readonly tenBitLane: boolean;`
   `private readonly preferSoftware: boolean;` (default false).
3. `buildConfig()`:
   ```ts
   hardwareAcceleration:
     this.downgraded || this.preferSoftware ? "prefer-software" : "prefer-hardware",
   ```
4. Output callback — after the `firstFrameDiag` block, before `ring.push(frame)`:
   ```ts
   if (this.tenBitLane && isTenBitDecoderFormat(frame.format)) {
     void copyToTenBit(frame)
       .then((tb) => {
         frame.close();
         if (this.decoder !== dec) return;
         this.ring.push(tb);
       })
       .catch((e: unknown) => {
         frame.close();
         // eslint-disable-next-line no-console
         console.error(`[weftcut/export] ${this.mediaId} copyTo failed:`, e);
       });
     return;
   }
   ```
   (Out-of-order copyTo completions are fine — `push` sorts by pts.)
5. Reorder margin — at the top of the file:
   ```ts
   /// SW 10-bit decoders hold a reorder tail internally and the chunked model
   /// never mid-flushes (see the reverted 2026-06-04 10-bit DirectExport —
   /// memory note project_10bit_direct_export). Feeding a bounded lead-in past
   /// the stop key pushes the tail out; H.264's max DPB is 16.
   const TENBIT_REORDER_MARGIN = 16;
   ```
   In `decodeRange`, immediately after the `while (pkt)` loop and BEFORE the
   `coveredThroughUs` update:
   ```ts
   if (this.tenBitLane) {
     let extra = 0;
     while (pkt && extra < TENBIT_REORDER_MARGIN) {
       this.decoder.decode(pkt.toEncodedVideoChunk());
       this.cursor = pkt;
       this.lastDispatchedPtsUs = Math.round(pkt.timestamp * 1e6);
       dispatched++;
       this.dispatchedTotal++;
       extra++;
       pkt = await packetSink.getNextPacket(pkt);
       if (this._disposed) return;
     }
   }
   ```
   (`coveredThroughUs` stays at the stop key — conservative and correct: the
   margin packets sit ahead of the cursor, never re-fed. `pkt === null` after
   the margin falls through to the existing EOS branch.)

- [ ] **Step 5: Run tests**

Run: `cd apps/desktop && npm run test -- src/render/decoder && npm run typecheck`
Expected: all decoder tests PASS; typecheck clean (preview code is untouched —
`TenBitFrame` only ever appears when `tenBitLane` is set).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/render/decoder/tenBitFrame.ts apps/desktop/src/render/decoder/SourceDecoderPool.ts apps/desktop/src/render/decoder/ExportDecoderPool.ts apps/desktop/src/render/decoder/ExportFrameStore.test.ts apps/desktop/src/render/decoder/ExportSourceHandle.test.ts apps/desktop/src/render/sprite/VideoClipSprite.ts
git commit -m "feat(export10): CPU-plane TenBitFrame lane + SW reorder margin in the export decoder"
```

---### Task 5: GPU passes — `TenBitIngest` (RG8→f16) and `PackP010` (f16→yuv420p10le bytes) + GL parity e2e

**Files:**
- Create: `apps/desktop/src/render/tenbit/TenBitIngest.ts`
- Create: `apps/desktop/src/render/tenbit/PackP010.ts`
- Create: `apps/desktop/e2e/tools/iso_tenbit_gl_parity.e2e.js`

Pre-check (one grep each; both are expected to exist — Pixi 8.18 ships them):
`grep -c "BufferImageSource" node_modules/pixi.js/dist/pixi.mjs` and
`grep -n "rg8:" node_modules/pixi.js/dist/pixi.mjs | head -2`.

- [ ] **Step 1: `TenBitIngest.ts`**

```ts
// Converts TenBitFrames into per-clip RGBA16F textures through a Pixi
// WebGL2 mesh pass. Planes upload as RG8 (r = low byte, g = high byte of the
// u16LE sample) with NEAREST sampling — bilinear would interpolate the two
// bytes independently and produce garbage. Chroma is upsampled nearest (v1).

import {
  BufferImageSource, Mesh, MeshGeometry, RenderTexture, Shader, Texture,
} from "pixi.js";
import type { Renderer } from "pixi.js";
import type { TenBitFrame } from "../decoder/tenBitFrame";
import { BT601, BT709, inverseCoef } from "./yuv10";

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uY;
uniform sampler2D uU;
uniform sampler2D uV;
uniform vec4 uCoef;   // crR, cbG, crG, cbB
uniform vec2 uScale;  // y scale (876 limited / 1023 full), c scale (896 / 1023)
uniform float uYOff;  // 64 limited / 0 full
float decode10(vec4 t) { return t.r * 255.0 + t.g * 255.0 * 256.0; }
void main() {
  float y  = (decode10(texture(uY, vUV)) - uYOff) / uScale.x;
  float cb = (decode10(texture(uU, vUV)) - 512.0) / uScale.y;
  float cr = (decode10(texture(uV, vUV)) - 512.0) / uScale.y;
  vec3 rgb = vec3(
    y + uCoef.x * cr,
    y - uCoef.z * cr - uCoef.y * cb,
    y + uCoef.w * cb);
  finalColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

interface ClipState {
  w: number; h: number;
  y: BufferImageSource; u: BufferImageSource; v: BufferImageSource;
  rt: RenderTexture;
  mesh: Mesh;
  last: TenBitFrame | null;
}

function planeSource(data: Uint8Array, w: number, h: number): BufferImageSource {
  return new BufferImageSource({
    resource: data, width: w, height: h, format: "rg8",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
  });
}

export class TenBitIngest {
  private states = new Map<string, ClipState>();
  constructor(private renderer: Renderer) {}

  textureFor(key: string, tb: TenBitFrame): Texture {
    let s = this.states.get(key);
    if (s && (s.w !== tb.width || s.h !== tb.height)) {
      this.release(key);
      s = undefined;
    }
    if (!s) {
      s = this.build(key, tb);
      this.states.set(key, s);
    }
    if (s.last !== tb) {
      const cw = tb.width >> 1, ch = tb.height >> 1;
      s.y.resource = tb.data.subarray(tb.yOffset, tb.yOffset + tb.width * tb.height * 2);
      s.u.resource = tb.data.subarray(tb.uOffset, tb.uOffset + cw * ch * 2);
      s.v.resource = tb.data.subarray(tb.vOffset, tb.vOffset + cw * ch * 2);
      s.y.update(); s.u.update(); s.v.update();
      const full = tb.colorSpace?.fullRange === true;
      const coef = inverseCoef(tb.colorSpace?.matrix === "smpte170m" ? BT601 : BT709);
      const u = s.mesh.shader!.resources.tenbit.uniforms;
      u.uCoef = new Float32Array(coef);
      u.uScale = new Float32Array(full ? [1023, 1023] : [876, 896]);
      u.uYOff = full ? 0 : 64;
      this.renderer.render({ container: s.mesh, target: s.rt });
      s.last = tb;
    }
    return s.rt;
  }

  private build(key: string, tb: TenBitFrame): ClipState {
    const w = tb.width, h = tb.height, cw = w >> 1, ch = h >> 1;
    const y = planeSource(tb.data.subarray(tb.yOffset, tb.yOffset + w * h * 2), w, h);
    const u = planeSource(tb.data.subarray(tb.uOffset, tb.uOffset + cw * ch * 2), cw, ch);
    const v = planeSource(tb.data.subarray(tb.vOffset, tb.vOffset + cw * ch * 2), cw, ch);
    const rt = RenderTexture.create({ width: w, height: h, format: "rgba16float" });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG },
      resources: {
        uY: y, uYSampler: y.style,
        uU: u, uUSampler: u.style,
        uV: v, uVSampler: v.style,
        tenbit: {
          uCoef: { value: new Float32Array(inverseCoef(BT709)), type: "vec4<f32>" },
          uScale: { value: new Float32Array([876, 896]), type: "vec2<f32>" },
          uYOff: { value: 64, type: "f32" },
        },
      },
    });
    const mesh = new Mesh({ geometry, shader });
    return { w, h, y, u, v, rt, mesh, last: null };
  }

  release(key: string): void {
    const s = this.states.get(key);
    if (!s) return;
    s.mesh.destroy();
    s.rt.destroy(true);
    s.y.destroy(); s.u.destroy(); s.v.destroy();
    this.states.delete(key);
  }

  dispose(): void {
    for (const k of [...this.states.keys()]) this.release(k);
  }
}
```

- [ ] **Step 2: `PackP010.ts`**

```ts
// f16 composite → yuv420p10le bytes via three byte-pack fragment passes into
// RGBA8 targets (each texel = two u16LE samples) + readPixels (byte-exact).
// The pass samples the composite BILINEARLY at output resolution, so encoder
// downscale folds in here. Chroma = one bilinear tap at each 2×2 block
// midpoint (an exact box average). GL readback rows are bottom-up; rows are
// flipped on the CPU copy (PACK_ROW_FLIP, pinned by the parity e2e).

import { Mesh, MeshGeometry, RenderTexture, Shader } from "pixi.js";
import type { Renderer, Texture } from "pixi.js";

/// GL framebuffer origin is bottom-left; plane layout wants top-down rows.
/// The parity e2e (iso_tenbit_gl_parity) asserts orientation — if it reports
/// rows already top-down (Pixi RT projection flip), set this to false.
const PACK_ROW_FLIP = true;

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;

// Y pass: output texel x covers source pixels (2x, y) and (2x+1, y).
const FRAG_Y = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut; // encoder (outW, outH)
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float q(float y) { return clamp(floor(64.0 + y * 876.0 + 0.5), 0.0, 1023.0); }
void main() {
  float px = (gl_FragCoord.x - 0.5) * 2.0;
  float row = gl_FragCoord.y - 0.5;
  float y0 = q(dot(texture(uC, vec2((px + 0.5) / uOut.x, (row + 0.5) / uOut.y)).rgb, KY));
  float y1 = q(dot(texture(uC, vec2((px + 1.5) / uOut.x, (row + 0.5) / uOut.y)).rgb, KY));
  o = vec4(mod(y0, 256.0) / 255.0, floor(y0 / 256.0) / 255.0,
           mod(y1, 256.0) / 255.0, floor(y1 / 256.0) / 255.0);
}`;

// Chroma pass: output texel x covers chroma samples (2x, y) and (2x+1, y) of
// a half-res plane; each chroma sample = bilinear tap at its 2×2 block
// midpoint. uSel selects Cb (0) or Cr (1).
const FRAG_C = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
uniform float uSel;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float qc(float c) { return clamp(floor(512.0 + c * 896.0 + 0.5), 0.0, 1023.0); }
float chroma(vec2 blockMid) {
  vec3 rgb = texture(uC, blockMid).rgb;
  float y = dot(rgb, KY);
  return uSel < 0.5 ? (rgb.b - y) / 1.8556 : (rgb.r - y) / 1.5748;
}
void main() {
  float cx = (gl_FragCoord.x - 0.5) * 2.0;
  float cy = gl_FragCoord.y - 0.5;
  float c0 = qc(chroma(vec2((2.0 * cx + 1.0) / uOut.x, (2.0 * cy + 1.0) / uOut.y)));
  float c1 = qc(chroma(vec2((2.0 * (cx + 1.0) + 1.0) / uOut.x, (2.0 * cy + 1.0) / uOut.y)));
  o = vec4(mod(c0, 256.0) / 255.0, floor(c0 / 256.0) / 255.0,
           mod(c1, 256.0) / 255.0, floor(c1 / 256.0) / 255.0);
}`;

interface Pass { rt: RenderTexture; mesh: Mesh; w: number; h: number }

export class PackP010 {
  private y: Pass | null = null;
  private u: Pass | null = null;
  private v: Pass | null = null;
  private out: Uint8Array | null = null;
  private flip: Uint8Array | null = null;

  constructor(
    private renderer: Renderer,
    private outW: number,
    private outH: number,
  ) {
    if (outW % 4 !== 0 || outH % 2 !== 0) {
      throw new Error(`10-bit export needs width%4==0 and height%2==0, got ${outW}x${outH}`);
    }
  }

  private buildPass(frag: string, w: number, h: number, sel: number | null, composite: Texture): Pass {
    const rt = RenderTexture.create({ width: w, height: h, format: "rgba8unorm" });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex: VERT, fragment: frag },
      resources: {
        uC: composite.source,
        uCSampler: composite.source.style,
        pack: {
          uOut: { value: new Float32Array([this.outW, this.outH]), type: "vec2<f32>" },
          ...(sel !== null ? { uSel: { value: sel, type: "f32" } } : {}),
        },
      },
    });
    return { rt, mesh: new Mesh({ geometry, shader }), w, h };
  }

  /// Render the three pack passes off `composite` and return one buffer in
  /// yuv420p10le plane order. The returned view is REUSED across calls —
  /// the caller must consume (send) it before the next pack().
  pack(composite: Texture): Uint8Array {
    const W = this.outW, H = this.outH;
    this.y ??= this.buildPass(FRAG_Y, W / 2, H, null, composite);
    this.u ??= this.buildPass(FRAG_C, W / 4, H / 2, 0, composite);
    this.v ??= this.buildPass(FRAG_C, W / 4, H / 2, 1, composite);
    const ySize = W * H * 2;
    const cSize = (W >> 1) * (H >> 1) * 2;
    this.out ??= new Uint8Array(ySize + 2 * cSize);
    for (const [pass, offset] of [
      [this.y, 0], [this.u, ySize], [this.v, ySize + cSize],
    ] as Array<[Pass, number]>) {
      this.renderer.render({ container: pass.mesh, target: pass.rt });
      this.readPlane(pass, this.out.subarray(offset, offset + pass.w * pass.h * 4));
    }
    return this.out;
  }

  private readPlane(pass: Pass, dst: Uint8Array): void {
    // Reach the raw GL context the same way the float16 probes did (P2b):
    // bind the RT's framebuffer, then readPixels.
    const renderer = this.renderer as Renderer & { gl: WebGL2RenderingContext };
    (renderer as unknown as { renderTarget: { bind(t: unknown, clear: boolean): void } })
      .renderTarget.bind(pass.rt, false);
    const gl = renderer.gl;
    const rowBytes = pass.w * 4;
    if (!PACK_ROW_FLIP) {
      gl.readPixels(0, 0, pass.w, pass.h, gl.RGBA, gl.UNSIGNED_BYTE, dst);
      return;
    }
    this.flip ??= new Uint8Array(dst.length);
    const tmp = this.flip.length >= dst.length ? this.flip.subarray(0, dst.length) : (this.flip = new Uint8Array(dst.length));
    gl.readPixels(0, 0, pass.w, pass.h, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
    for (let r = 0; r < pass.h; r++) {
      dst.set(tmp.subarray(r * rowBytes, (r + 1) * rowBytes), (pass.h - 1 - r) * rowBytes);
    }
  }

  dispose(): void {
    for (const p of [this.y, this.u, this.v]) {
      if (p) { p.mesh.destroy(); p.rt.destroy(true); }
    }
    this.y = this.u = this.v = null;
    this.out = null;
    this.flip = null;
  }
}
```

- [ ] **Step 3: GL parity e2e tool**

`apps/desktop/e2e/tools/iso_tenbit_gl_parity.e2e.js` — self-contained like the
float16 probes (inject pixi from node_modules with the same `stashLibSource` /
blob-import helpers — copy them from `float16_probes.e2e.js`). It cannot
import the app's TS modules, so it inlines the SAME shader sources (copy VERT/
FRAG strings — they are the contract under test) and computes expectations
with an inlined JS twin of `yuv10.ts` (small; copy the functions):

Test 1 (ingest parity): build a synthetic 64×64 TenBitFrame-shaped plane set
(Y ramp 64→940 across x, U=512, V=720), upload via the ingest shader path,
read the f16 RT back with `renderer.renderTarget.bind` + `readPixels(RGBA, FLOAT)`,
and for 16 sample points assert |GL − yuv10ToRgb(...)| < 2/876 per channel.

Test 2 (pack parity + orientation): render a known f16 gradient (reuse the
P2b custom-shader mesh verbatim) into a 128×16 rgba16float RT, run the three
pack passes, readPixels, and against the JS reference assert:
- byte-exact match (±1 code on every 10-bit sample — float rounding at quant
  boundaries) for the Y plane on rows 0 and 15,
- **orientation**: the reference's row 0 (top) matches the GL output's row 0
  after the CPU flip. If it matches row 15 instead, flip `PACK_ROW_FLIP` in
  `PackP010.ts` and re-run until this assertion passes (the constant is pinned
  by this test).
- chroma plane spot-checks at 8 sample points (±2 codes — box-average vs
  reference float math).

Run: `node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.mjs --spec ./tools/iso_tenbit_gl_parity.e2e.js`
Expected: both tests PASS (iterate on the flip constant / coefficient typos —
this spec exists precisely to catch them cheaply).

- [ ] **Step 4: Typecheck + commit**

```bash
cd apps/desktop && npm run typecheck
git add apps/desktop/src/render/tenbit/TenBitIngest.ts apps/desktop/src/render/tenbit/PackP010.ts apps/desktop/e2e/tools/iso_tenbit_gl_parity.e2e.js
git commit -m "feat(export10): RG8->f16 ingest + f16->yuv420p10le pack passes, GL-parity gated"
```

---

### Task 6: Route TenBitFrames through the Compositor and sprite

**Files:**
- Modify: `apps/desktop/src/render/sprite/VideoClipSprite.ts`
- Modify: `apps/desktop/src/render/Compositor.ts` (frame-binding site ~line 1478 + dispose; read the surrounding `ensureClip`/dispose code first)

- [ ] **Step 1: `VideoClipSprite.bindExternalTexture`**

```ts
/// 10-bit export lane: bind a converter-owned texture directly (the f16
/// conversion result). Skips the 8-bit canvas snapshot entirely. The texture
/// is owned by TenBitIngest — dispose() must NOT destroy it, so it is never
/// stored in `this.texture`.
bindExternalTexture(texture: Texture): void {
  this.currentFrame = null;
  if (this.sprite.texture !== texture) this.sprite.texture = texture;
}
```

- [ ] **Step 2: Compositor routing**

Imports: `import { TenBitIngest } from "./tenbit/TenBitIngest";` and
`import { isTenBitFrame } from "./decoder/tenBitFrame";`. Add a field
`private tenBitIngest: TenBitIngest | null = null;`. At the binding site
(currently `clip.sprite.updateFrame(frame)` after `frameAt`):

```ts
const frame = clip.source.ring.frameAt(srcTUs);
if (frame) {
  if (isTenBitFrame(frame)) {
    this.tenBitIngest ??= new TenBitIngest(this.app.renderer);
    clip.sprite.bindExternalTexture(this.tenBitIngest.textureFor(clip.layerId, frame));
  } else {
    clip.sprite.updateFrame(frame);
  }
}
```

In the Compositor's dispose path (find where sprites/pool are disposed) add
`this.tenBitIngest?.dispose(); this.tenBitIngest = null;` and where a clip is
torn down (sprite dispose / layer removal) add
`this.tenBitIngest?.release(clip.layerId);`.

- [ ] **Step 3: Typecheck + existing unit tests**

Run: `cd apps/desktop && npm run typecheck && npm run test`
Expected: clean — preview behavior is untouched (TenBitFrames only exist when
the export worker enables the lane).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/render/sprite/VideoClipSprite.ts apps/desktop/src/render/Compositor.ts
git commit -m "feat(export10): bind TenBitFrames via f16 ingest textures in the Compositor"
```

---

### Task 7: Export worker 10-bit branch + sink client

**Files:**
- Create: `apps/desktop/src/render/worker/videoSinkClient.ts`
- Modify: `apps/desktop/src/render/worker/protocol.ts`
- Modify: `apps/desktop/src/render/worker/exportWorker.ts`

- [ ] **Step 1: Protocol additions** (`protocol.ts`, inside the `start` variant)

```ts
/// 10 ⇒ the f16/WebGL2 pipeline: composite into an rgba16float target,
/// pack to yuv420p10le, stream to the Rust video sink. Absent/8 ⇒ the
/// existing WebCodecs pipeline, untouched.
bitDepth?: 8 | 10;
/// Rust sink endpoint (bitDepth 10 only). "ws" carries the loopback
/// WebSocket coordinates; the worker falls back to posting `chunk`
/// events (raw yuv bytes) if the connect fails — the main thread then
/// routes writeChunk to export_video_sink_write.
videoSink?: { port: number; token: string };
/// mediaIds whose ORIGINAL decodes 10-bit in-webview (tenBitExportCapable);
/// these acquire originalAssetUrls + tenBitLane + preferSoftware.
tenBitMedia?: Record<string, boolean>;
```

- [ ] **Step 2: `videoSinkClient.ts`**

```ts
// One-shot loopback WS client for the 10-bit export exit. Frame ordering is
// the socket's; backpressure = bufferedAmount high-water polling (WS has no
// drain event).

const HIGH_WATER = 32 * 1024 * 1024;

export class VideoSinkClient {
  private constructor(private ws: WebSocket) {}

  static connect(port: number, token: string, timeoutMs = 5000): Promise<VideoSinkClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.binaryType = "arraybuffer";
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("video sink WS connect timeout"));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.send(token);
        resolve(new VideoSinkClient(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("video sink WS connect failed"));
      };
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    while (this.ws.bufferedAmount > HIGH_WATER) {
      await new Promise((r) => setTimeout(r, 2));
    }
    this.ws.send(bytes);
  }

  /// Drain, then Normal-close (the sink treats 1000 as EOF → ffmpeg finalize).
  async finish(): Promise<void> {
    while (this.ws.bufferedAmount > 0) {
      await new Promise((r) => setTimeout(r, 2));
    }
    this.ws.close(1000);
  }

  abort(): void {
    try { this.ws.close(4000, "cancelled"); } catch { /* already closed */ }
  }
}
```

- [ ] **Step 3: Worker branch** (`exportWorker.ts`)

Imports: `RenderTexture` from "pixi.js", `PackP010` from "../tenbit/PackP010",
`VideoSinkClient` from "./videoSinkClient".

1. Top of `runExport`:
   ```ts
   const tenBit = req.bitDepth === 10;
   ```
2. `app.init`: `preference: tenBit ? "webgl" : "webgpu"`, and right after:
   ```ts
   if (tenBit && !(app.renderer as { gl?: unknown }).gl) {
     throw new Error("10-bit export needs the WebGL2 renderer; got " + app.renderer.name);
   }
   ```
3. After the encoder-config block (step 4 in the file), make the WebCodecs
   sink conditional and add the 10-bit kit:
   ```ts
   const encoder = tenBit ? null : new EncoderSink({ /* unchanged args */ });
   let compositeRT: RenderTexture | null = null;
   let pack: PackP010 | null = null;
   let sinkClient: VideoSinkClient | null = null;
   if (tenBit) {
     compositeRT = RenderTexture.create({
       width: req.project.width, height: req.project.height, format: "rgba16float",
     });
     pack = new PackP010(app.renderer, outWidth, outHeight);
     if (req.videoSink) {
       try {
         sinkClient = await VideoSinkClient.connect(req.videoSink.port, req.videoSink.token);
       } catch (e) {
         console.warn("[weftcut/export] WS sink connect failed, falling back to IPC:", e);
       }
     }
   }
   ```
   (`scaleCanvas`/`scaleCtx` stay 8-bit-path-only: wrap their creation in
   `!tenBit` — Pack samples the composite at output dims directly.)
4. Handle acquisition (6a): thread the lane through —
   ```ts
   const tenBitSource = tenBit && req.tenBitMedia?.[g.mediaId] === true;
   const handle = exportPool.acquire({
     layerId: g.clips[0]!.layerId,
     mediaId: g.mediaId,
     handleKey: g.key,
     proxyAssetUrl: tenBitSource
       ? req.project.originalAssetUrls[g.mediaId]!
       : proxyUrl,
     sourceColor: req.project.mediaColor[g.mediaId],
     tenBitLane: tenBitSource,
     preferSoftware: tenBitSource,
   });
   ```
5. Per-frame capture/encode (the block from `const capT0` through
   `encoder.encodeFrame(captured, isKey)`): branch —
   ```ts
   if (tenBit) {
     app.renderer.render({ container: app.stage, target: compositeRT! });
     const capT0 = performance.now();
     const bytes = pack!.pack(compositeRT!);
     captureMs += performance.now() - capT0;
     const encT0 = performance.now();
     if (sinkClient) {
       await sinkClient.write(bytes);
     } else {
       // IPC fallback: reuse the chunk/ack backpressure path; the main
       // thread routes these bytes to export_video_sink_write. Copy —
       // postChunk transfers the buffer and pack() reuses its output.
       await postChunk(bytes.slice());
     }
     encodeMs += performance.now() - encT0;
   } else {
     app.render();
     /* existing scaleCanvas + new VideoFrame + encoder.encodeFrame block,
        unchanged */
   }
   ```
   Note `app.render()` moves INTO the 8-bit branch (it renders to the canvas;
   the 10-bit branch renders the stage to the RT instead — keep the
   `compositor.compositeFrame(tUs)` + `setAnchorTime` lines shared above the
   branch).
6. Finish path: where the file flushes the encoder and posts `done` —
   ```ts
   if (tenBit) {
     await sinkClient?.finish();
   } else {
     /* existing encoder flush/finalize, unchanged */
   }
   ```
7. `cleanup(...)`: accept the nullable encoder, and add
   `pack?.dispose(); compositeRT?.destroy(true); sinkClient?.abort();` on the
   cancel path (abort BEFORE destroying GL resources).

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: clean. (The worker has no unit-test harness — it is gated by the
Task 9 e2e.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/worker/protocol.ts apps/desktop/src/render/worker/videoSinkClient.ts apps/desktop/src/render/worker/exportWorker.ts
git commit -m "feat(export10): worker f16/WebGL2 branch — composite RT, pack, WS sink client"
```

---

### Task 8: Settings schema + main-thread glue

**Files:**
- Modify: `apps/desktop/src/render/exportSettings.ts`
- Test: `apps/desktop/src/render/exportSettings.test.ts` (extend)
- Modify: `apps/desktop/src/ipc.ts` (sink command wrappers; read the file's existing invoke-wrapper style first)
- Modify: `apps/desktop/src/render/worker/runExport.ts`
- Modify: `apps/desktop/src/render/PixiPreview.tsx` (`runPixiExport` pass-through — find the existing field list)
- Modify: `apps/desktop/src/App.tsx` (`runExportWithSettings`)
- Modify: `apps/desktop/src/panels/ExportSettingsDialog.tsx`

- [ ] **Step 1: Failing settings tests** (append to `exportSettings.test.ts`)

```ts
describe("bitDepth", () => {
  it("defaults to 8 and survives merge", () => {
    expect(mergeSettings(null).bitDepth).toBe(8);
    expect(mergeSettings({ bitDepth: 10, codec: "hevc" }).bitDepth).toBe(10);
  });
  it("snaps 10-bit H.264 back to 8 (no Hi10P output)", () => {
    expect(mergeSettings({ bitDepth: 10, codec: "h264" }).bitDepth).toBe(8);
  });
  it("detects 10-bit-capable sources (Hi10P only, v1)", () => {
    expect(tenBitExportCapable({ codec: "h264", pix_fmt: "yuv420p10le" })).toBe(true);
    expect(tenBitExportCapable({ codec: "hevc", pix_fmt: "yuv420p10le" })).toBe(false);
    expect(tenBitExportCapable({ codec: "h264", pix_fmt: "yuv420p" })).toBe(false);
    expect(tenBitExportCapable({ codec: null, pix_fmt: null })).toBe(false);
  });
});
```

Run: `cd apps/desktop && npm run test -- src/render/exportSettings.test.ts` → FAIL.

- [ ] **Step 2: Implement in `exportSettings.ts`**

```ts
export type BitDepth = 8 | 10;
// ExportSettings gains:
  /// Output bit depth. 10 runs the f16/WebGL2 + native-encode pipeline
  /// (HEVC Main10 / AV1 10-bit); 8 is the existing pipeline, unchanged.
  /// H.264 output is always 8 (Hi10P output compatibility is poor).
  bitDepth: BitDepth;
// DEFAULT_EXPORT_SETTINGS gains: bitDepth: 8,

export function isBitDepthValid(codec: CodecId, d: BitDepth): boolean {
  return d === 8 || codec !== "h264";
}

/// v1 rule (probe P1): only H.264 Hi10P software-decodes to I420P10 in
/// WebView2. AV1 10-bit is a candidate behind a decode probe; HEVC Main10
/// originals are HW-opaque (no copyTo) until the 10-bit conform lands.
export function tenBitExportCapable(m: {
  codec: string | null;
  pix_fmt: string | null;
}): boolean {
  return m.codec === "h264" && m.pix_fmt === "yuv420p10le";
}
```

In `mergeSettings`, after the audio snap:

```ts
if (!isBitDepthValid(merged.codec, merged.bitDepth)) {
  merged.bitDepth = 8;
}
```

Run the tests again → PASS.

- [ ] **Step 3: ipc wrappers** (`ipc.ts`, matching the file's existing style)

```ts
export interface VideoSinkStartArgs {
  /// "ws" is the only mode App sends; the IPC fallback rides the SAME sink
  /// (the WS thread tolerates a never-connecting client — see Task 3).
  mode: "ws";
  width: number; height: number;
  fpsNum: number; fpsDen: number;
  codec: string; bitrate: number; cbr: boolean; gop: number;
  software: boolean; outputPath: string;
}
export function exportVideoSinkStart(args: VideoSinkStartArgs): Promise<{ port: number; token: string }> {
  return invoke("export_video_sink_start", { args });
}
export function exportVideoSinkFinish(): Promise<{ bytes: number; frames: number; elapsedMs: number }> {
  return invoke("export_video_sink_finish");
}
export function exportVideoSinkCancel(): Promise<void> {
  return invoke("export_video_sink_cancel");
}
export function exportVideoSinkWrite(bytes: Uint8Array): Promise<void> {
  return invoke("export_video_sink_write", bytes);
}
```

- [ ] **Step 4: `runExport.ts` + `PixiPreview.tsx` pass-through**

`RunExportInit` gains `bitDepth?: 8 | 10; videoSink?: { port: number; token: string };`
— and computes `tenBitMedia` itself (it already iterates `mediaById`):

```ts
// in the media loop, collect:
const tenBitMedia: Record<string, boolean> = {};
if (init.bitDepth === 10 && m.kind === "Video" && tenBitExportCapable(m)) {
  tenBitMedia[m.id] = true;
}
// startReq gains:
bitDepth: init.bitDepth ?? 8,
videoSink: init.videoSink,
tenBitMedia,
```

(import `tenBitExportCapable` from "../exportSettings"). `runPixiExport` in
`PixiPreview.tsx` forwards `bitDepth` and `videoSink` exactly like the
existing fields (find its `RunExportInit` construction and add the two).

- [ ] **Step 5: `App.tsx` branch** (inside `runExportWithSettings`, after
`dims`/`outFps` are computed, before `resolveEncodePath`)

```ts
const tenBit = settings.bitDepth === 10 && settings.codec !== "h264";
let videoSink: { port: number; token: string } | undefined;
if (tenBit) {
  videoSink = await exportVideoSinkStart({
    mode: "ws",
    width: dims.width,
    height: dims.height,
    fpsNum,
    fpsDen,
    codec: settings.codec,
    bitrate: computeBitrate(settings, dims.width, dims.height, outFps),
    cbr: settings.rateMode === "cbr",
    gop: gopFrames(settings.keyframeIntervalSec, outFps),
    software: settings.hwAccel === "software",
    outputPath: tempVideoPath,
  });
}
```

- `encodePath`: skip the mezzanine machinery — `const encodePath = tenBit ? "webcodecs" : await resolveEncodePath(...)` (the worker ignores `encoderConfig.codec` in the 10-bit branch; keeping `encodePath = "webcodecs"` keeps `transcode === undefined` at mux time, which is what we want).
- `writeChunk` becomes mode-aware:
  ```ts
  const writeChunk = tenBit
    ? async (data: ArrayBuffer): Promise<void> => {
        await exportVideoSinkWrite(new Uint8Array(data));
      }
    : async (data: ArrayBuffer): Promise<void> => {
        await writeFile(tempVideoPath, new Uint8Array(data), { append: true });
      };
  ```
- Pass `bitDepth: settings.bitDepth, videoSink` into `runPixiExport`.
- After `runPixiExport` resolves (before the audio step):
  ```ts
  if (tenBit) await exportVideoSinkFinish(); // ffmpeg wrote tempVideoPath
  ```
- Error/cancel paths (the `catch` around `runPixiExport` AND the export-cancel
  handler): `if (tenBit) void exportVideoSinkCancel().catch(() => {});`
- The mux call stays exactly `await muxExport(tempVideoPath, tempAudioPath, path, transcode)` with `transcode === undefined` on the 10-bit path (stream-copy into the chosen container + audio).

- [ ] **Step 6: Dialog** (`ExportSettingsDialog.tsx`)

Read the dialog's codec `Select` block and clone its pattern for a Bit depth
select with options `8-bit` / `10-bit (HEVC/AV1)`:
- value `settings.bitDepth`, disabled (locked to 8) when `codec === "h264"`;
- on codec change to h264, snap `bitDepth` to 8 (mirror the existing
  audio-codec/container snap);
- smart default: the dialog receives a new prop `hasTenBitSource: boolean`
  (App computes `[...mediaById.values()].some((m) => m.kind === "Video" && tenBitExportCapable(m))`);
  when the user changes codec to hevc/av1 AND the persisted settings carried
  no explicit `bitDepth` (track with a local `userTouchedBitDepth` ref set by
  the select's onChange) AND `hasTenBitSource`, preset `bitDepth` to 10;
- show a one-line hint under the control when `hasTenBitSource && bitDepth === 8`:
  `"Timeline has 10-bit sources — 10-bit output preserves their precision."`

- [ ] **Step 7: Typecheck + full unit tests + commit**

```bash
cd apps/desktop && npm run typecheck && npm run test
git add apps/desktop/src/render/exportSettings.ts apps/desktop/src/render/exportSettings.test.ts apps/desktop/src/ipc.ts apps/desktop/src/render/worker/runExport.ts apps/desktop/src/render/PixiPreview.tsx apps/desktop/src/App.tsx apps/desktop/src/panels/ExportSettingsDialog.tsx
git commit -m "feat(export10): bitDepth setting, sink wiring, dialog with smart default"
```

---

### Task 9: Fixtures + end-to-end gates

**Files:**
- Modify: `apps/desktop/e2e/fixtures/generate.go` (`--gradient-h264` + `--gradient-h264-bf`)
- Modify: `apps/desktop/e2e/fixtures/generate-fixtures.mjs` (matrix entries + `outputName`)
- Create: `apps/desktop/e2e/specs/export_10bit.e2e.js`

- [ ] **Step 1: Fixture generators** (clone the existing `--gradient` block in `generate.go`)

`--gradient-h264` → `test_1080p_gradient10_h264.mp4`: identical filtergraph,
encoder `libx264 -profile:v high10 -pix_fmt yuv420p10le` (same color tags).
`--gradient-h264-bf` → `test_1080p_gradient10_h264_bf.mp4`: same, 10 s
duration, plus `-x264-params keyint=120:bframes=3` and an animated ramp so
frames differ: `lum='mod((X/(W-1))*1023 + N*4, 1024)'` — the long-GOP +
B-frame + SW-decode combination is the reorder-tail regression shape.
Add both to `generate-fixtures.mjs`'s matrix + `outputName`, and delete the
hand-made `probe_1080p_gradient10_h264.mp4` (same name is now generated).

Run once: `cd apps/desktop/e2e/fixtures && go run generate.go --gradient-h264 && go run generate.go --gradient-h264-bf` (into `media/`), then
`ffprobe -show_entries stream=codec_name,profile,pix_fmt media/test_1080p_gradient10_h264_bf.mp4`
Expected: `h264 / High 10 / yuv420p10le`.

- [ ] **Step 2: The gate spec** (`specs/export_10bit.e2e.js`)

Mirror the structure of an existing export spec (read
`export_eos_tail.e2e.js` for the exportClip + analyzer invocation pattern).
Two tests, both `function () { this.timeout(300000); … }`:

1. **10-bit survives end-to-end**: `__weftcutTest.newProjectAndEnter` +
   `exportClip` of `test_1080p_gradient10_h264.mp4` with
   `settings: { codec: "hevc", bitDepth: 10, container: "mp4", audio: { include: false } }`.
   Then Node-side:
   - `ffprobe` the output: assert `codec_name=hevc`, `pix_fmt` ∈
     {`yuv420p10le`, `p010le`}, `profile=Main 10`, and color tags
     bt709/tv (`-show_entries stream=pix_fmt,profile,color_space,color_transfer,color_primaries,color_range`).
   - run the conformance analyzer's gradient meter the same way the color
     specs do (`media_conformance --gradient-row` via the existing
     `analyze.mjs` invocation pattern): assert **distinct steps > 600**
     (the fixture carries ~877; >256 proves 10-bit, >600 proves it survived
     decode→f16→pack→encode without major collapse).
2. **Reorder-tail regression**: `exportClip` of
   `test_1080p_gradient10_h264_bf.mp4` (same settings, full range). Assert it
   RESOLVES (the deadlock shape = hang → mocha timeout) and ffprobe
   `nb_read_packets` of the output ≈ 300 ± 1
   (`ffprobe -count_packets -show_entries stream=nb_read_packets`).

Check before writing: whether `media_conformance --gradient-row` accepts a
10-bit input (read `tools/media_conformance` usage in the analyzer source);
if it decodes via ffmpeg to RGB internally it does — otherwise extend it to
request `-pix_fmt rgb48le` decode for 10-bit inputs in a preparatory commit.

- [ ] **Step 3: Run the new spec**

`node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.mjs --spec ./specs/export_10bit.e2e.js`
Expected: 2 passing. Debug loop lives here — pack orientation, sink lifecycle,
margin sizing all surface in this spec.

- [ ] **Step 4: Full regression**

Run the WHOLE suite (8-bit path must be untouched):
`node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.mjs`
Expected: all specs green (18 existing + the new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/fixtures/generate.go apps/desktop/e2e/fixtures/generate-fixtures.mjs apps/desktop/e2e/specs/export_10bit.e2e.js
git commit -m "test(export10): 10-bit gradient + B-frame fixtures, end-to-end 10-bit export gates"
```

---

### Task 10: Docs

**Files:**
- Modify: `docs/render.md` (export pipeline section: describe the two encode exits — WebCodecs 8-bit and rawvideo 10-bit — and the TenBitFrame ingest lane; evergreen voice, no dates/phases)
- Modify: `docs/roadmap.md` (re-scope the native-backend item to "native encode exit (shipped for 10-bit) + HDR preview pending Pixi upstream", per the exploration doc's consequence note)
- Modify: `docs/superpowers/specs/2026-06-12-float16-pipeline-exploration.md` (record the Task 1 spike number in the P3 row)

- [ ] **Step 1: Write the doc updates** (match each file's existing tone; `docs/` reads as authored today — no phase numbers, no commit hashes)
- [ ] **Step 2: Commit**

```bash
git add docs/render.md docs/roadmap.md docs/superpowers/specs/2026-06-12-float16-pipeline-exploration.md
git commit -m "docs(export10): dual encode exits + 10-bit ingest lane; roadmap re-scope"
```

---

## Self-review checklist (run after Task 10)

- [ ] Spec coverage: decisions table → Task 8 (trigger/settings), data flow → Tasks 4–7, sink/transport → Tasks 1+3, landmine #1 (reorder) → Task 4 margin + Task 9 gate, validation section → Tasks 2/5/9.
- [ ] 8-bit pipeline untouched: `git diff main -- apps/desktop/src/render/worker/exportWorker.ts` shows the existing path only moved under `else`; full e2e suite green (Task 9 step 4).
- [ ] The spike number is recorded in the exploration doc (Task 1 step 6 + Task 10).
