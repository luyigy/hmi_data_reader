import * as Lark from '@larksuiteoapi/node-sdk';
import { sendFeishuTextMessage } from '@/lib/feishu-api';
import { updateFeishuRuntimeStatus } from '@/lib/feishu-runtime-status';

export const FEISHU_PONG_TIMEOUT_MS = 7 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;
const NOTICE_TIMEOUT_MS = 10 * 1000;

type ConnectionState = 'connecting' | 'healthy' | 'stalled';
type ConnectionClient = { start(): Promise<void>; close(params: { force: boolean }): void };

export class FeishuConnectionSupervisor {
  private client: ConnectionClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private connectedAt = 0;
  private lastPongAt: number | null = null;
  private incidentOpen = false;
  private stopped = false;
  private noticeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    createClient: (callbacks: { onPong: () => void; onReconnect: () => void }) => ConnectionClient;
    notify: (text: string, signal: AbortSignal) => Promise<void>;
    report: (state: ConnectionState, lastPongAt: number | null) => void;
    log: (message: string, error?: unknown) => void;
    now?: () => number;
  }) {}

  start() {
    if (this.timer || this.stopped) return;
    this.connect();
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  check() {
    if (this.stopped) return;
    const now = this.now();
    if (now - (this.lastPongAt ?? this.connectedAt) < FEISHU_PONG_TIMEOUT_MS) return;

    if (!this.incidentOpen) {
      this.incidentOpen = true;
      this.queueNotice('⚠️ 飞书连接异常：平台暂时无法确认收到新消息，正在自动重连。未收到回复的消息请在恢复后重发。');
    }
    this.report('stalled');
    this.deps.log('Feishu WebSocket pong timeout; reconnecting');
    if (!this.client) {
      this.connect();
      return;
    }
    this.client.close({ force: true });
    this.connectedAt = now;
    this.lastPongAt = null;
    this.report('connecting');
    void this.client.start().catch((error) => this.deps.log('Feishu WebSocket restart failed', error));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    this.client?.close({ force: true });
    this.client = null;
  }

  private now() { return (this.deps.now ?? Date.now)(); }

  private report(state: ConnectionState) {
    try { this.deps.report(state, this.lastPongAt); }
    catch (error) { this.deps.log('Feishu transport status update failed', error); }
  }

  private connect() {
    const generation = ++this.generation;
    this.connectedAt = this.now();
    this.lastPongAt = null;
    this.report('connecting');
    try {
      this.client = this.deps.createClient({
        onPong: () => {
          if (this.stopped || generation !== this.generation) return;
          this.lastPongAt = this.now();
          this.report('healthy');
          if (this.incidentOpen) {
            this.incidentOpen = false;
            this.queueNotice('✅ 飞书连接已恢复，平台已重新接收消息。异常期间发送但没有回复的消息，请重新发送。');
          }
        },
        onReconnect: () => {
          if (this.stopped || generation !== this.generation) return;
          this.connectedAt = this.now();
          this.lastPongAt = null;
          this.report('connecting');
        },
      });
      void this.client.start().catch((error) => this.deps.log('Feishu WebSocket start failed', error));
    } catch (error) {
      this.client = null;
      this.deps.log('Feishu WebSocket creation failed', error);
    }
  }

  private queueNotice(text: string) {
    this.noticeQueue = this.noticeQueue.then(async () => {
      try {
        await this.deps.notify(text, AbortSignal.timeout(NOTICE_TIMEOUT_MS));
      } catch (error) {
        this.deps.log('Feishu admin connection notice failed', error);
      }
    });
  }
}

let activeSupervisor: FeishuConnectionSupervisor | null = null;

export function startFeishuConnectionSupervisor(args: {
  appId: string;
  appSecret: string;
  eventDispatcher: Lark.EventDispatcher;
  prefix: string;
}) {
  activeSupervisor?.stop();
  const { appId, appSecret, eventDispatcher, prefix } = args;
  const adminOpenId = process.env.FEISHU_ADMIN_OPEN_ID?.trim();
  activeSupervisor = new FeishuConnectionSupervisor({
    createClient: ({ onPong, onReconnect }) => {
      // WSClient exposes no pong callback; its public logger receives that signal at trace level.
      const logger = {
        error: () => console.error(`${prefix} Feishu SDK WebSocket error`),
        warn: () => console.warn(`${prefix} Feishu SDK WebSocket warning`),
        info: (parts: unknown) => {
          const values = Array.isArray(parts) ? parts : [parts];
          if (values[0] !== '[ws]') return;
          if (values[1] === 'reconnect') onReconnect();
          if (values[1] === 'reconnect' || values[1] === 'ws client ready') {
            console.info(`${prefix} Feishu WebSocket ${values[1]}`);
          }
        },
        debug: () => {},
        trace: (parts: unknown) => {
          const values = Array.isArray(parts) ? parts : [parts];
          if (values[0] === '[ws]' && values[1] === 'receive pong') onPong();
        },
      };
      const client = new Lark.WSClient({
        appId, appSecret, domain: Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.trace, logger,
      });
      return { start: () => client.start({ eventDispatcher }), close: (params) => client.close(params) };
    },
    notify: async (text, signal) => {
      if (!adminOpenId) throw new Error('FEISHU_ADMIN_OPEN_ID is not configured');
      await sendFeishuTextMessage({ receiveId: adminOpenId, receiveIdType: 'open_id', text, signal });
    },
    report: (transportState, lastPongAt) => {
      updateFeishuRuntimeStatus({
        transportState,
        lastTransportAt: lastPongAt === null ? null : new Date(lastPongAt).toISOString(),
      });
    },
    log: (message, error) => console.warn(`${prefix} ${message}`, error ?? ''),
  });
  activeSupervisor.start();
}

export function stopFeishuConnectionSupervisor() {
  activeSupervisor?.stop();
  activeSupervisor = null;
}
