import { PROGRESS_CARD_MIN_MS, sanitizePreview } from '@/lib/acpx/harness-events';
import { editFeishuMessage, sendFeishuInteractiveMessage } from '@/lib/feishu-api';

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

export class FeishuProgressTracker {
  private progressMsgId: string | null = null;
  private chatId: string;
  private entries: ToolEntry[] = [];
  private systemEntries: SystemEntry[] = [];
  private lastEditAt = 0;
  private flushPromise: Promise<void> = Promise.resolve();
  private statusText = '执行中...';
  private stepCount = 0;
  private phase = '等待';
  private readonly startedAt = Date.now();
  private readonly workspaceRoot: string;

  constructor(chatId: string, workspaceRoot = process.cwd()) {
    this.chatId = chatId;
    this.workspaceRoot = workspaceRoot;
  }

  onToolEvent(toolName: string, preview: string, emoji: string): void {
    console.log(`[FeishuProgress] onToolEvent: ${toolName} | chatId=${this.chatId}`);
    const safeToolName = sanitizePreview(toolName, { workspaceRoot: this.workspaceRoot });
    const safePreview = sanitizePreview(preview, { workspaceRoot: this.workspaceRoot });
    this.phase = '工具';

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
    else if (emoji === '💓' || emoji === '🚀') this.phase = '等待';
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    const lastEntry = this.systemEntries.at(-1);
    if (lastEntry && lastEntry.message === truncated) {
      return;
    }

    this.systemEntries.push({ message: truncated, emoji, time: timeStr });
    if (this.systemEntries.length > 20) {
      this.systemEntries.shift();
    }

    this.flushPromise = this.flushPromise.then(() => this.maybeFlush()).catch((err) => {
      console.error('[FeishuProgress] flush error:', err);
    });
  }

  setStatus(status: string): void {
    this.statusText = sanitizePreview(status, { workspaceRoot: this.workspaceRoot });
  }

  private elapsedText(): string {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  }

  private buildCard(): Record<string, unknown> {
    const toolLines = this.entries.slice(-RECENT_TOOL_COUNT).map((e) => {
      const suffix = e.count > 1 ? ` ×${e.count}` : '';
      return `${e.emoji} ${e.toolName}: "${e.preview}"${suffix}`;
    });

    const systemLines = this.systemEntries.map((s) => `${s.emoji} \`[${s.time}]\` ${s.message}`);

    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'markdown',
        content: `**当前阶段：${this.phase}** · 已用时 ${this.elapsedText()} · 累计 ${this.stepCount} 步`,
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
    const now = Date.now();
    if (!this.progressMsgId) {
      console.log(`[FeishuProgress] sending first progress card to ${this.chatId}`);
      const card = this.buildCard();
      this.progressMsgId = await sendFeishuInteractiveMessage({
        receiveId: this.chatId,
        card,
      }) ?? null;
      console.log(`[FeishuProgress] first card sent, id=${this.progressMsgId}`);
      this.lastEditAt = Date.now();
    } else if (now - this.lastEditAt >= PROGRESS_CARD_MIN_MS) {
      console.log(`[FeishuProgress] updating card ${this.progressMsgId}`);
      await this.updateCard();
      this.lastEditAt = Date.now();
    } else {
      console.log(`[FeishuProgress] throttled, skipping edit (${now - this.lastEditAt}ms < ${PROGRESS_CARD_MIN_MS}ms)`);
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
          content: JSON.stringify(card),
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
    await this.flushPromise;
    const card = this.buildFinalCard(summary, success);

    if (this.progressMsgId) {
      try {
        const token = await import('@/lib/feishu-api').then(m => m.getFeishuTenantAccessToken());
        await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(this.progressMsgId)}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              msg_type: 'interactive',
              content: JSON.stringify(card),
            }),
          }
        );
        return this.progressMsgId;
      } catch {
        // fall through to send new
      }
    }

    this.progressMsgId = await sendFeishuInteractiveMessage({
      receiveId: this.chatId,
      card,
    }) ?? null;
    return this.progressMsgId;
  }
}
