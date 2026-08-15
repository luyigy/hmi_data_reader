import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { claimPairingTicket, createPairingTicket, PairingTicketError } from '../src/lib/pairing-tickets';
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

    const wsSource = await readFile('src/lib/remote-node-ws.ts', 'utf8');
    const runnerSource = await readFile('scripts/agent-platform-runner.js', 'utf8');
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
