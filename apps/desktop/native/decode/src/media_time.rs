const MICROSECONDS_PER_SECOND: i128 = 1_000_000;

/// Convert integer container ticks to integer microseconds using truncation
/// toward zero. This is the native adapter for Mediabunny/WebCodecs'
/// `microsecondTimestamp` contract; origin and sample PTS must both pass
/// through this function before subtraction.
pub(crate) fn ticks_to_us(ticks: i64, time_base: (i32, i32)) -> i64 {
    let (num, den) = (time_base.0 as i128, time_base.1 as i128);
    debug_assert!(num > 0 && den > 0, "invalid media time base {num}/{den}");
    (ticks as i128 * num * MICROSECONDS_PER_SECOND / den) as i64
}

/// Container PTS ticks → source-normalized microseconds.
pub(crate) fn ticks_to_source_us(ticks: i64, time_base: (i32, i32), origin_us: i64) -> i64 {
    ticks_to_us(ticks, time_base) - origin_us
}

/// Source-normalized microseconds → container ticks for an at-or-before seek.
/// Integer division in Rust truncates toward zero, which is AFTER the target
/// for negative values; use mathematical floor so AVSEEK_FLAG_BACKWARD never
/// starts from a tick later than requested.
pub(crate) fn source_us_to_ticks_floor(
    source_us: i64,
    time_base: (i32, i32),
    origin_us: i64,
) -> i64 {
    let (num, den) = (time_base.0 as i128, time_base.1 as i128);
    debug_assert!(num > 0 && den > 0, "invalid media time base {num}/{den}");
    let numerator = (source_us as i128 + origin_us as i128) * den;
    let denominator = num * MICROSECONDS_PER_SECOND;
    div_floor(numerator, denominator) as i64
}

fn div_floor(numerator: i128, denominator: i128) -> i128 {
    debug_assert!(denominator > 0);
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    if remainder < 0 {
        quotient - 1
    } else {
        quotient
    }
}

#[cfg(test)]
mod tests {
    use super::{source_us_to_ticks_floor, ticks_to_source_us, ticks_to_us};

    #[test]
    fn matches_webcodecs_shared_golden_vectors() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/decode-time-golden.json"))
                .expect("decode time fixture must be valid JSON");

        for vector in fixture["vectors"].as_array().expect("vectors array") {
            let name = vector["name"].as_str().expect("vector name");
            let time_base = (
                vector["timeBaseNum"].as_i64().expect("timeBaseNum") as i32,
                vector["timeBaseDen"].as_i64().expect("timeBaseDen") as i32,
            );
            let origin_us = vector["originUs"].as_i64().expect("originUs");

            for sample in vector["samples"].as_array().expect("samples array") {
                let ticks = sample["ticks"].as_i64().expect("ticks");
                let container_us = sample["containerUs"].as_i64().expect("containerUs");
                let source_us = sample["sourceUs"].as_i64().expect("sourceUs");
                assert_eq!(ticks_to_us(ticks, time_base), container_us, "{name}");
                assert_eq!(
                    ticks_to_source_us(ticks, time_base, origin_us),
                    source_us,
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn seek_conversion_floors_negative_container_time() {
        // source 0 maps to -66,666 µs. At time_base 1/30 this is -1.99998
        // ticks, so an at-or-before seek must choose -2, never trunc to -1.
        assert_eq!(source_us_to_ticks_floor(0, (1, 30), -66_666), -2);
    }
}
