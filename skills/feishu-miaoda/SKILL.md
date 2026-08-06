---
name: feishu-miaoda
description: Standard operating guide for all agents to interact, sync, and publish project deliverables, showcase records, and Feishu Cloud Docs with Feishu Miaoda (飞书秒搭 / Miaoda PM).
---

# Feishu Miaoda (飞书秒搭 / Miaoda PM) Integration Skill

This skill defines the standard operating procedures for all AI agents (Codex, Claude Code, Antigravity, Pi Agent, Deepseek, etc.) to work with **Feishu Miaoda** (飞书秒搭 / Miaoda PM low-code platform).

Use this skill whenever:
- Publishing or updating project showcase records to Feishu Miaoda PM database.
- Integrating Feishu Cloud Docs created via `lark-cli` into Miaoda PM showcase records.
- Working with Feishu Miaoda PM OpenAPI REST endpoints.
- Verifying or configuring Miaoda PM environment settings.

---

## 1. Core Concepts & Architectural Overview

**Feishu Miaoda (飞书秒搭 / Miaoda PM)** serves as the central showcase and low-code project management portal for Agent Platform projects.

```
+-------------------+        +----------------------------+        +--------------------------+
|  Local Markdown   | -----> |   Feishu Cloud Doc API     | -----> |  Feishu Miaoda (秒搭 PM)  |
|  (SHOWCASE.md)    |        |  (lark-cli / docx import)  |        |  OpenAPI (POST/PATCH)    |
+-------------------+        +----------------------------+        +--------------------------+
```

Key Components:
- **Feishu Cloud Doc Integration**: Markdown documents auto-imported to online Feishu Docs (`https://feishu.cn/docx/...`).
- **Miaoda PM OpenAPI**: Restful JSON endpoints to manage project records in Miaoda PM low-code database.
- **Showcase Helper Script**: [`scripts/submit-to-miaoda-pm.mjs`](file:///data1/code/agent-platform-v2/scripts/submit-to-miaoda-pm.mjs) handles auto-doc creation, `.env` updating, and Miaoda PM API sync.

---

## 2. Required Environment Variables

All agents must verify that these environment variables are set in [`.env`](file:///data1/code/agent-platform-v2/.env):

| Variable Name | Description | Example / Usage |
|---|---|---|
| `FEISHU_MIAODA_PM_API_KEY` | Bearer token for Miaoda PM OpenAPI authorization | Required for GET/POST/PATCH requests |
| `FEISHU_MIAODA_PM_NEW_API_URL` | Miaoda PM database API endpoint URL | Endpoint for querying and posting showcase records |
| `FEISHU_DOC_URL` | Online Feishu Cloud Doc URL | Synced to Miaoda PM record's `docUrls` field |

---

## 3. Standard Agent Workflow for Miaoda PM Sync

Every agent updating project deliverables or completing milestones **MUST** follow this 4-step workflow:

### Step 1: Update Local Showcase Documentation
Ensure [`docs/AGENT_PLATFORM_V2_SHOWCASE.md`](file:///data1/code/agent-platform-v2/docs/AGENT_PLATFORM_V2_SHOWCASE.md) contains accurate title, highlights, and architecture details.

### Step 2: Execute Miaoda PM Sync Script
Run the automated submission script from the project root:

```bash
node scripts/submit-to-miaoda-pm.mjs
```

To specify a custom Feishu Doc URL directly:
```bash
node scripts/submit-to-miaoda-pm.mjs --doc-url=https://feishu.cn/docx/<your_doc_token>
```

### Step 3: Script Automation Behaviors
- **Doc Link Validation**: Detects missing or placeholder `FEISHU_DOC_URL` (`doxcnAgentPlatformV2Showcase2026`).
- **Auto Doc Creation**: Invokes `importMarkdownAsFeishuDocument` via `lark-cli` if needed.
- **`.env` Persistence**: Auto-saves the created `FEISHU_DOC_URL` into `.env`.
- **Miaoda PM Record Upsert**:
  - Performs `GET` on `FEISHU_MIAODA_PM_NEW_API_URL` searching for record named `'Agent Platform v2'`.
  - Performs `PATCH` if record exists, or `POST` if creating new.

### Step 4: Verify API Response
Confirm console output logs:
- `HTTP Status: 200 OK` or `201 Created`
- `✅ 项目已成功更新/创建！Record ID: <ID>`

---

## 4. Miaoda PM Database Schema Reference

When invoking Miaoda PM REST endpoints directly or extending scripts, adhere strictly to the database schema:

```json
{
  "name": "Agent Platform v2",
  "description": "面向企业级复杂研发场景的高能 AI Agent 协作平台...",
  "resultDescription": "1. 👥 多 Agent Live Room\n2. ⚡️ 飞书卡片 50ms Fast-Ack\n...",
  "categoryId": "3d2ce773-9f06-49b7-b9b9-04217e09cd3e",
  "categoryName": "内部工具",
  "tags": ["工程", "测试"],
  "gitUrl": "file:///data1/code/agent-platform-v2",
  "projectUrl": "",
  "docUrls": [
    {
      "name": "说明文档",
      "url": "https://feishu.cn/docx/..."
    }
  ],
  "isShowcase": true,
  "status": "completed",
  "priority": "P2"
}
```

---

## 5. Troubleshooting & Edge Cases

1. **Missing Environment Variables**:
   If error `❌ 缺少环境变量 FEISHU_MIAODA_PM_NEW_API_URL 或 FEISHU_MIAODA_PM_API_KEY` occurs, check [`.env`](file:///data1/code/agent-platform-v2/.env) and ensure keys are populated.
2. **`lark-cli` Execution Failure**:
   If automatic doc creation fails, inspect `lark-cli` status or fallback to passing `--doc-url=<valid_url>`.
3. **HTTP 401 / 403 Errors**:
   Verify token freshness in `FEISHU_MIAODA_PM_API_KEY`.

---

## 6. Registration & Discovery

This skill is registered in:
- [`AGENTS.md`](file:///data1/code/agent-platform-v2/AGENTS.md)
- [`CLAUDE.md`](file:///data1/code/agent-platform-v2/CLAUDE.md)
- `skills/feishu-miaoda/SKILL.md` & `skills/feishu-miaodao/SKILL.md`
- `.claude/skills/feishu-miaoda/SKILL.md` & `.claude/skills/feishu-miaodao/SKILL.md`
