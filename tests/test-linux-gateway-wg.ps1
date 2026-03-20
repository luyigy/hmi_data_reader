# Test Linux Gateway Connection (via WireGuard)
$uri = "http://10.0.8.4:18789/api/health"
$token = "21FGUgEmv3vTMlkCO811z3pwyc2kywyMQrb3YW7l_mY"

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

Write-Host "Testing Linux Gateway connection (WireGuard)..."
Write-Host "URI: $uri"
Write-Host ""

try {
    # Test health endpoint
    Write-Host "1. Testing /api/health..."
    $healthResponse = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 5
    Write-Host "✅ Health check successful!" -ForegroundColor Green
    $healthResponse | ConvertTo-Json -Depth 5 | Write-Host
    Write-Host ""
    
    # Test sending message
    Write-Host "2. Testing message sending..."
    $msgUri = "http://10.0.8.4:18789/api/messages/incoming"
    $body = @{
        from = "HK-vision"
        content = "Hello Linux! Test from Agent Platform - $(Get-Date -Format 'HH:mm:ss')"
        timestamp = Get-Date -Format 'o'
    } | ConvertTo-Json
    
    $msgResponse = Invoke-RestMethod -Uri $msgUri -Method Post -Headers $headers -Body $body -TimeoutSec 5
    Write-Host "✅ Message sent successfully!" -ForegroundColor Green
    $msgResponse | ConvertTo-Json -Depth 5 | Write-Host
}
catch {
    Write-Host "❌ Connection failed!" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        Write-Host "Status: $($_.Exception.Response.StatusCode)"
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $reader.ReadToEnd() | Write-Host
    }
}
