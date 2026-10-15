import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FeishuConnectionSupervisor,
  FEISHU_PONG_TIMEOUT_MS,
} from '../src/lib/feishu-connection-supervisor';

test('silent Feishu connection is replaced once and admin gets outage and recovery notices', async () => {
  let now = 0;
  const clients: Array<{
    callbacks: { onPong: () => void; onReconnect: () => void };
    closed: boolean;
    starts: number;
  }> = [];
  const notices: string[] = [];
  const states: string[] = [];
  const supervisor = new FeishuConnectionSupervisor({
    now: () => now,
    createClient: (callbacks) => {
      const client = { callbacks, closed: false, starts: 0 };
      clients.push(client);
      return {
        start: async () => { client.starts++; },
        close: () => { client.closed = true; },
      };
    },
    notify: async (message) => { notices.push(message); },
    report: (state) => { states.push(state); },
    log: () => {},
  });

  try {
    supervisor.start();
    clients[0].callbacks.onPong();
    now = FEISHU_PONG_TIMEOUT_MS - 1;
    supervisor.check();
    assert.equal(clients.length, 1);

    now = FEISHU_PONG_TIMEOUT_MS;
    supervisor.check();
    assert.equal(clients[0].closed, true);
    assert.equal(clients.length, 1);
    assert.equal(clients[0].starts, 2);
    assert.deepEqual(states.slice(-2), ['stalled', 'connecting']);

    now += FEISHU_PONG_TIMEOUT_MS;
    supervisor.check();
    assert.equal(clients[0].starts, 3, 'a still-stalled socket is retried');

    clients[0].callbacks.onPong();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(states.at(-1), 'healthy');
    assert.equal(notices.length, 2);
    assert.match(notices[0], /正在自动重连/);
    assert.match(notices[1], /连接已恢复/);
  } finally {
    supervisor.stop();
  }
});

test('normal SDK reconnect resets the pong deadline without warning the admin', async () => {
  let now = 0;
  let callbacks!: { onPong: () => void; onReconnect: () => void };
  const notices: string[] = [];
  const supervisor = new FeishuConnectionSupervisor({
    now: () => now,
    createClient: (next) => {
      callbacks = next;
      return { start: async () => {}, close: () => {} };
    },
    notify: async (message) => { notices.push(message); },
    report: () => {},
    log: () => {},
  });
  try {
    supervisor.start();
    callbacks.onPong();
    now = FEISHU_PONG_TIMEOUT_MS - 1000;
    callbacks.onReconnect();
    now += 2000;
    supervisor.check();
    assert.equal(notices.length, 0);
  } finally {
    supervisor.stop();
  }
});
