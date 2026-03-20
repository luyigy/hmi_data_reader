# Test Linux Gateway Message Sending
$baseUrl = "http://10.0.8.4:18789"
$token = "21FGUgEmv3vTMlkCO811z3pwyc2kywyMQrb3YW7l_mY"

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

# Test message endpoints
$messageEndpoints = @(
    "/api/messages/incoming",
    "/messages/incoming",
    "/api/messages",
    "/messages"
)

$body = @{
    from = "HK-vision"
    content = "Hello Linux! Test from Agent Platform - $(Get-Date -Format 'HH:mm:ss')"
    timestamp = Get-Date -Format 'o'
} | ConvertTo-Json

Write-Host "Testing Linux Gateway message endpoints..."
Write-Host "Base URL: $baseUrl"
Write-Host ""

foreach ($endpoint in $messageEndpoints) {
    $uri = "$baseUrl$endpoint"
    Write-Host "Testing: POST $endpoint" -ForegroundColor Yellow
    
    try {
        $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 5
        Write-Host "  ✅ Success!" -ForegroundColor Green
        Write-Host "  Response:"
        $response | ConvertTo-Json -Depth 5 | ForEach-Object { Write-Host "    $_" }
        Write-Host ""
    }
    catch {
        $status = if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { "N/A" }
        Write-Host "  ❌ Failed ($status)" -ForegroundColor Red
        if ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $errorBody = $reader.ReadToEnd()
                Write-Host "  Error: $errorBody" -ForegroundColor Gray
            }
            catch {}
        }
    }
}
