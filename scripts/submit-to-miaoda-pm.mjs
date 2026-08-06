import fs from 'fs';

// Parse .env file manually
if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...vals] = trimmed.split('=');
      const val = vals.join('=').replace(/^["']|["']$/g, '');
      process.env[key.trim()] = val.trim();
    }
  }
}

// Parse CLI arguments (e.g. --doc-url=https://...)
const cliArgs = process.argv.slice(2);
let cliDocUrl = '';
for (const arg of cliArgs) {
  if (arg.startsWith('--doc-url=')) {
    cliDocUrl = arg.slice('--doc-url='.length).trim();
  }
}

const API_KEY = process.env.FEISHU_MIAODA_PM_API_KEY;
const NEW_PROJECT_URL = process.env.FEISHU_MIAODA_PM_NEW_API_URL;
let docUrl = cliDocUrl || process.env.FEISHU_DOC_URL || process.env.FEISHU_SHOWCASE_DOC_URL || '';

if (!docUrl || docUrl.includes('doxcnAgentPlatformV2Showcase2026')) {
  console.log('⚠️ 检测到未配置有效的 FEISHU_DOC_URL，正在通过 lark-cli 从 docs/AGENT_PLATFORM_V2_SHOWCASE.md 自动创建真实飞书云文档...');
  try {
    const { importMarkdownAsFeishuDocument } = await import('../src/lib/feishu-document-import.ts');
    const content = fs.readFileSync('docs/AGENT_PLATFORM_V2_SHOWCASE.md', 'utf8');
    docUrl = await importMarkdownAsFeishuDocument({
      content,
      name: 'Agent Platform v2 项目成果展示与核心亮点'
    });
    console.log(`✅ 自动创建飞书云文档成功: ${docUrl}`);
    // Write to .env
    if (fs.existsSync('.env')) {
      let envTxt = fs.readFileSync('.env', 'utf-8');
      if (envTxt.includes('FEISHU_DOC_URL=')) {
        envTxt = envTxt.replace(/#?\s*FEISHU_DOC_URL=.*(\r?\n|$)/, `FEISHU_DOC_URL=${docUrl}\n`);
      } else {
        envTxt += `\nFEISHU_DOC_URL=${docUrl}\n`;
      }
      fs.writeFileSync('.env', envTxt, 'utf-8');
      console.log('✅ 已同步写入 .env 配置 FEISHU_DOC_URL');
    }
  } catch (err) {
    console.warn('⚠️ 自动创建飞书云文档失败，退回默认展示地址:', err.message);
    docUrl = 'https://feishu.cn/docx/doxcnAgentPlatformV2Showcase2026';
  }
}

console.log('=== 飞书秒搭 PM 项目提交助手 ===');
console.log('NEW_PROJECT_URL:', NEW_PROJECT_URL);
console.log('API_KEY (truncated):', API_KEY ? `${API_KEY.slice(0, 8)}...` : 'MISSING');
console.log('Doc URL:', docUrl);

if (!NEW_PROJECT_URL || !API_KEY) {
  console.error('❌ 缺少环境变量 FEISHU_MIAODA_PM_NEW_API_URL 或 FEISHU_MIAODA_PM_API_KEY');
  process.exit(1);
}

// Prepare Showcase Data strictly matching Miaoda PM DB Schema
const showcasePayload = {
  name: 'Agent Platform v2',
  description: '面向企业级复杂研发场景的高能 AI Agent 协作平台，支持多 Agent Live Room 组队、飞书卡片 50ms 异步 Fast-Ack、规范化工作流演进与质量守护防线。',
  resultDescription: [
    '1. 👥 多 Agent Live Room (支持 codex, claude, pi-agent, deepseek 组队协作与 <room-control> 调度)',
    '2. ⚡️ 飞书卡片 50ms 极速 Fast-Ack (突破 3 秒 Wait 限制，全流程异步进度卡片)',
    '3. 📜 单一规则源工作流 (PLAN / HANDOVER 自动化演进与完备校验门禁)',
    '4. 🛡 代码质量防护网 (长文件守护 check:long-files + Git 历史只追加防篡改)',
    '5. 📄 飞书云在线文档 (' + docUrl + ')'
  ].join('\n'),
  categoryId: '3d2ce773-9f06-49b7-b9b9-04217e09cd3e',
  categoryName: '内部工具',
  tags: ['工程', '测试'],
  gitUrl: 'file:///data1/code/agent-platform-v2',
  projectUrl: '',
  docUrls: docUrl ? [
    {
      name: '说明文档',
      url: docUrl
    }
  ] : [],
  isShowcase: true,
  status: 'completed',
  priority: 'P2'
};

console.log('\n📦 项目展示数据 Payload 已格式化:');
console.log(JSON.stringify(showcasePayload, null, 2));

async function submitProject() {
  try {
    // 1. Check if record already exists
    console.log(`\n🔍 检查已存在项目记录...`);
    const listRes = await fetch(NEW_PROJECT_URL, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json'
      }
    });

    let existingId = null;
    if (listRes.ok) {
      const listData = await listRes.json();
      const match = (listData.items || []).find(item => item.name === showcasePayload.name);
      if (match) {
        existingId = match.id;
        console.log(`ℹ️ 找到已有项目记录: ID ${existingId}`);
      }
    }

    // 2. Update via PATCH or Create via POST
    const targetUrl = existingId ? `${NEW_PROJECT_URL}/${existingId}` : NEW_PROJECT_URL;
    const method = existingId ? 'PATCH' : 'POST';

    console.log(`\n🚀 向 Endpoint [${method}] 提交数据: ${targetUrl}`);
    const response = await fetch(targetUrl, {
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(showcasePayload)
    });

    console.log(`HTTP Status: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.log('Response body:', text);

    if (response.ok) {
      const json = JSON.parse(text);
      console.log(`✅ 项目已成功${existingId ? '更新' : '创建'}！Record ID:`, json.id || existingId);
    } else {
      console.error(`❌ 请求失败 (HTTP ${response.status})`);
    }
  } catch (err) {
    console.error('提交请求失败:', err.message);
  }
}

submitProject();

