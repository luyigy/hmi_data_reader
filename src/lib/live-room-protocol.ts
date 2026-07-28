export const buildLiveRoomControlManual = ({
  replyableMemberLabels,
  directedTargetAlias,
  directedTargetDisplayName,
}: {
  replyableMemberLabels: string[];
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
  '- Agent mentions are visible references only; they do not schedule another turn.',
  '- Do not attempt an autonomous $member handoff. The operator or a structured /ap plan or /run workflow schedules member turns.',
  directedTargetAlias
    ? `- The requested member is ${directedTargetDisplayName}; explain briefly that the operator or orchestrator must schedule that turn.`
    : '- Answer the current turn normally.',
  `- Available replyable members: ${replyableMemberLabels.join(', ') || '(none)'}`,
].join('\n');

export const buildLiveRoomContinuationMessage = (manual: string, content: string) =>
  `${manual}\n\nLatest user message:\n${content}`;

export const stripLeadingMentionForTarget = ({
  content,
  targetDisplayName,
}: {
  content: string;
  targetDisplayName?: string | null;
}) => {
  if (!/^[@$]/.test(content)) return content;

  if (targetDisplayName) {
    const exactPrefix = `${content[0]}${targetDisplayName}`;
    if (content.startsWith(exactPrefix)) {
      const stripped = content.slice(exactPrefix.length).trim();
      if (stripped) return stripped;
    }
  }

  if (/^[@$]all\b/i.test(content)) {
    const strippedAll = content.replace(/^[@$]all\b/i, '').trim();
    if (strippedAll) return strippedAll;
  }

  return content.match(/^[@$]\S+\s+([\s\S]*)$/)?.[1].trim() || content;
};
