<#
.SYNOPSIS
  Fetch once and show every worktree's branch, drift vs origin/main, and dirty
  state — a 30-second health check for the parallel-worktree pool.

.DESCRIPTION
  All worktrees share one object store, so a single `git fetch` updates
  origin/* for every worktree at once. This then reports, per worktree:
    - the checked-out branch
    - Behind: commits on origin/main not yet in this branch (rebase candidates)
    - Ahead : commits on this branch not yet on origin/main (unmerged work)
    - State : clean / dirty (uncommitted changes)

  Use it before starting a task (rebase stale branches onto fresh main) and
  before integrating (spot worktrees with unpushed/uncommitted work).

.EXAMPLE
  pwsh scripts/worktree-sync.ps1
#>
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot

Write-Host "Fetching origin (shared across all worktrees)..."
git -C $root fetch origin --prune | Out-Null

# Parse `git worktree list --porcelain` into path + branch records.
$wts = @()
$cur = $null
foreach ($line in (git -C $root worktree list --porcelain)) {
    if ($line -match '^worktree (.+)$') {
        if ($cur) { $wts += $cur }
        $cur = [ordered]@{ Path = $Matches[1]; Branch = '(detached)' }
    }
    elseif ($line -match '^branch refs/heads/(.+)$' -and $cur) {
        $cur.Branch = $Matches[1]
    }
}
if ($cur) { $wts += $cur }

$rows = foreach ($w in $wts) {
    $p = $w.Path
    # left = origin/main not in HEAD (behind); right = HEAD not in origin/main (ahead)
    $ab = (git -C $p rev-list --left-right --count origin/main...HEAD 2>$null)
    if ($ab) { $behind, $ahead = ($ab -split '\s+') } else { $behind, $ahead = '?', '?' }
    $dirty = if (git -C $p status --porcelain) { 'dirty' } else { 'clean' }
    [pscustomobject]@{
        Worktree = Split-Path -Leaf $p
        Branch   = $w.Branch
        Behind   = $behind
        Ahead    = $ahead
        State    = $dirty
    }
}
$rows | Format-Table -AutoSize
