# 04 Handover — 运维与接手指南

## 概览
- **项目**: Agent Platform (agent-platform-v2)
- **位置**: e:/projects/agent-platform-v2
- **目的**: 指导接手者快速了解运行、注册网关、生成 token、诊断连接并日常运维要点。

## 快速启动（开发）
1. 复制环境文件（如果尚未配置）:

```powershell
copy .env.example .env
```

2. 安装依赖并启动开发服务器:

```powershell
npm install
npm run dev
```

3. 默认本地地址: `http://localhost:3000`（若端口被占用，Next 会轮询 3001/3002）。

## 关键 API 概览
- `GET /api/gateways` — 列出所有网关（含 agents）
- `POST /api/gateways/register` — 远端网关注册/心跳/注销（必须带 token）
- `POST /api/gateways/token` — 为指定 gateway 生成 token（返回原始 token）
- `GET /api/gateways/[id]/test` — 测试与指定网关连通性（会使用解密后 token 发起请求）
- `POST /api/agents` — 创建本地 agent

> 注意: 注册接口已强制要求 token 验证；若远端未携带 token，请先在管理端为其生成并下发。

## 网关注册与验证（运维步骤）
1. 在管理端生成 token:

```bash
curl -X POST http://localhost:3002/api/gateways/token \
  -H "Content-Type: application/json" \
  -d '{"gatewayId":"<GATEWAY_ID>","expiresIn":24}'
```

2. 将返回的 `token` 传给远端管理员或在远端配置为 `GATEWAY_TOKEN`。
3. 远端在调用注册端点时必须添加请求头 `Authorization: Bearer <token>`。
4. 验证注册：
   - 查看 `GET /api/gateways` 列表
   - 或调用 `GET /api/gateways/<id>/test` 检查连通性和 `hasToken` 状态

## 常见故障与排查
- 无法注册（401）: 检查 token 是否正确、是否使用 `Authorization` 或 `X-Gateway-Token` 头。
- 无法连通（connection unreachable）: 检查 `gateway.url` 配置、网络连通性、防火墙和远端 `/api/health` 是否可达。
- 跨网关消息失败: 检查在 `src/lib/gateway-router.ts` 发送消息时是否使用了解密后的 token（已修复测试路由）。

## 代码位置参考
- API: `src/app/api/gateways`（register、token、[id]/test、messages）
- 网关路由/队列: `src/lib/gateway-router.ts`
- Token 加密: `src/lib/encryption.ts`
- 验证中间件: `src/lib/gateway-auth.ts`
- 前端注册表单: `src/components/dashboard/RemoteGatewayForm.tsx`

## 日常运维命令
- 停止所有项目相关 Node 进程（谨慎）:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'agent-platform-v2' } | Select-Object -ExpandProperty ProcessId | ForEach-Object { Stop-Process -Id $_ -Force }
```

- 检查端口占用:

```powershell
Get-NetTCPConnection -LocalPort 3000,3001,3002,3003 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess,State
```

## 接手注意事项
- `OPENCLAW_ENCRYPTION_KEY` 环境变量用于 AES-256-GCM token 加密；生产环境务必设置为强随机值。
- 若要强制回滚到“允许无 token 注册”的兼容模式，需要修改 `src/app/api/gateways/register/route.ts`（不推荐）。
- 若要增强安全性，建议新增 `verified` 字段并执行 DB 迁移，区分“已验证”和“未验证”网关。

---

作者: 自动生成交接文件
日期: 2026-03-20
