# One-shot dev environment initializer.
#
# - Verifies Node + Rust + MSVC build tools are reachable.
# - Generates a placeholder app icon at apps/desktop/src-tauri/icons/icon.png
#   so `tauri dev` can launch before the user runs `tauri icon`.
#
# Run once after cloning:
#   pwsh scripts/init-dev.ps1

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# DestroyIcon p/invoke for releasing HICON returned by Bitmap.GetHicon.
if (-not ("Videtor.Win32" -as [type])) {
    Add-Type -Namespace Videtor -Name Win32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool DestroyIcon(System.IntPtr hIcon);
'@
}

$root = Split-Path -Parent $PSScriptRoot
Write-Host "Videtor dev init — root: $root"

function Check-Cmd($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        # Rust installs to %USERPROFILE%\.cargo\bin which doesn't always show up
        # in the current PowerShell session — check there before warning.
        $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
        $exe = Join-Path $cargoBin "$name.exe"
        if (Test-Path $exe) {
            Write-Host ("  {0,-8} {1}  (not on PATH; open a new shell)" -f $name, $exe)
            return $true
        }
        Write-Warning "$name not found. $hint"
        return $false
    }
    Write-Host ("  {0,-8} {1}" -f $name, $cmd.Source)
    return $true
}

Write-Host "`nToolchain:"
$ok = $true
$ok = (Check-Cmd "node"   "Install Node 20+: https://nodejs.org") -and $ok
$ok = (Check-Cmd "npm"    "Comes with Node.")                     -and $ok
$ok = (Check-Cmd "cargo"  "Install Rust: winget install Rustlang.Rustup -e") -and $ok
$ok = (Check-Cmd "rustup" "Install: winget install Rustlang.Rustup -e")     -and $ok

if (-not $ok) {
    Write-Warning "Some tools are missing. See docs/setup.md."
}

# Placeholder icon: 256x256 PNG with the play-triangle motif.
$iconDir = Join-Path $root "apps\desktop\src-tauri\icons"
$iconPng = Join-Path $iconDir "icon.png"
$iconIco = Join-Path $iconDir "icon.ico"

function New-PlaceholderBitmap {
    param([int]$Size)
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([System.Drawing.Color]::FromArgb(31, 41, 55))
        $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(96, 165, 250))
        try {
            $s = $Size / 256.0
            $tri = New-Object 'System.Drawing.PointF[]' 3
            $tri[0] = New-Object System.Drawing.PointF ([float](96 * $s), [float](80 * $s))
            $tri[1] = New-Object System.Drawing.PointF ([float](96 * $s), [float](176 * $s))
            $tri[2] = New-Object System.Drawing.PointF ([float](180 * $s), [float](128 * $s))
            $g.FillPolygon($brush, $tri)
        } finally { $brush.Dispose() }
    } finally { $g.Dispose() }
    return $bmp
}

if (-not (Test-Path $iconPng)) {
    Write-Host "`nGenerating placeholder icon.png at $iconPng ..."
    New-Item -ItemType Directory -Path $iconDir -Force | Out-Null
    $bmp = New-PlaceholderBitmap 256
    try {
        $bmp.Save($iconPng, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
    Write-Host "Wrote $iconPng"
} else {
    Write-Host "`nicon.png already present: $iconPng"
}

if (-not (Test-Path $iconIco)) {
    Write-Host "Generating placeholder icon.ico at $iconIco ..."
    Add-Type -AssemblyName System.Drawing
    $bmp = New-PlaceholderBitmap 64
    try {
        $hicon = $bmp.GetHicon()
        try {
            $icon = [System.Drawing.Icon]::FromHandle($hicon)
            $fs = [System.IO.File]::Create($iconIco)
            try { $icon.Save($fs) } finally { $fs.Dispose() }
        } finally {
            # Release the unmanaged HICON returned by GetHicon.
            [Videtor.Win32]::DestroyIcon($hicon) | Out-Null
        }
    } finally { $bmp.Dispose() }
    Write-Host "Wrote $iconIco"
} else {
    Write-Host "icon.ico already present: $iconIco"
}

Write-Host "`nNext:"
Write-Host "  npm install"
Write-Host "  npm run dev"
