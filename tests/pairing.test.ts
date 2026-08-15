import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { claimPairingTicket, createPairingTicket, PairingTicketError, requestOrigin, resolveRunnerServerUrl } from '../src/lib/pairing-tickets';
import { resolveRouteAuth } from '../src/lib/auth-routes';

async function main() {
  const db = prisma as any;
  const originals = {
    transaction: db.$transaction,
    ticketDeleteMany: db.pairingTicket.deleteMany,
    ticketCreate: db.pairingTicket.create,
    ticketFindUnique: db.pairingTicket.findUnique,
  };
  let ticket: any;
  let createdNode: any;

  db.pairingTicket.deleteMany = async () => ({ count: ticket ? 1 : 0 });
  db.pairingTicket.create = async ({ data }: any) => {
    ticket = { id: 'ticket-1', consumedAt: null, createdAt: new Date(), ...data };
    return ticket;
  };
  db.pairingTicket.findUnique = async ({ where }: any) => ticket?.tokenHash === where.tokenHash ? ticket : null;
  db.$transaction = async (value: any) => {
    if (Array.isArray(value)) return Promise.all(value);
    return value({
      pairingTicket: {
        updateMany: async ({ where, data }: any) => {
          if (ticket.id !== where.id || ticket.consumedAt || ticket.expiresAt <= where.expiresAt.gt) return { count: 0 };
          ticket.consumedAt = data.consumedAt;
          return { count: 1 };
        },
      },
      remoteNode: {
        create: async ({ data }: any) => {
          createdNode = { id: 'node-1', ...data };
          return createdNode;
        },
      },
    });
  };

  try {
    assert.equal(
      requestOrigin(new Request('http://0.0.0.0:3010/x', { headers: { host: '10.144.144.5:3010' } })),
      'http://10.144.144.5:3010',
      'Host header wins over the unroutable listen address',
    );
    assert.equal(
      requestOrigin(new Request('http://internal/x', {
        headers: { host: 'proxy.example.com', 'x-forwarded-proto': 'https' },
      })),
      'https://proxy.example.com',
    );

    assert.equal(
      resolveRunnerServerUrl('http://10.144.144.5:3010', {}),
      'ws://10.144.144.5:3012/runner',
      'tunnel access derives a tunnel-routable ws endpoint',
    );
    assert.equal(
      resolveRunnerServerUrl('http://192.168.31.109:3010', {}),
      'ws://192.168.31.109:3012/runner',
    );
    assert.equal(
      resolveRunnerServerUrl('https://platform.example.com', {}),
      'wss://platform.example.com:3012/runner',
    );
    assert.equal(
      resolveRunnerServerUrl('http://10.144.144.5:3010', { REMOTE_RUNNER_PUBLIC_URL: 'https://proxy.example.com/' }),
      'wss://proxy.example.com/runner',
      'explicit public URL override wins',
    );
    assert.equal(
      resolveRunnerServerUrl('http://10.144.144.5:3010', { REMOTE_RUNNER_GATEWAY_PORT: '9312' }),
      'ws://10.144.144.5:9312/runner',
    );

    assert.deepEqual(resolveRouteAuth({ surface: 'api', pathname: '/api/pairing-tickets', method: 'POST' }), { access: 'authenticated' });
    assert.deepEqual(resolveRouteAuth({ surface: 'api', pathname: '/api/runner/claim', method: 'POST' }), { access: 'public' });
    assert.deepEqual(resolveRouteAuth({ surface: 'page', pathname: '/runner.js', method: 'GET' }), { access: 'public' });

    const issued = await createPairingTicket({ id: 'user-a', username: 'alice', role: 'user', displayName: 'Alice' });
    assert.equal(issued.token.length, 64);
    assert.equal(ticket.ownerUserId, 'user-a');
    assert.notEqual(ticket.tokenHash, issued.token);

    const claimed = await claimPairingTicket(issued.token, 'Alice Laptop');
    assert.match(claimed.nodeName, /^alice-laptop-[0-9a-f]{8}$/);
    assert.equal(claimed.nodeSecret.length, 64);
    assert.equal(createdNode.ownerUserId, 'user-a');
    assert.notEqual(createdNode.secretHash, claimed.nodeSecret);
    await assert.rejects(() => claimPairingTicket(issued.token, 'replay'), (error) => error instanceof PairingTicketError && error.status === 409);

    const expired = await createPairingTicket({ id: 'user-b', username: 'bob', role: 'user', displayName: 'Bob' });
    ticket.expiresAt = new Date(0);
    await assert.rejects(() => claimPairingTicket(expired.token, 'expired'), (error) => error instanceof PairingTicketError && error.status === 410);

    const runnerRoute = await import('../src/app/runner.js/route');
    const runnerResponse = runnerRoute.GET(new Request('http://pairing.test/runner.js'));
    const runnerBody = await runnerResponse.then((response: Response) => response.text());
    assert.match(runnerBody, /^process\.env\.AGENT_PLATFORM_SERVER="http:\/\/pairing\.test";/);
    assert.ok(!/^#!/.test(runnerBody), 'served runner must not start with a shebang');
    assert.ok(
      runnerBody.split('\n').slice(1).every((line) => !line.startsWith('#!')),
      'served runner must not contain a mid-file shebang (SyntaxError for node stdin/file)',
    );
    new (await import('node:vm')).Script(runnerBody);

    const wsSource = await readFile('src/lib/remote-node-ws.ts', 'utf8');
    const runnerSource = await readFile('scripts/agent-platform-runner.js', 'utf8');
    const pairingUiSource = await readFile('src/components/common/PairComputerButton.tsx', 'utf8');
    assert.match(pairingUiSource, /Windows PowerShell \/ CMD/);
    assert.match(pairingUiSource, /无需先 cd/);
    assert.match(pairingUiSource, /curl\.exe -fsSL/);
    assert.match(wsSource, /headers\.authorization/);
    assert.doesNotMatch(wsSource, /searchParams\.get\('secret'\)/);
    assert.match(runnerSource, /Authorization: `Bearer \$\{nodeToken\}`/);
    assert.match(runnerSource, /mode: 0o600/);
  } finally {
    db.$transaction = originals.transaction;
    db.pairingTicket.deleteMany = originals.ticketDeleteMany;
    db.pairingTicket.create = originals.ticketCreate;
    db.pairingTicket.findUnique = originals.ticketFindUnique;
  }

  console.log('pairing tests passed');
}

void main();
