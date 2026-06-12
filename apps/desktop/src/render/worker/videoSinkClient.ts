// One-shot loopback WS client for the 10-bit export exit. Frame ordering is
// the socket's; backpressure = bufferedAmount high-water polling (WS has no
// drain event). Protocol (see src-tauri/src/export/videosink.rs): first
// message = token text, then binary yuv420p10le frames; close(1000) = clean
// EOF (ffmpeg finalizes), any other close = abort (ffmpeg killed).

const HIGH_WATER = 32 * 1024 * 1024;

export class VideoSinkClient {
  private constructor(private ws: WebSocket) {}

  /// Non-null once the socket closes or errors after the connection is open.
  /// Checked at loop-top in write/finish so a dead ffmpeg process is detected
  /// promptly rather than spinning on bufferedAmount forever.
  private dead: string | null = null;

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
        const client = new VideoSinkClient(ws);
        // Post-open handlers: ffmpeg dying drops the TCP stream with no close
        // frame, so the WS transitions CLOSED with a non-1000 code. Install
        // these AFTER resolving so connect-time errors still reject above.
        ws.onclose = (e) => { client.dead ??= `video sink closed (code ${e.code})`; };
        ws.onerror = () => { client.dead ??= "video sink socket error"; };
        resolve(client);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("video sink WS connect failed"));
      };
    });
  }

  /// Send one frame. The buffer is copied by send() synchronously, so the
  /// caller may reuse it immediately after this resolves.
  async write(bytes: Uint8Array): Promise<void> {
    while (this.ws.bufferedAmount > HIGH_WATER) {
      if (this.dead) throw new Error(this.dead);
      await new Promise((r) => setTimeout(r, 2));
    }
    if (this.dead) throw new Error(this.dead);
    this.ws.send(bytes as unknown as Uint8Array<ArrayBuffer>);
  }

  /// Drain, then Normal-close (the sink treats 1000 as EOF → ffmpeg finalize).
  async finish(): Promise<void> {
    while (this.ws.bufferedAmount > 0) {
      if (this.dead) throw new Error(this.dead);
      await new Promise((r) => setTimeout(r, 2));
    }
    this.ws.close(1000);
  }

  abort(): void {
    this.dead ??= "aborted";
    try { this.ws.close(4000, "cancelled"); } catch { /* already closed */ }
  }
}
