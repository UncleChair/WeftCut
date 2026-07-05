// Web Worker — the frame consumer (stands in for the export encoder stage).
//
// Transport arms: receive an NV12 buffer, construct a VideoFrame (this is the one
// unavoidable in-renderer copy — VideoFrame copies the pixel data), close it, ack.
// No createImageBitmap in the throughput loop: that isolates the CHANNEL cost, which
// is the head risk. createImageBitmap's per-frame cost is measured separately (cib probe).

let port = null
let arm = null
let w = 0, h = 0
let ts = 0

function processFrame(u8) {
  try {
    const vf = new VideoFrame(u8, {
      format: 'NV12',
      codedWidth: w,
      codedHeight: h,
      timestamp: ts++,
    })
    vf.close()
  } catch (err) {
    self.postMessage({ type: 'err', message: 'VideoFrame(NV12) failed: ' + err.message })
    return
  }
  if (arm === 'arm0') {
    self.postMessage({ type: 'ack' })
  } else if (arm === 'arm2') {
    // recycle: hand the drained backing store back to main for reuse.
    port.postMessage({ type: 'ack', buf: u8.buffer }, [u8.buffer])
  } else {
    port.postMessage({ type: 'ack' })
  }
}

function onPortMsg(e) {
  const d = e.data
  if (d && d.type === 'frame') processFrame(d.buf)
}

async function runCib(cw, ch, n) {
  try {
    const size = cw * ch + ((cw * ch) >> 1)
    const u8 = new Uint8Array(size)
    u8.fill(128)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      const vf = new VideoFrame(u8, { format: 'NV12', codedWidth: cw, codedHeight: ch, timestamp: i })
      const bmp = await createImageBitmap(vf)
      vf.close()
      bmp.close()
      sum += performance.now() - t0
    }
    self.postMessage({ type: 'cib-result', w: cw, h: ch, avgMs: sum / n })
  } catch (err) {
    self.postMessage({ type: 'cib-result', w: cw, h: ch, avgMs: -1 })
    self.postMessage({ type: 'err', message: 'cib failed: ' + err.message })
  }
}

self.onmessage = (e) => {
  const d = e.data
  if (!d) return
  if (d.type === 'port') {
    port = e.ports[0]
    port.onmessage = onPortMsg
    port.start && port.start()
    self.postMessage({ type: 'port-ok' })
    return
  }
  if (d.type === 'setArm') {
    arm = d.arm; w = d.w; h = d.h; ts = 0
    self.postMessage({ type: 'arm-ready' })
    return
  }
  if (d.type === 'cib') { runCib(d.w, d.h, d.n); return }
  if (d.type === 'frame') { processFrame(d.buf); return } // arm0 relay
}
