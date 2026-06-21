use super::Cue;
use crate::state::animated::Animated;
use crate::state::color::Rgba;
use crate::state::layer::{FontSpec, Outline, Shadow, TextAlign, TextBackend, TextParams};
use crate::state::transform::Transform;

pub const DEFAULT_CAPTION_FONT: &str = "Liberation Sans, Noto Sans SC";

/// Lay out one cue as a Text layer. Styleless cues (SRT/VTT) get the default
/// caption look: white fill, black outline + soft shadow, size 5% of comp
/// height, bottom-centre with an 8% safe-area margin. The ASS 9-grid `align`
/// (or `\pos`) is converted here to an absolute anchor + position — the render
/// model stays plain x/y/anchor (no caption-specific render code).
pub fn cue_to_text_params(cue: &Cue, comp_w: u32, comp_h: u32) -> TextParams {
    let s = &cue.style;
    let size = s.size_px.unwrap_or((comp_h as f32 * 0.05).round());
    let primary = s.primary.unwrap_or(Rgba::WHITE);
    let outline_w = s.outline_px.unwrap_or(size * 0.06).max(1.0);
    let shadow_off = s.shadow_px.unwrap_or(2.0).max(1.0);

    let an = s.align.unwrap_or(2);
    let (anchor, base_x, base_y) = anchor_for(an, comp_w as f64, comp_h as f64);
    let (x, y) = s.pos.unwrap_or((base_x, base_y));

    TextParams {
        content: cue.text.clone(),
        font: FontSpec {
            family: s.font_family.clone().unwrap_or_else(|| DEFAULT_CAPTION_FONT.to_string()),
            size_px: size,
            weight: if s.bold { 700 } else { 400 },
            italic: s.italic,
        },
        color: Animated::Static(primary),
        align: align_for(an),
        transform: Transform {
            x: Animated::Static(x),
            y: Animated::Static(y),
            anchor,
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
        backend_hint: TextBackend::DrawText,
    }
}

/// ASS 9-grid → (anchor, x, y). 1-3 bottom, 4-6 middle, 7-9 top; 1/4/7 left,
/// 2/5/8 centre, 3/6/9 right. 8% horizontal + vertical safe-area margins.
fn anchor_for(an: u8, w: f64, h: f64) -> ((f64, f64), f64, f64) {
    let mx = w * 0.08;
    let my = h * 0.08;
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
        Cue { start_us: 0, end_us: 1, text: "hi".into(), style }
    }

    #[test]
    fn styleless_cue_gets_bottom_center_default() {
        let p = cue_to_text_params(&cue(CueStyle::default()), 1920, 1080);
        assert_eq!(p.font.family, "Liberation Sans, Noto Sans SC");
        assert_eq!(p.font.size_px, 54.0); // round(1080 * 0.05)
        assert!(p.outline.is_some());
        assert!(p.shadow.is_some());
        // an2: bottom-center → anchor (0.5, 1.0), x = w/2, y = h - 8%
        assert_eq!(p.transform.anchor, (0.5, 1.0));
        match (&p.transform.x, &p.transform.y) {
            (Animated::Static(x), Animated::Static(y)) => {
                assert_eq!(*x, 960.0);
                assert!((*y - (1080.0 - 1080.0 * 0.08)).abs() < 0.5);
            }
            _ => panic!("static xy expected"),
        }
    }

    #[test]
    fn an8_top_center_anchors_top() {
        let mut s = CueStyle::default();
        s.align = Some(8);
        let p = cue_to_text_params(&cue(s), 1920, 1080);
        assert_eq!(p.transform.anchor, (0.5, 0.0));
    }
}
