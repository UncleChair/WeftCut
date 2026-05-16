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

/// JSON-serializable composition state. The generator builds this from
/// `Project` state; the engine reads it inside the composition.
///
/// Times in **microseconds** to match the Rust side; the engine
/// converts to seconds at the `__setTime` boundary.
export interface CompositionState {
  /// Composition canvas in CSS pixels.
  width: number;
  height: number;
  layers: CompositionLayer[];
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
}

export type CompositionLayerParams =
  | { kind: "Color"; rgba: { r: number; g: number; b: number; a: number }; width: number; height: number }
  | { kind: "Text"; content: string; font_family: string; font_size_px: number; color: { r: number; g: number; b: number; a: number } }
  | { kind: "VideoClip"; media_id: string; src_in_us: number; src_out_us: number }
  | { kind: "ImageOverlay"; media_id: string };

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
    // Transform: translate then scale. Use 2D for simplicity; html-group
    // CSS effects (3D perspective etc.) lives in per-effect catalog and
    // composes on top of this.
    host.style.transform =
      "translate(" + layer.x + "px, " + layer.y + "px) scale(" + layer.scale_x + ", " + layer.scale_y + ")";
    host.style.opacity = String(layer.opacity);
  }

  function applyAll(tSeconds) {
    if (!STATE) return;
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

  // Expose a tiny status surface for the export-side waiter to poll.
  // Mirrors the raster time_mock.js __seek_status shape; the
  // raster-side __seek_dispatch wrapper layers on top of this in H.5.
  window.__weftcutCompositionStatus = function () {
    return { ready: !!window.__weftcutCompositionReady, layers: STATE ? STATE.layers.length : 0 };
  };
})();
`;
