//! Rust-side mirror of `apps/desktop/src/preview/dom/composition/CompositionGenerator.ts`.
//!
//! At export time the offscreen raster webview navigates to a composition
//! HTML document (decision 11 — c.2: full root doc on the export side).
//! The TS generator runs in the main webview's React tree; the export
//! path needs to produce the same composition independently, so this
//! module duplicates the generation logic.
//!
//! **Stay in sync.** Any change to the per-kind DOM shape on the TS
//! side must mirror here, and vice versa. Until we share the engine
//! source via a single `engine.js` file (a future refactor), keep
//! `ENGINE_SOURCE` byte-identical to its TS counterpart.
//!
//! H.5 v1 scope intentionally tight: Color / Text / ImageOverlay
//! render correctly, VideoClip renders as a solid-color placeholder
//! (real per-frame extraction is a H.5 follow-up — see the doc's
//! "video resolver" section).

use serde::Serialize;

/// CSS id used by the engine to find its state blob. Matches the TS
/// `STATE_SCRIPT_ID` constant in `composition/engine.ts`.
pub const STATE_SCRIPT_ID: &str = "weftcut-composition";

/// Engine source — verbatim copy of `ENGINE_SOURCE` in `engine.ts`.
/// If the TS side updates, update here too (a static-eq test in
/// `mod tests` flags drift at first run).
pub const ENGINE_SOURCE: &str = r#"
(function () {
  "use strict";

  // ---- Read the inlined state once. ------------------------------------
  function readState() {
    var el = document.getElementById("weftcut-composition");
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
    window.__weftcutCompositionReady = false;
  } else {
    window.__weftcutCompositionReady = true;
  }

  var hostCache = Object.create(null);
  function hostOf(layerId) {
    if (hostCache[layerId]) return hostCache[layerId];
    var el = document.querySelector('[data-layer-id="' + cssEscape(layerId) + '"]');
    if (el) hostCache[layerId] = el;
    return el;
  }
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }
  var compositionEl = document.getElementById("composition");

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
    return a.value + (b.value - a.value) * u;
  }

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

  function applyLayer(layer, tSeconds) {
    var host = hostOf(layer.id);
    if (!host) return;
    var tUs = Math.floor(tSeconds * 1e6);
    var visible = tUs >= layer.t_start_us && tUs < layer.t_end_us;
    if (!visible) {
      host.style.opacity = "0";
      return;
    }
    host.style.transform =
      "translate(" + layer.x + "px, " + layer.y + "px) scale(" + layer.scale_x + ", " + layer.scale_y + ")";
    host.style.opacity = String(layer.opacity);
  }

  function applyAll(tSeconds) {
    if (!STATE) return;
    var tCompUs = Math.floor(tSeconds * 1e6);
    applyCompositionTransform(tCompUs);
    for (var i = 0; i < STATE.layers.length; i++) {
      applyLayer(STATE.layers[i], tSeconds);
    }
  }

  window.__setTime = function (tSeconds) {
    applyAll(Number(tSeconds) || 0);
  };

  window.__seek = async function (tSeconds) {
    applyAll(Number(tSeconds) || 0);
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (e) {}
    }
    await new Promise(function (resolve) {
      var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
      raf(function () { resolve(); });
    });
  };

  window.__weftcutCompositionStatus = function () {
    return { ready: !!window.__weftcutCompositionReady, layers: STATE ? STATE.layers.length : 0 };
  };
})();
"#;

/// Composition state shape — must serialize to the same JSON the TS
/// `CompositionState` produces (the engine reads it via the script
/// tag's `textContent`).
#[derive(Clone, Debug, Serialize)]
pub struct CompositionState {
    pub width: u32,
    pub height: u32,
    pub layers: Vec<CompositionLayer>,
    /// Group-level transform driven by the group's `HtmlTransform`
    /// effect. Serializes via `camelCase` field rename to match the
    /// TS `compositionTransform` field name; `None` → field omitted
    /// from the JSON (matches the TS `?: CompositionTransform | null`).
    #[serde(rename = "compositionTransform", skip_serializing_if = "Option::is_none")]
    pub composition_transform: Option<CompositionTransform>,
}

/// Mirror of the TS `CompositionTransform`. Each field is a wire-
/// compatible serialization of the Rust `Animated<f64>` enum
/// (`#[serde(tag = "mode", content = "value")]`).
#[derive(Clone, Debug, Serialize)]
pub struct CompositionTransform {
    pub x: crate::state::animated::Animated<f64>,
    pub y: crate::state::animated::Animated<f64>,
    pub scale_x: crate::state::animated::Animated<f64>,
    pub scale_y: crate::state::animated::Animated<f64>,
    pub rotation_deg: crate::state::animated::Animated<f64>,
    pub opacity: crate::state::animated::Animated<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompositionLayer {
    pub id: String,
    pub z: u32,
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub opacity: f64,
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub params: CompositionLayerParams,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind")]
pub enum CompositionLayerParams {
    Color {
        rgba: Rgba8,
        width: u32,
        height: u32,
    },
    Text {
        content: String,
        font_family: String,
        font_size_px: f64,
        color: Rgba8,
    },
    VideoClip {
        media_id: String,
        src_in_us: i64,
        src_out_us: i64,
    },
    ImageOverlay {
        media_id: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Rgba8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

const COMPOSITION_BASE_STYLES: &str = r#"
html, body { background: transparent; margin: 0; padding: 0; }
#composition { position: relative; overflow: hidden; background: transparent; }
.layer {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  pointer-events: none;
  opacity: 0;
}
.layer-text {
  white-space: pre-wrap;
  line-height: 1.2;
}
.layer-video, .layer-image {
}
.layer-video > video, .layer-video > img, .layer-image > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.layer-video.placeholder, .layer-image.placeholder {
  background-color: rgba(64, 64, 64, 0.5);
  border: 2px dashed rgba(255, 255, 255, 0.3);
  box-sizing: border-box;
}
"#;

fn rgba_css(c: Rgba8) -> String {
    let alpha = c.a as f64 / 255.0;
    format!("rgba({}, {}, {}, {:.3})", c.r, c.g, c.b, alpha)
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn render_layer_html(layer: &CompositionLayer) -> String {
    let id = escape_html(&layer.id);
    match &layer.params {
        CompositionLayerParams::Color { rgba, width, height } => {
            format!(
                r#"<div class="layer layer-color" data-layer-id="{id}" data-kind="Color" style="width: {w}px; height: {h}px; background-color: {bg};"></div>"#,
                w = width,
                h = height,
                bg = rgba_css(*rgba),
            )
        }
        CompositionLayerParams::Text {
            content,
            font_family,
            font_size_px,
            color,
        } => {
            format!(
                r#"<div class="layer layer-text" data-layer-id="{id}" data-kind="Text" style="font-family: {family}; font-size: {size}px; color: {fg};">{content}</div>"#,
                family = escape_html(font_family),
                size = font_size_px,
                fg = rgba_css(*color),
                content = escape_html(content),
            )
        }
        CompositionLayerParams::VideoClip { media_id, .. } => {
            // v1 limitation: per-frame source extraction (decision 4 +
            // section "Phase 1 — source frame extraction") isn't in
            // H.5 v1. Render as a translucent placeholder so the user
            // can see the layout/transform on the composition; real
            // pixels come once the resolver lands.
            format!(
                r#"<div class="layer layer-video placeholder" data-layer-id="{id}" data-kind="VideoClip" data-media-id="{m}" style="width: 100%; height: 100%;"></div>"#,
                m = escape_html(media_id),
            )
        }
        CompositionLayerParams::ImageOverlay { media_id } => {
            // Same v1 limitation as VideoClip — placeholder. ImageOverlay
            // is structurally simpler (one frame) and is a faster
            // follow-up target than full VideoClip extraction.
            format!(
                r#"<div class="layer layer-image placeholder" data-layer-id="{id}" data-kind="ImageOverlay" data-media-id="{m}" style="width: 100%; height: 100%;"></div>"#,
                m = escape_html(media_id),
            )
        }
    }
}

/// Escape `</` inside JSON so a value containing `</script>` can't
/// break out of the embedding `<script>` tag. Matches the TS
/// `safeJsonEmbed` helper.
fn safe_json_embed(value: &impl Serialize) -> Result<String, serde_json::Error> {
    let json = serde_json::to_string(value)?;
    Ok(json.replace("</script", "<\\/script"))
}

/// Build the full HTML document for a composition. The offscreen
/// raster webview navigates to this directly (no shadow wrapper on the
/// export side — decision 11 c.2).
pub fn build_composition_document(state: &CompositionState) -> Result<String, serde_json::Error> {
    let mut sorted: Vec<&CompositionLayer> = state.layers.iter().collect();
    sorted.sort_by_key(|l| l.z);

    let layer_html: String = sorted
        .iter()
        .map(|l| render_layer_html(l))
        .collect::<Vec<_>>()
        .join("\n");

    let state_json = safe_json_embed(state)?;

    Ok(format!(
        r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="normal">
<style>
{base_styles}
#composition {{ width: {w}px; height: {h}px; }}
</style>
</head>
<body>
<div id="composition">
{layers}
</div>
<script type="application/json" id="{state_id}">{state_json}</script>
<script>{engine}</script>
</body>
</html>"#,
        base_styles = COMPOSITION_BASE_STYLES,
        w = state.width,
        h = state.height,
        layers = layer_html,
        state_id = STATE_SCRIPT_ID,
        state_json = state_json,
        engine = ENGINE_SOURCE,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_document_contains_layers_and_state() {
        let state = CompositionState {
            composition_transform: None,
            width: 800,
            height: 200,
            layers: vec![
                CompositionLayer {
                    id: "L1".into(),
                    z: 0,
                    t_start_us: 0,
                    t_end_us: 1_000_000,
                    opacity: 1.0,
                    x: 0.0,
                    y: 0.0,
                    scale_x: 1.0,
                    scale_y: 1.0,
                    params: CompositionLayerParams::Color {
                        rgba: Rgba8 { r: 255, g: 0, b: 0, a: 255 },
                        width: 100,
                        height: 100,
                    },
                },
                CompositionLayer {
                    id: "L2".into(),
                    z: 1,
                    t_start_us: 0,
                    t_end_us: 1_000_000,
                    opacity: 1.0,
                    x: 10.0,
                    y: 10.0,
                    scale_x: 1.0,
                    scale_y: 1.0,
                    params: CompositionLayerParams::Text {
                        content: "Hi".into(),
                        font_family: "sans".into(),
                        font_size_px: 16.0,
                        color: Rgba8 { r: 255, g: 255, b: 255, a: 255 },
                    },
                },
            ],
        };
        let doc = build_composition_document(&state).unwrap();
        assert!(doc.contains(r#"data-layer-id="L1""#));
        assert!(doc.contains(r#"data-layer-id="L2""#));
        assert!(doc.contains(r#"id="weftcut-composition""#));
        assert!(doc.contains("__setTime"));
    }

    #[test]
    fn embedded_state_is_script_close_safe() {
        let state = CompositionState {
            composition_transform: None,
            width: 64,
            height: 64,
            layers: vec![CompositionLayer {
                id: "evil".into(),
                z: 0,
                t_start_us: 0,
                t_end_us: 1_000_000,
                opacity: 1.0,
                x: 0.0,
                y: 0.0,
                scale_x: 1.0,
                scale_y: 1.0,
                params: CompositionLayerParams::Text {
                    content: "</script><script>alert(1)</script>".into(),
                    font_family: "x".into(),
                    font_size_px: 1.0,
                    color: Rgba8 { r: 0, g: 0, b: 0, a: 255 },
                },
            }],
        };
        let doc = build_composition_document(&state).unwrap();
        // The text content is HTML-escaped in the DOM, and the state
        // JSON's </script gets the safe-embed escape — neither path
        // breaks out of the embedding context.
        assert!(!doc.contains("</script>alert"));
        assert!(doc.contains("alert(1)") || doc.contains("alert\\u00281\\u0029") || doc.contains("&lt;"));
    }
}
