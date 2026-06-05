// The JS injected into the capture iframe as an inline `<script>` body. Plain,
// dependency-free JS in a template string — it runs INSIDE the sandboxed iframe
// (`sandbox="allow-scripts"`, no `allow-same-origin`), alongside the template's
// own inline `render()` script.
//
// Protocol (parent <-> iframe), all via postMessage with targetOrigin "*"
// (the iframe's origin is opaque without `allow-same-origin`, so it can't be
// pinned):
//   iframe -> parent  { type: "ready" }                         once, on load
//   parent -> iframe  { type: "render", id, t, dur, props }     a frame request
//   iframe -> parent  { type: "rendered", id, svg }             success
//   iframe -> parent  { type: "rendered", id, error }           render threw
//
// On a render request the harness awaits `ready()` (if the template defines
// one), calls the template's global `render(t, dur, props)`, forces a reflow,
// then clones the live `<svg>`, strips any `<script>` descendants from the
// clone, and serializes it with `XMLSerializer`. Cloning keeps the live DOM
// intact for the next (possibly earlier-t) render; stripping scripts keeps the
// serialized markup inert when later rasterized via `<img>`.
//
// IMPORTANT (build hazard): this is a single template-literal string. Do NOT
// introduce a backtick or a `${` sequence inside the body — either would close
// or interpolate the literal and break the bundle (see the ENGINE_SOURCE /
// String.raw lesson). Keep it plain ES5-ish JS.
export const HARNESS_FRAME = `
(function () {
  // Stub determinism hazards so two captures at the same t are byte-identical.
  // Wrapped: some of these are read-only in strict mode / certain engines.
  try { Date.now = function () { return 0; }; } catch (e) {}
  try { if (typeof performance !== "undefined") performance.now = function () { return 0; }; } catch (e) {}
  try { window.requestAnimationFrame = function (cb) { return 0; }; } catch (e) {}

  function captureSvg() {
    var svg = document.querySelector("svg");
    if (!svg) throw new Error("harness: no <svg> element found in template");
    var clone = svg.cloneNode(true);
    var scripts = clone.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.parentNode) s.parentNode.removeChild(s);
    }
    return new XMLSerializer().serializeToString(clone);
  }

  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.type !== "render") return;
    var id = data.id;
    Promise.resolve()
      .then(function () {
        return typeof ready === "function" ? ready() : undefined;
      })
      .then(function () {
        if (typeof render !== "function") {
          throw new Error("harness: template defines no global render()");
        }
        render(data.t, data.dur, data.props);
        // Force a synchronous reflow so layout-dependent reads (e.g.
        // getComputedTextLength) reflect the just-applied mutations.
        void document.body.offsetHeight;
        var svg = captureSvg();
        parent.postMessage({ type: "rendered", id: id, svg: svg }, "*");
      })
      .catch(function (e) {
        parent.postMessage({ type: "rendered", id: id, error: String(e) }, "*");
      });
  });

  parent.postMessage({ type: "ready" }, "*");
})();
`;
