# Download chrome-headless-shell for Windows from the Chrome for Testing
# project. We bundle this with the app so export raster always has the
# legacy-headless binary that exposes `HeadlessExperimental.beginFrame` —
# which Chrome stable / Edge dropped in v132. Without it, `Page.captureScreenshot`
# is the only capture path and we lose ~30–40% of the speedup.
#
# This script is idempotent: skips download when the binary already exists,
# and is safe to re-run after a version bump.
#
# Run from the repo root: `pwsh apps/desktop/src-tauri/vendor/chrome-headless-shell/download.ps1`
#
# Reference: https://googlechromelabs.github.io/chrome-for-testing/

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinaryPath = Join-Path $ScriptDir 'chrome-headless-shell.exe'

if (Test-Path $BinaryPath) {
    Write-Host "chrome-headless-shell already present at $BinaryPath — skipping download."
    Write-Host "Delete the file (or this whole directory's binary subdir) to force a re-download."
    exit 0
}

Write-Host "Resolving latest stable Chrome for Testing version..."
$ManifestUrl = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
$Manifest = Invoke-RestMethod -Uri $ManifestUrl
$Stable = $Manifest.channels.Stable
$Version = $Stable.version
$Downloads = $Stable.downloads.'chrome-headless-shell'
if ($null -eq $Downloads) {
    throw "No chrome-headless-shell downloads in the Stable channel manifest."
}
$Win64 = $Downloads | Where-Object { $_.platform -eq 'win64' } | Select-Object -First 1
if ($null -eq $Win64) {
    throw "No win64 chrome-headless-shell build in Stable $Version."
}
$ZipUrl = $Win64.url
Write-Host "Stable channel = $Version"
Write-Host "Download URL   = $ZipUrl"

$TmpZip = Join-Path $env:TEMP "chrome-headless-shell-$Version.zip"
$TmpExtract = Join-Path $env:TEMP "chrome-headless-shell-$Version"

Write-Host "Downloading..."
Invoke-WebRequest -Uri $ZipUrl -OutFile $TmpZip -UseBasicParsing
Write-Host "Extracting..."
if (Test-Path $TmpExtract) {
    Remove-Item -Recurse -Force $TmpExtract
}
Expand-Archive -Path $TmpZip -DestinationPath $TmpExtract

# The zip wraps everything in a `chrome-headless-shell-win64/` directory.
# Move that directory's contents into our vendor folder so the binary
# lands at $ScriptDir/chrome-headless-shell.exe.
$ExtractedSub = Get-ChildItem -Path $TmpExtract -Directory | Select-Object -First 1
if ($null -eq $ExtractedSub) {
    throw "Extracted archive has no top-level directory."
}
Write-Host "Moving extracted files into $ScriptDir ..."
Get-ChildItem -Path $ExtractedSub.FullName | ForEach-Object {
    $dest = Join-Path $ScriptDir $_.Name
    if (Test-Path $dest) {
        Remove-Item -Recurse -Force $dest
    }
    Move-Item -Path $_.FullName -Destination $dest
}
Remove-Item -Recurse -Force $TmpExtract
Remove-Item -Force $TmpZip

if (-not (Test-Path $BinaryPath)) {
    throw "Download completed but $BinaryPath is missing — archive layout changed?"
}
Write-Host ""
Write-Host "chrome-headless-shell $Version installed at $BinaryPath"
Write-Host "Total size:"
"{0:N1} MB" -f ((Get-ChildItem -Path $ScriptDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB)
