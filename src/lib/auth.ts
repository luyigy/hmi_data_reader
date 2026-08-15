import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export const AUTH_COOKIE = 'ap_auth_token';

export type AuthContext =
  | { tier: 'operator'; subject: 'admin' }
  | { tier: 'operator'; subject: string; userId: string; role: 'admin' | 'user' }
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

type UserSessionClaims = {
  version: 2;
  purpose: 'operator-session';
  subject: string;
  userId: string;
  role: 'admin' | 'user';
  issuedAt: number;
  expiresAt: number;
};

type ParsedSessionClaims = {
  version?: unknown;
  purpose?: unknown;
  subject?: unknown;
  userId?: unknown;
  role?: unknown;
  issuedAt?: unknown;
  expiresAt?: unknown;
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

export function createUserSession(
  user: { id: string; username: string; role: 'admin' | 'user' },
  config: AuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const claims: UserSessionClaims = {
    version: 2,
    purpose: 'operator-session',
    subject: user.username,
    userId: user.id,
    role: user.role,
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
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ParsedSessionClaims;
    const validLifetime = typeof claims.issuedAt === 'number'
      && typeof claims.expiresAt === 'number'
      && Number.isInteger(claims.issuedAt)
      && Number.isInteger(claims.expiresAt)
      && claims.issuedAt <= nowSeconds
      && claims.expiresAt > nowSeconds
      && claims.expiresAt - claims.issuedAt === config.sessionTtlSeconds;
    if (
      claims.purpose !== 'operator-session'
      || !validLifetime
    ) {
      return null;
    }
    if (claims.version === 1 && claims.subject === 'admin') {
      return { tier: 'operator', subject: 'admin' };
    }
    if (
      claims.version === 2
      && typeof claims.subject === 'string'
      && claims.subject.length > 0
      && typeof claims.userId === 'string'
      && claims.userId.length > 0
      && (claims.role === 'admin' || claims.role === 'user')
    ) {
      return { tier: 'operator', subject: claims.subject, userId: claims.userId, role: claims.role };
    }
    return null;
  } catch {
    return null;
  }
}

export { resolveRouteAuth } from './auth-routes';
export type { RouteAuthRequirement } from './auth-routes';
