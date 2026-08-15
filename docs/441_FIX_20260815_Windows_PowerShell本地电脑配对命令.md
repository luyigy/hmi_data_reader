---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · Windows PowerShell 本地电脑配对命令

## 问题

“接入我的本地电脑”弹窗只展示以下 Unix 命令：

```sh
curl -fsSL http://<平台地址>/runner.js | node - --pairing-token=<TOKEN>
```

在 Windows PowerShell 5.1 中，`curl` 默认是 `Invoke-WebRequest` 的别名，后者不支持 curl 的组合参数 `-fsSL`，因此命令在下载 Runner 前就报“找不到与参数名称 fsSL 匹配的参数”。

## 修复

弹窗同时展示目标系统对应命令，不根据浏览器环境猜测目标电脑：

```powershell
curl.exe -fsSL http://<平台地址>/runner.js | node - --pairing-token=<TOKEN>
```

```sh
curl -fsSL http://<平台地址>/runner.js | node - --pairing-token=<TOKEN>
```

Windows 命令明确调用系统自带的 `curl.exe`，绕过 PowerShell 别名；macOS/Linux 命令保持不变。两个复制按钮分别复制对应命令，命令中的管道符与 `runner.js` 路径保持为原始连续文本。

## 验收

1. 登录平台，点击“+ 接入我的本地电脑”。
2. Windows PowerShell 运行弹窗中的 `curl.exe` 命令；不要手工改成 `curl`。
3. 看到 `Paired remote node: <节点名>` 后，确认平台出现对应远程节点。
4. 若票据已超过 10 分钟或已执行过一次，关闭弹窗并重新生成；不要复用旧 Token。

关联 PLAN：`docs/430_PLAN_20260815_多用户认证与WebUI配对接入.md`。
