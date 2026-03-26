# Windows Server Setup Handover

## Date
2026-03-26

## Purpose
Document the Windows server configuration for running the agent platform on port 3010 with WireGuard network access.

## Changes Made

### 1. Package.json Scripts Updated
**File**: `package.json`

Changed dev and start scripts to bind to all interfaces (`0.0.0.0`) and use port 3010 explicitly:

```json
"scripts": {
  "predev": "prisma generate",
  "dev": "next dev -H 0.0.0.0 -p 3010",
  "build": "next build",
  "start": "next start -H 0.0.0.0 -p 3010",
  "lint": "next lint",
  "postinstall": "prisma generate"
}
```

**Why**: Next.js doesn't reliably read `PORT` from `.env` on Windows. Using `-p 3010` and `-H 0.0.0.0` in the script is the most reliable method.

### 2. Environment Configuration
**File**: `.env`

```
DATABASE_URL="file:./dev.db"

# Next.js port
PORT=3010

# WebSocket (optional - defaults to current origin if not set)
# NEXT_PUBLIC_SOCKET_URL=http://localhost:3000
SOCKET_PORT=3011
NEXT_PUBLIC_SOCKET_PORT=3011
```

**Note**: WebSocket moved to 3011 to avoid conflict with main Next.js port.

## Windows Firewall Setup

### PowerShell Commands (Run as Administrator)

```powershell
# Allow inbound traffic on port 3010 (Next.js)
New-NetFirewallRule -DisplayName "Agent Platform 3010" -Direction Inbound -LocalPort 3010 -Protocol TCP -Action Allow -Profile Any

# Allow inbound traffic on port 3011 (WebSocket)
New-NetFirewallRule -DisplayName "Agent Platform WebSocket 3011" -Direction Inbound -LocalPort 3011 -Protocol TCP -Action Allow -Profile Any

# Verify rules
Get-NetFirewallRule | Where-Object {$_.DisplayName -like "*Agent*"} | Format-Table DisplayName, Enabled, Direction, Profile
```

### Alternative: Using netsh (older Windows)

```cmd
netsh advfirewall firewall add rule name="Agent Platform 3010" dir=in action=allow protocol=TCP localport=3010
netsh advfirewall firewall add rule name="Agent Platform 3011" dir=in action=allow protocol=TCP localport=3011
```

## WireGuard Network Access

To find your WireGuard interface IP:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -like "*WireGuard*"} | Select-Object InterfaceAlias, IPAddress
```

Then access via: `http://<wireguard-ip>:3010`

## Running the Server

```bash
# Development mode
npm run dev

# Production mode
npm run build
npm start
```

## Port Summary

| Service | Port | Purpose |
|---------|------|---------|
| Next.js | 3010 | Main web application |
| WebSocket | 3011 | Socket.IO server |

## Troubleshooting

### Server running on wrong port
- Check `package.json` scripts include `-p 3010`
- Next.js doesn't reliably read PORT from .env on Windows

### Can't access from WireGuard network
- Verify firewall rules are created: `Get-NetFirewallRule -DisplayName "*Agent*"`
- Ensure Next.js binds to `0.0.0.0` not `localhost`
- Check WireGuard interface is up: `Get-NetAdapter | Where-Object {$_.Name -like "*WireGuard*"}`
