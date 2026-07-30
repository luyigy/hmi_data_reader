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

export const buildFeishuCommandCenterCards = (chatType: 'p2p' | 'group') => HELP_PAGES.map(
  ([group, commands], pageIndex) => ({
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: `AP 命令中心 · ${group}` },
    },
    header: {
      title: { tag: 'plain_text', content: group },
      subtitle: { tag: 'plain_text', content: `AP 命令中心 · ${pageIndex + 1}/${HELP_PAGES.length}` },
      template: pageIndex === 2 ? 'wathet' : 'blue',
      icon: { tag: 'standard_icon', token: pageIndex === 3 ? 'approval_colorful' : 'lark-logo_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [{
            tag: 'column',
            width: 'weighted',
            weight: 1,
            background_style: pageIndex === 2 ? 'wathet-50' : 'blue-50',
            padding: '12px',
            elements: [{
              tag: 'markdown',
              content: '**点击执行常用只读命令**\n带参数或会改变状态的命令仅展示模板，请显式输入。',
            }],
          }],
        },
        {
          tag: 'markdown',
          content: commands.map((command) => `- \`${command}\``).join('\n'),
          text_size: 'notation',
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          columns: QUICK_ACTIONS[pageIndex].map(([label, command], actionIndex) => ({
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: label },
              type: actionIndex === 0 ? 'primary_filled' : 'default',
              size: 'small',
              behaviors: [{
                type: 'callback',
                value: { cmd: 'ap-command', command, chatType },
              }],
            }],
          })),
        },
      ],
    },
  }),
);

export async function sendFeishuCommandCenter(context?: FeishuConversationContext) {
  if (!context) return '当前命令中心需要来自 Feishu webhook 的会话上下文。';
  for (const card of buildFeishuCommandCenterCards(context.chatType === 'p2p' ? 'p2p' : 'group')) {
    await sendFeishuInteractiveMessage({
      receiveId: context.chatId,
      receiveIdType: 'chat_id',
      card,
    });
  }
  return '✅ AP 命令中心已发送；只有以 /ap 开头的消息才会被识别为命令。';
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
