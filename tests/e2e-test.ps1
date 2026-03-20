# Agent Platform v2 - End-to-End Test Script
# 功能：验证完整的核心业务流程
# 用法：.\tests\e2e-test.ps1

$ErrorActionPreference = "Stop"
$baseUrl = "http://localhost:3000/api"
$testResults = @()
$passed = 0
$failed = 0

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Agent Platform v2 - End-to-End Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Helper function: Make HTTP request
function Invoke-ApiRequest {
    param(
        [string]$Method,
        [string]$Endpoint,
        [object]$Body = $null,
        [string]$ContentType = "application/json"
    )
    
    $url = "$baseUrl$Endpoint"
    $params = @{
        Method = $Method
        Uri = $url
        ContentType = $ContentType
    }
    
    if ($Body) {
        $params.Body = $Body | ConvertTo-Json -Depth 10
    }
    
    try {
        $response = Invoke-RestMethod @params -ErrorAction Stop
        return @{ Success = $true; Data = $response }
    }
    catch {
        return @{ 
            Success = $false
            Error = $_.Exception.Message
            StatusCode = $_.Exception.Response.StatusCode.value__
        }
    }
}

# Helper function: Record test result
function Test-Result {
    param(
        [string]$TestName,
        [bool]$Passed,
        [string]$Message = ""
    )
    
    $testResults += @{
        Name = $TestName
        Passed = $Passed
        Message = $Message
    }
    
    if ($Passed) {
        $script:passed++
        Write-Host "  ✅ $TestName" -ForegroundColor Green
    }
    else {
        $script:failed++
        Write-Host "  ❌ $TestName - $Message" -ForegroundColor Red
    }
}

# ============================================
# Step 1: Health Check
# ============================================
Write-Host "`n📋 Step 1: Health Check" -ForegroundColor Yellow
Write-Host "----------------------------------------"

$result = Invoke-ApiRequest -Method GET -Endpoint "/health"
Test-Result "API 可访问" $result.Success "API 服务正常运行"

if (-not $result.Success) {
    Write-Host "`n❌ 健康检查失败，请确保开发服务器正在运行 (npm run dev)" -ForegroundColor Red
    exit 1
}

# ============================================
# Step 2: Gateway 管理测试
# ============================================
Write-Host "`n📋 Step 2: Gateway 管理测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 获取所有 Gateways
$result = Invoke-ApiRequest -Method GET -Endpoint "/gateways"
Test-Result "获取 Gateway 列表" $result.Success "返回 $($result.Data.Count) 个 Gateways"

if ($result.Success -and $result.Data.Count -gt 0) {
    $gateway1 = $result.Data[0]
    Test-Result "Gateway 数据结构" ($gateway1.id -and $gateway1.name) "包含必要字段"
}

# ============================================
# Step 3: Agent 管理测试
# ============================================
Write-Host "`n📋 Step 3: Agent 管理测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 获取所有 Agents
$result = Invoke-ApiRequest -Method GET -Endpoint "/agents"
Test-Result "获取 Agent 列表" $result.Success "返回 $($result.Data.Count) 个 Agents"

if ($result.Success -and $result.Data.Count -gt 0) {
    $agent1 = $result.Data[0]
    Test-Result "Agent 数据结构" ($agent1.id -and $agent1.name -and $agent1.gatewayId) "包含必要字段"
    
    # 测试 Agent 状态更新
    $updateResult = Invoke-ApiRequest -Method PUT -Endpoint "/agents/$($agent1.id)" -Body @{
        status = "busy"
    }
    Test-Result "更新 Agent 状态" $updateResult.Success "状态更新为 busy"
    
    # 验证更新
    $verifyResult = Invoke-ApiRequest -Method GET -Endpoint "/agents/$($agent1.id)"
    Test-Result "验证 Agent 状态" ($verifyResult.Success -and $verifyResult.Data.status -eq "busy") "状态已正确更新"
}

# ============================================
# Step 4: Token 认证测试
# ============================================
Write-Host "`n📋 Step 4: Token 认证测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 生成 Token
$tokenResult = Invoke-ApiRequest -Method POST -Endpoint "/gateways/token" -Body @{
    gatewayId = 1
    expiresHours = 24
}
Test-Result "生成 Gateway Token" $tokenResult.Success "Token 生成成功"

if ($tokenResult.Success) {
    # 验证 Token
    $verifyTokenResult = Invoke-ApiRequest -Method GET -Endpoint "/gateways/token" -Body @{
        token = $tokenResult.Data.token
    }
    Test-Result "验证 Token" $verifyTokenResult.Success "Token 验证通过"
}

# ============================================
# Step 5: 聊天室管理测试
# ============================================
Write-Host "`n📋 Step 5: 聊天室管理测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 获取聊天室列表
$roomsResult = Invoke-ApiRequest -Method GET -Endpoint "/chat/rooms"
Test-Result "获取聊天室列表" $roomsResult.Success "返回 $($roomsResult.Data.Count) 个聊天室"

if ($roomsResult.Success -and $roomsResult.Data.Count -gt 0) {
    $room1 = $roomsResult.Data[0]
    Test-Result "聊天室数据结构" ($room1.id -and $room1.name) "包含必要字段"
    
    # 获取聊天室消息
    $messagesResult = Invoke-ApiRequest -Method GET -Endpoint "/chat/messages?roomId=$($room1.id)&limit=10"
    Test-Result "获取聊天消息" $messagesResult.Success "返回 $($messagesResult.Data.Count) 条消息"
}

# ============================================
# Step 6: 消息发送测试
# ============================================
Write-Host "`n📋 Step 6: 消息发送测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

if ($roomsResult.Success -and $roomsResult.Data.Count -gt 0) {
    $room1 = $roomsResult.Data[0]
    
    # 发送测试消息
    $testMessage = "🤖 [E2E 测试] 自动化测试消息 - $(Get-Date -Format 'HH:mm:ss')"
    $sendResult = Invoke-ApiRequest -Method POST -Endpoint "/chat/messages" -Body @{
        roomId = $room1.id
        content = $testMessage
        senderId = "e2e-test"
        senderName = "E2E Test Bot"
    }
    Test-Result "发送聊天消息" $sendResult.Success "消息发送成功"
    
    if ($sendResult.Success) {
        # 验证消息已保存
        $verifyMessageResult = Invoke-ApiRequest -Method GET -Endpoint "/chat/messages?roomId=$($room1.id)&limit=5"
        $lastMessage = $verifyMessageResult.Data[0]
        Test-Result "验证消息持久化" ($verifyMessageResult.Success -and $lastMessage.content -eq $testMessage) "消息已保存到数据库"
    }
}

# ============================================
# Step 7: @提及功能测试
# ============================================
Write-Host "`n📋 Step 7: @提及功能测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

if ($result.Success -and $result.Data.Count -gt 0) {
    $agent1 = $result.Data[0]
    
    # 发送带@提及的消息
    $mentionMessage = "@$($agent1.name) 请帮我执行这个测试任务"
    $mentionResult = Invoke-ApiRequest -Method POST -Endpoint "/chat/messages" -Body @{
        roomId = $room1.id
        content = $mentionMessage
        senderId = "e2e-test"
        senderName = "E2E Test Bot"
    }
    Test-Result "发送@提及消息" $mentionResult.Success "@提及消息发送成功"
    
    # 测试提及解析 API
    $parseResult = Invoke-ApiRequest -Method POST -Endpoint "/chat/agent-response" -Body @{
        roomId = $room1.id
        content = $mentionMessage
    }
    Test-Result "提及解析 API" $parseResult.Success "提及解析正常"
}

# ============================================
# Step 8: 跨网关消息路由测试（模拟）
# ============================================
Write-Host "`n📋 Step 8: 跨网关消息路由测试（模拟）" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 测试消息发送 API（需要有效的 Gateway）
$gatewayMessageResult = Invoke-ApiRequest -Method GET -Endpoint "/gateways/messages/send"
Test-Result "跨网关消息发送 API" $gatewayMessageResult.Success "API 可访问"

# 测试消息接收 API
$incomingMessageResult = Invoke-ApiRequest -Method GET -Endpoint "/gateways/messages/incoming"
Test-Result "跨网关消息接收 API" $incomingMessageResult.Success "API 可访问"

# ============================================
# Step 9: 任务管理测试
# ============================================
Write-Host "`n📋 Step 9: 任务管理测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 获取任务列表
$tasksResult = Invoke-ApiRequest -Method GET -Endpoint "/tasks"
Test-Result "获取任务列表" $tasksResult.Success "返回 $($tasksResult.Data.Count) 个任务"

if ($tasksResult.Success -and $tasksResult.Data.Count -gt 0) {
    $task1 = $tasksResult.Data[0]
    Test-Result "任务数据结构" ($task1.id -and $task1.description) "包含必要字段"
}

# ============================================
# 测试总结
# ============================================
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "测试总结" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$total = $passed + $failed
$passRate = if ($total -gt 0) { [math]::Round(($passed / $total) * 100, 2) } else { 0 }

Write-Host ""
Write-Host "  总测试数：$total" -ForegroundColor White
Write-Host "  ✅ 通过：$passed" -ForegroundColor Green
Write-Host "  ❌ 失败：$failed" -ForegroundColor Red
Write-Host "  通过率：$passRate%" -ForegroundColor $(if ($passRate -ge 90) { "Green" } else { "Yellow" })

Write-Host ""
Write-Host "详细测试结果:" -ForegroundColor Yellow
foreach ($test in $testResults) {
    $icon = if ($test.Passed) { "✅" } else { "❌" }
    Write-Host "  $icon $($test.Name): $($test.Message)"
}

Write-Host ""
if ($failed -eq 0) {
    Write-Host "🎉 所有测试通过！Feature 12 - 端到端测试 完成" -ForegroundColor Green
    Write-Host ""
    Write-Host "阶段 2 最终进度：12/12 (100%) - 正式结项！" -ForegroundColor Cyan
}
else {
    Write-Host "⚠️  部分测试失败，请检查错误信息" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan

# 保存测试报告
$reportPath = "tests\E2E_TEST_REPORT_$(Get-Date -Format 'yyyyMMdd_HHmmss').md"
$reportContent = @"
# E2E 测试报告

**测试时间**: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
**测试版本**: Agent Platform v2 阶段 2
**测试人员**: E2E Automated Test

## 测试结果

- 总测试数：$total
- ✅ 通过：$passed
- ❌ 失败：$failed
- 通过率：$passRate%

## 详细结果

"@

foreach ($test in $testResults) {
    $status = if ($test.Passed) { "✅" } else { "❌" }
    $reportContent += "`n- $status **$($test.Name)**: $($test.Message)"
}

if ($failed -eq 0) {
    $reportContent += "`n\n## 结论`n`n🎉 所有测试通过！Feature 12 - 端到端测试 完成`n`n**阶段 2 正式结项：12/12 (100%)**"
}
else {
    $reportContent += "`n\n## 结论`n`n⚠️  部分测试失败，需要修复后重新测试"
}

$reportContent | Out-File -FilePath $reportPath -Encoding utf8
Write-Host "📄 测试报告已保存：$reportPath" -ForegroundColor Gray
