// Renderer — thin relay + Web Worker host.
//   - arm0 frames come from main over ipc; relayed into the worker (same-process transfer).
//   - the main<->worker MessageChannelMain port is forwarded straight into the worker.
//   - worker status/acks/results are relayed back to main over ipc.
const { ipcRenderer } = require('electron')

const worker = new Worker('worker.js')

worker.onmessage = (e) => {
  const d = e.data
  switch (d.type) {
    case 'ack': ipcRenderer.send('w-ack'); break // arm0 acks route through the renderer
    case 'arm-ready': ipcRenderer.send('w-arm-ready'); break
    case 'port-ok': ipcRenderer.send('w-port-ok'); break
    case 'cib-result': ipcRenderer.send('w-cib', { w: d.w, h: d.h, avgMs: d.avgMs }); break
    case 'err': ipcRenderer.send('w-err', d.message); break
  }
}

// Forward the dedicated main<->worker port into the worker.
ipcRenderer.on('worker-port', (event) => {
  worker.postMessage({ type: 'port' }, [event.ports[0]])
})

// arm0 data path: main -> renderer (ipc, structured clone) -> worker (transfer, same process).
ipcRenderer.on('arm0-frame', (_e, buf) => {
  // buf arrives as a Uint8Array; transfer its backing store into the worker.
  worker.postMessage({ type: 'frame', buf }, [buf.buffer])
})

// Control messages (setArm / cib).
ipcRenderer.on('ctl', (_e, msg) => worker.postMessage(msg))

ipcRenderer.send('ready')
