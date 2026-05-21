//! `fixture_compare` — CLI wrapper around `weftcut_lib::fixtures::check_fixture`.
//!
//! Usage:
//!
//!   fixture_compare --fixture <fixture_root> --mp4 <path/to/rendered.mp4>
//!
//! Reads `<fixture_root>/manifest.json`, extracts a frame from `<mp4>`
//! at each `sample_times_us`, SSIM-compares against
//! `<fixture_root>/expected/t_<us>.png`. Prints a JSON report on
//! stdout and exits non-zero on any compare-side failure (regression,
//! decode error, or — when `--allow-missing-baseline` is not passed —
//! missing baseline).
//!
//! Pair with the vitest browser test (`npm run fixtures:render`) which
//! produces the MP4 in the first place. The two halves stay decoupled
//! so the render side can move to a different driver later without
//! touching this binary.

use std::path::PathBuf;
use std::process::ExitCode;

use weftcut_lib::fixtures::check_fixture;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let invocation = args.first().cloned().unwrap_or_else(|| "fixture_compare".into());

    let mut fixture: Option<String> = None;
    let mut mp4: Option<String> = None;
    let mut allow_missing = false;
    let mut iter = args.iter().skip(1).peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--fixture" => fixture = iter.next().cloned(),
            "--mp4" => mp4 = iter.next().cloned(),
            "--allow-missing-baseline" => allow_missing = true,
            "-h" | "--help" => {
                print_usage(&invocation);
                return ExitCode::from(0);
            }
            other => {
                eprintln!("fixture_compare: unrecognized arg `{other}`");
                print_usage(&invocation);
                return ExitCode::from(2);
            }
        }
    }

    let fixture_root = match fixture {
        Some(s) => PathBuf::from(s),
        None => {
            eprintln!("fixture_compare: --fixture <root> is required");
            print_usage(&invocation);
            return ExitCode::from(2);
        }
    };
    let mp4_path = match mp4 {
        Some(s) => PathBuf::from(s),
        None => {
            eprintln!("fixture_compare: --mp4 <path> is required");
            print_usage(&invocation);
            return ExitCode::from(2);
        }
    };

    let report = match check_fixture(&fixture_root, &mp4_path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("fixture_compare: {e:#}");
            return ExitCode::from(3);
        }
    };

    // Pretty JSON so a CI log is readable + a grep for "pass": false
    // surfaces the regression instantly.
    match serde_json::to_string_pretty(&report) {
        Ok(s) => println!("{s}"),
        Err(e) => eprintln!("fixture_compare: serialize report: {e}"),
    }

    // Exit-code policy:
    //   0 — every sample passed, no missing baselines.
    //   1 — at least one sample failed the SSIM threshold (true regression).
    //   2 — argument / usage error.
    //   3 — fatal infrastructure error (manifest unreadable, ffmpeg missing, …).
    //   4 — missing baseline AND --allow-missing-baseline was not passed.
    //
    // Missing-baseline gets its own code so CI can choose: fail (the
    // default — "you committed a fixture without baselines"); or allow
    // (a deliberate baseline-generation run, gated behind the flag).
    if !report.pass {
        return ExitCode::from(1);
    }
    if report.any_missing_baseline && !allow_missing {
        return ExitCode::from(4);
    }
    ExitCode::from(0)
}

fn print_usage(invocation: &str) {
    eprintln!(
        "Usage: {invocation} --fixture <fixture_root> --mp4 <rendered.mp4> \
         [--allow-missing-baseline]"
    );
}
