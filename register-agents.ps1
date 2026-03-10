# Register Real Agents Script

Write-Host "Registering Codex Agent..." -ForegroundColor Cyan
$codexResult = Invoke-RestMethod `
  -Uri "http://localhost:3000/api/agents/register-real" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"type": "codex", "name": "Codex Agent"}'

Write-Host "Codex registered:" -ForegroundColor Green
$codexResult | ConvertTo-Json

Write-Host "`nRegistering Claude Code Agent..." -ForegroundColor Cyan
$claudeResult = Invoke-RestMethod `
  -Uri "http://localhost:3000/api/agents/register-real" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"type": "claude", "name": "Claude Code Agent"}'

Write-Host "Claude Code registered:" -ForegroundColor Green
$claudeResult | ConvertTo-Json

Write-Host "`n✅ Both agents registered successfully!" -ForegroundColor Green
Write-Host "`nNow you can:" -ForegroundColor Yellow
Write-Host "1. Go to http://localhost:3000/tasks" -ForegroundColor White
Write-Host "2. Create a new task" -ForegroundColor White
Write-Host "3. Assign it to Codex Agent or Claude Code Agent" -ForegroundColor White
Write-Host "4. Click '🚀 执行任务' to run real agents!" -ForegroundColor White
