# Test Claude Code directly

$testPrompt = "Say hello and tell me what time it is"

Write-Host "Testing Claude Code..." -ForegroundColor Cyan
try {
  $output = claude $testPrompt --print --permission-mode bypassPermissions 2>&1
  Write-Host "Output:" -ForegroundColor Green
  Write-Host $output
} catch {
  Write-Host "Error:" -ForegroundColor Red
  Write-Host $_.Exception.Message
}
