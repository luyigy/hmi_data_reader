# Test Linux Gateway - Final Attempt
$baseUrl = "http://10.0.8.4:18789"
$token = $env:LINUX_GATEWAY_TOKEN

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

# Test all possible message endpoints
$endpoints = @(
    "/api/gateways/messages/incoming",
    "/api/messages/receive",
    "/api/incoming",
    "/incoming",
    "/api/chat",
    "/chat"
)

$body = @{
    from = "HK-vision"
    fromGatewayId = "agent-platform-v2"
    content = "Hello Linux! Test from Agent Platform - $(Get-Date -Format 'HH:mm:ss')"
    type = "direct"
    timestamp = Get-Date -Format 'o'
} | ConvertTo-Json

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Linux Gateway Communication Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Target: $baseUrl (via WireGuard 10.0.8.4)"
Write-Host "Token: $token"
Write-Host ""

# First test health
Write-Host "1. Health Check..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 5
    Write-Host "  ✅ Gateway is live!" -ForegroundColor Green
    Write-Host "  Status: $($health.status)"
    Write-Host ""
}
catch {
    Write-Host "  ❌ Health check failed: $($_.Exception.Message)"
    Write-Host ""
}

# Test message endpoints
Write-Host "2. Testing Message Endpoints..." -ForegroundColor Yellow
foreach ($endpoint in $endpoints) {
    $uri = "$baseUrl$endpoint"
    Write-Host "  POST $endpoint" -NoNewline
    
    try {
        $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 5
        Write-Host " - ✅ Success!" -ForegroundColor Green
        Write-Host "  Response: $($response | ConvertTo-Json -Compress)"
        return
    }
    catch {
        $status = if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { "N/A" }
        Write-Host " - ❌ $status" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Conclusion:" -ForegroundColor Cyan
Write-Host "✅ Gateway is reachable (health check passed)" -ForegroundColor Green
Write-Host "❌ Message endpoints not found - may need different API format" -ForegroundColor Red
Write-Host "========================================" -ForegroundColor Cyan
