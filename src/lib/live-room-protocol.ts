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
  'Live room directed-visible protocol:',
  '- If the user asks you to contact another room member, do not answer on their behalf.',
  '- A named live-room member is not an internal sub-agent. Do not use spawn_agent, send_message, or another private delegation mechanism to contact them.',
  '- If the requested name matches an available replyable member, you must use the $member protocol below so the handoff stays visible in the room.',
  '- Instead, reply with exactly one directed message that starts with a single $member alias and then the message body.',
  '- Example: $pi 请回复一句 can hear you，并告诉我你的名字',
  '- The platform will treat that as a room-visible directed message: the operator can still see it, but only the mentioned member will act on it.',
  '- Use $member only for this protocol. Do not use @member.',
  '- Do not mention multiple members when using this protocol.',
  '- If you are contacting another member, do not add explanation, summary, or extra prose before or after the $member message.',
  directedTargetAlias
    ? `- For this turn, the intended member to contact is ${directedTargetDisplayName}. Your reply should start with $${directedTargetAlias}.`
    : '- If no other member needs to be contacted, answer normally.',
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
