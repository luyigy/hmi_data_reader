import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export type AuthContext =
  | { tier: 'operator'; subject: 'admin' }
  | { tier: 'machine'; subject: 'gateway'; gatewayId: string }
  | { tier: 'machine'; subject: 'feishu'; senderOpenId: string };

export interface AuthConfig {
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new AuthConfigurationError(`Missing required environment variable: ${name}`);
  return value;
};

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = env.NODE_ENV === 'production';
  const localCompatibility = env.AUTH_ALLOW_INSECURE_LOCAL === 'true';
  if (production && localCompatibility) {
    throw new AuthConfigurationError('AUTH_ALLOW_INSECURE_LOCAL is forbidden in production');
  }

  const adminUsername = required(env, 'AUTH_ADMIN_USERNAME');
  const adminPassword = required(env, 'AUTH_ADMIN_PASSWORD');
  const sessionSecret = required(env, 'AUTH_SESSION_SECRET');
  const sessionTtlSeconds = Number(required(env, 'AUTH_SESSION_TTL_SECONDS'));
  const minimumPasswordLength = localCompatibility ? 8 : 12;
  const minimumSecretLength = localCompatibility ? 16 : 32;

  if (adminPassword.length < minimumPasswordLength) {
    throw new AuthConfigurationError(`AUTH_ADMIN_PASSWORD must be at least ${minimumPasswordLength} characters`);
  }
  if (Buffer.byteLength(sessionSecret) < minimumSecretLength) {
    throw new AuthConfigurationError(`AUTH_SESSION_SECRET must be at least ${minimumSecretLength} bytes`);
  }
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 300 || sessionTtlSeconds > 86_400) {
    throw new AuthConfigurationError('AUTH_SESSION_TTL_SECONDS must be an integer from 300 to 86400');
  }

  return { adminUsername, adminPassword, sessionSecret, sessionTtlSeconds };
}

const keyedDigest = (value: string, secret: string) =>
  createHmac('sha256', secret).update(value).digest();

const safeEqual = (actual: string, expected: string, secret: string) =>
  timingSafeEqual(keyedDigest(actual, secret), keyedDigest(expected, secret));

export function verifyAdminCredentials(
  username: string,
  password: string,
  config: AuthConfig
): boolean {
  return safeEqual(username, config.adminUsername, config.sessionSecret)
    && safeEqual(password, config.adminPassword, config.sessionSecret);
}

type OperatorSessionClaims = {
  version: 1;
  purpose: 'operator-session';
  subject: 'admin';
  issuedAt: number;
  expiresAt: number;
};

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function createOperatorSession(
  config: AuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const claims: OperatorSessionClaims = {
    version: 1,
    purpose: 'operator-session',
    subject: 'admin',
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + config.sessionTtlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, config.sessionSecret)}`;
}

export function verifyOperatorSession(
  token: string,
  config: AuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): AuthContext | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [payload, signature] = parts;
  const expectedSignature = sign(payload, config.sessionSecret);
  if (!safeEqual(signature, expectedSignature, config.sessionSecret)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<OperatorSessionClaims>;
    if (
      claims.version !== 1
      || claims.purpose !== 'operator-session'
      || claims.subject !== 'admin'
      || !Number.isInteger(claims.issuedAt)
      || !Number.isInteger(claims.expiresAt)
      || claims.issuedAt! > nowSeconds
      || claims.expiresAt! <= nowSeconds
      || claims.expiresAt! - claims.issuedAt! !== config.sessionTtlSeconds
    ) {
      return null;
    }
    return { tier: 'operator', subject: 'admin' };
  } catch {
    return null;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type RouteSurface = 'page' | 'api' | 'socket';
export type RouteAuthRequirement =
  | { access: 'public' }
  | { access: 'operator' }
  | { access: 'machine'; subject: 'gateway' | 'feishu'; verification: 'route' }
  | { access: 'self_verified'; verification: 'signed-action' }
  | { access: 'deny' };

type RouteRule = {
  surface: RouteSurface;
  pattern: string;
  methods?: readonly HttpMethod[];
  requirement: RouteAuthRequirement;
};

const operator = { access: 'operator' } as const;
const ROUTE_RULES: readonly RouteRule[] = [
  { surface: 'page', pattern: '/login', methods: ['GET'], requirement: { access: 'public' } },
  ...[
    '/', '/agents', '/chat', '/gateway-tools', '/gateways/register', '/remote-ssh-tools',
    '/rooms', '/rooms/:id', '/tasks', '/tasks/:id', '/tasks/:id/chat', '/workflow',
    '/workspaces', '/workspaces/:id',
  ].map((pattern): RouteRule => ({ surface: 'page', pattern, methods: ['GET'], requirement: operator })),
  { surface: 'api', pattern: '/api/health', methods: ['GET'], requirement: { access: 'public' } },
  { surface: 'api', pattern: '/api/feishu/grant', methods: ['GET'], requirement: { access: 'self_verified', verification: 'signed-action' } },
  { surface: 'api', pattern: '/api/feishu/webhook', methods: ['POST'], requirement: { access: 'machine', subject: 'feishu', verification: 'route' } },
  { surface: 'api', pattern: '/api/gateways/register', methods: ['POST'], requirement: { access: 'machine', subject: 'gateway', verification: 'route' } },
  { surface: 'api', pattern: '/api/gateways/:id/test', methods: ['POST'], requirement: { access: 'machine', subject: 'gateway', verification: 'route' } },
  { surface: 'api', pattern: '/api/gateways/messages/incoming', methods: ['GET', 'POST'], requirement: { access: 'machine', subject: 'gateway', verification: 'route' } },
  { surface: 'api', pattern: '/api/gateways/messages/send', methods: ['GET', 'POST'], requirement: { access: 'machine', subject: 'gateway', verification: 'route' } },
  ...[
    ['/api/acpx/harness-options', ['GET']],
    ['/api/agents', ['GET']],
    ['/api/agents/:id', ['PATCH']],
    ['/api/agents/register-real', ['GET', 'POST']],
    ['/api/chat/agent-response', ['POST']],
    ['/api/chat/messages', ['GET', 'POST']],
    ['/api/chat/rooms', ['GET']],
    ['/api/control-plane/execute', ['GET', 'POST']],
    ['/api/feishu/connection', ['GET']],
    ['/api/gateways', ['GET', 'POST']],
    ['/api/gateways/:id/agents/refresh', ['POST']],
    ['/api/gateways/:id/health', ['GET']],
    ['/api/gateways/:id/openclaw/config', ['GET', 'POST', 'DELETE']],
    ['/api/gateways/:id/openclaw/respond', ['POST']],
    ['/api/gateways/:id/test', ['GET']],
    ['/api/gateways/chat', ['GET', 'POST']],
    ['/api/gateways/register', ['GET']],
    ['/api/gateways/token', ['GET', 'POST', 'DELETE']],
    ['/api/live-rooms', ['GET', 'POST']],
    ['/api/live-rooms/:id', ['GET', 'PATCH', 'DELETE']],
    ['/api/live-rooms/:id/clear-task-room', ['POST']],
    ['/api/live-rooms/:id/interrupt', ['POST']],
    ['/api/live-rooms/:id/members', ['POST']],
    ['/api/live-rooms/:id/members/:memberId', ['PATCH', 'DELETE']],
    ['/api/live-rooms/:id/messages', ['GET', 'POST']],
    ['/api/live-rooms/:id/speaker', ['POST']],
    ['/api/live-rooms/:id/topic', ['POST']],
    ['/api/remote-harness-hosts', ['GET', 'POST']],
    ['/api/remote-harness-hosts/:id', ['PATCH', 'DELETE']],
    ['/api/remote-harness-hosts/:id/test', ['POST']],
    ['/api/socket', ['GET']],
    ['/api/tasks', ['GET', 'POST']],
    ['/api/tasks/:id', ['GET', 'PUT', 'DELETE']],
    ['/api/tasks/:id/control', ['POST']],
    ['/api/tasks/:id/execute', ['POST']],
    ['/api/tasks/:id/logs', ['GET']],
    ['/api/tasks/:id/room', ['GET', 'DELETE']],
    ['/api/tasks/:id/runs', ['GET']],
    ['/api/tasks/:id/runs/latest', ['GET']],
    ['/api/workspaces', ['GET']],
    ['/api/workspaces/:id', ['GET']],
  ].map(([pattern, methods]): RouteRule => ({
    surface: 'api',
    pattern: pattern as string,
    methods: methods as HttpMethod[],
    requirement: operator,
  })),
  { surface: 'socket', pattern: '/api/socket', requirement: operator },
];

const matchesPattern = (pattern: string, pathname: string) => {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  return expected.length === actual.length
    && expected.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
};

export function resolveRouteAuth(args: {
  surface: RouteSurface;
  pathname: string;
  method?: string;
}): RouteAuthRequirement {
  const pathname = args.pathname.split('?')[0].replace(/\/$/, '') || '/';
  const method = args.method?.toUpperCase();
  const rule = ROUTE_RULES.find((candidate) =>
    candidate.surface === args.surface
    && matchesPattern(candidate.pattern, pathname)
    && (!candidate.methods || (!!method && candidate.methods.includes(method as HttpMethod)))
  );
  return rule?.requirement ?? { access: 'deny' };
}
