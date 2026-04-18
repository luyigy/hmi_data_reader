import { editFeishuMessage, sendFeishuTextMessageAndReturnId } from '@/lib/feishu-api';

const THROTTLE_MS = 1500;
const MAX_PREVIEW_LEN = 50;

export class FeishuProgressTracker {
  private progressMsgId: string | null = null;
  private lines: string[] = [];
  private lastEditAt = 0;
  private flushPromise: Promise<void> = Promise.resolve();

  constructor(private readonly chatId: string) {}

  onToolEvent(toolName: string, preview: string, emoji: string): void {
    console.log(`[FeishuProgress] onToolEvent: ${toolName} | chatId=${this.chatId}`);
    const truncated = preview.length > MAX_PREVIEW_LEN
      ? preview.slice(0, MAX_PREVIEW_LEN) + '…'
      : preview;
    const line = `${emoji} ${toolName}: "${truncated}"`;

    const lastLine = this.lines.at(-1) ?? '';
    const prefix = `${emoji} ${toolName}:`;
    if (lastLine.startsWith(prefix)) {
      const countMatch = lastLine.match(/ ×(\d+)$/);
      const count = countMatch ? parseInt(countMatch[1], 10) + 1 : 2;
      this.lines[this.lines.length - 1] = lastLine.replace(/ ×\d+$/, '') + ` ×${count}`;
    } else {
      this.lines.push(line);
    }

    this.flushPromise = this.flushPromise.then(() => this.maybeFlush()).catch((err) => {
      console.error('[FeishuProgress] flush error:', err);
    });
  }

  private async maybeFlush(): Promise<void> {
    const now = Date.now();
    if (!this.progressMsgId) {
      console.log(`[FeishuProgress] sending first progress message to ${this.chatId}`);
      this.progressMsgId = await sendFeishuTextMessageAndReturnId({
        receiveId: this.chatId,
        text: this.buildContent(),
      });
      console.log(`[FeishuProgress] first message sent, id=${this.progressMsgId}`);
      this.lastEditAt = Date.now();
    } else if (now - this.lastEditAt >= THROTTLE_MS) {
      console.log(`[FeishuProgress] editing message ${this.progressMsgId}`);
      await editFeishuMessage(this.progressMsgId, this.buildContent());
      this.lastEditAt = Date.now();
    } else {
      console.log(`[FeishuProgress] throttled, skipping edit (${now - this.lastEditAt}ms < ${THROTTLE_MS}ms)`);
    }
  }

  async flush(): Promise<void> {
    await this.flushPromise;
    if (this.progressMsgId && this.lines.length > 0) {
      await editFeishuMessage(this.progressMsgId, this.buildContent()).catch(() => {});
    }
  }

  private buildContent(): string {
    return this.lines.join('\n');
  }
}
