import { safeFeishuCard } from './feishu-card-markdown';
import { PROGRESS_CARD_MIN_MS, sanitizePreview } from '@/lib/acpx/harness-events';
import { resolveFeishuMessageTarget, sendFeishuInteractiveMessage } from '@/lib/feishu-api';

const RECENT_TOOL_COUNT = 5;

interface ToolEntry {
  toolName: string;
  preview: string;
  emoji: string;
  count: number;
}

interface SystemEntry {
  message: string;
  emoji: string;
  time: string;
}

export type FeishuProgressTarget = {
  chatId: string;
  // Thread output replies to the persisted entry root.
  threadId?: string | null;
  rootMessageId?: string | null;
};

export class FeishuProgressTracker {
  private progressMsgId: string | null = null;
  private chatId: string;
  private target: ReturnType<typeof resolveFeishuMessageTarget>;
  private entries: ToolEntry[] = [];
  private systemEntries: SystemEntry[] = [];
  private replyContent: { text: string; details: string; usage: string } | null = null;
  private footnotes: string[] = [];
  setFootnotes(lines: string[]): void { this.footnotes = lines; }
  private lastEditAt = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private finalized = false;
  private flushPromise: Promise<void> = Promise.resolve();
  private statusText = '执行中...';
  private stepCount = 0;
  private phase = '等待';
  private latestActivity = '等待 Agent 输出...';
  private readonly startedAt = Date.now();
  private readonly workspaceRoot: string;

  constructor(target: FeishuProgressTarget | string, workspaceRoot = process.cwd(), private readonly displayName = 'Agent') {
    const normalized = typeof target === 'string' ? { chatId: target } : target;
    this.chatId = normalized.chatId;
    this.target = resolveFeishuMessageTarget(normalized);
    this.workspaceRoot = workspaceRoot;
  }

  onToolEvent(toolName: string, preview: string, emoji: string): void {
    console.log(`[FeishuProgress] onToolEvent: ${toolName} | chatId=${this.chatId}`);
    const safeToolName = sanitizePreview(toolName, { workspaceRoot: this.workspaceRoot });
    const safePreview = sanitizePreview(preview, { workspaceRoot: this.workspaceRoot });
    this.phase = '工具';
    this.latestActivity = `${emoji} ${safeToolName}${safePreview ? `：${safePreview}` : ''}`;

    const lastEntry = this.entries.at(-1);
    if (lastEntry && lastEntry.toolName === safeToolName) {
      lastEntry.count += 1;
      lastEntry.preview = safePreview;
    } else {
      this.entries.push({ toolName: safeToolName, preview: safePreview, emoji, count: 1 });
    }
    this.stepCount += 1;

    this.flushPromise = this.flushPromise.then(() => this.maybeFlush()).catch((err) => {
      console.error('[FeishuProgress] flush error:', err);
    });
  }

  onSystemEvent(message: string, emoji = 'ℹ️'): void {
    console.log(`[FeishuProgress] onSystemEvent: ${message} | chatId=${this.chatId}`);
    const truncated = sanitizePreview(message, { workspaceRoot: this.workspaceRoot });
    if (emoji === '🧠') this.phase = '思考';
    else if (emoji === '🚀') this.phase = '等待';
    if (emoji !== '💓') this.latestActivity = `${emoji} ${truncated}`;
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    const lastEntry = this.systemEntries.at(-1);
    if (emoji !== '💓' && (!lastEntry || lastEntry.message !== truncated)) {
      this.systemEntries.push({ message: truncated, emoji, time: timeStr });
      if (this.systemEntries.length > 20) {
        this.systemEntries.shift();
      }
    }

    this.flushPromise = this.flushPromise.then(() => this.maybeFlush()).catch((err) => {
      console.error('[FeishuProgress] flush error:', err);
    });
  }

  setStatus(status: string): void {
    this.statusText = sanitizePreview(status, { workspaceRoot: this.workspaceRoot });
  }

  /** Content has been extracted and redacted at the stream boundary. */
  async setReplyContent(text: string, details: string, usage: string): Promise<void> {
    this.replyContent = { text, details, usage };
    this.flushPromise = this.flushPromise.then(() => this.maybeFlush());
    await this.flushPromise;
  }

  private buildReplyCard(status: string): Record<string, unknown> {
    // ponytail: card previews are bounded; full answers remain in the task room.
    // Budget the doubly encoded request, including Unicode and escaped characters.
    const bounded = (text: string, budget: number) => {
      let size = 0;
      let result = '';
      for (const character of text) {
        size += Buffer.byteLength(JSON.stringify(JSON.stringify(character))) - 6;
        if (size > budget) return `${result}\n…（卡片预览已截断，完整内容请查看任务室）`;
        result += character;
      }
      return result;
    };
    const reply = this.replyContent!;
    const system = this.systemEntries.map(entry => `${entry.emoji} ${entry.message}`).join('\n');
    return {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: `${this.displayName} · ${status}` } },
      elements: [
        { tag: 'markdown', content: bounded(reply.text || '正在处理…', 12000) },
        {
          tag: 'collapsible_panel',
          header: { title: { tag: 'plain_text', content: '⚙️ 系统信息详情' } },
          expanded: false,
          elements: [{ tag: 'div', text: { tag: 'plain_text', content: bounded(
            [reply.details, system].filter(Boolean).join('\n') || '暂无过程信息', 6000,
          ) } }],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content:
          this.footnotes.length ? this.footnotes.join('\n') : `本轮耗时 ${this.elapsedText()}${reply.usage ? ` · ${reply.usage}` : ' · Token 用量未提供'}`,
        }] },
      ],
    };
  }

  private elapsedText(): string {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  }

  private buildCard(): Record<string, unknown> {
    if (this.replyContent !== null) return this.buildReplyCard(this.statusText);
    const toolLines = this.entries.slice(-RECENT_TOOL_COUNT).map((e) => {
      const suffix = e.count > 1 ? ` ×${e.count}` : '';
      return `${e.emoji} ${e.toolName}: "${e.preview}"${suffix}`;
    });

    const systemLines = this.systemEntries.map((s) => `${s.emoji} \`[${s.time}]\` ${s.message}`);

    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'markdown',
        content: `**当前阶段：${this.phase}** · 已用时 ${this.elapsedText()} · 累计 ${this.stepCount} 步\n**最新进展：** ${this.latestActivity}`,
      },
    ];

    if (this.systemEntries.length > 0) {
      elements.push({
        tag: 'collapsible_panel',
        header: { title: { tag: "plain_text", content: "⚙️ 系统信息详情" } },
        expanded: false,
        elements: systemLines.map((line) => ({
          tag: 'markdown',
          content: line,
        })),
      });
    }

    elements.push({
      tag: 'collapsible_panel',
      header: { title: { tag: "plain_text", content: `🛠️ 最近 ${RECENT_TOOL_COUNT} 条工具` } },
      expanded: false,
      elements: toolLines.length > 0
        ? toolLines.map((line) => ({
            tag: 'markdown',
            content: line,
          }))
        : [{
            tag: 'markdown',
            content: '等待工具调用...',
          }],
    });

    if (this.footnotes.length) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: this.footnotes.join('\n') }] });
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: `🔄 Agent ${this.statusText}` },
      },
      elements,
    };
  }

  private async maybeFlush(): Promise<void> {
    if (this.finalized) return;
    const now = Date.now();
    if (!this.progressMsgId) {
      console.log(`[FeishuProgress] sending first progress card to ${this.chatId}`);
      const card = this.buildCard();
      this.progressMsgId = await sendFeishuInteractiveMessage({
        ...this.target,
        card,
      }) ?? null;
      if (this.replyContent !== null && !this.progressMsgId) throw new Error('Feishu reply card returned no message id');
      console.log(`[FeishuProgress] first card sent, id=${this.progressMsgId}`);
      this.lastEditAt = Date.now();
    } else if (now - this.lastEditAt >= PROGRESS_CARD_MIN_MS) {
      console.log(`[FeishuProgress] updating card ${this.progressMsgId}`);
      await this.updateCard();
      this.lastEditAt = Date.now();
    } else {
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        this.flushPromise = this.flushPromise.then(() => this.maybeFlush()).catch((err) => {
          console.error('[FeishuProgress] delayed flush error:', err);
        });
      }, PROGRESS_CARD_MIN_MS - (now - this.lastEditAt));
      this.flushTimer.unref();
    }
  }

  private async updateCard(): Promise<void> {
    if (!this.progressMsgId) return;
    const token = await import('@/lib/feishu-api').then(m => m.getFeishuTenantAccessToken());
    const card = this.buildCard();
    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(this.progressMsgId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: 'interactive',
          content: JSON.stringify(safeFeishuCard(card)),
        }),
      }
    );
    const data = await response.json() as { code?: number; msg?: string };
    if (!response.ok || data.code !== 0) {
      throw new Error(data.msg || `Failed to update Feishu progress card: HTTP ${response.status}`);
    }
  }

  async flush(): Promise<void> {
    await this.flushPromise;
    if (this.progressMsgId && (this.entries.length > 0 || this.systemEntries.length > 0)) {
      await this.updateCard().catch(() => {});
    }
  }

  private buildFinalCard(summary: string, success: boolean): Record<string, unknown> {
    if (this.replyContent !== null) return this.buildReplyCard(success ? '执行完成' : '执行失败');
    const systemLines = this.systemEntries.map((s) => `${s.emoji} \`[${s.time}]\` ${s.message}`);
    const safeSummary = sanitizePreview(summary, { workspaceRoot: this.workspaceRoot });
    const tally = new Map<string, number>();
    for (const entry of this.entries) tally.set(entry.toolName, (tally.get(entry.toolName) ?? 0) + entry.count);
    const tallyText = tally.size
      ? Array.from(tally, ([toolName, count]) => `${toolName} ×${count}`).join(' · ')
      : '无工具调用';
    return {
      config: { wide_screen_mode: true },
      header: {
        template: success ? 'green' : 'red',
        title: { tag: 'plain_text', content: success ? '✅ 执行完成' : '❌ 执行失败' },
      },
      elements: [
        {
          tag: 'markdown',
          content: `**摘要：** ${safeSummary || (success ? '执行完成' : '执行失败')}\n**已用时：** ${this.elapsedText()} · **累计步骤：** ${this.stepCount}\n**工具 tally：** ${tallyText}`,
        },
        ...(this.systemEntries.length > 0 ? [{
          tag: 'collapsible_panel',
          header: { title: { tag: "plain_text", content: "⚙️ 系统信息详情" } },
          expanded: false,
          elements: systemLines.map((line) => ({
            tag: 'markdown',
            content: line,
          })),
        }] : []),
        ...(this.entries.length > 0 ? [{
          tag: 'collapsible_panel',
          header: { title: { tag: "plain_text", content: "🛠️ 工具调用详情" } },
          expanded: false,
          elements: this.entries.map((e) => {
            const suffix = e.count > 1 ? ` ×${e.count}` : '';
            return {
              tag: 'markdown',
              content: `${e.emoji} ${e.toolName}: "${e.preview}"${suffix}`,
            };
          }),
        }] : []),
      ],
    };
  }

  /** Send a final summary card (replacing the progress card) and return the message id */
  async finalize(summary: string, success: boolean): Promise<string | null> {
    this.finalized = true;
    clearTimeout(this.flushTimer);
    await this.flushPromise;
    const card = this.buildFinalCard(summary, success);

    if (this.progressMsgId) {
      try {
        const token = await import('@/lib/feishu-api').then(m => m.getFeishuTenantAccessToken());
        const response = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(this.progressMsgId)}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              msg_type: 'interactive',
              content: JSON.stringify(safeFeishuCard(card)),
            }),
          }
        );
        const data = await response.json() as { code?: number; msg?: string };
        if (!response.ok || data.code !== 0) throw new Error(data.msg || 'Failed to finalize Feishu progress card');
        return this.progressMsgId;
      } catch (error) {
        // A failed edit must not turn streaming into duplicate messages.
        if (this.replyContent !== null) throw error;
        // fall through to send new
      }
    }

    this.progressMsgId = await sendFeishuInteractiveMessage({
      ...this.target,
      card,
    }) ?? null;
    return this.progressMsgId;
  }
}
