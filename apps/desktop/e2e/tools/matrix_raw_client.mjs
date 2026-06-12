// Diagnostic helper for the transport matrix (see iso_transport_matrix.e2e.js):
// raw WS client over a TCP socket with a ZERO mask key — the client pays no
// masking cost, the receiving server still runs its full unmask/read path.
// Usage: node matrix_raw_client.mjs <port> <token>
import net from "node:net";
import crypto from "node:crypto";
import { once } from "node:events";

const [port, token] = [Number(process.argv[2]), process.argv[3]];
const FRAME = 1920 * 1080 * 3;
const N = 90;

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
  return Buffer.concat([head, Buffer.alloc(4)]); // zero mask key
}

const sock = net.connect({ host: "127.0.0.1", port });
sock.setNoDelay(true);
await once(sock, "connect");

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
  console.log(JSON.stringify({ error: resp.toString("latin1").split("\r\n")[0] }));
  process.exit(1);
}

async function rawWrite(buf) {
  if (!sock.write(buf)) await once(sock, "drain");
}

const tokenBuf = Buffer.from(token, "utf8");
await rawWrite(Buffer.concat([frameHeader(0x1, tokenBuf.length), tokenBuf]));
const payload = Buffer.alloc(FRAME);
for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff;
const header = frameHeader(0x2, FRAME);
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  await rawWrite(header);
  await rawWrite(payload);
}
const closeBody = Buffer.from([0x03, 0xe8]); // 1000
await new Promise((res, rej) =>
  sock.write(Buffer.concat([frameHeader(0x8, closeBody.length), closeBody]), (e) =>
    e ? rej(e) : res(),
  ),
);
const sendMs = performance.now() - t0;
sock.end();
console.log(
  JSON.stringify({
    sendMs: Math.round(sendMs),
    clientMBps: Math.round((FRAME * N) / 1048576 / (sendMs / 1000)),
  }),
);
