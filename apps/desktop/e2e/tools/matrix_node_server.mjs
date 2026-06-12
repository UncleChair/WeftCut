// Diagnostic helper for the transport matrix (see iso_transport_matrix.e2e.js):
// two counting WS servers on fixed ports. Prints one JSON line per closed
// connection; exits once BOTH ports have served at least one connection (so a
// single-port test run must be killed manually / times out after 120s).
// NOTE: Node's `ws` receive path itself tops out around ~190 MB/s for 6 MB
// binary messages — fine as a counting endpoint, do NOT read its number as
// the sender's ceiling (see the matrix header).
import { WebSocketServer } from "ws";

const PORTS = [38881, 38882];
const served = new Set();
let open = 0;

for (const port of PORTS) {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port,
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });
  wss.on("listening", () => console.log(JSON.stringify({ listening: port })));
  wss.on("connection", (sock) => {
    open++;
    let bytes = 0;
    let messages = 0;
    let t0 = null;
    sock.on("message", (data) => {
      if (t0 == null) t0 = performance.now();
      bytes += data.length;
      messages++;
    });
    sock.on("close", () => {
      const ms = t0 == null ? 0 : Math.round(performance.now() - t0);
      console.log(JSON.stringify({ port, bytes, messages, recvMs: ms }));
      served.add(port);
      open--;
      if (served.size === PORTS.length && open === 0) process.exit(0);
    });
  });
}

setTimeout(() => process.exit(1), 120000);
