# 44 Platform Local Agent Hostname Support

## Date
2026-03-26

## Overview

Implemented **hostname support** for Platform Local agents to differentiate between agents running on different servers. Platform Local agents now have database records with hostname field, enabling global nicknames.

---

## Problem Solved

### Original Issue
When running the platform on multiple servers:
- Server A (host: `prod-server-01`) has "Platform Local Claude"
- Server B (host: `prod-server-02`) also has "Platform Local Claude"
- Users couldn't distinguish which server's agent they're mentioning
- Platform Local agents had no database records, so no global nicknames

### Solution
1. Added `hostname` field to `Agent` schema
2. Platform Local agents are now created in database with server's hostname
3. Display names include hostname: `Claude (prod-server-01)` vs `Claude (prod-server-02)`
4. Global nicknames now supported for Platform Local agents

---

## Database Changes

### Schema Extension

```prisma
model Agent {
  // ... existing fields

  hostname String?  // NEW: Server hostname for platform_local agents

  @@index([hostname])  // NEW: Index for hostname queries
}
```

### Migration
```bash
npx prisma db push
```

---

## New File: platform-local-init.ts

**Location**: `src/lib/platform-local-init.ts`

### Functions

| Function | Purpose |
|----------|---------|
| `getServerHostname()` | Get current server's hostname via `os.hostname()` |
| `ensurePlatformLocalAgents()` | Create/update platform local agents in DB on startup |
| `getAllPlatformLocalAgents()` | Get all platform local agents across all servers |
| `getLocalPlatformAgents()` | Get platform local agents for current server only |
| `generatePlatformLocalAgentKey(type, hostname)` | Generate agent key: `platform_local:{hostname}:{type}` |

### Agent ID Format

Platform Local agents now have IDs like:
```
platform-local:prod-server-01:claude
platform-local:prod-server-01:codex
platform-local:prod-server-02:claude
```

---

## Updated Files

### Core Logic

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Added `hostname` field to Agent model |
| `src/lib/agent-identity.ts` | Updated `generateDisplayName()`, `generateShortAlias()`, `buildAgentIdentity()` to use hostname |
| `src/lib/platform-local-init.ts` | **NEW** - Platform local agent initialization |
| `src/lib/acpx/catalog.ts` | Updated `deriveGatewayHarnessOptions()` to fetch platform local agents from DB with nicknames |
| `src/lib/live-room.ts` | Updated `serializeLiveRoomMember()` to prefer current nickname from `agentRecord`; updated `serializeLiveRoomSummary()` to use nickname |
| `src/app/api/agents/route.ts` | Now calls `ensurePlatformLocalAgents()`, includes hostname in response |
| `src/app/api/agents/[id]/route.ts` | Removed hardcoded platform local check, added hostname support |
| `src/app/api/live-rooms/route.ts` | Include `agentRecord` in queries for current nickname |
| `src/app/api/live-rooms/[id]/route.ts` | Include `agentRecord` in queries for current nickname |
| `src/app/api/live-rooms/[id]/members/route.ts` | Use nickname when adding new members |
| `src/app/agents/page.tsx` | Added hostname field, fixed error handling, updated grouping by hostname |

---

## API Changes

### GET /api/agents

**New Response Field**:
```json
{
  "agents": [
    {
      "id": "platform-local:prod-server-01:claude",
      "hostname": "prod-server-01",
      "displayName": "Claude (prod-server-01)",
      "rawName": "prod-server-01 - Claude",
      "isPlatformLocal": true,
      "backend": "platform_local"
    }
  ]
}
```

### PATCH /api/agents/[id]

**Now works for Platform Local agents** (previously returned error):

```bash
# Now you can set global nicknames for Platform Local agents
curl -X PATCH "http://localhost:3010/api/agents/platform-local:prod-server-01:claude" \
  -H "Content-Type: application/json" \
  -d '{
    "userNickname": "小C",
    "emojiIcon": "🎨",
    "colorTag": "#4A90E2"
  }'
```

---

## Display Name Logic

### With Hostname
```
Agent: claude, Hostname: prod-server-01
→ Display: "Claude (prod-server-01)"
→ Alias: "prod-server-01-claude"
```

### Without Hostname (fallback)
```
Agent: claude, Hostname: null
→ Display: "Claude (本地)"
→ Alias: "local-claude"
```

---

## Live Room Nickname Sync

### Problem: Nicknames not showing in Live Rooms
After setting a nickname in `/agents`, existing Live Rooms still showed the old name. This was because:
1. Live Room members stored a snapshot `displayName` when added to the room
2. The catalog didn't include nicknames when listing available agents
3. New rooms used the agent's original name instead of nickname

### Solution
1. **Include `agentRecord` in queries** - All Live Room API endpoints now fetch `agentRecord` to get the current nickname
2. **Prefer current nickname** - `serializeLiveRoomMember()` now uses `agentRecord.userNickname` over the stored snapshot
3. **Updated catalog** - `listLiveRoomCatalogAgents()` now includes `userNickname` and `hostname`
4. **Room creation uses nickname** - New rooms and added members use the nickname from the start

### Result
- **Existing rooms** automatically show the new nickname without needing to recreate
- **New rooms** use the nickname from the start
- **Room dropdown** shows nicknames when selecting agents

---

## Usage Examples

### Server Startup
```typescript
// In your server initialization code
import { ensurePlatformLocalAgents } from '@/lib/platform-local-init';

await ensurePlatformLocalAgents();
```

### User Mentions
```
# Before (ambiguous)
@Platform Local Claude help me

# After (with hostname differentiation)
@prod-server-01-claude help me

# Or with nickname
@小C help me
```

---

## Testing Checklist

- [ ] Platform Local agents appear in `/api/agents` with hostname
- [ ] Can set global nickname for Platform Local agents
- [ ] Display name shows hostname: `Claude (server-01)`
- [ ] Short alias works: `@server-01-claude`
- [ ] Different servers show different agents
- [ ] Room-specific nicknames still work

---

## Rollback Plan

If issues arise:

1. **Ignore hostname field** in code (set to null)
2. **Revert API changes** to not call `ensurePlatformLocalAgents()`
3. **Keep schema** - the field is optional and indexed, no harm in keeping

---

## Summary

**What was implemented**:
1. ✅ Added `hostname` field to Agent schema
2. ✅ Created `platform-local-init.ts` for agent initialization
3. ✅ Updated agent identity logic to use hostname
4. ✅ Platform Local agents now have database records
5. ✅ Global nicknames now work for Platform Local agents
6. ✅ Live Rooms now sync with current nicknames automatically

**What users can do now**:
1. See which server a Platform Local agent belongs to
2. Set global nicknames like "小C" for Platform Local Claude
3. Distinguish between agents on different servers via hostname
4. Use `@server-01-claude` style mentions
5. **Nicknames in Live Rooms update immediately** - no need to recreate rooms
