export const buildLiveRoomControlManual = ({
  replyableMemberLabels,
  replyableMemberTokens,
  directedTargetAlias,
  directedTargetDisplayName,
}: {
  replyableMemberLabels: string[];
  replyableMemberTokens?: string[];
  directedTargetAlias?: string | null;
  directedTargetDisplayName?: string | null;
}) => [
  'AP live-room operator manual:',
  '- You are operating inside an Agent Platform live room.',
  '- When the user asks to add a member/agent into the current room, do not describe the plan. Emit a room-control action immediately.',
  '- The room-control action must be the first block in your reply.',
  '- Exact format:',
  '- <room-control>{"action":"add_members","agents":["local:codex","TX-server:claude"]}</room-control>',
  '- `action` is currently limited to `add_members`.',
  '- `agents` is an array of Agent Platform selectors, using the same selector style as `/ap add --agents=...`.',
  '- Valid selector examples:',
  '- `local:codex`',
  '- `local:pi-agent`',
  '- `TX-server:claude`',
  '- `TX-server/claude`',
  '- `claude@TX-server`',
  '- If the user asks to add exactly one member, emit exactly one selector in `agents`.',
  '- If the user names multiple members, emit them all in the same `agents` array.',
  '- Do not invent chat commands. Do not output fake `/ap add` text as the control contract.',
  '- After the room-control block, you may add one short visible sentence for the operator, but it is optional.',
  '- If you do not know the exact selector, make the best selector guess from the room and server names already mentioned by the user.',
  '',
  'Live room turn protocol:',
  '- If the user asks you to contact another room member, do not answer on their behalf.',
  '- A named live-room member is not an internal sub-agent. Do not use spawn_agent, send_message, or another private delegation mechanism to contact them.',
  '- `@member` is a visible reference only; it never schedules another turn.',
  '- When another room member must continue the current request, end with exactly one canonical handoff token from the list below; otherwise emit no handoff token.',
  '- Hand off only when the latest user instruction asks that member to act now. A mention of future work is not permission; if the user says other members should wait, stop after your own reply.',
  '- Never hand off to yourself.',
  '- Never emit multiple handoff tokens. Structured /ap plan and /run workflows keep their orchestrated order.',
  directedTargetAlias
    ? `- The requested member is ${directedTargetDisplayName}; use $${directedTargetAlias} once if your reply should hand off to them.`
    : '- Answer the current turn normally.',
  `- Available replyable members: ${replyableMemberLabels.join(', ') || '(none)'}`,
  `- Canonical handoff tokens: ${replyableMemberTokens?.join(', ') || '(none)'}`,
].join('\n');

export const buildLiveRoomContinuationMessage = (manual: string, content: string) =>
  `${manual}\n\nLatest user message:\n${content}`;

export const stripLeadingMentionForTarget = ({
  content,
  targetDisplayName,
  targetAliases = [],
}: {
  content: string;
  targetDisplayName?: string | null;
  targetAliases?: string[];
}) => {
  if (!/^[@$]/.test(content)) return content;

  for (const targetName of [targetDisplayName, ...targetAliases].filter(Boolean) as string[]) {
    const exactPrefix = `${content[0]}${targetName}`;
    if (content.startsWith(exactPrefix)) {
      const stripped = content.slice(exactPrefix.length).trim();
      if (stripped) return stripped.replace(/^[,.;:!?，。；：！？、]+\s*/, '');
    }
  }

  if (/^[@$]all\b/i.test(content)) {
    const strippedAll = content.replace(/^[@$]all\b/i, '').trim();
    if (strippedAll) return strippedAll;
  }

  return content.match(/^[@$]\S+\s+([\s\S]*)$/)?.[1].trim() || content;
};
