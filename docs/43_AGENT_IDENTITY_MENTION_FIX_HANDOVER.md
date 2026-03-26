# 43 Agent Identity Management & @Mention Fix Handover

## Date
2026-03-26

## Overview

This document covers the implementation of **Agent Identity Management** system to solve @mention detection issues and provide user-friendly nicknames for agents.

---

## Part 1: Problems Solved

### Problem 1: @Mention Stripping Not Working

**Issue**: When users sent `@Platform Local Claude hello`, the agent received the full message including `@Platform Local Claude`, causing Claude CLI to interpret `@Platform` as a command.

**Root Cause**: The regex `/^@[\S\s]+?\s+/` used non-greedy matching, which only matched up to the first space:
- Input: `@Platform Local Claude hello`
- Matched: `@Platform ` (stopped at first space)
- Result: `Local Claude hello` (wrong!)

**Solution**: Implemented multi-layer stripping with greedy regex fallback:

1. **Primary**: Use matched alias from detection
   ```typescript
   if (matchedAlias && content.startsWith(`@${matchedAlias}`)) {
     contentForTaskRoom = content.slice(`@${matchedAlias}`.length).trim();
   }
   ```

2. **Fallback 1**: Greedy regex `/^@.+\s+(.+)$/s`
3. **Fallback 2**: Non-greedy regex `/^@\S+\s+(.*)$/s`

**Files Modified**:
- `src/lib/live-room.ts:867-901` - Task Room message stripping
- `src/lib/live-room-delivery.ts:240-260` - Continuation message stripping
- `src/lib/acpx/runner.ts:565-597` - Double-insurance stripping in prompt building

---

### Problem 2: Multiple Agents with Same Name

**Issue**: When multiple gateways have agents named "claude" or "codex", users couldn't distinguish which one they're mentioning.

**Root Cause**: Display names were generic ("Claude", "Codex") without gateway context.

**Solution**: Implemented **Agent Identity Management** system with:

1. **Database Schema Extension**:
   - `Agent.userNickname` - User-defined nickname (e.g., "小C")
   - `Agent.roleDescription` - Role description (e.g., "前端开发专家")
   - `Agent.colorTag` - Color for UI differentiation
   - `Agent.emojiIcon` - Emoji icon (e.g., "🤖")
   - `LiveRoomMember.userNickname` - Room-specific nickname
   - `LiveRoomMember.shortAlias` - Short alias for @mentions

2. **Smart Naming System** (`src/lib/agent-identity.ts`):
   - `originalName` - Original name from gateway (e.g., "main", "claude-3.5")
   - `rawName` - Gateway + type (e.g., "Linux Gateway - Claude")
   - `displayName` - Nickname OR original name
   - Priority: Nickname > Short Alias > Original Name

3. **Mention Detection Priority**:
   ```typescript
   // Priority order for @mention matching
   1. Room-specific nickname (userNickname on LiveRoomMember)
   2. Agent-level nickname (userNickname on Agent)
   3. Short alias (shortAlias)
   4. Original name (Agent.name)
   5. Display name (generated)
   ```

---

### Problem 3: Session Continuation with @Mentions

**Issue**: When resuming a session, the continuation message still contained the @mention, causing Claude CLI to misinterpret it.

**Solution**: Use stripped content for continuation message:
```typescript
// Before
continuationMessage: latestSession?.continuationSessionId ? sourceMessage.content : undefined

// After
continuationMessage: latestSession?.continuationSessionId ? contentForAgent : undefined
```

---

## Part 2: Database Changes

### Schema Extensions

```prisma
model Agent {
  // ... existing fields

  // New fields for Agent Identity Management
  userNickname     String?   // 用户自定义昵称
  roleDescription  String?   // 角色描述
  colorTag         String?   // 颜色标签
  emojiIcon        String?   // 表情图标
}

model LiveRoomMember {
  // ... existing fields

  // New fields for Agent Identity Management
  userNickname     String?   // 房间专属昵称
  shortAlias       String?   // 简短别名，用于 @提及
}
```

### Migration

```bash
npx prisma db push
```

---

## Part 3: API Endpoints

### GET /api/agents
List all agents with identity information.

**Response**:
```json
{
  "agents": [
    {
      "id": "agent_id",
      "agentKey": "gateway-id:agent-type",
      "originalName": "main",           // From gateway
      "rawName": "Linux Gateway - Claude", // Gateway + type
      "displayName": "main",             // Nickname or original
      "userNickname": null,
      "shortAlias": null,
      "roleDescription": null,
      "colorTag": "#4A90E2",
      "emojiIcon": "🤖",
      "status": "online",
      "type": "claude",
      "gateway": { "id": "...", "name": "Linux Gateway" }
    }
  ]
}
```

### PATCH /api/agents/[id]
Update agent identity information.

**Body**:
```json
{
  "userNickname": "小C",
  "roleDescription": "前端开发专家",
  "emojiIcon": "🎨",
  "colorTag": "#4A90E2"
}
```

### PATCH /api/live-rooms/[roomId]/members/[memberId]
Set room-specific nickname.

**Body**:
```json
{
  "userNickname": "审查员",
  "shortAlias": "reviewer"
}
```

---

## Part 4: UI - Agent Management Page

### URL: `/agents`

**Features**:
- View all agents grouped by gateway
- See original names from gateway
- Set custom nicknames
- Choose emoji icons and colors
- Set role descriptions

**Card Display** (without nickname):
```
🤖 main
   Linux Gateway 10.0.8.4 - Openclaw
   openclaw
```

**Card Display** (with nickname):
```
🤖 小C
   main
   Linux Gateway 10.0.8.4 - Openclaw
   openclaw
```

---

## Part 5: Files Modified

### Core Logic
| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Added Agent identity fields, LiveRoomMember identity fields |
| `src/lib/agent-identity.ts` | **NEW** - Smart naming system, mention aliases |
| `src/lib/live-room.ts` | Updated mention detection to use nicknames, improved stripping |
| `src/lib/live-room-delivery.ts` | Fixed continuation message stripping |
| `src/lib/acpx/runner.ts` | Double-insurance @mention stripping in prompt |
| `src/lib/task-room.ts` | Added debug logging, clear messages API |

### API Routes
| File | Purpose |
|------|---------|
| `src/app/api/agents/route.ts` | **NEW** - List agents with identity info |
| `src/app/api/agents/[id]/route.ts` | **NEW** - Update agent nickname |
| `src/app/api/live-rooms/[id]/members/[memberId]/route.ts` | **NEW** - Room-specific nickname |
| `src/app/api/live-rooms/[id]/clear-task-room/route.ts` | **NEW** - Clear task room history |

### UI Components
| File | Purpose |
|------|---------|
| `src/app/agents/page.tsx` | **NEW** - Agent management UI |
| `src/components/live-room/LiveRoomWorkspace.tsx` | Added "管理昵称" link |

### Documentation
| File | Purpose |
|------|---------|
| `docs/43_AGENT_IDENTITY_MENTION_FIX_HANDOVER.md` | This document |

---

## Part 6: Usage Examples

### Setting Agent Nicknames

```bash
# Via API
curl -X PATCH http://localhost:3010/api/agents/{AGENT_ID} \
  -H "Content-Type: application/json" \
  -d '{
    "userNickname": "小C",
    "emojiIcon": "🎨",
    "colorTag": "#4A90E2"
  }'

# Via UI
# Visit http://localhost:3010/agents
# Click "Edit" on any agent card
# Set nickname and save
```

### Using Nicknames in Live Room

After setting nicknames:
```
# Before
@Platform Local Claude hello

# After (with nickname "小C")
@小C hello
```

The mention detection will automatically:
1. Match "小C" to the correct agent
2. Strip the @mention before passing to Claude
3. Claude receives: "hello"

---

## Part 7: Debug Logging

Enable debug logging to see mention detection details:

```bash
# .env
DEBUG_MENTION_DETECTION=true
```

**Log Output**:
```
[Mention Detection] Content: @小C hello world
[Mention Detection] Checking 小C, aliases: ["小C", "local-claude", "Platform Local Claude"]
[Mention Detection] ✓ Explicit match for 小C: { index: 0, matchedAlias: '小C', matchedLength: 2 }
[Task Room] Stripped @mention using matched alias: { original: '@小C hello world', matchedAlias: '小C', stripped: 'hello world' }
```

---

## Part 8: Platform Local Agents

### What are Platform Local Agents?

**Platform Local agents** are built-in agents that run CLI tools directly on the local machine:

| Agent ID | Harness | Description |
|----------|--------|-------------|
| `platform-local:{hostname}:claude` | Claude Code CLI | Runs `claude` command locally |
| `platform-local:{hostname}:codex` | Codex CLI | Runs `codex` command locally |

**Key Characteristics**:
- `backend: platform_local` - Runs locally, not through a gateway
- `gatewayId: null` - No associated gateway
- `hostname` - Server hostname for differentiation across servers
- Available in all Live Rooms by default

### Multi-Server Support

**✅ UPDATED**: Platform Local agents now have database records with hostname!

When running on multiple servers:
- Server `prod-server-01` → `Claude (prod-server-01)`, alias `@prod-server-01-claude`
- Server `prod-server-02` → `Claude (prod-server-02)`, alias `@prod-server-02-claude`

See [docs/44_PLATFORM_LOCAL_AGENT_HOSTNAME_SUPPORT.md](44_PLATFORM_LOCAL_AGENT_HOSTNAME_SUPPORT.md) for full implementation details.

### Nicknames for Platform Local Agents

**Global nicknames ARE NOW supported**:
```bash
# Set global nickname via API
curl -X PATCH "http://localhost:3010/api/agents/platform-local:prod-server-01:claude" \
  -H "Content-Type: application/json" \
  -d '{"userNickname": "小C"}'

# Or use room-specific nicknames
curl -X PATCH "http://localhost:3010/api/live-rooms/{roomId}/members/{memberId}" \
  -H "Content-Type: application/json" \
  -d '{"userNickname": "审查员", "shortAlias": "reviewer"}'
```

---

## Part 9: Known Issues & TODO

### Known Issues

1. **Live Room Member Nicknames**: Room-specific nicknames are implemented but the UI doesn't expose them yet.

### TODO (Future Work)

1. **Phase 3 - Complete Agent Management UI**:
   - [ ] Add agent creation form
   - [ ] Add agent deletion
   - [ ] Bulk edit capabilities

2. **Phase 4 - Mention UX Improvements**:
   - [ ] Tab autocomplete for @mentions
   - [ ] Mention preview popup
   - [ ] Highlight matching agents in real-time

3. **Phase 5 - Live Room Integration**:
   - [ ] Inline nickname editing in Live Room
   - [ ] Show nicknames in message headers
   - [ ] Color-coded messages by agent

4. ~~**Create Platform Local Agents**~~ ✅ **COMPLETED** - See [docs/44_PLATFORM_LOCAL_AGENT_HOSTNAME_SUPPORT.md](44_PLATFORM_LOCAL_AGENT_HOSTNAME_SUPPORT.md)
   - Platform Local agents now have database records with hostname
   - Global nicknames are now supported
   - Agents are differentiated by server hostname

---

## Part 9: Testing Checklist

### @Mention Stripping
- [ ] Single-word name: `@claude hello` → `hello`
- [ ] Multi-word name: `@Platform Local Claude hello` → `hello`
- [ ] With nickname: `@小C hello` → `hello`
- [ ] Without @mention: `hello` → `hello`

### Session Continuation
- [ ] First message creates session
- [ ] Second message resumes same session
- [ ] Context is preserved across messages

### Agent Management
- [ ] Can view all agents
- [ ] Can set nickname
- [ ] Nickname is used in @mentions
- [ ] Color and emoji are saved

---

## Part 10: Rollback Plan (if needed)

If issues arise:

1. **Revert @mention stripping changes**:
   ```bash
   git revert <commit-hash>
   ```

2. **Remove identity fields** (keep data, just ignore):
   - Set `userNickname`, `shortAlias`, etc. to null in code

3. **Restore simple mention detection**:
   - Use original regex without nickname support

---

## Summary

**What was implemented**:
1. ✅ Fixed @mention stripping with greedy regex
2. ✅ Agent Identity Management system (database + API + UI)
3. ✅ Agent management page at `/agents`
4. ✅ Debug logging for troubleshooting
5. ✅ Session continuation fixes

**What users can do now**:
1. Visit `/agents` to see all agents
2. Set nicknames like "小C", "老王" for easier @mentions
3. Use nicknames in Live Room: `@小C 请用中文回复`
4. Distinguish between agents with same original names
