import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  AuthConfigurationError,
  createOperatorSession,
  createUserSession,
  loadAuthConfig,
  resolveRouteAuth,
  verifyAdminCredentials,
  verifyOperatorSession,
} from '../src/lib/auth';

const env = {
  NODE_ENV: 'production',
  AUTH_ADMIN_USERNAME: 'admin',
  AUTH_ADMIN_PASSWORD: 'correct horse battery staple',
  AUTH_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  AUTH_SESSION_TTL_SECONDS: '3600',
} as NodeJS.ProcessEnv;
const config = loadAuthConfig(env);
const now = 1_800_000_000;

assert.equal(verifyAdminCredentials('admin', 'correct horse battery staple', config), true);
assert.equal(verifyAdminCredentials('admin', 'wrong password', config), false);

const session = createOperatorSession(config, now);
assert.deepEqual(verifyOperatorSession(session, config, now), { tier: 'operator', subject: 'admin' });
assert.equal(verifyOperatorSession(`${session.slice(0, -1)}x`, config, now), null);
assert.equal(verifyOperatorSession(session, config, now + config.sessionTtlSeconds), null);

const userSession = createUserSession({ id: 'user-1', username: 'alice', role: 'user' }, config, now);
assert.deepEqual(verifyOperatorSession(userSession, config, now), {
  tier: 'operator', subject: 'alice', userId: 'user-1', role: 'user',
});
assert.equal(verifyOperatorSession(`${userSession.slice(0, -1)}x`, config, now), null);

const wrongPurposePayload = Buffer.from(JSON.stringify({
  version: 1,
  purpose: 'password-reset',
  subject: 'admin',
  issuedAt: now,
  expiresAt: now + config.sessionTtlSeconds,
})).toString('base64url');
const wrongPurposeSignature = createHmac('sha256', config.sessionSecret)
  .update(wrongPurposePayload)
  .digest('base64url');
assert.equal(verifyOperatorSession(`${wrongPurposePayload}.${wrongPurposeSignature}`, config, now), null);

assert.throws(
  () => loadAuthConfig({ ...env, AUTH_SESSION_SECRET: undefined }),
  AuthConfigurationError
);
assert.throws(
  () => loadAuthConfig({ ...env, AUTH_ALLOW_INSECURE_LOCAL: 'true' }),
  /forbidden in production/
);
assert.doesNotThrow(() => loadAuthConfig({
  ...env,
  NODE_ENV: 'development',
  AUTH_ALLOW_INSECURE_LOCAL: 'true',
  AUTH_ADMIN_PASSWORD: 'localpass',
  AUTH_SESSION_SECRET: 'local-secret-key',
}));

assert.deepEqual(resolveRouteAuth({ surface: 'page', pathname: '/', method: 'GET' }), { access: 'authenticated' });
assert.deepEqual(resolveRouteAuth({ surface: 'page', pathname: '/workspaces', method: 'GET' }), { access: 'admin' });
assert.deepEqual(resolveRouteAuth({ surface: 'api', pathname: '/api/health', method: 'GET' }), { access: 'public' });
assert.deepEqual(resolveRouteAuth({ surface: 'api', pathname: '/api/feishu/webhook', method: 'POST' }), {
  access: 'machine', subject: 'feishu', verification: 'route',
});
assert.deepEqual(resolveRouteAuth({ surface: 'api', pathname: '/api/gateways/gw-1/test', method: 'POST' }), {
  access: 'machine', subject: 'gateway', verification: 'route',
});
assert.deepEqual(resolveRouteAuth({ surface: 'socket', pathname: '/api/socket' }), { access: 'admin' });
assert.deepEqual(resolveRouteAuth({ surface: 'api', pathname: '/api/unknown', method: 'GET' }), { access: 'deny' });
assert.deepEqual(resolveRouteAuth({ surface: 'api', pathname: '/api/health', method: 'POST' }), { access: 'deny' });

for (const relativePath of readdirSync('src/app', { recursive: true, encoding: 'utf8' })) {
  const filename = path.basename(relativePath);
  if (filename !== 'page.tsx' && filename !== 'route.ts') continue;
  const pathname = `/${path.dirname(relativePath)}`
    .replace(/^\/\.$/, '/')
    .replace(/\[([^\]]+)\]/g, '$1');
  if (filename === 'page.tsx') {
    assert.notEqual(resolveRouteAuth({ surface: 'page', pathname, method: 'GET' }).access, 'deny', relativePath);
    continue;
  }
  const methods = Array.from(readFileSync(path.join('src/app', relativePath), 'utf8')
    .matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)/g));
  for (const match of methods) {
    assert.notEqual(resolveRouteAuth({ surface: 'api', pathname, method: match[1] }).access, 'deny', `${match[1]} ${relativePath}`);
  }
}

console.log('auth tests passed');
