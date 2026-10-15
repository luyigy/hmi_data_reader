import { randomUUID } from 'node:crypto';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import { sendFeishuInteractiveMessage } from '@/lib/feishu-api';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';

const HELP_PAGES = [
  ['房间与 Agent', [
    '/ap menu  返回分类命令卡片',
    '/ap codex-config --agent=<memberName|idSuffix> [--list] [--model=<model|inherit>] [--thinking=<level|inherit>]  Codex 模型 / 思考强度；不带修改参数时查看配置',
    '/ap model-config --agent=<memberName|idSuffix> [--list] [--provider=<provider|inherit>] [--model=<model|inherit>] [--thinking=<level|inherit>]  成员模型/强度；Pi/Kimi 可用 --list 查本机模型，下一轮生效',
    '/ap isolation [status|on|off]  群任务隔离（默认关闭，仅群管理员/平台管理员可修改）',
    '/ap task new --title=任务名 --workdir=<目录>  创建独立任务入口卡；在卡片话题内续聊',
    '/ap broadcast <通知原文>  群主聊天区广播；目标任务各成员下一轮可见，不立即唤醒或打断',
    '/ap task retry <请求ID>  恢复失败的创建；关闭后已有任务仍保持隔离',
    '/ap room --workdir=<目录> [--agents=<local:codex,local:claude>] [--topic=xxx] [--profile=safe|dev|full] [--mode=discussion|execution|hybrid] [--handoff-limit=<0-32>] [--timeout=<1-1440 分钟>] [title]',
    '/ap handoff-limit [0-32]',
    '/ap timeout [<1-1440 分钟>|inherit]  房间级执行超时；inherit 恢复默认',
    '/ap mode <discussion|execution|hybrid>',
    '/ap members',
    '/ap nick --member=<memberName|idSuffix> --name=<newNickname>',
    '/ap role --member=<memberName|idSuffix> --role=<planner|researcher|implementer|reviewer|tester|custom>',
    '/ap specialty --member=<memberName|idSuffix> --specialty=<documentation|diagnostics|implementation|general>',
    '/ap speaker [memberName|idSuffix]',
    '/ap add --agents=<agentId>  支持短写：TX-server:claude',
    '/ap kick <memberName>',
    '/ap chat [--agents=<agentId1,agentId2>] <message>',
    '/ap chat --from-member=<memberName> --to-member=<memberName> <message>',
    '/ap plan [--host=<memberName|idSuffix>] [--format=html] <需求>  HTML 为试点候选，不进入审批',
    '/ap doc <仓库内已提交的 Markdown 路径>  转为飞书文档',
    '/ap md [关键词|完整路径.md]  按分区倒序浏览并发送原始 Markdown 文件',
    '/ap chat --from=<gatewayId> --to=<gatewayId> <prompt>',
    '/ap handover [agentName|idSuffix] [--title="handover title"]',
  ]],
  ['运行控制', [
    '/ap status',
    '/ap status --quota [--agent=<成员>]  (管理员)',
    '/ap gateways',
    '/ap discover-agents [gatewayId]  发现本地、Remote SSH 与 Runner（/ap agents 兼容）',
    '/ap hosts',
    '/ap register --label=<名称> --host=<IP> --user=<用户> --keyfile=<私钥路径> [--harnesses=claude,codex] [--port=22] [--network=wireguard|lan|public]',
    '/ap run --host=<hostId|label> --harness=<codex|claude|claude-haha> <prompt>',
    '/ap workspace [root 内的绝对或相对路径]',
    '/ap stop [--all|agentName|idSuffix]',
    '/ap sessions',
    '/ap new [--all] [--blank] [--handover="docs/xx.md"] [--profile=safe|dev|full] [agentName|idSuffix]',
    '/ap new-session [--all] [--blank] [--handover="docs/xx.md"] [--profile=safe|dev|full] [agentName|idSuffix]',
  ]],
  ['Workflow / Jobs', [
    '/ap workflow status',
    '/ap workflow level show',
    '/ap workflow level set <full|lean|fast|implement>  (管理员/项目审批人，后续 Slice 生效)',
    '/ap workflow autonomy show',
    '/ap workflow autonomy set <manual|semi_auto|auto> --head=<当前HEAD>  (管理员/项目审批人)',
    '/ap workflow validation show',
    '/ap workflow validation set <balanced|strict> --head=<当前HEAD>  (管理员/项目审批人)',
    '/ap workflow validation template',
    '/ap workflow validation repair --head=<当前HEAD>  (管理员/项目审批人)',
    '/ap workflow policy show',
    '/ap workflow policy set --preset=workspace [--extra-read/--extra-write=绝对路径]  (管理员)',
    '/ap workflow policy edit  发送额外挂载配置卡片  (管理员)',
    '/ap dashboard [job-id]  返回可点击的 Workflow 状态卡',
    '/ap jobs',
    '/ap branch status  查询当前仓库实际分支、监控分支与漂移警告',
    '/ap branch apply [new_branch] [--branch-space=name]  确认并申请同步分支与文档目录',
    '/ap branch switch <new_branch> [--branch-space=name]  (管理员) 直接同步分支与文档目录',
    '/ap branch approvals  查看所有待审批的分支切换申请单',
    '/ap job <status|dashboard|cursor|diagnose|schedule|enable|disable|run|retry|resend|stop> <job-id>',
    '/ap job diagnose workflow-watcher',
    '/ap job cursor workflow-watcher [--latest|--clear-pending]',
  ]],
  ['权限与管理', [
    '/ap users [--status=approved|pending|denied|revoked|blocked]  打开用户管理卡（管理员私聊）',
    '/ap user approve <open_id> --workspace-root=/absolute/path  (管理员)',
    '/ap user workspace <open_id> <absolute_root>  (管理员)',
    '/ap user <revoke|block|unblock> <open_id>  (管理员)',
    '/ap approvals',
    '/ap approve <approvalId>',
    '/ap deny <approvalId> [reason]',
    '/ap answer <approvalId> <text>',
    '/ap restrict <agent-id|all> <safe|dev>',
    '/ap grant <dev|full> [--agent=<name>] [message]',
    '/ap rights [--agent=<name>]',
  ]],
] as const;

const CODEX_CONFIG_HELP = {
  tag: 'markdown',
  content: [
    '**Codex 模型 / 思考强度**',
    '复制命令到当前房间发送；将 codex 换成实际成员名称或 ID 后缀。',
    '查看配置：`/ap codex-config --agent=codex`',
    '模型及对应思考档位：`/ap codex-config --agent=codex --list`（本机 Codex）；修改时校验目录，继承模型时请同时指定模型和档位。',
    '修改模型：`/ap codex-config --agent=codex --model=<模型ID>`',
    '思考强度：`/ap codex-config --agent=codex --thinking=high`',
    '恢复继承：`/ap codex-config --agent=codex --model=inherit --thinking=inherit`',
    '其他成员：`/ap model-config --agent=antigravity --thinking=high`；Antigravity 支持 low/medium/high/max。Kimi 可用 `--list` 查本机模型及 CLI 报告的思考档位，但目前仅支持 `--model` 设置。',
    'Pi：`/ap model-config --agent=pi-agent --list` 查本机 Provider 与模型；`/ap model-config --agent=pi-agent --provider=openrouter --model=anthropic/claude-sonnet-4.5 --thinking=high` 设置。支持 off/minimal/low/medium/high/xhigh。Provider 与模型一起指定；`--model=inherit --thinking=inherit` 清除房间覆盖，继承运行环境或会话默认值。',
    '修改作用于指定成员，下一次运行或续接生效。',
  ].join('\n'),
};

export const FEISHU_COMMAND_CARD_ACTIONS = new Set([
  '/ap members',
  '/ap status',
  '/ap gateways',
  '/ap agents',
  '/ap discover-agents',
  '/ap hosts',
  '/ap sessions',
  '/ap dashboard',
  '/ap jobs',
  '/ap workflow status',
  '/ap branch status',
  '/ap workflow validation show',
  '/ap workflow validation template',
  '/ap workflow policy show',
  '/ap workflow policy edit',
  '/ap job diagnose workflow-watcher',
  '/ap users',
  '/ap approvals',
  '/ap rights',
]);

const QUICK_ACTIONS = [
  [
    ['成员', '/ap members'],
    ['功能开发 /run feature', '/ap run feature'],
    ['排障修复 /run debug', '/ap run debug'],
  ],
  [
    ['状态', '/ap status'],
    ['网关', '/ap gateways'],
    ['发现 Agents', '/ap discover-agents'],
    ['Hosts', '/ap hosts'],
    ['Sessions', '/ap sessions'],
  ],
  [
    ['Workflow Dashboard', '/ap dashboard'],
    ['Workflow 状态', '/ap workflow status'],
    ['分支状态', '/ap branch status'],
    ['校验状态', '/ap workflow validation show'],
    ['错误模板', '/ap workflow validation template'],
    ['Jobs', '/ap jobs'],
    ['权限策略', '/ap workflow policy show'],
    ['额外挂载配置…', '/ap workflow policy edit'],
    ['诊断', '/ap job diagnose workflow-watcher'],
  ],
  [
    ['用户', '/ap users'],
    ['待审批', '/ap approvals'],
    ['权限申请', '/ap rights'],
  ],
] as const;

const CATEGORY_VIEWS = ['room', 'runtime', 'workflow', 'admin'] as const;
const FORM_VIEWS = ['form-task-new', 'form-run-feature', 'form-run-debug', 'form-documentation', 'form-workspace', 'form-chat', 'form-plan', 'form-schedule', 'form-workflow-level'] as const;
export type FeishuCommandCenterView = 'home' | typeof CATEGORY_VIEWS[number] | typeof FORM_VIEWS[number];
export type FeishuRoomControlView = 'permission' | 'role' | 'specialty';

export type FeishuRoomControlMember = {
  id: string;
  displayName: string;
  userNickname?: string | null;
};

export type FeishuRoomCreationAgent = {
  id: string;
  label: string;
};

const FORM_DEFINITIONS = {
  'form-task-new': {
    title: '新增独立任务',
    description: '在已开启任务隔离的群聊中创建新任务；创建后在新入口卡片的话题内添加 Agent 并续聊。',
    fields: [
      { name: 'title', label: '任务名', placeholder: '例如：修复登录问题' },
      { name: 'workdir', label: '工作目录', placeholder: '授权根目录内的绝对或相对路径' },
    ],
    submitName: 'submitTask',
    submitLabel: '创建独立任务',
    returnView: 'room',
  },
  'form-run-feature': {
    title: '功能开发 /run feature',
    description: '选择 workflow 档位并填写任务。',
    fields: [{ name: 'task', label: '任务描述', placeholder: '请描述要实现的功能、目标和验收标准', multiline: true }],
    submitName: 'submitRunFeature',
    submitLabel: '启动功能开发',
    returnView: 'room',
  },
  'form-run-debug': {
    title: '排障修复 /run debug',
    description: '按角色流水线执行：分析 → 复现方案 → 修复计划 → 实施 → 审查 → 回归测试。',
    fields: [{ name: 'task', label: '问题描述', placeholder: '请描述要排查的问题、现象和复现条件', multiline: true }],
    submitName: 'submitRunDebug',
    submitLabel: '启动排障修复',
    returnView: 'room',
  },
  'form-documentation': {
    title: '文档与记录',
    description: '写进 inbox、出 FIX 文档、记录决定等文档类任务。',
    fields: [{ name: 'task', label: '文档/记录内容', placeholder: '例如：写进 inbox / 出个 FIX 文档 / 记录这次决定...', multiline: true }],
    submitName: 'submitDocumentation',
    submitLabel: '提交文档任务',
    returnView: 'room',
  },
  'form-workspace': {
    title: '切换工作区',
    description: '填写 root 范围内的绝对或相对路径。',
    fields: [{ name: 'path', label: '工作区路径', placeholder: '例如：projects/hmi-reader' }],
    submitName: 'submitWorkspace',
    submitLabel: '应用工作区',
    returnView: 'runtime',
  },
  'form-chat': {
    title: '发送 Agent 消息',
    description: '消息会沿用当前会话的成员与权限上下文。',
    fields: [{ name: 'message', label: '消息内容', placeholder: '请输入要发送给 Agent 的消息', multiline: true }],
    submitName: 'submitChat',
    submitLabel: '发送消息',
    returnView: 'room',
  },
  'form-plan': {
    title: '创建 PLAN',
    description: '只讨论需求并提交合格 PLAN，不直接实施。',
    fields: [{ name: 'requirements', label: '需求', placeholder: '请描述目标、范围和验收标准', multiline: true }],
    submitName: 'submitPlan',
    submitLabel: '提交需求',
    returnView: 'room',
  },
  'form-schedule': {
    title: '修改 Workflow 调度',
    description: '保留既有管理员/审批人校验；default 可恢复项目配置。',
    fields: [
      { name: 'jobId', label: 'Job ID', placeholder: 'workflow-watcher', defaultValue: 'workflow-watcher' },
      { name: 'cron', label: 'Cron', placeholder: '*/5 * * * *', defaultValue: '* * * * *' },
    ],
    submitName: 'submitSchedule',
    submitLabel: '应用调度',
    returnView: 'workflow',
  },
  'form-workflow-level': {
    title: '修改 Workflow 执行档位',
    description: '修改当前 PLAN 后续 Slice 的角色执行流程；不会中断正在运行的阶段。',
    fields: [],
    submitName: 'submitWorkflowLevel',
    submitLabel: '应用执行档位',
    returnView: 'workflow',
  },
} as const;

export const isFeishuCommandCenterView = (value: unknown): value is FeishuCommandCenterView =>
  value === 'home' || CATEGORY_VIEWS.includes(value as typeof CATEGORY_VIEWS[number])
    || FORM_VIEWS.includes(value as typeof FORM_VIEWS[number]);

const callbackButton = (
  label: string,
  value: Record<string, unknown>,
  type = 'default',
) => ({
  tag: 'button',
  text: { tag: 'plain_text', content: label },
  type,
  size: 'small',
  behaviors: [{ type: 'callback', value }],
});

const buttonColumns = (buttons: Record<string, unknown>[]) => ({
  tag: 'column_set',
  flex_mode: 'flow',
  horizontal_spacing: '8px',
  columns: buttons.map((button) => ({
    tag: 'column',
    width: 'auto',
    elements: [button],
  })),
});

const cardShell = (title: string, subtitle: string, elements: Record<string, unknown>[], template = 'blue') => ({
  schema: '2.0',
  config: {
    update_multi: true,
    width_mode: 'default',
    summary: { content: `AP 命令中心 · ${title}` },
  },
  header: {
    title: { tag: 'plain_text', content: title },
    subtitle: { tag: 'plain_text', content: subtitle },
    template,
    icon: { tag: 'standard_icon', token: 'lark-logo_colorful' },
  },
  body: {
    direction: 'vertical',
    padding: '12px 12px 20px 12px',
    vertical_spacing: '12px',
    elements,
  },
});

export const buildFeishuCommandCenterCard = (
  chatType: 'p2p' | 'group',
  view: FeishuCommandCenterView = 'home',
) => {
  if (view === 'home') {
    return cardShell('AP 命令中心', '选择一个分类，本卡片会原地切换', [
      {
        tag: 'markdown',
        content: '**所有命令都必须以 `/ap` 开头。**\n常用只读命令可直接执行；带参数命令使用结构化表单。',
      },
      CODEX_CONFIG_HELP,
      buttonColumns([
        ...(chatType === 'group' ? [callbackButton('新增独立任务…', { cmd: 'ap-menu', view: 'form-task-new', chatType }, 'primary_filled')] : []),
        callbackButton('功能开发…', { cmd: 'ap-menu', view: 'form-run-feature', chatType }, 'primary_filled'),
        callbackButton('发现 Agents', { cmd: 'ap-command', command: '/ap discover-agents', chatType }),
      ]),
      buttonColumns(HELP_PAGES.map(([group], index) => callbackButton(
        group,
        { cmd: 'ap-menu', view: CATEGORY_VIEWS[index], chatType },
        index === 0 ? 'primary_filled' : 'default',
      ))),
    ]);
  }

  if (view.startsWith('form-')) {
    const form = FORM_DEFINITIONS[view as typeof FORM_VIEWS[number]];
    return cardShell(form.title, form.description, [
      {
        tag: 'form',
        name: view,
        elements: [
          ...(['form-run-feature', 'form-workflow-level'].includes(view) ? [{
            tag: 'select_static',
            name: view === 'form-run-feature' ? 'level' : 'workflowLevel',
            required: true,
            width: 'fill',
            ...(view === 'form-run-feature' ? { initial_option: 'full' } : {}),
            placeholder: { tag: 'plain_text', content: '选择 workflow 档位' },
            options: [
              { text: { tag: 'plain_text', content: 'Full · 完整流程' }, value: 'full' },
              { text: { tag: 'plain_text', content: 'Lean · 计划审查 + 实施 + 测试' }, value: 'lean' },
              { text: { tag: 'plain_text', content: 'Fast · 实施 + 测试' }, value: 'fast' },
              { text: { tag: 'plain_text', content: 'Implement · 仅实施（不测试）' }, value: 'implement' },
            ],
          }] : []),
          ...form.fields.map((field) => ({
            tag: 'input',
            name: field.name,
            required: true,
            input_type: 'multiline' in field && field.multiline ? 'multiline_text' : 'text',
            ...('multiline' in field && field.multiline
              ? { rows: 4, max_rows: 8, auto_resize: true }
              : {}),
            label: { tag: 'plain_text', content: field.label },
            placeholder: { tag: 'plain_text', content: field.placeholder },
            ...('defaultValue' in field ? { default_value: field.defaultValue } : {}),
          })),
          {
            tag: 'button',
            // Each opened task form has one stable creation request, including retries.
            name: `${form.submitName}${view === 'form-task-new' ? `:${randomUUID()}` : ''}_${chatType}`,
            text: { tag: 'plain_text', content: form.submitLabel },
            type: 'primary_filled',
            form_action_type: 'submit',
          },
        ],
      },
      buttonColumns([callbackButton('返回分类', {
        cmd: 'ap-menu',
        view: form.returnView,
        chatType,
      })]),
    ], 'wathet');
  }

  const categoryView = view as typeof CATEGORY_VIEWS[number];
  const pageIndex = CATEGORY_VIEWS.indexOf(categoryView);
  const [group, commands] = HELP_PAGES[pageIndex];
  const formButtons = categoryView === 'room'
    ? [
      ...(chatType === 'group' ? [callbackButton('新增独立任务…', { cmd: 'ap-menu', view: 'form-task-new', chatType }, 'primary_filled')] : []),
      callbackButton('功能开发…', { cmd: 'ap-menu', view: 'form-run-feature', chatType }),
      callbackButton('排障修复…', { cmd: 'ap-menu', view: 'form-run-debug', chatType }),
      callbackButton('文档与记录…', { cmd: 'ap-menu', view: 'form-documentation', chatType }, 'primary_filled'),
      callbackButton('创建/配置房间…', { cmd: 'ap-room-create', chatType }),
      callbackButton('创建 PLAN…', { cmd: 'ap-menu', view: 'form-plan', chatType }),
      callbackButton('设置角色…', { cmd: 'ap-room-control', view: 'role', chatType }),
      callbackButton('设置职责…', { cmd: 'ap-room-control', view: 'specialty', chatType }),
    ]
    : categoryView === 'runtime'
      ? [callbackButton('切换工作区…', { cmd: 'ap-menu', view: 'form-workspace', chatType })]
      : categoryView === 'workflow'
        ? [
          callbackButton('修改执行档位…', { cmd: 'ap-menu', view: 'form-workflow-level', chatType }, 'primary_filled'),
          callbackButton('修改调度…', { cmd: 'ap-menu', view: 'form-schedule', chatType }),
        ]
        : categoryView === 'admin'
          ? [callbackButton('权限约束…', { cmd: 'ap-room-control', view: 'permission', chatType })]
        : [];
  return cardShell(group, `AP 命令中心 · ${pageIndex + 1}/${HELP_PAGES.length}`, [
    ...(categoryView === 'room' ? [CODEX_CONFIG_HELP] : []),
    {
      tag: 'markdown',
      content: '**常用操作**\n点击后立即反馈接收状态，完成后回复一张中文结果卡。',
    },
    buttonColumns(QUICK_ACTIONS[pageIndex].map(([label, command], actionIndex) => callbackButton(
      label,
      { cmd: 'ap-command', command, chatType },
      actionIndex === 0 ? 'primary_filled' : 'default',
    ))),
    ...(formButtons.length ? [buttonColumns(formButtons)] : []),
    {
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: '查看全部命令模板' },
      },
      elements: [{
        tag: 'markdown',
        content: commands.map((command) => `- \`${command}\``).join('\n'),
        text_size: 'notation',
      }],
    },
    buttonColumns([callbackButton('返回分类', { cmd: 'ap-menu', view: 'home', chatType })]),
  ], pageIndex === 2 ? 'wathet' : 'blue');
};

export const buildFeishuRoomControlCard = (
  chatType: 'p2p' | 'group',
  view: FeishuRoomControlView,
  members: FeishuRoomControlMember[],
  workspace: string,
  currentPermission?: string,
) => {
  const memberOptions = members.map((member) => ({
    text: { tag: 'plain_text', content: member.userNickname || member.displayName },
    value: member.id,
  }));
  const permission = view === 'permission';
  const specialty = view === 'specialty';
  return cardShell(
    permission ? '房间权限约束' : specialty ? '设置 Agent 职责' : '设置 Agent 角色',
    permission ? '先写入新的工作区边界，再停止目标旧运行' : specialty ? '职责将用于意图路由' : '角色将在后续调度中生效',
    [
      {
        tag: 'markdown',
        content: permission
          ? `**当前房间权限：${currentPermission || 'Safe Local'}**\n**房间工作区**\n\`${workspace || '未配置'}\`\n仅提供工作区受限档位；Full Access 请使用“权限申请”。不支持真实隔离的 Agent 会使本次操作整体拒绝。`
          : specialty
            ? '**选择一个 Agent 和它在当前房间中的专项职责。**'
            : '**选择一个 Agent 和它在当前房间中的角色。**',
      },
      {
        tag: 'form',
        name: permission ? 'form-room-restriction' : specialty ? 'form-agent-specialty' : 'form-agent-role',
        vertical_spacing: '12px',
        elements: [
          {
            tag: 'select_static',
            name: 'target',
            required: true,
            width: 'fill',
            placeholder: { tag: 'plain_text', content: permission ? '选择全部或指定 Agent' : '选择 Agent' },
            options: permission
              ? [
                { text: { tag: 'plain_text', content: '全部 Agent' }, value: 'all' },
                ...memberOptions,
              ]
              : memberOptions,
          },
          {
            tag: 'select_static',
            name: permission ? 'profile' : specialty ? 'specialty' : 'role',
            required: true,
            width: 'fill',
            placeholder: {
              tag: 'plain_text',
              content: permission ? '选择工作区权限档位' : specialty ? '选择职责' : '选择角色',
            },
            options: permission
              ? [
                { text: { tag: 'plain_text', content: 'Safe Local · 禁止网络' }, value: 'safe_local' },
                { text: { tag: 'plain_text', content: 'Dev Local · 允许网络' }, value: 'dev_local' },
              ]
              : specialty
                ? [
                  ['文档 Documentation', 'documentation'],
                  ['诊断 Diagnostics', 'diagnostics'],
                  ['实施 Implementation', 'implementation'],
                  ['通用 General', 'general'],
                ].map(([content, value]) => ({
                  text: { tag: 'plain_text', content },
                  value,
                }))
                : [
                ['规划 Planner', 'planner'],
                ['研究 Researcher', 'researcher'],
                ['实施 Implementer', 'implementer'],
                ['审查 Reviewer', 'reviewer'],
                ['测试 Tester', 'tester'],
                ['自定义 Custom', 'custom'],
              ].map(([content, value]) => ({
                text: { tag: 'plain_text', content },
                value,
              })),
          },
          {
            tag: 'button',
            name: `${permission ? 'submitRoomRestriction' : specialty ? 'submitAgentSpecialty' : 'submitAgentRole'}_${chatType}`,
            text: { tag: 'plain_text', content: permission ? '应用权限约束' : specialty ? '设置职责' : '设置角色' },
            type: 'primary_filled',
            width: 'fill',
            form_action_type: 'submit',
          },
        ],
      },
      buttonColumns([callbackButton('返回分类', {
        cmd: 'ap-menu',
        view: permission ? 'admin' : 'room',
        chatType,
      })]),
    ],
    'wathet',
  );
};

export const buildFeishuRoomCreationCard = (
  chatType: 'p2p' | 'group',
  agents: FeishuRoomCreationAgent[],
  workspaceRoot?: string | null,
) => cardShell('创建/配置 Live Room', '复用现有 /ap room；已绑定的会话会更新当前房间', [
  {
    tag: 'markdown',
    content: `**选择 Agent 并明确工作目录。**${workspaceRoot ? `\n授权根目录：\`${workspaceRoot}\`` : ''}`,
  },
  {
    tag: 'form',
    name: 'form-room-create',
    vertical_spacing: '12px',
    elements: [
      {
        tag: 'input',
        name: 'workdir',
        required: true,
        width: 'fill',
        label: { tag: 'plain_text', content: '工作目录' },
        placeholder: { tag: 'plain_text', content: 'root 内的绝对或相对路径' },
        ...(workspaceRoot ? { default_value: workspaceRoot } : {}),
      },
      {
        tag: 'multi_select_static',
        name: 'agents',
        required: true,
        width: 'fill',
        placeholder: { tag: 'plain_text', content: '选择一个或多个 Agent' },
        options: agents.map((agent) => ({
          text: { tag: 'plain_text', content: agent.label },
          value: agent.id,
        })),
      },
      {
        tag: 'input',
        name: 'title',
        width: 'fill',
        label: { tag: 'plain_text', content: '房间标题（可选）' },
        placeholder: { tag: 'plain_text', content: '默认使用当前飞书会话名称' },
      },
      {
        tag: 'input',
        name: 'topic',
        width: 'fill',
        input_type: 'multiline_text',
        rows: 2,
        max_rows: 4,
        auto_resize: true,
        label: { tag: 'plain_text', content: 'Topic（可选）' },
        placeholder: { tag: 'plain_text', content: '本房间当前目标' },
      },
      {
        tag: 'input',
        name: 'timeout',
        width: 'fill',
        label: { tag: 'plain_text', content: '执行超时（分钟，可选）' },
        placeholder: { tag: 'plain_text', content: '留空继承默认（远程 10 分钟 / Platform Local 不限时）；1-1440' },
      },
      {
        tag: 'select_static',
        name: 'profile',
        required: true,
        width: 'fill',
        initial_option: 'safe',
        placeholder: { tag: 'plain_text', content: '选择权限档位' },
        options: [
          { text: { tag: 'plain_text', content: 'Safe Local · 禁止网络' }, value: 'safe' },
          { text: { tag: 'plain_text', content: 'Dev Local · 允许网络' }, value: 'dev' },
          { text: { tag: 'plain_text', content: 'Full Access · 需要审批' }, value: 'full' },
        ],
      },
      {
        tag: 'select_static',
        name: 'mode',
        required: true,
        width: 'fill',
        initial_option: 'discussion',
        placeholder: { tag: 'plain_text', content: '选择房间模式' },
        options: [
          { text: { tag: 'plain_text', content: 'Discussion · 讨论' }, value: 'discussion' },
          { text: { tag: 'plain_text', content: 'Execution · 执行' }, value: 'execution' },
          { text: { tag: 'plain_text', content: 'Hybrid · 混合' }, value: 'hybrid' },
        ],
      },
      {
        tag: 'button',
        name: `submitRoom_${chatType}`,
        text: { tag: 'plain_text', content: '创建/应用房间配置' },
        type: 'primary_filled',
        width: 'fill',
        form_action_type: 'submit',
      },
    ],
  },
  buttonColumns([callbackButton('返回分类', { cmd: 'ap-menu', view: 'room', chatType })]),
], 'wathet');

export const buildFeishuCommandCenterCards = (chatType: 'p2p' | 'group') => [
  buildFeishuCommandCenterCard(chatType),
];

export const buildFeishuCommandCenterCardUpdate = (
  chatType: 'p2p' | 'group',
  view: FeishuCommandCenterView,
) => ({
  type: 'raw',
  data: buildFeishuCommandCenterCard(chatType, view),
});

export const buildFeishuCommandFromForm = (
  form: unknown,
  values: Record<string, unknown> | undefined,
): ParsedFeishuCommand | null => {
  const text = (name: string) => typeof values?.[name] === 'string' ? values[name].trim() : '';
  const selected = (name: string) => (Array.isArray(values?.[name])
    ? values[name]
    : typeof values?.[name] === 'string' ? values[name].split(',') : [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  if (form === 'form-room-create' && text('workdir') && selected('agents').length && text('profile') && text('mode')) {
    return {
      command: 'room',
      args: text('title') ? [text('title')] : [],
      options: {
        workdir: text('workdir'),
        agents: selected('agents').join(','),
        profile: text('profile'),
        mode: text('mode'),
        ...(text('topic') ? { topic: text('topic') } : {}),
        ...(text('timeout') ? { timeout: text('timeout') } : {}),
      },
    };
  }
  if (form === 'form-task-new' && text('title') && text('workdir')) {
    return { command: 'task', args: ['new'], options: { title: text('title'), workdir: text('workdir') } };
  }
  if (form === 'form-workspace' && text('path')) {
    return { command: 'workspace', args: [text('path')], options: {} };
  }
  if (form === 'form-chat' && text('message')) {
    return { command: 'chat', args: [text('message')], options: {} };
  }
  if (form === 'form-plan' && text('requirements')) {
    return { command: 'plan', args: [text('requirements')], options: {} };
  }
  if (form === 'form-schedule' && text('jobId') && text('cron')) {
    return { command: 'job', args: ['schedule', text('jobId')], options: { cron: text('cron') } };
  }
  if (form === 'form-workflow-level' && ['full', 'lean', 'fast', 'implement'].includes(text('workflowLevel'))) {
    return { command: 'workflow', args: ['level', 'set', text('workflowLevel')], options: {} };
  }
  if (form === 'form-run-feature' && text('task')) {
    const level = text('level');
    if (!['full', 'lean', 'fast', 'implement'].includes(level)) return null;
    return { command: 'chat', args: [`/run feature --level=${level} ${text('task')}`], options: {} };
  }
  if (form === 'form-run-debug' && text('task')) {
    return { command: 'chat', args: [`/run debug ${text('task')}`], options: {} };
  }
  if (form === 'form-documentation' && text('task')) {
    return { command: 'chat', args: [text('task')], options: {} };
  }
  if (form === 'form-room-restriction' && text('target') && text('profile')) {
    return { command: 'restrict', args: [text('target'), text('profile')], options: {} };
  }
  if (form === 'form-agent-role' && text('target') && text('role')) {
    return { command: 'role', args: [], options: { member: text('target'), role: text('role') } };
  }
  if (form === 'form-agent-specialty' && text('target') && text('specialty')) {
    return { command: 'specialty', args: [], options: { member: text('target'), specialty: text('specialty') } };
  }
  return null;
};

export const buildFeishuCommandResultCard = (
  title: string,
  result: string,
  chatType: 'p2p' | 'group',
) => {
  const lines = result.trim().split(/\r?\n/);
  const summary = lines.shift() || '命令已完成';
  const details = lines.join('\n').trim();
  return cardShell(title, 'AP 命令执行结果', [
    { tag: 'markdown', content: summary },
    ...(details ? [{
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: '查看详细信息' } },
      elements: [{ tag: 'markdown', content: details, text_size: 'notation' }],
    }] : []),
    buttonColumns([callbackButton('返回命令中心', { cmd: 'ap-menu', view: 'home', chatType })]),
  ], result.trim().startsWith('❌') ? 'red' : 'green');
};

export async function sendFeishuCommandCenter(context?: FeishuConversationContext) {
  if (!context) return '当前命令中心需要来自 Feishu webhook 的会话上下文。';
  await sendFeishuInteractiveMessage({
    receiveId: context.chatId,
    receiveIdType: 'chat_id',
    card: buildFeishuCommandCenterCard(context.chatType === 'p2p' ? 'p2p' : 'group'),
  });
  return '✅ AP 命令中心已发送；分类会在同一张卡片内切换，只有以 /ap 开头的消息才会被识别为命令。';
}

export function formatFeishuHelp(command: Pick<ParsedFeishuCommand, 'args' | 'options'>) {
  const requested = command.options.page ?? command.args[0] ?? '1';
  const page = Number(requested);
  if (!Number.isInteger(page) || page < 1 || page > HELP_PAGES.length) {
    return `页码无效：${requested}。请使用 /ap help 1-${HELP_PAGES.length}。`;
  }

  const [group, commands] = HELP_PAGES[page - 1];
  return [
    `Agent Platform Feishu Bot · ${group}`,
    '',
    ...commands,
    '',
    `第 ${page}/${HELP_PAGES.length} 页 · 上一页：${page > 1 ? `/ap help ${page - 1}` : '无'} · 下一页：${page < HELP_PAGES.length ? `/ap help ${page + 1}` : '无'}`,
    '用法：/ap help [页码] 或 /ap help --page=<页码>',
  ].join('\n');
}
