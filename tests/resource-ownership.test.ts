import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { createUserSession, loadAuthConfig } from '../src/lib/auth';
import { AuthenticationError, requireExecutionAccess } from '../src/lib/auth-users';
import { prisma } from '../src/lib/prisma';
import { GET as getTask } from '../src/app/api/tasks/[id]/route';
import { GET as listTasks, POST as createTask } from '../src/app/api/tasks/route';

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
  const token = createUserSession(
    { id: 'user-a', username: 'alice', role: 'user' },
    loadAuthConfig(env as NodeJS.ProcessEnv),
  );
  const request = (url: string, init?: { method?: string; body?: BodyInit; headers?: HeadersInit }) => new NextRequest(url, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie: `ap_auth_token=${token}` },
  });
  const users = prisma.user as unknown as { findUnique: (args: unknown) => Promise<unknown> };
  const tasks = prisma.task as unknown as {
    findMany: (args: any) => Promise<any[]>;
    findFirst: (args: any) => Promise<any>;
  };
  const nodes = prisma.remoteNode as unknown as { count: (args: any) => Promise<number> };
  const originals = {
    userFindUnique: users.findUnique,
    taskFindMany: tasks.findMany,
    taskFindFirst: tasks.findFirst,
    nodeCount: nodes.count,
  };

  try {
    users.findUnique = async () => ({
      id: 'user-a', username: 'alice', passwordHash: 'unused', role: 'user', displayName: 'Alice',
      createdAt: new Date(), updatedAt: new Date(),
    });

    let listWhere: unknown;
    tasks.findMany = async (args) => {
      listWhere = args.where;
      return [];
    };
    assert.equal((await listTasks(request('http://localhost/api/tasks'))).status, 200);
    assert.deepEqual(listWhere, { ownerUserId: 'user-a' });

    let detailWhere: unknown;
    tasks.findFirst = async (args) => {
      detailWhere = args.where;
      return null;
    };
    assert.equal((await getTask(request('http://localhost/api/tasks/task-b'), { params: { id: 'task-b' } })).status, 404);
    assert.deepEqual(detailWhere, { id: 'task-b', ownerUserId: 'user-a' });

    const localCreate = await createTask(request('http://localhost/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: 'forbidden local task',
        executionMode: 'acpx',
        acpxParticipants: [{
          gatewayId: 'platform-local', harnessType: 'codex', role: 'implementer', executionBackend: 'platform_local',
        }],
      }),
      headers: { 'content-type': 'application/json' },
    }));
    assert.equal(localCreate.status, 403);

    nodes.count = async () => 0;
    await assert.rejects(
      requireExecutionAccess(
        { id: 'user-a', username: 'alice', role: 'user', displayName: 'Alice' },
        [{ executionBackend: 'remote_ssh', gatewayId: 'remote-node:bobs-node' }],
      ),
      (error) => error instanceof AuthenticationError && error.status === 403,
    );
  } finally {
    users.findUnique = originals.userFindUnique;
    tasks.findMany = originals.taskFindMany;
    tasks.findFirst = originals.taskFindFirst;
    nodes.count = originals.nodeCount;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log('resource ownership tests passed');
}

void main();
