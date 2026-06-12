// TRANSPORT SPIKE (spec gate): loopback WebSocket throughput webview->Rust.
// Verdict thresholds: >=190 MB/s = realtime-capable; >=60 = offline-OK; below
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
      })().catch(async (e) => { await window.__TAURI__.core.invoke("export_video_sink_cancel").catch(() => {}); done({ fatal: String((e && e.stack) || e) }); });
    });
    console.log("\n[sinkSpike] result:", JSON.stringify(r));
    if (!r.fatal) {
      const v = r.clientMBps >= 190 ? "✅ >=190 MB/s (realtime-capable)"
        : r.clientMBps >= 60 ? "🟡 >=60 MB/s (offline-OK; UI should state reduced speed)"
        : "❌ <60 MB/s -- STOP and re-plan transport";
      console.log(`[sinkSpike] ${r.clientMBps} MB/s -> ${v}`);
      expect(r.stats.bytes).toBe(r.frame * r.n);
      expect(r.stats.frames).toBe(r.n);
    }
    expect(r.fatal).toBeUndefined();
  });
});
