import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import { sendFeishuInteractiveMessage } from '@/lib/feishu-api';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';

const HELP_PAGES = [
  ['房间与 Agent', [
    '/ap menu  返回分类命令卡片',
    '/ap room --workdir=<目录> [--agents=<local:codex,local:claude>] [--topic=xxx] [--profile=safe|dev|full] [--mode=discussion|execution|hybrid] [--handoff-limit=<0-32>] [title]',
    '/ap handoff-limit [0-32]',
    '/ap mode <discussion|execution|hybrid>',
    '/ap members',
    '/ap nick --member=<memberName|idSuffix> --name=<newNickname>',
    '/ap role --member=<memberName|idSuffix> --role=<planner|researcher|implementer|reviewer|tester|custom>',
    '/ap codex-config --agent=<memberName|idSuffix> [--model=<model|inherit>] [--thinking=<level|inherit>]',
    '/ap speaker [memberName|idSuffix]',
    '/ap add --agents=<agentId>  支持短写：TX-server:claude',
    '/ap kick <memberName>',
    '/ap chat [--agents=<agentId1,agentId2>] <message>',
    '/ap chat --from-member=<memberName> --to-member=<memberName> <message>',
    '/ap plan [--host=<memberName|idSuffix>] <需求>  只讨论并提交合格 PLAN',
    '/ap chat --from=<gatewayId> --to=<gatewayId> <prompt>',
    '/ap handover [agentName|idSuffix] [--title="handover title"]',
  ]],
  ['运行控制', [
    '/ap status',
    '/ap status --quota [--agent=<成员>]  (管理员)',
    '/ap gateways',
    '/ap agents [gatewayId]',
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
    '/ap workflow policy show',
    '/ap workflow policy set --preset=workspace  (管理员)',
    '/ap dashboard [job-id]  返回可点击的 Workflow 状态卡',
    '/ap jobs',
    '/ap job <status|dashboard|cursor|diagnose|schedule|enable|disable|run|retry|resend|stop> <job-id>',
    '/ap job diagnose workflow-watcher',
    '/ap job cursor workflow-watcher [--latest|--clear-pending]',
  ]],
  ['权限与管理', [
    '/ap users [--status=approved|pending|denied|revoked|blocked]  (管理员)',
    '/ap user approve <open_id> --workspace-root=/absolute/path  (管理员)',
    '/ap user workspace <open_id> <absolute_root>  (管理员)',
    '/ap user <revoke|block|unblock> <open_id>  (管理员)',
    '/ap approvals',
    '/ap approve <approvalId>',
    '/ap deny <approvalId> [reason]',
    '/ap answer <approvalId> <text>',
    '/ap grant <dev|full> [--agent=<name>] [message]',
    '/ap rights [--agent=<name>]',
  ]],
] as const;

export const FEISHU_COMMAND_CARD_ACTIONS = new Set([
  '/ap members',
  '/ap status',
  '/ap gateways',
  '/ap agents',
  '/ap hosts',
  '/ap sessions',
  '/ap dashboard',
  '/ap jobs',
  '/ap workflow policy show',
  '/ap job diagnose workflow-watcher',
  '/ap users',
  '/ap approvals',
  '/ap rights',
]);

const QUICK_ACTIONS = [
  [
    ['成员', '/ap members'],
  ],
  [
    ['状态', '/ap status'],
    ['网关', '/ap gateways'],
    ['Agents', '/ap agents'],
    ['Hosts', '/ap hosts'],
    ['Sessions', '/ap sessions'],
  ],
  [
    ['Workflow Dashboard', '/ap dashboard'],
    ['Jobs', '/ap jobs'],
    ['权限策略', '/ap workflow policy show'],
    ['诊断', '/ap job diagnose workflow-watcher'],
  ],
  [
    ['用户', '/ap users'],
    ['待审批', '/ap approvals'],
    ['权限', '/ap rights'],
  ],
] as const;

const CATEGORY_VIEWS = ['room', 'runtime', 'workflow', 'admin'] as const;
const FORM_VIEWS = ['form-workspace', 'form-chat', 'form-plan', 'form-schedule'] as const;
export type FeishuCommandCenterView = 'home' | typeof CATEGORY_VIEWS[number] | typeof FORM_VIEWS[number];

const FORM_DEFINITIONS = {
  'form-workspace': {
    title: '切换工作区',
    description: '填写 root 范围内的绝对或相对路径。',
    fields: [{ name: 'path', label: '工作区路径', placeholder: '例如：projects/hmi-reader' }],
    submitLabel: '应用工作区',
    returnView: 'runtime',
  },
  'form-chat': {
    title: '发送 Agent 消息',
    description: '消息会沿用当前会话的成员与权限上下文。',
    fields: [{ name: 'message', label: '消息内容', placeholder: '请输入要发送给 Agent 的消息', multiline: true }],
    submitLabel: '发送消息',
    returnView: 'room',
  },
  'form-plan': {
    title: '创建 PLAN',
    description: '只讨论需求并提交合格 PLAN，不直接实施。',
    fields: [{ name: 'requirements', label: '需求', placeholder: '请描述目标、范围和验收标准', multiline: true }],
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
    submitLabel: '应用调度',
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
            name: 'submitApCommand',
            text: { tag: 'plain_text', content: form.submitLabel },
            type: 'primary_filled',
            form_action_type: 'submit',
            value: { cmd: 'ap-form', form: view, chatType },
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
      callbackButton('发送消息…', { cmd: 'ap-menu', view: 'form-chat', chatType }),
      callbackButton('创建 PLAN…', { cmd: 'ap-menu', view: 'form-plan', chatType }),
    ]
    : categoryView === 'runtime'
      ? [callbackButton('切换工作区…', { cmd: 'ap-menu', view: 'form-workspace', chatType })]
      : categoryView === 'workflow'
        ? [callbackButton('修改调度…', { cmd: 'ap-menu', view: 'form-schedule', chatType })]
        : [];
  return cardShell(group, `AP 命令中心 · ${pageIndex + 1}/${HELP_PAGES.length}`, [
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

export const buildFeishuCommandCenterCards = (chatType: 'p2p' | 'group') => [
  buildFeishuCommandCenterCard(chatType),
];

export const buildFeishuCommandFromForm = (
  form: unknown,
  values: Record<string, unknown> | undefined,
): ParsedFeishuCommand | null => {
  const text = (name: string) => typeof values?.[name] === 'string' ? values[name].trim() : '';
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
