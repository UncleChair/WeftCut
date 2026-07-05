// Electron MAIN — orchestrator for the export-frame-transport spike.
//
// Measures how fast raw NV12 frame buffers can be delivered main -> renderer
// (-> Web Worker) in the faithful export topology, across three transport arms:
//   arm0  classic IPC        (webContents.send / ipcRenderer.on, structured clone)
//   arm1  MessageChannelMain  (port.postMessage, no transfer)
//   arm2  MessageChannelMain + ArrayBuffer transfer + main<->worker buffer recycle
// Plus a separate createImageBitmap per-frame cost probe (the unavoidable in-renderer copy).
//
// Flow control: a credit window (CREDIT) bounds in-flight frames so a 12MB*300
// blast never floods the message queue — this is also the export chunk/chunk-ack
// backpressure pattern in miniature.
//
// Results are written to results.json (the reliable channel — Electron on Windows
// is a GUI-subsystem app and console.log may not reach the parent terminal).

const { app, BrowserWindow, MessageChannelMain, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const RESOS = [
  { name: '1080p', w: 1920, h: 1080 },
  { name: '4k', w: 3840, h: 2160 },
]
const ARMS = ['arm0', 'arm1', 'arm2']
const WARMUP = 30
const COUNT = 300
const CREDIT = 4

const nv12Bytes = (w, h) => w * h + ((w * h) >> 1)

const out = { electron: process.versions.electron, chrome: process.versions.chrome, arms: [], cib: [], errors: [] }
let win = null
let port1 = null

function once(channel) {
  return new Promise((res) => ipcMain.once(channel, (_e, payload) => res(payload)))
}

app.commandLine.appendSwitch('disable-gpu-vsync')

function writeResults() {
  try { fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(out, null, 2)) } catch (e) { /* ignore */ }
}

function progress(stage) { out.progress = stage; writeResults() }

// Global safety net: never hang the session.
const killTimer = setTimeout(() => { out.errors.push('TIMEOUT after 90s at stage=' + out.progress); writeResults(); app.quit() }, 90000)

async function runArm(arm, reso) {
  const armReadyP = once('w-arm-ready')
  win.webContents.send('ctl', { type: 'setArm', arm, w: reso.w, h: reso.h })
  await Promise.race([armReadyP, new Promise((r) => setTimeout(r, 5000))])

  const total = WARMUP + COUNT
  const bytes = nv12Bytes(reso.w, reso.h)
  const pool = [] // recycled ArrayBuffers (arm2)
  let sent = 0, acks = 0, inFlight = 0, tStart = 0
  let transferSupported = true

  return await new Promise((resolve) => {
    const makeU8 = () => new Uint8Array(pool.pop() || new ArrayBuffer(bytes))

    function sendOne() {
      const u8 = makeU8()
      try {
        if (arm === 'arm0') {
          win.webContents.send('arm0-frame', u8)
        } else if (arm === 'arm2' && transferSupported) {
          port1.postMessage({ type: 'frame', buf: u8 }, [u8.buffer])
        } else {
          port1.postMessage({ type: 'frame', buf: u8 })
        }
      } catch (err) {
        if (arm === 'arm2' && transferSupported) {
          transferSupported = false
          out.errors.push(`arm2 ${reso.name}: MessagePortMain ArrayBuffer transfer threw -> ${err.message}; falling back to copy`)
          port1.postMessage({ type: 'frame', buf: u8 })
        } else {
          out.errors.push(`${arm} ${reso.name} send threw: ${err.message}`)
        }
      }
      sent++; inFlight++
    }

    function pump() { while (inFlight < CREDIT && sent < total) sendOne() }

    function onAck(recycledAB) {
      if (arm === 'arm2' && recycledAB) pool.push(recycledAB)
      acks++; inFlight--
      if (acks === WARMUP) tStart = performance.now()
      if (acks === total) {
        const secs = (performance.now() - tStart) / 1000
        cleanup()
        resolve({
          arm, reso: reso.name, bytes,
          fps: +(COUNT / secs).toFixed(1),
          mbps: +((COUNT * bytes) / 1e6 / secs).toFixed(0),
          transferSupported,
        })
        return
      }
      pump()
    }

    let ackHandler
    if (arm === 'arm0') {
      ackHandler = () => onAck(null)
      ipcMain.on('w-ack', ackHandler)
    } else {
      ackHandler = (e) => onAck(arm === 'arm2' ? (e.data && e.data.buf) : null)
      port1.on('message', ackHandler)
    }
    function cleanup() {
      if (arm === 'arm0') ipcMain.off('w-ack', ackHandler)
      else port1.off('message', ackHandler)
    }

    pump()
  })
}

async function runCib(reso) {
  win.webContents.send('ctl', { type: 'cib', w: reso.w, h: reso.h, n: 30 })
  const r = await once('w-cib')
  return r
}

async function main() {
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  })
  win.webContents.setBackgroundThrottling(false)

  // Register the 'ready' listener BEFORE loadFile — the renderer fires it during
  // page load, which can beat a post-load registration (the hang we just saw).
  const readyP = once('ready')
  await win.loadFile(path.join(__dirname, 'index.html'))
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  progress('loaded')
  await Promise.race([readyP, delay(8000)]) // proceed even if the signal was missed
  progress('ready')

  // Set up the dedicated main<->worker MessageChannelMain port.
  const { port1: p1, port2 } = new MessageChannelMain()
  port1 = p1
  port1.start()
  const portOkP = once('w-port-ok')
  win.webContents.postMessage('worker-port', null, [port2])
  await Promise.race([portOkP, delay(8000)])
  progress('port-ok')

  for (const reso of RESOS) {
    for (const arm of ARMS) {
      progress(`${arm}-${reso.name}`)
      try {
        const r = await runArm(arm, reso)
        out.arms.push(r)
        console.log(`${arm} ${reso.name}: ${r.fps} fps  ${r.mbps} MB/s  transfer=${r.transferSupported}`)
      } catch (err) {
        out.errors.push(`${arm} ${reso.name} failed: ${err && err.message}`)
      }
      writeResults()
    }
  }

  for (const reso of RESOS) {
    try {
      const c = await runCib(reso)
      out.cib.push(c)
      console.log(`cib ${reso.name}: ${c.avgMs.toFixed ? c.avgMs.toFixed(2) : c.avgMs} ms/frame`)
    } catch (err) {
      out.errors.push(`cib ${reso.name} failed: ${err && err.message}`)
    }
    writeResults()
  }

  out.done = true
  writeResults()
  console.log('DONE')
  clearTimeout(killTimer)
  app.quit()
}

app.whenReady().then(() =>
  main().catch((err) => {
    out.errors.push('main() threw: ' + (err && err.stack || err))
    writeResults()
    app.quit()
  }),
)

app.on('window-all-closed', () => {}) // keep alive until we quit explicitly
