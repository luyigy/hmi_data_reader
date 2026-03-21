# Feature 2 - Linux Gateway Communication Test

$ErrorActionPreference = "Stop"

# Linux Gateway Config
$linuxGatewayUrl = "http://10.0.8.4:18789"
$linuxGatewayToken = "21FGUgEmv3vTMlkCO811z3pwyc2kywyMQrb3YW7l_mY"
$testMessage = "Feature 2 Test - Agent Platform v2 to Linux Gateway - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

Write-Host "========================================"
Write-Host "Feature 2 - Linux Gateway Test"
Write-Host "========================================"
Write-Host ""
Write-Host "Target Gateway: $linuxGatewayUrl"
Write-Host "Message: $testMessage"
Write-Host ""

# Test 1: Health Check
Write-Host "[Test 1] Health Check..."
try {
    $healthResponse = Invoke-WebRequest -Uri "$linuxGatewayUrl/health" -Method Get -TimeoutSec 5
    Write-Host "  PASS - Health Check OK"
    Write-Host "  Response: $($healthResponse.Content)"
} catch {
    Write-Host "  FAIL - Health Check: $($_.Exception.Message)"
}

Write-Host ""

# Test 2: Send Message to Linux Gateway
Write-Host "[Test 2] Send Message to Linux Gateway..."
try {
    $headers = @{
        "Authorization" = "Bearer $linuxGatewayToken"
        "Content-Type" = "application/json"
    }
    
    $body = @{
        "from" = "HK-vision"
        "content" = $testMessage
        "timestamp" = (Get-Date -Format 'o')
    } | ConvertTo-Json
    
    $messageResponse = Invoke-WebRequest -Uri "$linuxGatewayUrl/api/messages/incoming" `
        -Method Post `
        -Headers $headers `
        -Body $body `
        -TimeoutSec 10
    
    Write-Host "  PASS - Message sent successfully"
    Write-Host "  Response: $($messageResponse.Content)"
} catch {
    Write-Host "  FAIL - Message send: $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) {
        Write-Host "  Error Details: $($_.ErrorDetails.Message)"
    }
}

Write-Host ""
Write-Host "========================================"
Write-Host "Test Complete"
Write-Host "========================================"
