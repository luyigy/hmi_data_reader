---
name: feishu-doc-import
description: Guide for creating, importing, and syncing local Markdown documentation to Feishu Cloud Docs using lark-cli, updating .env, and publishing showcase records to Miaoda PM.
---

# Feishu Cloud Doc Import & Showcase Sync Skill

Use this skill when local Markdown documentation needs to be automatically converted and published as a real Feishu Cloud Doc (e.g. when Feishu doc links return 404, are blank, or contain placeholder tokens like `doxcnAgentPlatformV2Showcase2026`).

## Overview

This workflow automates:
1. Converting local Markdown files (e.g., [`docs/AGENT_PLATFORM_V2_SHOWCASE.md`](file:///data1/code/agent-platform-v2/docs/AGENT_PLATFORM_V2_SHOWCASE.md)) into Feishu Cloud Docs via `lark-cli`.
2. Extracting the generated online Feishu Doc URL (`https://*.feishu.cn/docx/...`).
3. Updating `.env` with `FEISHU_DOC_URL=<URL>`.
4. Syncing the updated documentation URL to showcase endpoints (e.g. Miaoda PM showcase records via [`scripts/submit-to-miaoda-pm.mjs`](file:///data1/code/agent-platform-v2/scripts/submit-to-miaoda-pm.mjs)).

---

## 1. Programmatic Import via `feishu-document-import.ts`

To import Markdown content in Node.js / TypeScript code:

```typescript
import fs from 'fs';
import { importMarkdownAsFeishuDocument } from '../src/lib/feishu-document-import';

const content = fs.readFileSync('docs/AGENT_PLATFORM_V2_SHOWCASE.md', 'utf8');
const docUrl = await importMarkdownAsFeishuDocument({
  content,
  name: 'Agent Platform v2 Showcase Document',
});

console.log('Feishu Doc URL:', docUrl);
```

### Under the Hood (`lark-cli` invocation)

The module creates a temporary directory with `plan.md` (stripping frontmatter and top `#` title headers for clean rendering) and executes:

```bash
lark-cli docs +create --as bot --api-version v2 \
  --title "<Title>" \
  --doc-format markdown \
  --content @plan.md \
  --format json
```

---

## 2. Automatic Import & Miaoda PM Sync Script

Run the showcase submission script directly:

```bash
node scripts/submit-to-miaoda-pm.mjs
```

### Behaviors:
- **Placeholder Detection**: Checks if `FEISHU_DOC_URL` is empty or contains placeholder string `doxcnAgentPlatformV2Showcase2026`.
- **Auto-Import**: If invalid, automatically triggers `importMarkdownAsFeishuDocument` using [`docs/AGENT_PLATFORM_V2_SHOWCASE.md`](file:///data1/code/agent-platform-v2/docs/AGENT_PLATFORM_V2_SHOWCASE.md).
- **Environment Persist**: Automatically writes the new URL back into [`.env`](file:///data1/code/agent-platform-v2/.env) as `FEISHU_DOC_URL=<new_url>`.
- **Showcase Update**: Queries Miaoda PM API for existing project record (by `name`) and updates via `PATCH` (or creates via `POST`).

---

## 3. Manual `lark-cli` CLI Workflow

If manual CLI execution is required from terminal:

```bash
# Prepare Markdown file (e.g., /tmp/doc.md)
# Execute lark-cli doc creation
lark-cli docs +create --as bot --api-version v2 \
  --title "Project Showcase Doc" \
  --doc-format markdown \
  --content @/tmp/doc.md \
  --format json
```

---

## 4. Verification Checklist

1. **Verify Doc URL**: Open the generated URL in browser to confirm content renders correctly without 404.
2. **Verify `.env`**: Ensure `FEISHU_DOC_URL` is updated in [`.env`](file:///data1/code/agent-platform-v2/.env).
3. **Verify Miaoda PM Sync**:
   ```bash
   node scripts/submit-to-miaoda-pm.mjs
   ```
   Confirm HTTP output returns status 200/201 with matching Record ID.
