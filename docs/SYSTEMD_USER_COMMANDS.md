# Systemd User Commands

## 适用服务

- `agent-platform-dev.service`
- `agent-platform-feishu.service`

## 查看状态

```bash
systemctl --user status agent-platform-dev.service
systemctl --user status agent-platform-feishu.service
```

## 重启服务

```bash
systemctl --user restart agent-platform-dev.service
systemctl --user restart agent-platform-feishu.service
```

## 停止服务

```bash
systemctl --user stop agent-platform-dev.service
systemctl --user stop agent-platform-feishu.service
```

## 启动服务

```bash
systemctl --user start agent-platform-dev.service
systemctl --user start agent-platform-feishu.service
```

## 查看实时日志

```bash
journalctl --user -u agent-platform-dev.service -f
journalctl --user -u agent-platform-feishu.service -f
```

## 查看最近日志

```bash
journalctl --user -u agent-platform-dev.service -n 200 --no-pager
journalctl --user -u agent-platform-feishu.service -n 200 --no-pager
```

## 查看是否开机/登录自启

```bash
systemctl --user is-enabled agent-platform-dev.service
systemctl --user is-enabled agent-platform-feishu.service
```

## 重新加载 service 文件

当你修改了 `deploy/systemd-user/*.service` 后，执行：

```bash
systemctl --user daemon-reload
systemctl --user restart agent-platform-dev.service
systemctl --user restart agent-platform-feishu.service
```

## 安装或重新安装本仓库自带 service

```bash
cd /data1/code/agent-platform-v2
./scripts/install-systemd-user-services.sh
```

## 查看服务是否真的在运行

```bash
ps -ef | rg 'next dev -H 0.0.0.0 -p 3010|feishu-standalone-monitor|npm run feishu:runtime'
```

## 常见判断

### Web 正常

看到类似：

```text
agent-platform-dev.service ... active (running)
```

### Feishu runtime 正常

看到类似：

```text
agent-platform-feishu.service ... active (running)
```

并且日志里出现：

```text
[ws] ws client ready
```

### 配置改了但没生效

通常是忘了：

```bash
systemctl --user daemon-reload
```

### 不要再用的方式

不推荐再长期使用：

```bash
nohup npm run dev > logs/xxx 2>&1 &
nohup npm run feishu:runtime > logs/xxx 2>&1 &
```

原因：

- 不会自动重启
- 进程关系不可控
- 日志分散
- 容易残留孤儿进程
