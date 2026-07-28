import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';

const HELP_PAGES = [
  ['房间与 Agent', [
    '/ap room --workdir=<目录> [--agents=<local:codex,local:claude>] [--topic=xxx] [--profile=safe|dev|full] [--mode=discussion|execution|hybrid] [title]',
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
    '/ap jobs',
    '/ap job <status|cursor|diagnose|schedule|enable|disable|run|retry|stop> <job-id>',
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
