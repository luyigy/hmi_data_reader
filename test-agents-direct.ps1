# Test Real Agents Directly

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Testing Real Agents Execution" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$testPrompt = "Task: Test Agent Execution`nDescription: This is a test to verify the agent works correctly.`n`nPlease execute this task and provide a summary."

Write-Host "`n1. Testing Claude Code..." -ForegroundColor Yellow
try {
  Write-Host "Command: claude '$testPrompt' --print --permission-mode bypassPermissions`n"
  
  $output = claude $testPrompt --print --permission-mode bypassPermissions 2>&1
  
  if ($LASTEXITCODE -eq 0 -or $output) {
    Write-Host "✅ Claude Success!" -ForegroundColor Green
    Write-Host "Output:" -ForegroundColor Cyan
    Write-Host $output
  } else {
    Write-Host "❌ Claude Failed with exit code $LASTEXITCODE" -ForegroundColor Red
  }
} catch {
  Write-Host "❌ Claude Error:" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

Write-Host "`n2. Testing Codex..." -ForegroundColor Yellow
try {
  Write-Host "Command: echo '$testPrompt' | codex`n"
  
  $output = echo $testPrompt | codex 2>&1
  
  if ($LASTEXITCODE -eq 0 -or $output) {
    Write-Host "✅ Codex Success!" -ForegroundColor Green
    Write-Host "Output:" -ForegroundColor Cyan
    Write-Host $output
  } else {
    Write-Host "❌ Codex Failed with exit code $LASTEXITCODE" -ForegroundColor Red
  }
} catch {
  Write-Host "❌ Codex Error:" -ForegroundColor Red
  Write-Host $_.Exception.Message
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Test Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
