#!/usr/bin/env bash
# One-shot dev environment initializer for macOS / Linux.
#
# - Verifies Node + Rust toolchain.
# - Generates a placeholder app icon at apps/desktop/src-tauri/icons/icon.png.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
echo "Videtor dev init — root: $root"

check_cmd() {
    local name="$1"
    local hint="$2"
    if command -v "$name" >/dev/null 2>&1; then
        printf '  %-8s %s\n' "$name" "$(command -v "$name")"
    else
        echo "  warn: $name not found. $hint"
        missing=1
    fi
}

missing=0
echo
echo "Toolchain:"
check_cmd node   "Install Node 20+: https://nodejs.org"
check_cmd npm    "Comes with Node."
check_cmd cargo  "Install Rust: https://rustup.rs"
check_cmd rustup "Install Rust: https://rustup.rs"

[ "$missing" = 1 ] && echo "Some tools are missing. See docs/setup.md."

icon_dir="$root/apps/desktop/src-tauri/icons"
icon_path="$icon_dir/icon.png"
mkdir -p "$icon_dir"

if [ -f "$icon_path" ]; then
    echo
    echo "Icon already present: $icon_path"
else
    echo
    echo "Generating placeholder icon at $icon_path ..."
    if command -v magick >/dev/null 2>&1; then
        magick -size 256x256 xc:'#1f2937' -fill '#60a5fa' \
               -draw 'polygon 96,80 96,176 180,128' "$icon_path"
    elif command -v convert >/dev/null 2>&1; then
        convert -size 256x256 xc:'#1f2937' -fill '#60a5fa' \
                -draw 'polygon 96,80 96,176 180,128' "$icon_path"
    else
        echo "warn: ImageMagick not found — generate icons manually with"
        echo "  npm run tauri icon path/to/source.png --workspace apps/desktop"
    fi
fi

echo
echo "Next:"
echo "  npm install"
echo "  npm run dev"
