# Test Linux Gateway Connection
$uri = "http://192.168.1.4:18790/api/messages/incoming"
$token = "21FGUgEmv3vTMlkCO811z3pwyc2kywyMQrb3YW7l_mY"

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

$body = @{
    from = "HK-vision"
    content = "Hello Linux! 测试通信 - $(Get-Date -Format 'HH:mm:ss')"
    timestamp = Get-Date -Format 'o'
} | ConvertTo-Json

Write-Host "Testing Linux Gateway connection..."
Write-Host "URI: $uri"
Write-Host ""

try {
    $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 5
    Write-Host "✅ Connection successful!" -ForegroundColor Green
    Write-Host "Response:"
    $response | ConvertTo-Json -Depth 5 | Write-Host
}
catch {
    Write-Host "❌ Connection failed!" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        Write-Host "Status: $($_.Exception.Response.StatusCode)"
    }
}
