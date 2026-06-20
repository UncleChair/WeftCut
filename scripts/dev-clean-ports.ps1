<#
.SYNOPSIS
  Free stale WeftCut dev-server ports by killing orphaned vite processes.

.DESCRIPTION
  `npm run dev` (electron-vite) starts a Vite dev server — port 1420 by default,
  with secondary worktree instances manually moved to 1430 / 1440. On Windows,
  quitting by closing the app window often leaves that Vite server orphaned — it
  keeps holding the port, so the next `npm run dev` fails with a strict-port
  collision. Stopping dev with Ctrl-C in its terminal avoids this; this script
  cleans up after the times you forgot.

  Safety: a port's listener is only killed if it is a Node process running vite
  (its command line contains "vite"). Anything else squatting the port is
  reported and left untouched — so this never kills an unrelated app. The
  orphan's npm/corepack parent is killed too when present.

.PARAMETER Ports
  Ports to clean. Default: 1420/1430/1440 (the WeftCut dev-server ports —
  1420 primary, 1430/1440 secondary worktree instances).

.EXAMPLE
  pwsh scripts/dev-clean-ports.ps1
  pwsh scripts/dev-clean-ports.ps1 -Ports 1430
#>
param([int[]]$Ports = @(1420, 1430, 1440))

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-Cmdline([int]$id) {
    try { (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop).CommandLine }
    catch { $null }
}

$killed = 0
foreach ($port in $Ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { Write-Host ("port {0,-5} : free" -f $port); continue }

    foreach ($listenerId in ($conns.OwningProcess | Sort-Object -Unique)) {
        $proc = Get-Process -Id $listenerId -ErrorAction SilentlyContinue
        $cmd = Get-Cmdline $listenerId
        $isVite = $proc -and $proc.ProcessName -eq 'node' -and $cmd -and ($cmd -match 'vite')

        if (-not $isVite) {
            $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
            Write-Host ("port {0,-5} : held by pid {1} ({2}) — not a vite dev server, leaving it" -f $port, $listenerId, $name)
            continue
        }

        $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$listenerId" -ErrorAction SilentlyContinue).ParentProcessId
        Write-Host ("port {0,-5} : killing orphaned vite (pid {1})" -f $port, $listenerId)
        Stop-Process -Id $listenerId -Force -ErrorAction SilentlyContinue
        $killed++

        if ($parentId) {
            $pcmd = Get-Cmdline $parentId
            if ($pcmd -and ($pcmd -match 'npm|run dev|corepack')) {
                Write-Host ("            + npm parent (pid {0})" -f $parentId)
                Stop-Process -Id $parentId -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

Write-Host ""
Write-Host ("Done. Killed {0} orphaned vite process(es)." -f $killed)
