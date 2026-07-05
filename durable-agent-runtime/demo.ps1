#!/usr/bin/env pwsh
# durable-agent-runtime — end-to-end walkthrough.
#
# Tells the whole story in one run:
#   clean run -> crash mid-run -> recover -> status -> trace -> eval (good + regressed).
# Everything is deterministic (mock model), offline, and isolated in a temp dir,
# so the repo stays clean and the output is reproducible.
#
# Usage:
#   pwsh ./demo.ps1            # pauses between sections (good for screen recording)
#   pwsh ./demo.ps1 -NoPause   # runs straight through (good for CI / a quick look)

param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
# A non-zero native exit code (the injected crash, and the eval regression) is
# part of the demo — don't let it abort the script.
$PSNativeCommandUseErrorActionPreference = $false

Set-Location $PSScriptRoot
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Isolate all demo artifacts in a throwaway temp dir so nothing lands in the repo.
$demo = Join-Path ([IO.Path]::GetTempPath()) "agent-demo-$(Get-Random)"
$env:AGENT_RUNS_DIR = $demo
$env:AGENT_CACHE    = Join-Path $demo 'cache.json'

function Section($title) {
  Write-Host ''
  Write-Host "==== $title ====" -ForegroundColor Cyan
  if (-not $NoPause) { Read-Host '  (press enter to run)' | Out-Null }
}
function Note($text) { Write-Host "  # $text" -ForegroundColor DarkGray }
function Agent { npx --yes tsx src/cli.ts @args }

try {
  Section '1. Clean run  —  analyze -> locate -> propose, then a proposal'
  Agent run 'Login page crashes with a null session'

  Section '2. Crash mid-run (CRASH_AFTER=locate.1)  —  leaves a resumable log'
  Note 'The crash is injected AFTER the searchCode tool ran but BEFORE the step is marked complete —'
  Note "that's the exact window a naive 'overwrite one snapshot' checkpoint corrupts."
  $env:CRASH_AFTER = 'locate.1'
  $crash = npx --yes tsx src/cli.ts run 'Token not refreshed on focus' 2>&1
  Remove-Item Env:\CRASH_AFTER
  $crash | ForEach-Object { Write-Host $_ }
  $runId = ([regex]'run-\d+-[0-9a-f]+').Match(($crash -join "`n")).Value
  if (-not $runId) { throw 'Could not parse the interrupted run id from the crash output.' }
  Note "Interrupted run id: $runId"

  Section '3. Recover  —  replays the log and finishes the run'
  Note "Watch: NO 'tool searchCode' line appears — the tool result is replayed from the log, not re-run (idempotency)."
  Agent recover

  Section '4. Status  —  state is derived purely by folding the event log'
  Agent status $runId

  Section '5. Trace  —  spans + token/cost/latency + durable-replay hit rate'
  Note 'replayHitRate > 0 because this run was resumed: the crashed step re-ran but its model call was replayed.'
  Agent trace $runId

  Section '6. Eval (good config)  —  scorers + LLM-as-judge grade real runs'
  Agent eval
  Note "exit code: $LASTEXITCODE   (0 = every scenario passed)"

  Section '7. Eval (AGENT_REGRESS=1)  —  a degraded prompt is caught'
  Note 'AGENT_REGRESS swaps in a worse propose step; evals use a fresh un-cached model so a stale cache cannot hide it.'
  $env:AGENT_REGRESS = '1'
  npx --yes tsx src/cli.ts eval
  $code = $LASTEXITCODE
  Remove-Item Env:\AGENT_REGRESS
  Note "exit code: $code   (1 = regression → CI would fail the build)"

  Write-Host ''
  Write-Host 'Done. State is derived from an append-only log; resume/recover never repeat side effects; trace and eval are just projections of the same runs.' -ForegroundColor Green
}
finally {
  Remove-Item Env:\AGENT_RUNS_DIR, Env:\AGENT_CACHE -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $demo -ErrorAction SilentlyContinue
}
