import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { createUserSession, loadAuthConfig } from '../src/lib/auth';
import { prisma } from '../src/lib/prisma';
import { AuthenticationError, requireAdmin, verifySessionToken } from '../src/lib/auth-users';
import { middleware } from '../src/middleware';

const env = {
  NODE_ENV: 'production',
  AUTH_ADMIN_USERNAME: 'admin',
  AUTH_ADMIN_PASSWORD: 'correct horse battery staple',
  AUTH_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  AUTH_SESSION_TTL_SECONDS: '3600',
  AUTH_ALLOW_INSECURE_LOCAL: 'false',
};

async function main() {
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const config = loadAuthConfig(env as NodeJS.ProcessEnv);
  const token = createUserSession({ id: 'user-1', username: 'alice', role: 'admin' }, config);
  const users = prisma.user as unknown as { findUnique: (args: unknown) => Promise<unknown> };
  const originalFindUnique = users.findUnique;
  const originalFetch = globalThis.fetch;

  try {
    users.findUnique = async () => ({
      id: 'user-1', username: 'alice', passwordHash: 'unused', role: 'user', displayName: 'Alice',
      createdAt: new Date(), updatedAt: new Date(),
    });
    assert.deepEqual(await verifySessionToken(token, config), {
      id: 'user-1', username: 'alice', role: 'user', displayName: 'Alice',
    });
    const shadowAdminToken = createUserSession({ id: 'user-1', username: 'admin', role: 'user' }, config);
    assert.deepEqual(await verifySessionToken(shadowAdminToken, config), {
      id: 'user-1', username: 'alice', role: 'user', displayName: 'Alice',
    });
    await assert.rejects(
      requireAdmin(new Request('http://localhost/', { headers: { cookie: `ap_auth_token=${token}` } })),
      (error) => error instanceof AuthenticationError && error.status === 403,
    );
    await assert.rejects(
      requireAdmin(new Request('http://localhost/', { headers: { cookie: 'ap_auth_token=%' } })),
      (error) => error instanceof AuthenticationError && error.status === 401,
    );

    users.findUnique = async () => null;
    assert.equal(await verifySessionToken(token, config), null);

    globalThis.fetch = async () => new Response(JSON.stringify({ user: { role: 'user' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal((await middleware(new NextRequest('http://localhost/api/tasks'))).headers.get('x-middleware-next'), '1');
    assert.equal((await middleware(new NextRequest('http://localhost/api/workspaces'))).status, 403);

    globalThis.fetch = async () => new Response(null, { status: 401 });
    const redirect = await middleware(new NextRequest('http://localhost/tasks'));
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get('location'), 'http://localhost/login?next=%2Ftasks');
  } finally {
    users.findUnique = originalFindUnique;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log('auth user tests passed');
}

void main();
