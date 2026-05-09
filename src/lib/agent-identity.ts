/**
 * Agent Identity Management - 智能命名和身份识别
 *
 * 提供智能命名生成、昵称管理、提及匹配等功能
 */

import type { Agent, Gateway, LiveRoomMember } from '@prisma/client';

// ============================================================================
// 类型定义
// ============================================================================

export interface AgentIdentity {
  /** 唯一标识符 */
  agentKey: string;
  /** 显示名称 */
  displayName: string;
  /** 用户自定义昵称 */
  userNickname: string | null;
  /** 简短别名（用于 @提及） */
  shortAlias: string | null;
  /** 角色描述 */
  roleDescription: string | null;
  /** 颜色标签 */
  colorTag: string | null;
  /** 表情图标 */
  emojiIcon: string | null;
  /** 服务器主机名（用于 platform_local agents） */
  hostname: string | null;
}

export interface AgentWithGateway extends Agent {
  gateway: Gateway | null;
}

export interface LiveRoomMemberWithAgent extends LiveRoomMember {
  agentRecord: AgentWithGateway | null;
  gateway: Gateway | null;
}

// ============================================================================
// 智能命名生成
// ============================================================================

/**
 * 生成 agentKey（唯一标识符）
 * 格式: {gatewayId}:{harnessType} 或 platform_local:{harnessType}
 */
export const generateAgentKey = (
  gatewayId: string | null,
  harnessType: string,
  backend?: string | null
): string => {
  const prefix = backend === 'platform_local' ? 'platform_local' : gatewayId || 'unknown';
  return `${prefix}:${harnessType}`;
};

/**
 * 生成显示名称
 * - 单个同类 agent: "Claude"
 * - 多个同类 agent: "Claude (本地)", "Claude (Linux)"
 * - platform_local with hostname: "Claude (server-01)"
 */
export const generateDisplayName = (
  harnessType: string,
  gatewayName: string | null,
  backend: string | null,
  sameTypeCount: number,
  hostname: string | null = null
): string => {
  const titleCase = toTitleCase(harnessType);

  // platform_local 的特殊处理 - 使用 hostname 区分不同服务器
  if (backend === 'platform_local') {
    if (hostname) {
      // 有 hostname 时使用: "Claude (server-01)"
      const hostnameShort = hostname.split('.')[0]; // 只取主机名第一部分
      return `${titleCase} (${hostnameShort})`;
    }
    return sameTypeCount <= 1 ? `${titleCase} (本地)` : `${titleCase} (平台本地)`;
  }

  // 只有一个该类型的 agent
  if (sameTypeCount <= 1) {
    return titleCase;
  }

  // 多个同类型 agent，添加 gateway 简称
  const gatewayShort = extractShortName(gatewayName);
  return gatewayShort ? `${titleCase} (${gatewayShort})` : titleCase;
};

/**
 * 生成简短别名（用于 @提及）
 * - "Claude (本地)" -> "本地Claude" 或 "local-claude"
 * - "Claude (server-01)" -> "server-01-claude"
 * - "Claude (Linux)" -> "linux-claude"
 * - 支持中英文
 */
export const generateShortAlias = (
  displayName: string,
  harnessType: string,
  gatewayName: string | null,
  backend: string | null,
  hostname: string | null = null
): string => {
  const type = harnessType.toLowerCase();

  // platform_local 使用特殊别名
  if (backend === 'platform_local') {
    if (hostname) {
      // 有 hostname 时使用: "server-01-claude"
      const hostnameShort = toKebabCase(hostname.split('.')[0]);
      return `${hostnameShort}-${type}`;
    }
    return `local-${type}`; // e.g., "local-claude", "local-codex"
  }

  // 从 displayName 提取简称
  // "Claude (Linux Gateway)" -> "linux-claude"
  const match = displayName.match(/^(\w+)\s*\(([^)]+)\)/);
  if (match) {
    const [, agentType, qualifier] = match;
    const qualifierShort = toKebabCase(qualifier.split(' ')[0]); // 只取第一个词
    return `${qualifierShort}-${agentType.toLowerCase()}`;
  }

  // 降级：使用 gateway 名称的第一个词 + agent 类型
  const gatewayShort = toKebabCase(extractShortName(gatewayName) || 'unknown');
  return `${gatewayShort}-${type}`;
};

/**
 * 生成默认颜色标签
 * 根据 harnessType 和 gatewayId 生成一致的颜色
 */
export const generateDefaultColorTag = (
  harnessType: string,
  gatewayId: string | null
): string => {
  const colors = [
    '#4A90E2', // 蓝色
    '#50E3C2', // 青色
    '#F5A623', // 橙色
    '#E056FD', // 紫色
    '#FF6B6B', // 红色
    '#6BCB77', // 绿色
    '#FFD93D', // 黄色
    '#4D96FF', // 深蓝
  ];

  // 基于 harnessType 和 gatewayId 生成哈希
  const input = `${harnessType}:${gatewayId || 'platform_local'}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
  }

  const index = Math.abs(hash) % colors.length;
  return colors[index];
};

/**
 * 生成默认表情图标
 */
export const generateDefaultEmojiIcon = (harnessType: string): string => {
  const type = harnessType.toLowerCase();
  const emojiMap: Record<string, string> = {
    'claude': '🤖',
    'codex': '💻',
    'gemini': '✨',
    'gemini-cli': '✨',
    'main': '🧠',
    'gpt': '🔮',
    'llama': '🦙',
    'mistral': '🌀',
  };

  return emojiMap[type] || '⚙️';
};

// ============================================================================
// 提及匹配（优先使用昵称/别名）
// ============================================================================

/**
 * 获取用于提及匹配的所有别名
 * 优先级: userNickname > shortAlias > displayName > agentKey
 */
export const getMentionAliases = (
  member: LiveRoomMemberWithAgent
): string[] => {
  const aliases: string[] = [];

  // 1. 房间专属昵称（最高优先级）
  if (member.userNickname) {
    aliases.push(member.userNickname);
  }

  // 2. Agent 级别的用户昵称
  if (member.agentRecord?.userNickname) {
    aliases.push(member.agentRecord.userNickname);
  }

  // 3. 简短别名
  if (member.shortAlias) {
    aliases.push(member.shortAlias);
  }

  // 4. 显示名称
  aliases.push(member.displayName);

  // 5. agent name snapshot（如果存在）
  if (member.agentNameSnapshot) {
    aliases.push(member.agentNameSnapshot);
  }

  // 6. 生成简短别名（如果未设置）
  if (!member.shortAlias) {
    const generatedAlias = generateShortAlias(
      member.displayName,
      member.harnessType || 'unknown',
      member.gateway?.name || null,
      member.backend,
      member.agentRecord?.hostname || null
    );
    aliases.push(generatedAlias);
  }

  // 7. 完整格式别名
  if (member.roleLabel) {
    aliases.push(member.roleLabel);
  }

  return aliases.filter(Boolean);
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 转换为标题格式
 */
function toTitleCase(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(/[_\s-]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * 转换为 kebab-case
 */
function toKebabCase(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w-]/g, '');
}

/**
 * 提取简称
 * "Linux Gateway 10.0.8.4" -> "Linux"
 * "Platform Local" -> "本地"
 */
function extractShortName(name: string | null): string | null {
  if (!name) return null;

  // 中文检测
  if (/[\u4e00-\u9fa5]/.test(name)) {
    // 提取中文词
    const chineseMatch = name.match(/[\u4e00-\u9fa5]+/);
    return chineseMatch ? chineseMatch[0] : name.split(' ')[0];
  }

  // 英文：取第一个词
  return name.split(' ')[0];
}

// ============================================================================
// Agent Identity 构建器
// ============================================================================

/**
 * 构建完整的 Agent Identity 对象
 */
export const buildAgentIdentity = (
  member: LiveRoomMemberWithAgent
): AgentIdentity => {
  const agent = member.agentRecord;
  const gateway = member.gateway;

  // 优先使用房间级别的昵称，其次使用 Agent 级别的昵称
  const userNickname = member.userNickname || agent?.userNickname || null;

  // 生成或使用已有的 shortAlias
  const shortAlias = member.shortAlias ||
    (agent ? generateShortAlias(
      member.displayName,
      member.harnessType || 'unknown',
      gateway?.name || null,
      member.backend,
      agent.hostname || null
    ) : null);

  // 角色描述
  const roleDescription = agent?.roleDescription || null;

  // 颜色标签
  const colorTag = agent?.colorTag ||
    generateDefaultColorTag(member.harnessType || 'unknown', gateway?.id || null);

  // 表情图标
  const emojiIcon = agent?.emojiIcon ||
    generateDefaultEmojiIcon(member.harnessType || 'unknown');

  // agentKey
  const agentKey = generateAgentKey(
    gateway?.id || null,
    member.harnessType || 'unknown',
    member.backend
  );

  // hostname (for platform_local agents)
  const hostname = agent?.hostname || null;

  return {
    agentKey,
    displayName: member.displayName,
    userNickname,
    shortAlias,
    roleDescription,
    colorTag,
    emojiIcon,
    hostname,
  };
};

/**
 * 获取用于显示的名称
 * 优先级: userNickname > displayName
 */
export const getDisplayLabel = (
  member: LiveRoomMemberWithAgent,
  includeEmoji: boolean = true
): string => {
  const identity = buildAgentIdentity(member);
  const label = identity.userNickname || identity.displayName;

  if (includeEmoji && identity.emojiIcon) {
    return `${identity.emojiIcon} ${label}`;
  }

  return label;
};

/**
 * 获取用于 @提及的标签
 * 优先级: userNickname > shortAlias > displayName
 */
export const getMentionLabel = (member: LiveRoomMemberWithAgent): string => {
  const identity = buildAgentIdentity(member);

  return identity.userNickname ||
         identity.shortAlias ||
         identity.displayName;
};
