// Suppress the extra console window on Windows in release builds. Keep it in debug
// so `println!` and `tracing` to stderr/stdout are visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    weftcut_lib::run();
}
