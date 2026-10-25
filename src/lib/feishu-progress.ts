import { turnReplyElements } from './agent-reply-card';
import { safeFeishuCard } from './feishu-card-markdown';
import { PROGRESS_CARD_MIN_MS, sanitizePreview } from '@/lib/acpx/harness-events';
import { resolveFeishuMessageTarget, sendFeishuInteractiveMessage } from '@/lib/feishu-api';

export type ProgressCardPublisher = (card: Record<string, unknown>, final: boolean) => Promise<string>;

interface ToolEntry {
  toolName: string;
  preview: string;
  emoji: string;
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
  private sendAttempted = false;
  private chatId: string;
  private target: ReturnType<typeof resolveFeishuMessageTarget>;
  private entries: ToolEntry[] = [];
  private systemEntries: SystemEntry[] = [];
  private replyContent: { text: string; details: string; usage: string; processEntries?: string[] } | null = null;
  private footnotes: string[] = [];
  setFootnotes(lines: string[]): void { this.footnotes = lines; }
  private lastEditAt = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private finalized = false;
  private flushPromise: Promise<void> = Promise.resolve();
  private statusText = '执行中...';
  private latestActivity = '等待 Agent 输出...';
  private readonly startedAt = Date.now();
  private readonly workspaceRoot: string;

  constructor(target: FeishuProgressTarget | string, workspaceRoot = process.cwd(), private readonly displayName = 'Agent', private readonly publisher?: ProgressCardPublisher) {
    const normalized = typeof target === 'string' ? { chatId: target } : target;
    this.chatId = normalized.chatId;
    this.target = resolveFeishuMessageTarget(normalized);
    this.workspaceRoot = workspaceRoot;
  }

  onToolEvent(toolName: string, preview: string, emoji: string): void {
    console.log(`[FeishuProgress] onToolEvent: ${toolName} | chatId=${this.chatId}`);
    const safeToolName = sanitizePreview(toolName, { workspaceRoot: this.workspaceRoot });
    const safePreview = sanitizePreview(preview, { workspaceRoot: this.workspaceRoot });
    this.latestActivity = `${emoji} ${safeToolName}${safePreview ? `：${safePreview}` : ''}`;

    this.entries.push({ toolName: safeToolName, preview: safePreview, emoji });

    this.flushPromise = this.flushPromise.then(() => this.maybeFlush()).catch((err) => {
      console.error('[FeishuProgress] flush error:', err);
    });
  }

  onSystemEvent(message: string, emoji = 'ℹ️'): void {
    console.log(`[FeishuProgress] onSystemEvent: ${message} | chatId=${this.chatId}`);
    const truncated = sanitizePreview(message, { workspaceRoot: this.workspaceRoot });
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
  async setReplyContent(text: string, details: string, usage: string, processEntries?: string[]): Promise<void> {
    this.replyContent = { text, details, usage, processEntries };
    this.flushPromise = this.flushPromise.then(() => this.maybeFlush());
    await this.flushPromise;
  }

  private elapsedText(): string {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  }

  private renderCard(active: boolean, summary = '', success = true): Record<string, unknown> {
    const reply = this.replyContent;
    const process = reply ? reply.details : this.systemEntries.filter(entry => entry.emoji === '🧠').map(entry => entry.message.replace(/^思考分析[:：]\s*/, '')).join('\n');
    return {
      config: { wide_screen_mode: true },
      header: { template: active ? 'blue' : success ? 'green' : 'red', title: { tag: 'plain_text',
        content: `${this.displayName} · ${active ? this.statusText : success ? '执行完成' : '执行失败'}` } },
      elements: turnReplyElements({ active, latest: reply?.text || this.latestActivity, final: summary,
        processEntries: reply?.processEntries, processStarted: `开始处理消息 | ${this.displayName}`,
        process, tools: this.entries.map(entry => `${entry.emoji} ${entry.toolName}：${entry.preview}`).join('\n'),
        footnotes: this.footnotes.length ? this.footnotes : [`耗时 ${this.elapsedText()} · ${reply?.usage || 'Token 用量未提供'}`],
      }),
    };
  }

  private buildCard(): Record<string, unknown> { return this.renderCard(true); }

  private async maybeFlush(): Promise<void> {
    if (this.finalized) return;
    const now = Date.now();
    if (this.publisher) {
      if (!this.progressMsgId || now - this.lastEditAt >= PROGRESS_CARD_MIN_MS) {
        this.progressMsgId = await this.publisher(this.buildCard(), false);
        this.lastEditAt = Date.now();
      } else {
        this.flushTimer ??= setTimeout(() => {
          this.flushTimer = undefined;
          this.flushPromise = this.flushPromise.then(() => this.maybeFlush()).catch(error => console.error('[FeishuProgress] delayed update:', error));
        }, PROGRESS_CARD_MIN_MS - (now - this.lastEditAt));
        this.flushTimer.unref();
      }
      return;
    }
    if (!this.progressMsgId) {
      if (this.sendAttempted) throw new Error('Feishu reply card has no message id; reconcile original send');
      this.sendAttempted = true;
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
    if (this.publisher) { this.progressMsgId = await this.publisher(this.buildCard(), false); return; }
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
    return this.renderCard(false, summary, success);
  }

  /** Send a final summary card (replacing the progress card) and return the message id */
  async finalize(summary: string, success: boolean): Promise<string | null> {
    this.finalized = true;
    clearTimeout(this.flushTimer);
    await this.flushPromise.catch(() => undefined);
    const card = this.buildFinalCard(summary, success);
    if (this.publisher) { this.progressMsgId = await this.publisher(card, true); return this.progressMsgId; }

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

    if (this.sendAttempted && !this.progressMsgId) throw new Error('Feishu reply card has no message id; reconcile original send');
    this.sendAttempted = true;
    this.progressMsgId = await sendFeishuInteractiveMessage({
      ...this.target,
      card,
    }) ?? null;
    return this.progressMsgId;
  }
}
