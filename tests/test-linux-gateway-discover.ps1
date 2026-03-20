# Discover Linux Gateway API endpoints
$baseUrl = "http://10.0.8.4:18789"
$token = "21FGUgEmv3vTMlkCO811z3pwyc2kywyMQrb3YW7l_mY"

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

$endpoints = @(
    "/",
    "/api",
    "/api/health",
    "/api/status",
    "/api/v1/health",
    "/health",
    "/status"
)

Write-Host "Discovering Linux Gateway API endpoints..."
Write-Host "Base URL: $baseUrl"
Write-Host ""

foreach ($endpoint in $endpoints) {
    $uri = "$baseUrl$endpoint"
    Write-Host "Testing: $endpoint" -ForegroundColor Yellow
    
    try {
        $response = Invoke-RestMethod -Uri $uri -Method Get -Headers $headers -TimeoutSec 3
        Write-Host "  ✅ Success (200)" -ForegroundColor Green
        Write-Host "  Response:"
        $response | ConvertTo-Json -Depth 3 | ForEach-Object { Write-Host "    $_" }
        Write-Host ""
    }
    catch {
        $status = if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { "N/A" }
        Write-Host "  ❌ Failed ($status)" -ForegroundColor Red
    }
}
