import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { deriveGatewayHarnessOptions } from '../src/lib/acpx/catalog';
import { resolveRouteAuth } from '../src/lib/auth-routes';

async function main() {
  assert.deepEqual(
    resolveRouteAuth({ surface: 'api', pathname: '/api/acpx/harness-options', method: 'GET' }),
    { access: 'authenticated' },
  );

  const suffix = crypto.randomBytes(3).toString('hex');
  const owner = await prisma.user.create({
    data: { username: `harness-owner-${suffix}`, passwordHash: 'x:y', role: 'user' },
  });
  const other = await prisma.user.create({
    data: { username: `harness-other-${suffix}`, passwordHash: 'x:y', role: 'user' },
  });
  const nodeNames = [`own-node-${suffix}`, `other-node-${suffix}`];

  try {
    await prisma.remoteNode.create({
      data: {
        name: nodeNames[0],
        host: 'unconnected',
        secretHash: crypto.createHash('sha256').update('a').digest('hex'),
        ownerUserId: owner.id,
        metadata: JSON.stringify({ harnesses: ['pi-agent'], workspace: '/tmp/a' }),
      },
    });
    await prisma.remoteNode.create({
      data: {
        name: nodeNames[1],
        host: 'unconnected',
        secretHash: crypto.createHash('sha256').update('b').digest('hex'),
        ownerUserId: other.id,
        metadata: JSON.stringify({ harnesses: ['pi-agent'] }),
      },
    });
    await prisma.remoteNode.create({
      data: {
        name: `platform-node-${suffix}`,
        host: 'unconnected',
        secretHash: crypto.createHash('sha256').update('c').digest('hex'),
        ownerUserId: null,
        metadata: JSON.stringify({ harnesses: ['pi-agent'] }),
      },
    });

    const ownerOptions = await deriveGatewayHarnessOptions({ id: owner.id, role: 'user' });
    assert.ok(ownerOptions.length > 0, 'owner sees at least their own node');
    const ownerGateways = new Set(ownerOptions.map((option) => option.gatewayId));
    assert.ok(ownerGateways.has(`remote-node:${nodeNames[0]}`), 'own node is offered');
    assert.ok(!ownerGateways.has(`remote-node:${nodeNames[1]}`), 'foreign node is hidden');
    assert.ok(!ownerGateways.has(`remote-node:platform-node-${suffix}`), 'platform node is hidden');
    assert.ok(
      ownerOptions.every((option) => option.executionBackend === 'remote_ssh'
        && option.gatewayId.startsWith(`remote-node:${nodeNames[0]}`)),
      'non-admin never sees platform-local, gateway, or shared-ssh options',
    );

    const adminOptions = await deriveGatewayHarnessOptions({ id: 'admin', role: 'admin' });
    const adminGateways = new Set(adminOptions.map((option) => option.gatewayId));
    assert.ok(adminGateways.has(`remote-node:${nodeNames[0]}`), 'admin sees owned nodes');
    assert.ok(adminGateways.has(`remote-node:platform-node-${suffix}`), 'admin sees platform nodes');
  } finally {
    await prisma.remoteNode.deleteMany({ where: { name: { in: [...nodeNames, `platform-node-${suffix}`] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }

  console.log('acpx harness options tests passed');
}

void main();
