use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // When the `mpv` feature is on, point the linker at the vendored libmpv
    // import library and stage `libmpv-2.dll` next to the output binary so the
    // dynamic linker finds it at runtime without touching system PATH.
    #[cfg(feature = "mpv")]
    wire_libmpv();
}

#[cfg(feature = "mpv")]
fn wire_libmpv() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest.join("vendor").join("libmpv");

    if !vendor.exists() {
        // Don't fail the build — let the linker's own "cannot open mpv.lib"
        // surface the missing-vendor case with its own clear error. But hint.
        println!(
            "cargo:warning=vendor/libmpv not found at {}; see docs/setup.md \
             to populate it before building with `--features mpv`",
            vendor.display()
        );
        return;
    }

    println!("cargo:rustc-link-search=native={}", vendor.display());
    println!("cargo:rerun-if-changed={}", vendor.join("mpv.lib").display());

    // Copy the runtime DLL to the same directory as the produced binary so
    // `cargo run` / `tauri dev` find it via Windows' DLL search.
    let dll_src = vendor.join("libmpv-2.dll");
    if !dll_src.exists() {
        println!(
            "cargo:warning=libmpv-2.dll missing at {}; runtime will fail",
            dll_src.display()
        );
        return;
    }

    let target_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap())
        .ancestors()
        .nth(3) // OUT_DIR/../../../  → target/<profile>
        .map(PathBuf::from);
    if let Some(dir) = target_dir {
        let dst = dir.join("libmpv-2.dll");
        // Always overwrite so a stale older copy doesn't linger.
        if let Err(e) = std::fs::copy(&dll_src, &dst) {
            println!(
                "cargo:warning=failed to stage libmpv-2.dll → {}: {e}",
                dst.display()
            );
        }
        // Also copy into the deps subdir for tests + examples.
        let deps_dst = dir.join("deps").join("libmpv-2.dll");
        if dir.join("deps").exists() {
            let _ = std::fs::copy(&dll_src, &deps_dst);
        }
    }
    println!("cargo:rerun-if-changed={}", dll_src.display());
}
