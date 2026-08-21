use super::Cue;
use crate::state::animated::Animated;
use crate::state::color::Rgba;
use crate::state::layer::{FontSpec, Outline, Shadow, TextAlign, TextParams, VAlign};
use crate::state::transform::Transform;

pub const DEFAULT_CAPTION_FONT: &str = "Liberation Sans, Noto Sans SC";

/// Per-side safe-area margin, as a fraction of the composition edge: the inset
/// `anchor_for` positions a cue at, and — doubled — the frame width the caption
/// box gives up. One constant for both, because the position margin and the
/// wrap width have to agree and two literals that must agree are how they stop
/// agreeing. Twin in `src/main/state/mutations/captions.ts` — diff both sides
/// when you touch one.
const SAFE_AREA_MARGIN: f64 = 0.08;

/// Lay out one cue as a Text layer. Styleless cues (SRT/VTT) get the default
/// caption look: white fill, black outline + soft shadow, size 5% of comp
/// height, bottom-centre inside `SAFE_AREA_MARGIN`. The ASS 9-grid `align`
/// (or `\pos`) is converted here to an absolute anchor + position — the render
/// model stays plain x/y/anchor (no caption-specific render code).
pub fn cue_to_text_params(cue: &Cue, comp_w: u32, comp_h: u32) -> TextParams {
    let s = &cue.style;
    let size = s.size_px.unwrap_or((comp_h as f32 * 0.05).round());
    let primary = s.primary.unwrap_or(Rgba::WHITE);
    let outline_w = s.outline_px.unwrap_or(size * 0.06).max(1.0);
    let shadow_off = s.shadow_px.unwrap_or(2.0).max(1.0);

    let an = s.align.unwrap_or(2);
    let ((anchor_x, anchor_y), base_x, base_y) = anchor_for(an, comp_w as f64, comp_h as f64);
    let (x, y) = s.pos.unwrap_or((base_x, base_y));

    TextParams {
        content: cue.text.clone(),
        font: FontSpec {
            family: s
                .font_family
                .clone()
                .unwrap_or_else(|| DEFAULT_CAPTION_FONT.to_string()),
            size_px: size,
            weight: if s.bold { 700 } else { 400 },
            italic: s.italic,
        },
        color: Animated::Static(primary),
        align: align_for(an),
        transform: Transform {
            x: Animated::Static(x),
            y: Animated::Static(y),
            anchor_x: Animated::Static(anchor_x),
            anchor_y: Animated::Static(anchor_y),
            ..Default::default()
        },
        opacity: Animated::Static(1.0),
        shadow: Some(Shadow {
            color: Rgba::BLACK,
            offset_x: shadow_off,
            offset_y: shadow_off,
            blur: shadow_off,
        }),
        outline: Some(Outline {
            color: s.outline_color.unwrap_or(Rgba::BLACK),
            width: outline_w,
        }),
        intro: None,
        outro: None,
        // Auto height, never Fixed: it wraps a transcript's unbroken line
        // without shrinking, so every cue keeps the size its style asked for.
        // Fixed would compress the long ones and make two cues of one file
        // render at different sizes. `box_w` is f32, the margin math f64 — cast
        // at the boundary, explicitly. See ADR 0049.
        box_w: Some((comp_w as f64 * (1.0 - 2.0 * SAFE_AREA_MARGIN)) as f32),
        box_h: None,
        // Never observable in Auto height — the box's height tracks the content.
        valign: VAlign::default(),
        line_height: 0.0,
        letter_spacing: 0.0,
    }
}

/// ASS 9-grid → (anchor, x, y). 1-3 bottom, 4-6 middle, 7-9 top; 1/4/7 left,
/// 2/5/8 centre, 3/6/9 right, inset by `SAFE_AREA_MARGIN` on both axes.
fn anchor_for(an: u8, w: f64, h: f64) -> ((f64, f64), f64, f64) {
    let mx = w * SAFE_AREA_MARGIN;
    let my = h * SAFE_AREA_MARGIN;
    let (ax, x) = match an {
        1 | 4 | 7 => (0.0, mx),
        3 | 6 | 9 => (1.0, w - mx),
        _ => (0.5, w / 2.0),
    };
    let (ay, y) = match an {
        7 | 8 | 9 => (0.0, my),
        4 | 5 | 6 => (0.5, h / 2.0),
        _ => (1.0, h - my),
    };
    ((ax, ay), x, y)
}

fn align_for(an: u8) -> TextAlign {
    match an {
        1 | 4 | 7 => TextAlign::Left,
        3 | 6 | 9 => TextAlign::Right,
        _ => TextAlign::Center,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subtitles::{Cue, CueStyle};

    fn cue(style: CueStyle) -> Cue {
        Cue {
            start_us: 0,
            end_us: 1,
            text: "hi".into(),
            style,
        }
    }

    #[test]
    fn styleless_cue_gets_bottom_center_default() {
        let p = cue_to_text_params(&cue(CueStyle::default()), 1920, 1080);
        assert_eq!(p.font.family, "Liberation Sans, Noto Sans SC");
        assert_eq!(p.font.size_px, 54.0); // round(1080 * 0.05)
        assert!(p.outline.is_some());
        assert!(p.shadow.is_some());
        // an2: bottom-center → anchor (0.5, 1.0), x = w/2, y = h - 8%
        assert_eq!(static_anchor(&p.transform), (0.5, 1.0));
        match (&p.transform.x, &p.transform.y) {
            (Animated::Static(x), Animated::Static(y)) => {
                assert_eq!(*x, 960.0);
                assert!((*y - (1080.0 - 1080.0 * 0.08)).abs() < 0.5);
            }
            _ => panic!("static xy expected"),
        }
        // Auto height: a wrap width so an unbroken transcript line stays inside
        // the safe area, and no height so it wraps without ever shrinking.
        let box_w = p.box_w.expect("a cue is born with a wrap width");
        assert!((box_w - 1612.8).abs() < 0.05); // 1920 less the margin per side
        assert!(p.box_h.is_none());
    }

    #[test]
    fn an8_top_center_anchors_top() {
        let mut s = CueStyle::default();
        s.align = Some(8);
        let p = cue_to_text_params(&cue(s), 1920, 1080);
        assert_eq!(static_anchor(&p.transform), (0.5, 0.0));
    }

    /// The box wraps; it never relocates. An ASS cue carrying both `\an` and an
    /// explicit `\pos` keeps its 9-grid alignment and its absolute position, and
    /// gets the same wrap width as a positionless cue.
    #[test]
    fn explicit_pos_and_an_survive_the_box() {
        let s = CueStyle {
            align: Some(1), // bottom-left
            pos: Some((100.0, 200.0)),
            ..CueStyle::default()
        };
        let p = cue_to_text_params(&cue(s), 1920, 1080);
        assert_eq!(static_anchor(&p.transform), (0.0, 1.0));
        match (&p.transform.x, &p.transform.y) {
            (Animated::Static(x), Animated::Static(y)) => assert_eq!((*x, *y), (100.0, 200.0)),
            _ => panic!("static xy expected"),
        }
        assert_eq!(p.align, TextAlign::Left);
        assert!((p.box_w.expect("wrap width") - 1612.8).abs() < 0.05);
        assert!(p.box_h.is_none());
    }

    /// The wrap width tracks the composition, not a hardcoded 1920.
    #[test]
    fn wrap_width_scales_with_the_composition() {
        let p = cue_to_text_params(&cue(CueStyle::default()), 640, 360);
        assert!((p.box_w.expect("wrap width") - 537.6).abs() < 0.05); // 640 * 0.84
    }

    /// The anchor pair as plain numbers. `\an` import always writes Static, so a
    /// Keyframed track here means the layout path grew an animation it shouldn't
    /// have — panic rather than silently reading the first key.
    fn static_anchor(t: &Transform) -> (f64, f64) {
        match (&t.anchor_x, &t.anchor_y) {
            (Animated::Static(x), Animated::Static(y)) => (*x, *y),
            _ => panic!("static anchor expected"),
        }
    }
}
