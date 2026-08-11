import fs from 'fs';

// Parse .env file manually if exists
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

const API_KEY = process.env.FEISHU_MIAODA_PM_API_KEY;
const UPDATE_URL = process.env.FEISHU_MIAODA_PM_UPDATE_API_URL || 'https://ecn6lj2fknte.feishuapp.com/app/app_17b68f01q87/openapi/project-updates';
const PROJECT_ID = process.env.FEISHU_MIAODA_PM_PROJECT_ID || '21316e95-cf20-47f9-81f5-4e876f38b5f2';

if (!API_KEY) {
  console.error('❌ 缺少环境变量 FEISHU_MIAODA_PM_API_KEY');
  process.exit(1);
}

const updates = [
  {
    projectId: PROJECT_ID,
    progress: 25,
    previousProgress: null,
    status: 'normal',
    currentStage: '需求阶段',
    completed: '项目初始化与多 Agent 平台架构设计\n* 确立 Agent Platform v2 总体架构，支持多 Agent 会话与任务编排\n* 搭建 Next.js 14 + Fastify + PostgreSQL + Prisma 技术栈与后端微服务骨架\n* 设计会话、任务、卡片消息与事件流数据模型\n* 完成开发环境容器化与 CI/CD 自动化流水线配置',
    nextPlan: '实现多 Agent Live Room 核心协作引擎与调度协议',
    risk: ''
  },
  {
    projectId: PROJECT_ID,
    progress: 55,
    previousProgress: 25,
    status: 'normal',
    currentStage: '开发阶段',
    completed: '多 Agent Live Room 核心协作引擎与消息流转\n* 实现多 Agent Live Room 会话机制，支持 Codex、Claude、Pi-Agent、Antigravity 统一纳管\n* 实现 <room-control> 动态成员调度协议（add_members 实时拉群）\n* 实现飞书卡片 50ms Fast-Ack 异步回执流转，突破飞书 3 秒超时限制\n* 支持 SSE 实时消息流与前端卡片状态联动展示',
    nextPlan: '推进单一规则源工作流规范化与代码质量防护体系建设',
    risk: ''
  },
  {
    projectId: PROJECT_ID,
    progress: 75,
    previousProgress: 55,
    status: 'normal',
    currentStage: '开发阶段',
    completed: '工作流规范化与全方位质量守护体系\n* 构建单一规则源（workflow-contract.yaml）PLAN/HANDOVER 自动化工作流与完备校验门禁\n* 实施长文件守卫（npm run check:long-files），杜绝超长文件膨胀\n* 引入 Git 历史只追加防篡改策略，保障分布式 Agent 协作审计追踪\n* 完善自动化测试套件与覆盖率门禁',
    nextPlan: '打通飞书秒搭 PM OpenAPI 与飞书文档自动导入能力',
    risk: ''
  },
  {
    projectId: PROJECT_ID,
    progress: 90,
    previousProgress: 75,
    status: 'normal',
    currentStage: '测试阶段',
    completed: '飞书生态深度集成与 Agent 技能互通\n* 实现 lark-cli Markdown 云文档自动导入与链接同步（FEISHU_DOC_URL）\n* 深度集成飞书秒搭 PM OpenAPI（项目同步、展示中心及进展追踪）\n* 完成 Antigravity、Codex、Pi-Agent 等 Real Agent 端到端集成测试\n* 优化高并发卡片更新队列与错误重试机制',
    nextPlan: '整理项目展示成果文档，进行全链路端到端验收与交付上线',
    risk: ''
  },
  {
    projectId: PROJECT_ID,
    progress: 100,
    previousProgress: 90,
    status: 'normal',
    currentStage: '上线阶段',
    completed: '成果沉淀与平台交付上线\n* 编制 AGENT_PLATFORM_V2_SHOWCASE 项目展示与成果文档并发布至飞书云文档\n* 飞书秒搭 PM 项目展示记录、成果介绍与阶段进展全量同步完成\n* 完成全链路验收测试与性能基准测试，系统运行平稳\n* Agent Platform v2 正式交付上线',
    nextPlan: '持续收集各业务团队 Agent 协作反馈，迭代演进平台智能化编排能力',
    risk: ''
  }
];

async function syncUpdates() {
  console.log('=== 飞书秒搭 PM 进展记录同步 ===');
  console.log('Project ID:', PROJECT_ID);
  console.log('API URL:', UPDATE_URL);

  for (let i = 0; i < updates.length; i++) {
    const item = updates[i];
    console.log(`\n🚀 [${i + 1}/${updates.length}] 提交进度 ${item.progress}% (${item.currentStage})...`);
    try {
      const res = await fetch(UPDATE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(item)
      });
      const text = await res.text();
      if (res.ok) {
        console.log(`✅ 提交成功 (HTTP ${res.status}):`, text);
      } else {
        console.error(`❌ 提交失败 (HTTP ${res.status}):`, text);
      }
    } catch (err) {
      console.error('❌ 网络或请求错误:', err.message);
    }
  }
}

syncUpdates();
