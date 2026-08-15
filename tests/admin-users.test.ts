import assert from 'node:assert/strict';
import { createUserSession, loadAuthConfig } from '../src/lib/auth';
import { prisma } from '../src/lib/prisma';
import { resolveRouteAuth } from '../src/lib/auth-routes';
import { GET, POST } from '../src/app/api/admin/users/route';
import { DELETE } from '../src/app/api/admin/users/[id]/route';
import { POST as resetPassword } from '../src/app/api/admin/users/[id]/reset-password/route';

const env = {
  NODE_ENV: 'production',
  AUTH_ADMIN_USERNAME: 'admin',
  AUTH_ADMIN_PASSWORD: 'correct horse battery staple',
  AUTH_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  AUTH_SESSION_TTL_SECONDS: '3600',
  AUTH_ALLOW_INSECURE_LOCAL: 'false',
};

const request = (url: string, token: string, init: RequestInit = {}) => new Request(url, {
  ...init,
  headers: { cookie: `ap_auth_token=${token}`, 'content-type': 'application/json', ...init.headers },
});

async function main() {
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const config = loadAuthConfig(env as NodeJS.ProcessEnv);
  const adminToken = createUserSession({ id: 'admin', username: 'admin', role: 'admin' }, config);
  const userToken = createUserSession({ id: 'user-1', username: 'alice', role: 'user' }, config);
  const users = prisma.user as unknown as Record<string, (...args: never[]) => Promise<unknown>>;
  const originals = Object.fromEntries(['findUnique', 'findMany', 'create', 'update', 'delete'].map((key) => [key, users[key]]));

  try {
    assert.deepEqual(resolveRouteAuth({ surface: 'page', pathname: '/admin/users', method: 'GET' }), { access: 'admin' });
    assert.deepEqual(resolveRouteAuth({ surface: 'api', pathname: '/api/admin/users/u1/reset-password', method: 'POST' }), { access: 'admin' });

    users.findUnique = async () => ({
      id: 'user-1', username: 'alice', passwordHash: 'unused', role: 'user', displayName: 'Alice',
      createdAt: new Date(), updatedAt: new Date(),
    });
    assert.equal((await GET(request('http://localhost/api/admin/users', userToken))).status, 403);

    users.findMany = async () => [{ id: 'u1', username: 'bob', role: 'user', displayName: 'Bob' }];
    const listResponse = await GET(request('http://localhost/api/admin/users', adminToken));
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json()).users[0].username, 'bob');

    let created: Record<string, string> | undefined;
    users.findUnique = async () => null;
    users.create = async (args: unknown) => {
      created = (args as { data: Record<string, string> }).data;
      return { id: 'u1', ...created };
    };
    const createResponse = await POST(request('http://localhost/api/admin/users', adminToken, {
      method: 'POST', body: JSON.stringify({ username: 'Bob', displayName: 'Bob', password: 'password123' }),
    }));
    assert.equal(createResponse.status, 201);
    assert.equal(created?.username, 'bob');
    assert.equal(created?.role, 'user');
    assert.notEqual(created?.passwordHash, 'password123');
    assert.equal((await POST(request('http://localhost/api/admin/users', adminToken, {
      method: 'POST', body: JSON.stringify({ username: 'admin', password: 'password123' }),
    }))).status, 409);

    let updated: { where: { id: string }; data: { passwordHash: string } } | undefined;
    users.findUnique = async () => ({ id: 'u1' });
    users.update = async (args: unknown) => { updated = args as typeof updated; return {}; };
    assert.equal((await resetPassword(request('http://localhost/api/admin/users/u1/reset-password', adminToken, {
      method: 'POST', body: JSON.stringify({ password: 'new-password' }),
    }), { params: { id: 'u1' } })).status, 200);
    assert.equal(updated?.where.id, 'u1');
    assert.notEqual(updated?.data.passwordHash, 'new-password');

    let deletedId = '';
    users.delete = async (args: unknown) => { deletedId = (args as { where: { id: string } }).where.id; return {}; };
    assert.equal((await DELETE(request('http://localhost/api/admin/users/u1', adminToken, { method: 'DELETE' }), {
      params: { id: 'u1' },
    })).status, 200);
    assert.equal(deletedId, 'u1');
  } finally {
    for (const [key, value] of Object.entries(originals)) users[key] = value;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log('admin user tests passed');
}

void main();
