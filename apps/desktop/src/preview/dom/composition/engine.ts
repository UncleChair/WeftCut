/// Composition engine — JavaScript that ships *inside* an html-render
/// group's composition (`docs/html-render-groups.md` decision 11). The
/// generator inlines this source into a `<script>` tag in the composed
/// HTML; the engine then runs in the same document/shadow-root scope
/// as the layer DOM it controls.
///
/// **Contract.**
///
/// At mount time, the host page must place a JSON-encoded
/// `CompositionState` snapshot into a script tag:
///
///   <script type="application/json" id="weftcut-composition">{...}</script>
///
/// The engine parses that on first `__setTime` / `__seek` call and walks
/// `state.layers`, locating each layer's host element by id selector and
/// updating `.style.transform / .style.opacity` per frame.
///
/// **Two entry points** (decision 5 + 11):
///
///   - `__setTime(t_seconds)`     — sync. Preview RAF tick calls this.
///   - `__seek(t_seconds)`        — async. Export raster's
///                                   `__seek_dispatch` calls this; awaits
///                                   `document.fonts.ready` + one rAF
///                                   tick so the captured frame is at-rest.
///
/// Both walk the same per-layer update path; only async-await differs.
///
/// **Why a string export instead of a real module.** Compositions ship as
/// self-contained HTML — the engine has to be inlined as a `<script>`
/// body, not imported. Keeping it as a TS-source string lets the TS
/// compiler still type-check the surrounding generator code while the
/// engine itself is a sandboxed `new Function(...)`-style execution.
///
/// H.3 scope intentionally narrow: time-gating, transform, opacity, +
/// kind-specific style application (background-color for Color layers,
/// text content for Text layers). Effect-catalog integration is a H.3
/// follow-up. Video and Template per-layer state (currentTime nudge,
/// per-instance shadow scripts) is delegated to per-layer handles
/// installed by the host via `videoResolver.ts` and the existing
/// `TemplateHandle`.

/// Wire-compatible mirror of the Rust `Interpolation` enum.
/// `Bezier`'s control points are typed loosely as `[number, number]`
/// pairs to match the Rust tuple-of-tuples serde shape.
export type Interpolation =
  | { kind: "Hold" }
  | { kind: "Linear" }
  | { kind: "EaseIn" }
  | { kind: "EaseOut" }
  | { kind: "Bezier"; p1: [number, number]; p2: [number, number] };

export interface Keyframe<T> {
  id: string;
  t_us: number;
  value: T;
  interp: Interpolation;
}

/// Wire-compatible mirror of the Rust `Animated<T>` enum, serialized
/// with `#[serde(tag = "mode", content = "value")]`. The engine reads
/// this shape and resolves per frame via `resolveAnimated()`.
export type AnimTrack<T> =
  | { mode: "Static"; value: T }
  | { mode: "Keyframed"; value: Keyframe<T>[] };

/// Composition-level transform applied to the `#composition` element
/// before any per-layer transforms. Sourced from the group's
/// `HtmlTransform` effect chain (one HtmlTransform per group in v1;
/// future versions can compose multiple).
///
/// All fields are `AnimTrack<number>` so authoring keyframes is
/// uniform; the engine resolves each at every tick. Defaults when an
/// `HtmlTransform` is missing or omits a field: identity values
/// (x/y/rotation=0; scale/opacity=1).
export interface CompositionTransform {
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scale_x: AnimTrack<number>;
  scale_y: AnimTrack<number>;
  rotation_deg: AnimTrack<number>;
  opacity: AnimTrack<number>;
}

/// CSS filter chain applied to a composition or per-layer host. v1
/// carries `blur` only — radius in CSS pixels, animated like every
/// other track. `null` / missing → no filter is written (the engine
/// clears `style.filter` so a previous frame's value doesn't stick).
///
/// Future filter axes (brightness/contrast/saturate/hue-rotate) slot in
/// here as additional optional fields; the engine composes them into
/// one `filter:` string per frame so the CSS cascade sees a single
/// value, not multiple competing rules.
export interface CompositionFilter {
  /// Blur radius in CSS pixels. Default 0 = no blur (CSS spec: 0
  /// renders identity). Mirrors `EffectParams::Blur { radius }`.
  blur_px: AnimTrack<number>;
}

/// JSON-serializable composition state. The generator builds this from
/// `Project` state; the engine reads it inside the composition.
///
/// Times in **microseconds** to match the Rust side; the engine
/// converts to seconds at the `__setTime` boundary.
export interface CompositionState {
  /// Composition canvas in CSS pixels.
  width: number;
  height: number;
  /// Project canvas fps. Engine uses this to compute the current
  /// frame index for export-path VideoClip `<img>` swaps. Preview
  /// path may omit; engine falls back to 30/1.
  fpsNum?: number;
  fpsDen?: number;
  layers: CompositionLayer[];
  /// Group-level transform driven by the group's `HtmlTransform`
  /// effect. Null/absent when the group has no `HtmlTransform`.
  compositionTransform?: CompositionTransform | null;
  /// Group-level CSS filter chain (currently: blur). Null/absent when
  /// the group has no filter-producing effects.
  compositionFilter?: CompositionFilter | null;
}

/// Shared layer fields used by every kind. Per-kind specifics live in
/// the discriminated `params` union.
export interface CompositionLayer {
  id: string;
  /// Z-index inside the composition. Higher renders on top. Computed
  /// from track index at generation time (decision 10: in-place
  /// flatten, paint order = track order).
  z: number;
  t_start_us: number;
  t_end_us: number;
  /// 0..1, after evaluating any `Animated<f64>` to its static value.
  /// H.3 uses static-only; keyframes arrive with the effect-catalog
  /// follow-up.
  opacity: number;
  /// Position + scale (transform: translate scale). Static for now.
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  params: CompositionLayerParams;
  /// Per-layer effect transform driven by the layer's `HtmlTransform`
  /// effect (if any). Null/absent when the layer has no
  /// `HtmlTransform`. Keyframes here are **layer-local** time —
  /// t_us=0 is the layer's t_start; the engine handles the
  /// composition→layer time shift.
  effectTransform?: CompositionTransform | null;
  /// Per-layer CSS filter chain (currently: blur from `EffectParams::
  /// Blur`). Keyframes are layer-local time, same convention as
  /// `effectTransform`. Null/absent when the layer has no filter-
  /// producing effects.
  effectFilter?: CompositionFilter | null;
}

export type CompositionLayerParams =
  | { kind: "Color"; rgba: { r: number; g: number; b: number; a: number }; width: number; height: number }
  | { kind: "Text"; content: string; font_family: string; font_size_px: number; color: { r: number; g: number; b: number; a: number } }
  | {
      kind: "VideoClip";
      media_id: string;
      src_in_us: number;
      src_out_us: number;
      /// Slot pixel dimensions on the composition canvas (defaults to
      /// media native dims, falls back to canvas dims when media meta
      /// is missing). The layer's transform.scale_x/y still applies
      /// on top.
      width: number;
      height: number;
      /// Export-path: pattern of pre-extracted frames relative to
      /// the composition's directory, e.g. "source/<lid>/frame_%05d.png".
      /// Absent on the preview path (resolver drives `<video>` instead).
      framePattern?: string;
      frameCount?: number;
    }
  | {
      kind: "ImageOverlay";
      media_id: string;
      width: number;
      height: number;
      /// Export-path: image source path relative to the composition's
      /// directory. Absent on the preview path.
      imageSrc?: string;
    }
  | {
      kind: "Template";
      template_id: string;
      /// Combined CSS body from every `<style>` block in the (composed)
      /// template HTML. Set on the per-template shadow root as a
      /// `<style>` sibling of the body, after a `:host {...}` size
      /// block that pins the host dimensions.
      style: string;
      /// Combined JS body from every `<script>` block. Run via
      /// `new Function` with per-instance shadowed globals so two
      /// templates with overlapping ids don't collide.
      scripts: string;
      /// Template body markup with `<script>` and `<style>` elements
      /// stripped (innerHTML doesn't execute scripts but they clutter
      /// the shadow and confuse `querySelector` walks).
      body: string;
      /// Per-instance props injected as `window.__props__` before
      /// scripts run. Templates poll for it in their `start()` loop.
      props: Record<string, unknown>;
      width: number;
      height: number;
    };

/// CSS id used by the engine to find its state blob.
export const STATE_SCRIPT_ID = "weftcut-composition";

/// The engine source. Inlined verbatim into a `<script>` tag at the end
/// of the composition body. **Keep this self-contained** — no module
/// imports, no closures over outer state at generation time.
///
/// Authoring note: the engine runs as a top-level script, so it shares
/// the document's global scope with the layer DOM. We attach the
/// public API to `window.__setTime` / `window.__seek` so the host
/// (preview RAF loop or export raster shim) can drive it through
/// `eval_async("window.__seek(t)")`.
export const ENGINE_SOURCE: string = String.raw`
(function () {
  "use strict";

  // ---- Read the inlined state once. ------------------------------------
  function readState() {
    var el = document.getElementById(${JSON.stringify(STATE_SCRIPT_ID)});
    if (!el) {
      console.error("weftcut composition: state script tag not found");
      return null;
    }
    try {
      return JSON.parse(el.textContent || "{}");
    } catch (e) {
      console.error("weftcut composition: state JSON parse failed", e);
      return null;
    }
  }

  var STATE = readState();
  if (!STATE || !Array.isArray(STATE.layers)) {
    // Defensive: render nothing rather than throw and break the host's
    // wait_seek poll loop on the export side.
    window.__weftcutCompositionReady = false;
  } else {
    window.__weftcutCompositionReady = true;
  }

  // ---- Per-layer DOM lookup, cached after first hit. -------------------
  var hostCache = Object.create(null);
  function hostOf(layerId) {
    if (hostCache[layerId]) return hostCache[layerId];
    var el = document.querySelector('[data-layer-id="' + cssEscape(layerId) + '"]');
    if (el) hostCache[layerId] = el;
    return el;
  }
  // Minimal css-attribute escape for our id format (UUIDs — alphanumeric + dash).
  // Avoids pulling CSS.escape (not in WebView2 older versions) for this narrow case.
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }
  var compositionEl = document.getElementById("composition");

  // ---- Template mount ----------------------------------------------------
  // Each Template member is rendered as an empty data-kind=Template
  // placeholder host by the generator. The engine walks them once at
  // startup, attachShadows each, and runs the template's scripts inside
  // a new Function with per-instance shadowed globals (document =
  // template shadow root, window proxy carrying __props__, synthetic
  // performance/Date driven by the engine's clock, per-instance rAF
  // queue). Mirrors TemplateHandle.instantiateTemplate so preview and
  // export render the same template output.
  //
  // Runtimes are stored in templateRuntimes keyed by layer id; the
  // per-layer driver in applyLayer looks up the runtime and calls
  // setTime(tLayerSec) after writing transform/opacity to the host.
  var templateRuntimes = Object.create(null);

  function instantiateCompositionTemplate(hostDiv, style, scripts, body, props, w, h) {
    if (hostDiv.shadowRoot) return null; // idempotent — already mounted
    var shadow = hostDiv.attachShadow({ mode: "open" });
    var hostStyle =
      "<style>:host { display: block; position: relative; width: " +
      (w | 0) + "px; height: " + (h | 0) +
      "px; overflow: hidden; }</style>";
    shadow.innerHTML = hostStyle + "<style>" + (style || "") + "</style>" + (body || "");

    var clock = { t: 0 };
    var rafQueue = Object.create(null);
    var rafSeq = 0;

    var winState = { __props__: props || {} };
    var winProxy = new Proxy(winState, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        return window[prop];
      },
      set: function (target, prop, value) {
        target[prop] = value;
        return true;
      },
      has: function (target, prop) {
        return prop in target || prop in window;
      }
    });

    var perfProxy = { now: function () { return clock.t * 1000; } };
    // Date proxy: instances delegate to real Date; static .now reflects
    // the synthetic clock. Templates rely on the static call site
    // Date.now() so the delegating constructor is defensive only.
    var DateCtor = window.Date;
    function DateShim() {
      if (arguments.length === 0) return new DateCtor();
      if (arguments.length === 1) return new DateCtor(arguments[0]);
      return new DateCtor(
        arguments[0], arguments[1], arguments[2],
        arguments[3], arguments[4], arguments[5], arguments[6]
      );
    }
    DateShim.now = function () { return clock.t * 1000; };

    var rafFn = function (cb) {
      var id = ++rafSeq;
      rafQueue[id] = cb;
      return id;
    };
    var cancelRafFn = function (id) {
      delete rafQueue[id];
    };

    try {
      var fn = new Function(
        "document",
        "window",
        "performance",
        "Date",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        scripts || ""
      );
      fn(shadow, winProxy, perfProxy, DateShim, rafFn, cancelRafFn);
    } catch (e) {
      console.warn("composition: template script execution failed", e);
    }

    return {
      setTime: function (seconds) {
        clock.t = Number(seconds) || 0;
        var keys = Object.keys(rafQueue);
        var pending = [];
        for (var i = 0; i < keys.length; i++) pending.push(rafQueue[keys[i]]);
        rafQueue = Object.create(null);
        var tMs = clock.t * 1000;
        for (var j = 0; j < pending.length; j++) {
          try { pending[j](tMs); }
          catch (e) { console.error("composition: template rAF cb threw", e); }
        }
      }
    };
  }

  function mountCompositionTemplates() {
    if (!STATE || !Array.isArray(STATE.layers)) return;
    for (var i = 0; i < STATE.layers.length; i++) {
      var layer = STATE.layers[i];
      if (!layer || !layer.params || layer.params.kind !== "Template") continue;
      var host = hostOf(layer.id);
      if (!host) continue;
      try {
        var rt = instantiateCompositionTemplate(
          host,
          layer.params.style,
          layer.params.scripts,
          layer.params.body,
          layer.params.props,
          layer.params.width | 0,
          layer.params.height | 0
        );
        if (rt) templateRuntimes[layer.id] = rt;
      } catch (e) {
        console.error("composition: instantiateCompositionTemplate threw for", layer.id, e);
      }
    }
  }

  mountCompositionTemplates();

  // ---- AnimTrack resolution. -------------------------------------------
  // Wire shape mirrors the Rust Animated<T> enum (serde tag "mode",
  // content "value"). Static: { mode, value }. Keyframed: { mode,
  // value: [{ id, t_us, value, interp: { kind, ... } }, ...] }.
  // Owner-local time on keyframes; for the composition transform
  // that's also composition-local, so the resolver compares directly
  // against tCompUs.
  function resolveAnimated(track, tCompUs, defaultValue) {
    if (!track) return defaultValue;
    if (track.mode === "Static") return track.value;
    var kfs = track.value;
    if (!kfs || kfs.length === 0) return defaultValue;
    if (kfs.length === 1) return kfs[0].value;
    if (tCompUs <= kfs[0].t_us) return kfs[0].value;
    if (tCompUs >= kfs[kfs.length - 1].t_us) return kfs[kfs.length - 1].value;
    var i = 0;
    while (i < kfs.length - 1 && kfs[i + 1].t_us <= tCompUs) i++;
    var a = kfs[i];
    var b = kfs[i + 1];
    var span = b.t_us - a.t_us;
    if (span <= 0) return b.value;
    var u = (tCompUs - a.t_us) / span;
    var interp = a.interp && a.interp.kind;
    if (interp === "Hold") return a.value;
    if (interp === "EaseIn") u = u * u;
    else if (interp === "EaseOut") { var iu = 1 - u; u = 1 - iu * iu; }
    // Bezier: skip cubic for v1; treat as linear. Editor can land
    // the cubic-bezier solver later — most authoring needs Linear /
    // EaseIn / EaseOut anyway.
    return a.value + (b.value - a.value) * u;
  }

  // ---- Composition-level transform application. ------------------------
  function applyCompositionTransform(tCompUs) {
    if (!compositionEl) return;
    var ct = STATE && STATE.compositionTransform;
    if (!ct) {
      compositionEl.style.transform = "";
      compositionEl.style.opacity = "";
      return;
    }
    var x   = resolveAnimated(ct.x,            tCompUs, 0);
    var y   = resolveAnimated(ct.y,            tCompUs, 0);
    var sx  = resolveAnimated(ct.scale_x,      tCompUs, 1);
    var sy  = resolveAnimated(ct.scale_y,      tCompUs, 1);
    var rot = resolveAnimated(ct.rotation_deg, tCompUs, 0);
    var op  = resolveAnimated(ct.opacity,      tCompUs, 1);
    compositionEl.style.transform =
      "translate(" + x + "px, " + y + "px) rotate(" + rot + "deg) scale(" + sx + ", " + sy + ")";
    compositionEl.style.transformOrigin = "center center";
    compositionEl.style.opacity = String(op);
  }

  // ---- Composition-level CSS filter (blur for v1). --------------------
  // Clearing to "" (not "blur(0px)") matters: a non-empty filter creates
  // a containing block that re-parents fixed/abs descendants and can
  // change paint order. The neutral state must leave the cascade
  // unchanged.
  function applyCompositionFilter(tCompUs) {
    if (!compositionEl) return;
    var cf = STATE && STATE.compositionFilter;
    if (!cf) {
      compositionEl.style.filter = "";
      return;
    }
    var blur = resolveAnimated(cf.blur_px, tCompUs, 0);
    compositionEl.style.filter = blur > 0 ? "blur(" + blur + "px)" : "";
  }

  // ---- Per-frame writer. -----------------------------------------------
  function applyLayer(layer, tSeconds) {
    var host = hostOf(layer.id);
    if (!host) return;
    var tUs = Math.floor(tSeconds * 1e6);
    // Time-gate via display so layout doesn't reflow per frame —
    // ungated layers stay laid out and only opacity/transform change.
    var visible = tUs >= layer.t_start_us && tUs < layer.t_end_us;
    if (!visible) {
      // Hidden via opacity=0 keeps the element laid out (avoids the
      // first-show paint cost). For long timelines this might want
      // display:none; revisit if a profile shows it.
      host.style.opacity = "0";
      return;
    }
    // Per-layer effect transform composes with the static layer
    // transform: positions add, scales multiply, opacity multiplies,
    // rotation is effect-only (no static layer rotation today).
    // Layer-local time: keyframes on layer.effectTransform are
    // anchored at layer.t_start_us.
    var tLayerUs = tUs - layer.t_start_us;
    var tx = layer.x, ty = layer.y;
    var sx = layer.scale_x, sy = layer.scale_y;
    var rot = 0;
    var op = layer.opacity;
    var et = layer.effectTransform;
    if (et) {
      tx  += resolveAnimated(et.x,            tLayerUs, 0);
      ty  += resolveAnimated(et.y,            tLayerUs, 0);
      sx  *= resolveAnimated(et.scale_x,      tLayerUs, 1);
      sy  *= resolveAnimated(et.scale_y,      tLayerUs, 1);
      rot  = resolveAnimated(et.rotation_deg, tLayerUs, 0);
      op  *= resolveAnimated(et.opacity,      tLayerUs, 1);
    }
    host.style.transform =
      "translate(" + tx + "px, " + ty + "px) rotate(" + rot + "deg) scale(" + sx + ", " + sy + ")";
    host.style.opacity = String(op);

    // Per-layer CSS filter (blur for v1). Layer-local time matches
    // effectTransform; same clear-to-"" discipline as the composition
    // filter avoids creating a stray containing block at blur=0.
    var filterStr = "";
    var ef = layer.effectFilter;
    if (ef) {
      var blurLayer = resolveAnimated(ef.blur_px, tLayerUs, 0);
      if (blurLayer > 0) filterStr = "blur(" + blurLayer + "px)";
    }
    host.style.filter = filterStr;

    // Export path: VideoClip with a pre-extracted frame pattern.
    // Swap the slot's <img>.src to the right per-tick frame. Preview
    // path leaves framePattern undefined and the host's
    // PreviewVideoResolver drives a <video> instead — this branch
    // is a no-op there.
    if (layer.params && layer.params.kind === "VideoClip" && layer.params.framePattern) {
      var img = host.firstElementChild;
      if (img && img.tagName === "IMG") {
        var fpsNum = (STATE && STATE.fpsNum) || 30;
        var fpsDen = (STATE && STATE.fpsDen) || 1;
        var idx = Math.floor(tLayerUs * fpsNum / (1e6 * fpsDen));
        var maxIdx = (layer.params.frameCount || 1) - 1;
        if (idx < 0) idx = 0;
        if (idx > maxIdx) idx = maxIdx;
        var padded = String(idx);
        while (padded.length < 5) padded = "0" + padded;
        var newSrc = layer.params.framePattern.replace("%05d", padded);
        if (img.getAttribute("src") !== newSrc) img.setAttribute("src", newSrc);
      }
    }

    // Template layers: advance the per-instance runtime to the
    // layer-local time so its rAF-driven animations re-render. The
    // engine already gated visibility via opacity above; the runtime
    // just needs the matching local clock.
    if (layer.params && layer.params.kind === "Template") {
      var rt = templateRuntimes[layer.id];
      if (rt) {
        try { rt.setTime(tLayerUs / 1e6); }
        catch (e) { console.error("composition: template setTime threw", e); }
      }
    }
  }

  function applyAll(tSeconds) {
    if (!STATE) return;
    var tCompUs = Math.floor(tSeconds * 1e6);
    applyCompositionTransform(tCompUs);
    applyCompositionFilter(tCompUs);
    for (var i = 0; i < STATE.layers.length; i++) {
      applyLayer(STATE.layers[i], tSeconds);
    }
  }

  // ---- Public API ------------------------------------------------------
  /// Synchronous tick — preview's RAF loop calls this every frame.
  window.__setTime = function (tSeconds) {
    applyAll(Number(tSeconds) || 0);
  };

  /// Async wait-for-stable — export raster calls this and polls
  /// __seek_status (or just awaits the returned promise) until the
  /// captured frame is at rest. Mirrors the offscreen-raster
  /// time_mock.js shim's __seek contract.
  window.__seek = async function (tSeconds) {
    applyAll(Number(tSeconds) || 0);
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (e) {
        /* font promises sometimes reject on stale references; tolerate */
      }
    }
    await new Promise(function (resolve) {
      var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
      raf(function () { resolve(); });
    });
  };

  // Export-side hook: the offscreen raster's time-mock shim
  // (raster/time_mock.js) calls __seek_dispatch(t) → __seek_impl(t)
  // → __onSeek(t) if defined. Without registering this, the shim's
  // seek path runs through fonts.ready + rAF flush but never reaches
  // our applyAll — every captured frame ends up at the layer CSS
  // default opacity 0 and the export looks all-black.
  window.__onSeek = function (tSeconds) {
    applyAll(Number(tSeconds) || 0);
  };

  // Expose a tiny status surface for the export-side waiter to poll.
  // Mirrors the raster time_mock.js __seek_status shape; the
  // raster-side __seek_dispatch wrapper layers on top of this in H.5.
  window.__weftcutCompositionStatus = function () {
    return { ready: !!window.__weftcutCompositionReady, layers: STATE ? STATE.layers.length : 0 };
  };
})();
`;
