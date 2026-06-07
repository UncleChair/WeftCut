/** Testable core: installs clock takeover onto an arbitrary global-like object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMotifRuntime(g: any = {}) {
  let vclock = 0;
  const epoch = 1700000000000;
  let rafQ: Array<(t: number) => void> = [];
  g.performance = { now: () => vclock };
  g.Date = Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function () { return new (Date as any)(epoch + vclock); },
    { now: () => epoch + vclock },
  );
  g.requestAnimationFrame = (cb: (t: number) => void) => { rafQ.push(cb); return rafQ.length; };
  g.cancelAnimationFrame = () => {};
  g.setTimeout = () => 0;
  g.setInterval = () => 0;
  function seek(t: number) {
    vclock = t;
    if (g.document?.getAnimations) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const a of (g.document as any).getAnimations()) {
        a.pause();
        try { a.currentTime = t; } catch { /* read-only animation */ }
      }
    }
    // Flush the queued rAF callbacks up to 4 rounds to handle re-queued cbs.
    for (let i = 0; i < 4; i++) { const q = rafQ; rafQ = []; for (const cb of q) try { cb(vclock); } catch { /* cb threw */ } }
    if (g.document?.body) void (g.document.body as HTMLElement).offsetHeight;
  }
  return { global: g, seek, epoch, get now() { return vclock; } };
}

/**
 * Browser-injection source. Prepended into every Motif document by the motif:
 * scheme handler (a later task). Installs the runtime on window, exposes
 * motif.define, and runs the postMessage seek/settle/ack loop the host drives.
 *
 * String.raw template — the substitution below (createMotifRuntime.toString)
 * is resolved by TypeScript at module-evaluation time into a plain string.
 * ZERO raw backticks are present inside the body of this literal; the only
 * backtick characters are the outer delimiters. (Same build hazard as
 * ENGINE_SOURCE / HARNESS_FRAME — a stray backtick would close the literal early.)
 */
export const MOTIF_RUNTIME_SOURCE: string = String.raw`
(function () {
  // Capture the NATIVE requestAnimationFrame BEFORE the factory overwrites it.
  // The factory installs a queued rAF (only fires on rt.seek) onto window.rAF.
  // The settle await at the bottom of the message handler uses _nativeRaf so the
  // Promise actually resolves after two real browser layout frames. Using the
  // overwritten queued rAF would deadlock every render because seek() is never
  // called during the settle step.
  var _nativeRaf = window.requestAnimationFrame.bind(window);

  var rt = (${createMotifRuntime.toString()})(window);
  var def = null, didSetup = false, lastPropsKey = null;

  function makeRandom(seedKey) {
    // Minimal seeded PRNG stub (Mulberry32). seedKey is a string; hash it to seed.
    var seed = 0;
    for (var i = 0; i < seedKey.length; i++) {
      seed = (seed ^ seedKey.charCodeAt(i)) >>> 0;
      seed = ((seed >>> 16) ^ seed) * 0x45d9f3b >>> 0;
    }
    return function () {
      seed += 0x6d2b79f5;
      var t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  window.motif = {
    define: function (d) { def = d; },
    random: makeRandom,
  };

  function ctxFor(t, props, meta) {
    return {
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      frame: Math.round(t * meta.fps),
      random: makeRandom,
    };
  }

  window.addEventListener("message", async function (e) {
    var msg = e.data || {};
    if (msg.type !== "motif:render") return;
    var meta = msg.meta, props = msg.props, propsKey = JSON.stringify(props);
    try {
      if (!def) throw new Error("motif: no motif.define() called");
      if (!didSetup || propsKey !== lastPropsKey) {
        if (def.setup) await def.setup(props, ctxFor(0, props, meta));
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        didSetup = true; lastPropsKey = propsKey;
      }
      if (def.frame) def.frame(msg.t, ctxFor(msg.t, props, meta));
      rt.seek(msg.t * 1000);
      // Use _nativeRaf (captured above) — NOT window.rAF which is the queued version.
      await new Promise(function (r) { _nativeRaf(function () { _nativeRaf(r); }); });
      parent.postMessage({ type: "motif:ready", id: msg.id }, "*");
    } catch (err) {
      parent.postMessage({ type: "motif:error", id: msg.id, error: String(err) }, "*");
    }
  });

  parent.postMessage({ type: "motif:loaded" }, "*");
})();
`;
