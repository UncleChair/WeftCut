// TRANSPORT MATRIX (diagnostic): decompose the 10-bit export's loopback-WS
// throughput wall into its two sides. Four measurements, one session:
//
//   T1  webview -> Rust sink (discard)     = the shipping path (baseline)
//   T2  webview -> Node ws server          = independent receiver A
//   T3  webview -> 2x Node servers (par.)  = per-connection vs global cap
//   T4  raw Node client -> Rust sink       = tungstenite receive side only
//
// T4 hand-rolls WS frames over a TCP socket with a ZERO mask key: the client
// pays no masking cost, while tungstenite still runs its full unmask/read
// path, so the number isolates the receiver.
//
// MEASURED 2026-06-13 (RTX-3050 dev box, app built at dev profile opt-level 0,
// 1080p yuv420p10le frames):
//   T1 71 MB/s | T2 189 MB/s | T3 221 MB/s aggregate | T4 107 MB/s
//   + standalone tungstenite bench: opt-0 ~107, opt-1/release ~330-357 MB/s
//   + webview -> release-Rust bench: 312 MB/s
// Verdict: the wall was the RECEIVER at opt-level 0 (fixed by
// `[profile.dev] opt-level = 1` in src-tauri/Cargo.toml — note a per-package
// tungstenite override does NOT work: the read path is generic and
// monomorphizes into the caller's crate at the caller's opt-level).
// CAVEAT for re-runs: T2/T3's ~190 MB/s is Node's `ws` package hitting its
// own parse/unmask ceiling, NOT the Chromium send cap (which is >=312 MB/s
// per the release-bench cross-check). Don't read T2 as the webview's limit.
// T3 ~= T2 also says striping across sockets buys little here.
//
//   node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.mjs --spec ./tools/iso_transport_matrix.e2e.js
import net from "node:net";
import crypto from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";

const FRAME = 1920 * 1080 * 3; // yuv420p10le bytes @1080p
const N = 90; // frames per direction (~560 MB)
const HIGH_WATER = 32 * 1024 * 1024;

const mbps = (bytes, ms) => Math.round(bytes / 1048576 / (ms / 1000));

/// Pump N frames from the webview to ws://127.0.0.1:port. Optional token text
/// first. Resolves { sendMs } measured from first send to bufferedAmount==0.
/// Serialized into the page; keep it dependency-free.
async function webviewPump(ports, token) {
  return browser.executeAsync(
    (ports, token, FRAME, N, HIGH_WATER, done) => {
      (async () => {
        const sockets = await Promise.all(
          ports.map(
            (p) =>
              new Promise((res, rej) => {
                const ws = new WebSocket(`ws://127.0.0.1:${p}`);
                ws.binaryType = "arraybuffer";
                ws.onopen = () => res(ws);
                ws.onerror = () => rej(new Error(`connect ${p} failed`));
              }),
          ),
        );
        if (token) for (const ws of sockets) ws.send(token);
        const payload = new Uint8Array(FRAME);
        for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff;
        const t0 = performance.now();
        await Promise.all(
          sockets.map(async (ws) => {
            for (let i = 0; i < N; i++) {
              while (ws.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 2));
              ws.send(payload);
            }
            while (ws.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 2));
          }),
        );
        const sendMs = performance.now() - t0;
        for (const ws of sockets) ws.close(1000);
        done({ sendMs: Math.round(sendMs) });
      })().catch((e) => done({ fatal: String((e && e.stack) || e) }));
    },
    ports,
    token ?? null,
    FRAME,
    N,
    HIGH_WATER,
  );
}

/// A Node-side ws server that counts received bytes. perMessageDeflate stays
/// off (the product sink never negotiates it either).
function countingServer() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
    });
    const state = { bytes: 0, messages: 0, closed: null };
    state.closed = new Promise((res) => {
      wss.on("connection", (sock) => {
        sock.on("message", (data) => {
          state.bytes += data.length;
          state.messages++;
        });
        sock.on("close", () => res());
      });
    });
    wss.on("listening", () => resolve({ wss, port: wss.address().port, state }));
  });
}

/// WS frame header for a client->server frame with a ZERO mask key (payload
/// passes through unchanged; the receiver still runs its unmask pass).
function frameHeader(opcode, len) {
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, Buffer.alloc(4)]); // 4-byte zero mask key
}

async function rawWrite(sock, buf) {
  if (!sock.write(buf)) await once(sock, "drain");
}

/// Start the Rust sink (discard) via the webview, returning { port, token }.
async function startRustSink() {
  const r = await browser.executeAsync((done) => {
    window.__TAURI__.core
      .invoke("export_video_sink_start", {
        args: {
          mode: "discard", width: 1920, height: 1080,
          fpsNum: 30, fpsDen: 1, codec: "hevc",
          bitrate: 0, cbr: false, gop: 30, software: false, outputPath: "",
        },
      })
      .then((v) => done(v))
      .catch((e) => done({ fatal: String(e) }));
  });
  if (r.fatal) throw new Error(r.fatal);
  return r;
}

async function finishRustSink() {
  const r = await browser.executeAsync((done) => {
    window.__TAURI__.core
      .invoke("export_video_sink_finish")
      .then((v) => done(v))
      .catch((e) => done({ fatal: String(e) }));
  });
  if (r.fatal) throw new Error(r.fatal);
  return r;
}

describe("export transport matrix (diagnostic)", function () {
  it("T1: webview -> Rust sink (shipping path)", async function () {
    this.timeout(120000);
    const { port, token } = await startRustSink();
    const r = await webviewPump([port], token);
    expect(r.fatal).toBeUndefined();
    const stats = await finishRustSink();
    console.log(
      `\n[matrix] T1 webview->Rust: ${mbps(FRAME * N, r.sendMs)} MB/s ` +
        `(send ${r.sendMs}ms; sink saw ${stats.frames} frames / ${stats.bytes} bytes in ${stats.elapsedMs}ms)`,
    );
    expect(stats.bytes).toBe(FRAME * N);
  });

  it("T2: webview -> Node ws server (Chromium send side only)", async function () {
    this.timeout(120000);
    const { wss, port, state } = await countingServer();
    try {
      const r = await webviewPump([port], null);
      expect(r.fatal).toBeUndefined();
      await state.closed;
      console.log(
        `\n[matrix] T2 webview->Node: ${mbps(FRAME * N, r.sendMs)} MB/s ` +
          `(send ${r.sendMs}ms; server saw ${state.messages} msgs / ${state.bytes} bytes)`,
      );
      expect(state.bytes).toBe(FRAME * N);
    } finally {
      wss.close();
    }
  });

  it("T3: webview -> 2x Node servers in parallel (per-connection cap probe)", async function () {
    this.timeout(120000);
    const a = await countingServer();
    const b = await countingServer();
    try {
      const r = await webviewPump([a.port, b.port], null);
      expect(r.fatal).toBeUndefined();
      await Promise.all([a.state.closed, b.state.closed]);
      const total = a.state.bytes + b.state.bytes;
      console.log(
        `\n[matrix] T3 webview->2xNode: aggregate ${mbps(total, r.sendMs)} MB/s ` +
          `(send ${r.sendMs}ms; ${a.state.bytes} + ${b.state.bytes} bytes)`,
      );
      expect(total).toBe(FRAME * N * 2);
    } finally {
      a.wss.close();
      b.wss.close();
    }
  });

  it("T4: raw Node client -> Rust sink (tungstenite receive side only)", async function () {
    this.timeout(120000);
    const { port, token } = await startRustSink();

    const sock = net.connect({ host: "127.0.0.1", port });
    sock.setNoDelay(true);
    await once(sock, "connect");

    // HTTP upgrade handshake.
    const key = crypto.randomBytes(16).toString("base64");
    sock.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    let resp = Buffer.alloc(0);
    while (!resp.includes("\r\n\r\n")) {
      const [chunk] = await once(sock, "data");
      resp = Buffer.concat([resp, chunk]);
    }
    if (!resp.toString("latin1").startsWith("HTTP/1.1 101")) {
      throw new Error(`upgrade failed: ${resp.toString("latin1").split("\r\n")[0]}`);
    }

    // Token (text frame), then N binary frames, then close(1000).
    const tokenBuf = Buffer.from(token, "utf8");
    await rawWrite(sock, Buffer.concat([frameHeader(0x1, tokenBuf.length), tokenBuf]));
    const payload = Buffer.alloc(FRAME);
    for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff;
    const header = frameHeader(0x2, FRAME);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      await rawWrite(sock, header);
      await rawWrite(sock, payload);
    }
    // Flush marker: close frame write callback fires when handed to the OS.
    const closeBody = Buffer.from([0x03, 0xe8]); // 1000
    await new Promise((res, rej) =>
      sock.write(Buffer.concat([frameHeader(0x8, closeBody.length), closeBody]), (e) =>
        e ? rej(e) : res(),
      ),
    );
    const sendMs = performance.now() - t0;
    sock.end();

    const stats = await finishRustSink();
    console.log(
      `\n[matrix] T4 rawNode->Rust: ${mbps(FRAME * N, sendMs)} MB/s client-side ` +
        `(send ${Math.round(sendMs)}ms; sink saw ${stats.frames} frames / ${stats.bytes} bytes in ${stats.elapsedMs}ms, ` +
        `${mbps(stats.bytes, stats.elapsedMs)} MB/s sink-side)`,
    );
    expect(stats.bytes).toBe(FRAME * N);
    expect(stats.frames).toBe(N);
  });
});
