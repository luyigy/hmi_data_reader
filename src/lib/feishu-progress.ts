import { editFeishuMessage, sendFeishuInteractiveMessage } from '@/lib/feishu-api';

const THROTTLE_MS = 1500;
const MAX_PREVIEW_LEN = 50;

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

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  onToolEvent(toolName: string, preview: string, emoji: string): void {
    console.log(`[FeishuProgress] onToolEvent: ${toolName} | chatId=${this.chatId}`);
    const truncated = preview.length > MAX_PREVIEW_LEN
      ? preview.slice(0, MAX_PREVIEW_LEN) + '…'
      : preview;

    const lastEntry = this.entries.at(-1);
    if (lastEntry && lastEntry.toolName === toolName) {
      lastEntry.count += 1;
      lastEntry.preview = truncated;
    } else {
      this.entries.push({ toolName, preview: truncated, emoji, count: 1 });
    }
    this.stepCount += 1;

    this.flushPromise = this.flushPromise.then(() => this.maybeFlush()).catch((err) => {
      console.error('[FeishuProgress] flush error:', err);
    });
  }

  onSystemEvent(message: string, emoji = 'ℹ️'): void {
    console.log(`[FeishuProgress] onSystemEvent: ${message} | chatId=${this.chatId}`);
    const truncated = message.length > 80 ? message.slice(0, 80) + '…' : message;
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
    this.statusText = status;
  }

  private buildCard(): Record<string, unknown> {
    const toolLines = this.entries.map((e) => {
      const suffix = e.count > 1 ? ` ×${e.count}` : '';
      return `${e.emoji} ${e.toolName}: "${e.preview}"${suffix}`;
    });

    const systemLines = this.systemEntries.map((s) => `${s.emoji} \`[${s.time}]\` ${s.message}`);

    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'markdown',
        content: `**已完成 ${this.stepCount} 个步骤**`,
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
      header: { title: { tag: "plain_text", content: "🛠️ 工具调用详情" } },
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
    } else if (now - this.lastEditAt >= THROTTLE_MS) {
      console.log(`[FeishuProgress] updating card ${this.progressMsgId}`);
      await this.updateCard();
      this.lastEditAt = Date.now();
    } else {
      console.log(`[FeishuProgress] throttled, skipping edit (${now - this.lastEditAt}ms < ${THROTTLE_MS}ms)`);
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

  /** Send a final summary card (replacing the progress card) and return the message id */
  async finalize(summary: string, success: boolean): Promise<string | null> {
    await this.flushPromise;
    const systemLines = this.systemEntries.map((s) => `${s.emoji} \`[${s.time}]\` ${s.message}`);
    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: success ? 'green' : 'red',
        title: { tag: 'plain_text', content: success ? '✅ 执行完成' : '❌ 执行失败' },
      },
      elements: [
        {
          tag: 'markdown',
          content: success ? '执行完成，步骤明细见下：' : summary.slice(0, 4000),
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
