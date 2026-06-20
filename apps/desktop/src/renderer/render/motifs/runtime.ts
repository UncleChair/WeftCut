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
 * Browser-injection source. Injected via the hidden host window's
 * `initialization_script` (runs before the Motif's own scripts), sourced from
 * this string handed to Rust at boot via `motif_register_runtime`. Installs
 * the runtime on window, exposes motif.define, and a
 * window.__motifRender(t, props, meta) entry point that Rust drives over CDP
 * Runtime.evaluate(awaitPromise:true).
 *
 * String.raw template — the substitution below (createMotifRuntime.toString)
 * is resolved by TypeScript at module-evaluation time into a plain string.
 * ZERO raw backticks are present inside the body of this literal; the only
 * backtick characters are the outer delimiters. (A stray backtick anywhere
 * inside the body would close the String.raw literal early and break the esbuild parse.)
 */
export const MOTIF_RUNTIME_SOURCE: string = String.raw`
(function () {
  // Capture the NATIVE requestAnimationFrame BEFORE the factory overwrites it.
  // The factory installs a queued rAF (only fires on rt.seek) onto window.rAF.
  // The settle await inside __motifRender uses _nativeRaf so the Promise actually
  // resolves after two real browser layout frames. Using the overwritten queued
  // rAF would deadlock every render because seek() is never called during settle.
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

  // Driven from Rust via CDP Runtime.evaluate(awaitPromise:true).
  // Resolves once setup (once-per-props) + frame(t) + seek + a double-rAF settle
  // have run, i.e. the frame for time t (seconds) is visually ready to capture.
  window.__motifRender = function (t, props, meta) {
    return (async function () {
      if (!def) throw new Error("motif: no motif.define() called");
      var propsKey = JSON.stringify(props);
      if (!didSetup || propsKey !== lastPropsKey) {
        if (def.setup) await def.setup(props, ctxFor(0, props, meta));
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        didSetup = true; lastPropsKey = propsKey;
      }
      if (def.frame) def.frame(t, ctxFor(t, props, meta));
      rt.seek(t * 1000);
      // settleRafs: how many real browser frames to wait so the paint commits.
      // 2 (default) is safe for canvas/WebGL; 1 suffices for CSS-only Motifs;
      // 0 captures immediately after seek(). Clamp to {0,1,2}; default 2.
      var sr = meta && typeof meta.settleRafs === 'number' ? meta.settleRafs : 2;
      sr = sr === 2 ? 2 : (sr === 1 ? 1 : (sr === 0 ? 0 : 2));
      if (sr === 2) {
        await new Promise(function (r) { _nativeRaf(function () { _nativeRaf(r); }); });
      } else if (sr === 1) {
        await new Promise(function (r) { _nativeRaf(r); });
      }
      return true;
    })();
  };
})();
`;
