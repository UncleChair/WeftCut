<#
.SYNOPSIS
  Launch `tauri dev` for a parallel worktree on an isolated port + app
  identifier, so several worktrees can run live dev instances side by side.

.DESCRIPTION
  Two concurrent `tauri dev` runs from two checkouts normally collide on the
  hardcoded vite port (1420, strictPort) and share the static app identifier
  `dev.weftcut.desktop` — which makes the single-instance plugin (lib.rs)
  surface the existing window instead of launching a second app.

  This launcher sidesteps both, per instance N:
    - vite dev server  : port 1420 + N*10   (0 -> 1420, 1 -> 1430, 2 -> 1440)
    - app identifier   : dev.weftcut.desktop[.wtN]
        A different identifier -> a different app_config_dir, so mcp_auth.json,
        app_settings.json, recents.json, the user-Motif store, WebView2
        user-data AND the single-instance lock are all isolated. The two
        instances never race each other's state.
    - build.devUrl     : http://localhost:<port>  (so the webview loads the
                         right vite server)

  Everything is injected at launch via `tauri dev --config <overlay.json>`.
  Nothing is committed into tauri.conf.json or vite.config.ts — the repo's
  default single-instance behaviour is unchanged.

  Instance 0 (no suffix, port 1420) is the normal app; that's what the primary
  checkout runs with a plain `npm run dev`.

.PARAMETER Instance
  Instance number. When omitted it is derived from the trailing digits of the
  worktree's root folder name: videtor-wt1 -> 1, videtor-wt2 -> 2, videtor -> 0.

.EXAMPLE
  pwsh scripts/dev-instance.ps1            # auto-detect from folder name
  pwsh scripts/dev-instance.ps1 -Instance 2
#>
param(
    [int]$Instance = -1
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot      # repo root of THIS worktree
$desktop = Join-Path $root "apps\desktop"

# Derive the instance from the worktree folder name when not given explicitly.
if ($Instance -lt 0) {
    $leaf = Split-Path -Leaf $root
    if ($leaf -match '(\d+)$') { $Instance = [int]$Matches[1] } else { $Instance = 0 }
}

$port = 1420 + $Instance * 10
$idSuffix = if ($Instance -eq 0) { "" } else { ".wt$Instance" }
$identifier = "dev.weftcut.desktop$idSuffix"

# Per-instance Tauri config overlay. `npm run dev -- --port <N>` forwards the
# port to vite (CLI flag overrides config.server.port); strictPort stays on, so
# a collision fails loudly instead of silently drifting to another port.
$overlay = [ordered]@{
    identifier = $identifier
    build      = [ordered]@{
        beforeDevCommand = "npm run dev -- --port $port"
        devUrl           = "http://localhost:$port"
    }
}
$cfgPath = Join-Path $env:TEMP ("weftcut-dev-wt{0}.json" -f $Instance)
($overlay | ConvertTo-Json -Depth 5) | Set-Content -Path $cfgPath -Encoding UTF8

Write-Host "WeftCut dev — instance $Instance"
Write-Host ("  worktree   : {0}" -f $root)
Write-Host ("  vite port  : {0}" -f $port)
Write-Host ("  identifier : {0}" -f $identifier)
Write-Host ("  config     : {0}" -f $cfgPath)
Write-Host ""

# Resolve the local tauri CLI shim directly (hoisted to the root node_modules by
# npm workspaces, with a fallback to the package-local one). Calling the .cmd
# shim with the call operator passes args cleanly — avoids the PowerShell/npx
# `--` arg-dropping trap (see CLAUDE memory: wdio single-spec on Windows).
$tauriCmd = Join-Path $root "node_modules\.bin\tauri.cmd"
if (-not (Test-Path $tauriCmd)) {
    $tauriCmd = Join-Path $desktop "node_modules\.bin\tauri.cmd"
}
if (-not (Test-Path $tauriCmd)) {
    throw "tauri CLI not found. Run `npm install` in this worktree first ($root)."
}

Set-Location $desktop
& $tauriCmd dev --config $cfgPath
